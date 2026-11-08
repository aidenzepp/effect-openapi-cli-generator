/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer, Path, Predicate, Schema, Sink, Stdio } from "effect";
import { Command } from "effect/cli";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";

// A deprecated parameter (PRM-07) keeps its flag, piped through `Input.deprecated` outside its
// presence wrapper, and its help annotation ends with `deprecated`. A parameter that is not
// deprecated emits what Milestone 1 emitted.

const root = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const readFixture = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

const goldenSpec = decodeRecord(JSON.parse(readFixture("openapi.json")));

const goldenConfig = readFixture("author-config.json");

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

// The golden author config names `./custom/commands.ts`, which the author owns: one `login` command.
const authorCommands = `import { Command } from "effect/cli";\n\nexport const login = Command.make("login");\n`;

const string = { type: "string" };

// The golden spec plus one operation with a deprecated path, query and repeated query parameter
// beside one that is not deprecated.
const withDeprecated: Schema.Json = {
  ...goldenSpec,
  paths: {
    ...decodeRecord(goldenSpec.paths),
    "/items/{id}": {
      get: {
        operationId: "items-list",
        parameters: [
          { deprecated: true, in: "path", name: "id", required: true, schema: string },
          { deprecated: true, in: "query", name: "old", schema: string },
          { deprecated: true, in: "query", name: "olds", schema: { items: string, type: "array" } },
          { in: "query", name: "fresh", schema: string },
        ],
        responses: { "204": { description: "Done." } },
        tags: ["items"],
      },
    },
  },
};

// Generated packages live under the worktree's git-ignored `work/`, so an emitted module resolves
// `effect` from the generator's own `node_modules`.
const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "deprecated-parameter-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

interface Observed {
  readonly cliItems: string;
  readonly out: string;
}

const run = (): Promise<Observed> =>
  Effect.runPromise(
    Effect.gen(function* prepare() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const specPath = path.join(work, "openapi.json");
      const configPath = path.join(work, "author-config.json");
      const out = path.join(work, "out");
      yield* fs.writeFileString(specPath, JSON.stringify(withDeprecated));
      yield* fs.writeFileString(configPath, goldenConfig);
      yield* generate(
        {
          document,
          generator,
          outDir: out,
          source: { _tag: "File", path: specPath },
          strict: true,
        },
        { document: configDocument, path: configPath },
      );
      yield* fs.makeDirectory(path.join(out, "custom"), { recursive: true });
      yield* fs.writeFileString(path.join(out, "custom/commands.ts"), authorCommands);

      return { cliItems: yield* fs.readFileString(path.join(out, "src/cli/items.ts")), out };
    }).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  );

let observed: Promise<Observed> | undefined;

const generated = (): Promise<Observed> => {
  observed ??= run();

  return observed;
};

const isListCommand = (value: unknown): value is Command.Command<"list", unknown, unknown> =>
  Command.isCommand(value);

// Parses `args` with the emitted `list` command and returns what reached stderr. Only parsing is
// under test: the handler's send services are absent, so the run ends after the flags are read.
const stderrOf = async (args: readonly string[]): Promise<string> => {
  const { out } = await generated();
  const emitted: unknown = await import(nodePath.join(out, "src/cli/items.ts"));
  const command = Predicate.isObject(emitted) && "list" in emitted ? emitted.list : undefined;
  if (!isListCommand(command)) {
    throw new Error("the emitted items module has no list command");
  }

  const err: string[] = [];
  const capture = () =>
    Sink.forEach((chunk: string | Uint8Array) =>
      Effect.sync(() => {
        err.push(Buffer.from(chunk).toString("utf-8"));
      }),
    );
  // Help text goes to the console, kept apart; the notice goes to Stdio's stderr.
  const help: string[] = [];
  // oxlint-disable-next-line prefer-object-spread
  const quiet: Console.Console = Object.assign({}, globalThis.console, {
    log: (...parts: readonly unknown[]) => {
      help.push(parts.join(" "));
    },
  });
  await Effect.runPromise(
    Command.runWith(command, { renderErrors: false, version: "0" })(args).pipe(
      Output.exitForHelp,
      Effect.provide(Stdio.layerTest({ stderr: capture, stdout: capture })),
      Effect.provide(BunServices.layer),
      Effect.provideService(Console.Console, quiet),
      Effect.exit,
    ),
  );

  return err.join("");
};

describe("generate: deprecated parameters", () => {
  test("a deprecated flag is piped through Input.deprecated outside its presence wrapper", async () => {
    const { cliItems } = await generated();

    expect(cliItems).toContain(
      'old: Flag.String("old").pipe(Flag.optional, Input.deprecated("old")',
    );
    expect(cliItems).toContain(
      'olds: Flag.String("olds").pipe(Flag.atLeast(0), Input.deprecated("olds")',
    );
  });

  test("a deprecated path parameter's argument is piped through Input.deprecatedArgument", async () => {
    const { cliItems } = await generated();

    expect(cliItems).toContain('id: Argument.String("id").pipe(Input.deprecatedArgument("id")');
  });

  test("a parameter that is not deprecated has no combinator", async () => {
    const { cliItems } = await generated();

    expect(cliItems).toContain('fresh: Flag.String("fresh").pipe(Flag.optional),');
  });

  test("the help annotation of a deprecated flag or argument ends with deprecated", async () => {
    const { cliItems } = await generated();

    expect(cliItems).toContain('old: "query old; deprecated"');
    expect(cliItems).toContain('olds: "query olds; deprecated"');
    expect(cliItems).toContain('id: "path id; deprecated"');
    expect(cliItems).toContain('fresh: "query fresh"');
  });

  test("the emitted command writes one notice for --old v and none without it", async () => {
    expect(await stderrOf(["7", "--old", "v-secret"])).toBe(
      "Notice: the parameter <id> is deprecated\nNotice: the parameter --old is deprecated\n",
    );
    expect(await stderrOf(["--help"])).toBe("");
  });
});
