import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunCrypto, BunFileSystem, BunPath, BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, FileSystem, Layer, Path, Predicate, Runtime, Schema } from "effect";
import { Command } from "effect/cli";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";

// Integer and number parameters get typed flags (PRM-14): the flag or argument checks the operator's
// text against the JSON number grammar and the builder sends that text unchanged. The type is the
// schema's scalar `type` through `$ref`, or its `items` type for an array; a 3.1 type list and an
// untyped schema keep the plain string flag.

const root = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const readFixture = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

const goldenSpec = decodeRecord(JSON.parse(readFixture("openapi.json")));

const goldenComponents = decodeRecord(goldenSpec.components);

const goldenConfig = readFixture("author-config.json");

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

// The golden author config names `./custom/commands.ts`, which the author owns: one `login` command.
const authorCommands = `import { Command } from "effect/cli";\n\nexport const login = Command.make("login");\n`;

const query = (name: string, schema: Schema.Json) => ({ in: "query", name, schema });

// The golden spec plus one operation whose parameters cover each scalar type the flag takes.
const withNumbers: Schema.Json = {
  ...goldenSpec,
  components: {
    ...goldenComponents,
    schemas: {
      ...decodeRecord(goldenComponents.schemas),
      Count: { type: "integer" },
      CountRef: { $ref: "#/components/schemas/Count" },
    },
  },
  paths: {
    ...decodeRecord(goldenSpec.paths),
    "/items/{id}": {
      get: {
        operationId: "items-list",
        parameters: [
          { in: "path", name: "id", required: true, schema: { type: "integer" } },
          query("limit", { type: "integer" }),
          query("ratio", { type: "number" }),
          query("ids", { items: { type: "integer" }, type: "array" }),
          query("count", { $ref: "#/components/schemas/CountRef" }),
          query("codes", { items: { $ref: "#/components/schemas/Count" }, type: "array" }),
          query("maybe", { type: ["integer", "null"] }),
          query("free", {}),
          query("label", { type: "string" }),
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

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "typed-parameter-flag-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

interface Observed {
  readonly apiItems: string;
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
      yield* fs.writeFileString(specPath, JSON.stringify(withNumbers));
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

      return {
        apiItems: yield* fs.readFileString(path.join(out, "src/api/items.ts")),
        cliItems: yield* fs.readFileString(path.join(out, "src/cli/items.ts")),
        out,
      };
    }).pipe(
      Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layerDigest)),
    ),
  );

let observed: Promise<Observed> | undefined;

const generated = (): Promise<Observed> => {
  observed ??= run();

  return observed;
};

interface BuiltRequest {
  readonly url: string;
}

interface ListInput {
  readonly id: string;
  readonly ids: readonly string[];
  readonly limit: string;
  readonly ratio: string;
}

type Builder = (input: ListInput) => Effect.Effect<BuiltRequest, unknown>;

const isBuilder = (value: unknown): value is Builder => Predicate.isFunction(value);

// The emitted command's handler needs the send services; a refused value never reaches it, so
// parsing alone needs none beyond the platform's.
const isListCommand = (value: unknown): value is Command.Command<"list", unknown, unknown> =>
  Command.isCommand(value);

// Parses `args` with the emitted `list` command, the generated entry's way (`exitForHelp`). A
// refused value fails while parsing, so the handler, and the request it builds, never runs.
const parse = async (args: readonly string[]) => {
  const { out } = await generated();
  const emitted: unknown = await import(nodePath.join(out, "src/cli/items.ts"));
  const command = Predicate.isObject(emitted) && "list" in emitted ? emitted.list : undefined;
  if (!isListCommand(command)) {
    throw new Error("the emitted items module has no list command");
  }

  const exit = await Effect.runPromise(
    Command.runWith(command, { renderErrors: false, version: "0" })(args).pipe(
      Output.exitForHelp,
      Effect.provide(BunServices.layer),
      Effect.exit,
    ),
  );
  const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

  return { code: Runtime.getErrorExitCode(error), text: JSON.stringify(error) };
};

describe("generate: integer and number parameters", () => {
  test("an integer or number flag is a numeric flag, per item for an array", async () => {
    const { cliItems } = await generated();

    expect(cliItems).toContain('limit: Input.numericFlag("limit", "integer").pipe(Flag.optional');
    expect(cliItems).toContain('ratio: Input.numericFlag("ratio", "number").pipe(Flag.optional');
    expect(cliItems).toContain('ids: Input.numericFlag("ids", "integer").pipe(Flag.atLeast(0)');
  });

  test("the scalar type is read through the $ref chain, also for array items", async () => {
    const { cliItems } = await generated();

    expect(cliItems).toContain('count: Input.numericFlag("count", "integer").pipe(Flag.optional');
    expect(cliItems).toContain('codes: Input.numericFlag("codes", "integer").pipe(Flag.atLeast(0)');
  });

  test("an integer path parameter is a numeric argument", async () => {
    const { cliItems } = await generated();

    expect(cliItems).toContain('id: Input.numericArgument("id", "integer")');
  });

  test("a type list, an untyped schema and a string keep the string flag", async () => {
    const { cliItems } = await generated();

    expect(cliItems).toContain('maybe: Flag.String("maybe").pipe(Flag.optional');
    expect(cliItems).toContain('free: Flag.String("free").pipe(Flag.optional');
    expect(cliItems).toContain('label: Flag.String("label").pipe(Flag.optional');
  });

  test("the api input stays a string, so the builder sends the text unchanged", async () => {
    const { apiItems, out } = await generated();
    const emitted: unknown = await import(nodePath.join(out, "src/api/items.ts"));
    const builder = Predicate.isObject(emitted) && "list" in emitted ? emitted.list : undefined;
    if (!isBuilder(builder)) {
      throw new Error("the emitted items module has no list builder");
    }

    const request = await Effect.runPromise(
      builder({ id: "7", ids: ["1", "2"], limit: "9007199254740993", ratio: "1.50" }),
    );

    expect(apiItems).toContain("  readonly limit?: string | undefined;");
    expect(request.url).toBe("/items/7?limit=9007199254740993&ratio=1.50&ids=1&ids=2");
  });

  test("--limit abc is exit 2 before any request, naming --limit and never the value", async () => {
    const { code, text } = await parse(["7", "--limit", "abc"]);

    expect(code).toBe(2);
    expect(text).toContain("--limit");
    expect(text).not.toContain("abc");
  });

  test("an integer path argument x is exit 2", async () => {
    const { code, text } = await parse(["x-secret"]);

    expect(code).toBe(2);
    expect(text).not.toContain("x-secret");
  });

  test("--ids 1 --ids x is exit 2", async () => {
    const { code, text } = await parse(["7", "--ids", "1", "--ids", "x-secret"]);

    expect(code).toBe(2);
    expect(text).toContain("--ids");
    expect(text).not.toContain("x-secret");
  });

  test("the emitted package type-checks with the typed flags", async () => {
    const { out } = await generated();

    nodeFs.symlinkSync(nodePath.join(root, "node_modules"), nodePath.join(out, "node_modules"));

    const tsc = nodePath.join(root, "node_modules/.bin/tsc");
    const result = Bun.spawnSync([tsc, "--noEmit", "-p", nodePath.join(out, "tsconfig.json")], {
      cwd: out,
    });

    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
