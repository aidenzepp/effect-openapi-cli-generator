import { Effect, Schema } from "effect";
import type { AuthorConfig } from "../model/author-config.ts";
import { methodTokens } from "../model/method-tokens.ts";
import type { EmittedFile } from "./package.ts";
import {
  Identifier,
  MemberName,
  ModuleSpecifier,
  Shebang,
  arr,
  arrow,
  bool,
  call,
  ident,
  member,
  newExpr,
  num,
  obj,
  printModule,
  str,
} from "./printer.ts";
import type { Expr, Import, Module, PrinterError, Statement } from "./printer.ts";

const I = Schema.decodeSync(Identifier);

const M = Schema.decodeSync(MemberName);

const S = Schema.decodeSync(ModuleSpecifier);

// `path("a.b.c")` is the member access `a.b.c`; every caller passes a fixed name.
const path = (dotted: string): Expr => {
  const [head = "", ...rest] = dotted.split(".");

  let expr = ident(I(head));
  for (const name of rest) {
    expr = member(expr, M(name));
  }

  return expr;
};

const fn = (callee: string, ...args: readonly Expr[]): Expr => call(path(callee), args);

const named = (from: string, names: readonly string[], typeOnly = false): Import => ({
  _tag: "Named",
  from: S(from),
  names: names.map((name) => I(name)),
  typeOnly,
});

const namespace = (from: string, name: string): Import => ({
  _tag: "Namespace",
  from: S(from),
  name: I(name),
  typeOnly: false,
});

const constant = (name: string, value: Expr, exported = false): Statement => ({
  _tag: "Const",
  exported,
  name: I(name),
  value,
});

/**
 * `main.ts` (design 4.1, 14 D5): `Command.run` with `renderErrors: false` (the final catch is the
 * only renderer), provided with the root's `services` and
 * `CliOutput.layer(Output.formatter(root))`, then `Output.exitForHelp` (help with parse errors
 * exits 2) inside `Output.finalCatch`. The credentials the handler evaluated reach the catch
 * through `RunCredentials`, so its own list is empty. M1 carries no runtime defaults, so there is
 * no `ConfigProvider` fallback.
 */
const mainModule = (config: AuthorConfig): Module => {
  const runRoot = fn(
    "Command.run",
    path("root"),
    obj([
      ["renderErrors", bool(false)],
      ["version", str(config.package.version)],
    ]),
  );
  const layers = fn(
    "Layer.mergeAll",
    path("services"),
    fn("CliOutput.layer", fn("Output.formatter", path("root"))),
  );

  return {
    imports: [
      named("effect", ["Effect", "Layer"]),
      named("effect/cli", ["CliOutput", "Command"]),
      named("./cli/root.ts", ["root", "services"]),
      namespace("./runtime/output.ts", "Output"),
    ],
    statements: [
      constant(
        "run",
        call(member(runRoot, M("pipe")), [
          fn("Effect.provide", layers),
          path("Output.exitForHelp"),
          fn("Output.finalCatch", arr([])),
        ]),
        true,
      ),
    ],
  };
};

/**
 * Built-in global flags the generated CLI keeps (design 4.3): every default but `--wizard`.
 */
const builtIns = ["Help", "Version", "Completions", "LogLevel"];

/**
 * `bin.ts` (design 4.1, 4.3): the only emitted module that names Bun. It composes the platform:
 * Bun services, the Bun HTTP client with manual redirects and no client timeout or `proxy` key,
 * the `FileBody` layer over `Bun.file` (spike S3), the client policy (the method allowlist of
 * design 6.7, the direct route `{ proxy: false }` for loopback hops of design 6.5, the
 * `User-Agent` name and version), the stdin claim, `RunCredentials` outside the final catch, the
 * runtime presenter with no second formatter, the built-in flags, logs to stderr and no trace
 * propagation. `runMain` reports no error: the final catch already rendered it.
 */
const binModule = (config: AuthorConfig): Module => {
  const fileBody = fn(
    "Layer.succeed",
    path("FileBody.FileBody"),
    obj([
      [
        "open",
        arrow(
          [{ name: I("path") }],
          fn("Effect.succeed", fn("HttpBody.raw", fn("Bun.file", path("path")))),
        ),
      ],
    ]),
  );
  const allowed = methodTokens.map((token) => str(token));
  const clientPolicy = fn(
    "Layer.succeed",
    path("Output.ClientPolicy"),
    obj([
      ["allowed", newExpr(path("Set"), [arr(allowed)])],
      ["binName", str(config.binName)],
      ["direct", obj([["proxy", bool(false)]])],
      ["version", str(config.package.version)],
    ]),
  );
  const entry = fn(
    "Layer.mergeAll",
    path("BunServices.layer"),
    fn(
      "BunHttpClient.layerOptions",
      obj([
        ["redirect", str("manual")],
        ["timeout", num(0)],
      ]),
    ),
    path("clientPolicy"),
    path("fileBody"),
    path("Input.stdinClaimLayer"),
    path("Output.runCredentialsLayer"),
    fn("CliOutput.layerPresenter", path("Output.presenter")),
    fn(
      "CliConfig.layer",
      obj([["builtIns", arr(builtIns.map((name) => path(`GlobalFlag.${name}`)))]]),
    ),
    fn("Layer.succeed", path("References.LogToStderr"), bool(true)),
    fn("Layer.succeed", path("HttpClient.TracerPropagationEnabled"), bool(false)),
  );

  return {
    imports: [
      named("@effect/platform-bun", ["BunHttpClient", "BunRuntime", "BunServices"]),
      named("effect", ["Effect", "Layer", "References"]),
      named("effect/cli", ["CliConfig", "CliOutput", "GlobalFlag"]),
      named("effect/http", ["HttpBody", "HttpClient"]),
      named("./main.ts", ["run"]),
      namespace("./runtime/file-body.ts", "FileBody"),
      namespace("./runtime/input.ts", "Input"),
      namespace("./runtime/output.ts", "Output"),
    ],
    shebang: Schema.decodeSync(Shebang)("/usr/bin/env bun"),
    statements: [
      constant("fileBody", fileBody),
      constant("clientPolicy", clientPolicy),
      constant("entry", entry),
      {
        _tag: "Expression",
        value: fn(
          "BunRuntime.runMain",
          fn("Effect.provide", path("run"), path("entry")),
          obj([["disableErrorReporting", bool(true)]]),
        ),
      },
    ],
  };
};

/**
 * Emits the generated package's `src/bin.ts` and `src/main.ts` (design 4.1, 4.3), sorted by path.
 * The package version is the `--version` text and the `User-Agent` version; the bin name is the
 * `User-Agent` name. Both print as escaped string literals.
 */
export const emitEntryFiles = (
  config: AuthorConfig,
): Effect.Effect<readonly EmittedFile[], PrinterError> =>
  Effect.all([printModule(binModule(config)), printModule(mainModule(config))]).pipe(
    Effect.map(([bin, main]) => [
      { content: bin, path: "src/bin.ts" },
      { content: main, path: "src/main.ts" },
    ]),
  );
