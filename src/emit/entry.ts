import { Effect, Schema } from "effect";
import { runtimeSettings } from "../model/author-config.ts";
import type { AuthorConfig } from "../model/author-config.ts";
import type { SecurityScheme } from "../model/entities.ts";
import { methodTokens } from "../model/method-tokens.ts";
import { envPrefixOf } from "../names/plan.ts";
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
  plus,
  printModule,
  str,
  typeKeyword,
  typeRef,
} from "./printer.ts";
import type { Expr, Import, Module, Param, PrinterError, Statement } from "./printer.ts";

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

const stringParam = (name: string): Param => ({ name: I(name), type: typeKeyword("string") });

const piped = (head: Expr, ...steps: readonly Expr[]): Expr => call(member(head, M("pipe")), steps);

const constant = (name: string, value: Expr, exported = false): Statement => ({
  _tag: "Const",
  exported,
  name: I(name),
  value,
});

/**
 * The fallback object of the `ConfigProvider` `main.ts` composes (design D-AD7): each runtime
 * setting `runtimeSettings` resolves, keyed by the explicit prefixed env name its runtime resolver
 * reads (`<PREFIX>_IDLE_TIMEOUT`, `<PREFIX>_RETRIES`, `<PREFIX>_TIMEOUT`; memo 6f21e261), in key
 * order. Nothing is nested, so an environment value of the same name wins.
 */
export const runtimeFallback = (config: AuthorConfig) => {
  const prefix = envPrefixOf(config);
  const settings = runtimeSettings(config);

  return {
    [`${prefix}_IDLE_TIMEOUT`]: settings.idleTimeoutSeconds,
    [`${prefix}_RETRIES`]: settings.retries,
    [`${prefix}_TIMEOUT`]: settings.timeoutSeconds,
  };
};

/**
 * `main.ts` (design 4.1 Lazy root, 14 D5): reads the arguments from `Stdio`, builds the root with
 * `cli/root.ts` `root` (which loads only the groups the arguments select), then `Command.run` over
 * that root with `renderErrors: false` (the final catch is the only renderer), provided with the
 * root's `services` and `CliOutput.layer(Output.formatter(root))`, then `Output.exitForHelp` (help
 * with parse errors exits 2) inside `Output.finalCatch`, which reads `<PREFIX>_ERROR_FORMAT` for a
 * parse-time error. The credentials the handler evaluated reach the catch through
 * `RunCredentials`, so its own list is empty. The whole run reads config through
 * `ConfigProvider.orElse(<env>, ConfigProvider.fromUnknown(runtimeFallback(config)))`, so an author
 * default applies when its env name is unset (design D-AD7).
 */
const mainModule = (config: AuthorConfig): Module => {
  const runRoot = fn(
    "Command.run",
    path("command"),
    obj([
      ["renderErrors", bool(false)],
      ["version", str(config.package.version)],
    ]),
  );
  const layers = fn(
    "Layer.mergeAll",
    path("services"),
    fn("CliOutput.layer", fn("Output.formatter", path("command"))),
  );
  const args = fn("Stdio.Stdio.use", arrow([{ name: I("stdio") }], path("stdio.args")));
  const fallback = Object.entries(runtimeFallback(config)).map(
    ([name, value]): readonly [string, Expr] => [name, num(value)],
  );
  const provider = fn(
    "ConfigProvider.orElse",
    fn("ConfigProvider.fromEnv"),
    fn("ConfigProvider.fromUnknown", obj(fallback)),
  );

  return {
    imports: [
      named("effect", ["ConfigProvider", "Effect", "Layer", "Stdio"]),
      named("effect/cli", ["CliOutput", "Command"]),
      named("./cli/root.ts", ["root", "services"]),
      namespace("./runtime/output.ts", "Output"),
    ],
    statements: [
      constant("provider", provider),
      constant(
        "run",
        call(member(args, M("pipe")), [
          fn("Effect.flatMap", path("root")),
          fn(
            "Effect.flatMap",
            arrow(
              [{ name: I("command") }],
              call(member(runRoot, M("pipe")), [fn("Effect.provide", layers)]),
            ),
          ),
          path("Output.exitForHelp"),
          fn("Output.finalCatch", arr([]), obj([["envPrefix", str(envPrefixOf(config))]])),
          fn("Effect.provideService", path("ConfigProvider.ConfigProvider"), path("provider")),
        ]),
        true,
      ),
    ],
  };
};

/**
 * The client-certificate part of `bin.ts` (design 4.3, 6.5 `mutualTLS` row, D-SEC3), emitted only
 * for a package with a `mutualTLS` scheme. At start-up it reads each `mutualTLS` scheme of
 * `api/security.ts` through the runtime's `Auth.clientCertificatePaths` (the names the scheme
 * carries are the one derivation), checks each configured path readable (an unreadable one is a
 * `UsageError` naming its environment variable, exit 2, rendered once by `Output.finalCatch`, which
 * reads `<PREFIX>_ERROR_FORMAT` as for a parse-time error, design 7.4), and
 * provides `{ tls: { cert, key, ca? } }` over `Bun.file` as `Auth.ClientCertificate`, the first
 * configured scheme's. The runtime sets it per hop on bound origins only; `layerOptions` never
 * gets a `tls` key, because a client-wide one presents the certificate to every host (I3).
 */
const clientCertificateStatements = (config: AuthorConfig): readonly Statement[] => {
  const unreadable = arrow(
    [stringParam("message")],
    newExpr(path("UsageError"), [obj([["message", path("message")]])]),
  );
  const certificateFile = arrow(
    [stringParam("name"), stringParam("path")],
    piped(
      fn(
        "FileSystem.FileSystem.use",
        arrow([{ name: I("fs") }], fn("fs.access", path("path"), obj([["readable", bool(true)]]))),
      ),
      fn(
        "Effect.mapError",
        arrow([], fn("unreadable", plus(str("cannot read the file named by "), path("name")))),
      ),
      fn("Effect.as", fn("Bun.file", path("path"))),
    ),
  );
  const files = obj([
    [
      "ca",
      fn(
        "Effect.transposeOption",
        fn(
          "Option.map",
          path("configured.ca"),
          arrow([{ name: I("ca") }], fn("certificateFile", path("scheme.caEnv"), path("ca"))),
        ),
      ),
    ],
    ["cert", fn("certificateFile", path("scheme.certEnv"), path("configured.cert"))],
    ["key", fn("certificateFile", path("scheme.keyEnv"), path("configured.key"))],
  ]);
  const pair: readonly (readonly [string, Expr])[] = [
    ["cert", path("files.cert")],
    ["key", path("files.key")],
  ];
  const init = arrow(
    [{ name: I("files") }],
    obj([
      [
        "tls",
        fn(
          "Option.match",
          path("files.ca"),
          obj([
            ["onNone", arrow([], obj(pair))],
            ["onSome", arrow([{ name: I("ca") }], obj([["ca", path("ca")], ...pair]))],
          ]),
        ),
      ],
    ]),
    typeRef(I("BunFetchRequestInit")),
  );
  const certificateInit = arrow(
    [{ name: I("scheme"), type: typeRef(I("Auth"), [M("MutualTlsScheme")]) }],
    piped(
      fn("Auth.clientCertificatePaths", path("scheme")),
      fn(
        "Effect.mapError",
        arrow([], fn("unreadable", plus(str("cannot read the setting "), path("scheme.certEnv")))),
      ),
      fn(
        "Effect.flatMap",
        arrow(
          [{ name: I("paths") }],
          fn(
            "Effect.transposeOption",
            fn(
              "Option.map",
              path("paths"),
              arrow([{ name: I("configured") }], fn("Effect.all", files)),
            ),
          ),
        ),
      ),
      fn("Effect.map", fn("Option.map", init)),
    ),
  );
  const perScheme = arrow(
    [{ name: I("scheme") }],
    piped(
      fn("Match.value", path("scheme")),
      fn("Match.when", obj([["kind", str("mutualTLS")]]), path("certificateInit")),
      fn("Match.orElse", arrow([], path("Effect.succeedNone"))),
    ),
  );
  const certificateInits = fn(
    "Effect.forEach",
    fn("Object.values", path("security.schemes")),
    perScheme,
  );
  const clientCertificate = piped(
    fn(
      "Layer.effect",
      path("Auth.ClientCertificate"),
      piped(
        fn(
          "Effect.map",
          path("certificateInits"),
          arrow([{ name: I("all") }], fn("Option.firstSomeOf", path("all"))),
        ),
        fn("Output.finalCatch", arr([]), obj([["envPrefix", str(envPrefixOf(config))]])),
      ),
    ),
    fn(
      "Layer.provide",
      fn("Layer.mergeAll", path("BunServices.layer"), path("Redact.runCredentialsLayer")),
    ),
  );

  return [
    constant("unreadable", unreadable),
    constant("certificateFile", certificateFile),
    constant("certificateInit", certificateInit),
    constant("certificateInits", certificateInits),
    constant("clientCertificate", clientCertificate),
  ];
};

/**
 * `bin.ts` (design 4.1, 4.3): the only emitted module that names Bun. It composes the platform:
 * Bun services, the Bun HTTP client with manual redirects and no client timeout or `proxy` key,
 * the `FileBody` layer over `Bun.file` (spike S3), the client policy (the method allowlist of
 * design 6.7, the runtime's `Client.directRoute` for loopback hops of design 6.5, the
 * `User-Agent` name and version), the run-scoped `RunCredentials`, `RunRecord` (the error format
 * and retry-hint record) and `RunWarnings` (the once-per-run warnings) outside the final catch, the
 * runtime presenter with no second formatter, the runtime's built-in flags (`Output.builtIns`:
 * every effect default but `--wizard`, help and version without `-h`/`-v`), logs to stderr and
 * no trace propagation. `runMain` reports no error: the final catch already rendered it. With a
 * `mutualTLS` scheme it also provides the client certificate (`clientCertificateStatements`);
 * without one it has no client-certificate part.
 */
const binModule = (config: AuthorConfig, mutualTls: boolean): Module => {
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
      ["direct", path("Client.directRoute")],
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
    ...(mutualTls ? [path("clientCertificate")] : []),
    path("Redact.runCredentialsLayer"),
    path("Output.runRecordLayer"),
    path("Output.runWarningsLayer"),
    fn("CliOutput.layerPresenter", path("Output.presenter")),
    fn("CliConfig.layer", obj([["builtIns", path("Output.builtIns")]])),
    fn("Layer.succeed", path("References.LogToStderr"), bool(true)),
    fn("Layer.succeed", path("HttpClient.TracerPropagationEnabled"), bool(false)),
  );

  return {
    imports: [
      named("@effect/platform-bun", ["BunHttpClient", "BunRuntime", "BunServices"]),
      named(
        "effect",
        mutualTls
          ? ["Effect", "FileSystem", "Layer", "Match", "Option", "References"]
          : ["Effect", "Layer", "References"],
      ),
      named("effect/cli", ["CliConfig", "CliOutput"]),
      named("effect/http", ["HttpBody", "HttpClient"]),
      ...(mutualTls
        ? [named("./api/security.ts", ["security"]), named("./domain/errors.ts", ["UsageError"])]
        : []),
      named("./main.ts", ["run"]),
      ...(mutualTls ? [namespace("./runtime/auth.ts", "Auth")] : []),
      namespace("./runtime/client.ts", "Client"),
      namespace("./runtime/file-body.ts", "FileBody"),
      namespace("./runtime/output.ts", "Output"),
      namespace("./runtime/redact.ts", "Redact"),
    ],
    shebang: Schema.decodeSync(Shebang)("/usr/bin/env bun"),
    statements: [
      constant("fileBody", fileBody),
      constant("clientPolicy", clientPolicy),
      ...(mutualTls ? clientCertificateStatements(config) : []),
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
 * `User-Agent` name. Both print as escaped string literals. `securitySchemes` are the model's
 * declared schemes: a `mutualTLS` one among them makes `bin.ts` provide the client certificate.
 */
export const emitEntryFiles = (
  config: AuthorConfig,
  securitySchemes: readonly SecurityScheme[],
): Effect.Effect<readonly EmittedFile[], PrinterError> =>
  Effect.all([
    printModule(
      binModule(
        config,
        securitySchemes.some((scheme) => scheme.kind.type === "mutualTls"),
      ),
    ),
    printModule(mainModule(config)),
  ]).pipe(
    Effect.map(([bin, main]) => [
      { content: bin, path: "src/bin.ts" },
      { content: main, path: "src/main.ts" },
    ]),
  );
