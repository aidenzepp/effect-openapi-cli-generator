import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, Exit, FileSystem, Layer, Order, Path, Schema } from "effect";
import generatorPackage from "../package.json" with { type: "json" };
import generatorTsconfig from "../tsconfig.json" with { type: "json" };
import { generate } from "../src/generate.ts";
import type { GenerateResult } from "../src/generate.ts";
import * as Library from "../src/index.ts";
import { DocumentUri } from "../src/model/brands.ts";
import { GenerationReport, generatorExitStatus } from "../src/report/index.ts";

const root = nodePath.resolve(import.meta.dir, "..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const tsc = nodePath.join(root, "node_modules/.bin/tsc");

const vp = nodePath.join(root, "node_modules/.bin/vp");

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

const decodeRecord = Schema.decodeUnknownSync(JsonRecord);

const readFixture = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const goldenSpec = decodeRecord(JSON.parse(readFixture("openapi.json")));

const goldenConfig = readFixture("author-config.json");

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const decodeReport = Schema.decodeUnknownSync(GenerationReport);

// The golden author config names `./custom/commands.ts`, which the generator never writes: the
// author owns it. The whole-package check supplies it as this fixture file, one `login` command.
const authorCommands = `import { Command } from "effect/cli";\n\nexport const login = Command.make("login");\n`;

interface Run {
  readonly dir: string;
  readonly out: string;
}

interface Options {
  readonly config?: string;
  readonly out?: (dir: string) => string;
  readonly spec?: Schema.Json;
  readonly strict?: boolean;
}

/**
 * Writes the spec and config into a scoped temp directory, runs `generate` into `<dir>/out` and
 * hands the exit and the directory to `inspect` before the scope removes it.
 */
const run = <A>(
  options: Options,
  inspect: (
    exit: Exit.Exit<GenerateResult, unknown>,
    at: Run,
  ) => Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* prepare() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gn1-" });
        const specPath = path.join(dir, "openapi.json");
        const configPath = path.join(dir, "author-config.json");
        const out = options.out === undefined ? path.join(dir, "out") : options.out(dir);
        yield* fs.writeFileString(specPath, JSON.stringify(options.spec ?? goldenSpec));
        yield* fs.writeFileString(configPath, options.config ?? goldenConfig);

        const exit = yield* Effect.exit(
          generate(
            {
              document,
              generator,
              outDir: out,
              source: { _tag: "File", path: specPath },
              strict: options.strict ?? false,
            },
            { document: configDocument, path: configPath },
          ),
        );

        return yield* inspect(exit, { dir, out });
      }),
    ).pipe(Effect.provide(layer)),
  );

const readOut = (out: string, relative: string) =>
  Effect.gen(function* read() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(out, ...relative.split("/"));

    return (yield* fs.exists(target)) ? yield* fs.readFileString(target) : undefined;
  });

const exists = (target: string) =>
  Effect.gen(function* check() {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.exists(target);
  });

const succeeded = (exit: Exit.Exit<GenerateResult, unknown>): GenerateResult => {
  if (Exit.isFailure(exit)) {
    throw new Error(`generate failed: ${String(exit.cause)}`);
  }

  return exit.value;
};

const RunFailure = Schema.Struct({
  _tag: Schema.String,
  diagnostics: Schema.optionalKey(Schema.Array(Schema.Struct({ code: Schema.String }))),
  reason: Schema.optionalKey(Schema.String),
});

const decodeFailure = Schema.decodeUnknownSync(RunFailure);

const failureOf = (exit: Exit.Exit<GenerateResult, unknown>): typeof RunFailure.Type =>
  decodeFailure(
    Exit.isFailure(exit)
      ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
      : undefined,
  );

const paths = decodeRecord(goldenSpec.paths);

// The golden spec plus one operation whose only request body is `text/event-stream`.
const withTextBody: Schema.Json = {
  ...goldenSpec,
  paths: {
    ...paths,
    "/notes": {
      post: {
        operationId: "notes-create",
        requestBody: {
          content: { "text/event-stream": { schema: { type: "string" } } },
          required: true,
        },
        responses: { "204": { description: "Stored." } },
        tags: ["notes"],
      },
    },
  },
};

// The golden spec plus one operation whose path template names a parameter it does not declare.
const withMissingParameter: Schema.Json = {
  ...goldenSpec,
  paths: {
    ...paths,
    "/teams/{teamId}": {
      get: {
        operationId: "teams-get",
        responses: { "204": { description: "Found." } },
        tags: ["teams"],
      },
    },
  },
};

// The golden spec with the avatar operation reusing the update operation's operationId.
const withDuplicateId: Schema.Json = {
  ...goldenSpec,
  paths: {
    ...paths,
    "/users/{id}/avatar": {
      put: {
        ...decodeRecord(decodeRecord(paths["/users/{id}/avatar"]).put),
        operationId: "users-update",
      },
    },
  },
};

const decoder = new TextDecoder();

const encoder = new TextEncoder();

// `vp fmt --stdin-filepath` applies the repository's formatter config: output equal to input is a
// passing `vp fmt --check`.
const formats = (relative: string, content: string): boolean => {
  const result = Bun.spawnSync([vp, "fmt", `--stdin-filepath=tests/generated/${relative}`], {
    cwd: root,
    stdin: encoder.encode(content),
  });

  return result.exitCode === 0 && decoder.decode(result.stdout) === content;
};

describe("generate", () => {
  test("the golden spec writes the expected api/ and cli/ files", async () => {
    const written = await run({}, (exit, { out }) =>
      Effect.all({
        apiServers: readOut(out, "src/api/servers.ts"),
        apiUsers: readOut(out, "src/api/users.ts"),
        cliUsers: readOut(out, "src/cli/users.ts"),
        report: readOut(out, "generation-report.json"),
        result: Effect.succeed(succeeded(exit)),
      }),
    );

    expect(written.apiUsers).toBe(readFixture("expected/src/api/users.ts"));
    expect(written.apiServers).toBe(readFixture("expected/src/api/servers.ts"));
    expect(written.cliUsers).toBe(readFixture("expected/src/cli/users.ts"));
    expect(written.result.files).toContain("generation-report.json");
    expect(written.result.files).toContain("src/domain/schemas.ts");
    expect(written.result.report.refusals).toEqual([]);

    const report = decodeReport(JSON.parse(written.report ?? ""));
    expect(report.generator.version).toBe(generatorPackage.version);
    expect(report.inputs.map((input) => input.document)).toEqual([document, configDocument]);
    expect(report.refusals).toEqual([]);
    expect(Object.keys(decodeRecord(JSON.parse(written.report ?? "{}")))).not.toContain(
      "timestamp",
    );
    expect(
      generatorExitStatus({
        _tag: "Written",
        diagnostics: written.result.diagnostics,
        strict: false,
      }),
    ).toBe(0);
  });

  test("the golden package type-checks and every written file passes vp fmt", async () => {
    const checked = await run({}, (exit, { out }) =>
      Effect.gen(function* check() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { files } = succeeded(exit);
        const contents = yield* Effect.all(
          files.map((file) =>
            readOut(out, file).pipe(Effect.map((content) => [file, content ?? ""] as const)),
          ),
        );
        yield* fs.makeDirectory(path.join(out, "custom"));
        yield* fs.writeFileString(path.join(out, "custom", "commands.ts"), authorCommands);
        yield* fs.symlink(path.join(root, "node_modules"), path.join(out, "node_modules"));

        const result = Bun.spawnSync([tsc, "--noEmit", "-p", path.join(out, "tsconfig.json")], {
          cwd: out,
        });

        return {
          tsc: { exitCode: result.exitCode, stdout: decoder.decode(result.stdout) },
          unformatted: contents
            .filter(([file, content]) => !formats(file, content))
            .map(([file]) => file),
        };
      }),
    );

    expect(checked.tsc.stdout).toBe("");
    expect(checked.tsc.exitCode).toBe(0);
    expect(checked.unformatted).toEqual([]);
  }, 180_000);

  test("a document-level refusal writes nothing", async () => {
    const observed = await run({ spec: withDuplicateId }, (exit, { out }) =>
      exists(out).pipe(Effect.map((written) => ({ error: failureOf(exit), written }))),
    );

    expect(observed.error._tag).toBe("GenerateRefused");
    expect(observed.error.reason).toBe("document");
    expect(observed.error.diagnostics?.map((diagnostic) => diagnostic.code)).toContain(
      "OPR-07/duplicate-id",
    );
    expect(observed.written).toBe(false);
  });

  test("an operation-scope refusal writes the rest and reports it", async () => {
    const observed = await run({ spec: withMissingParameter }, (exit, { out }) =>
      Effect.all({
        cliTeams: readOut(out, "src/cli/teams.ts"),
        cliUsers: readOut(out, "src/cli/users.ts"),
        report: readOut(out, "generation-report.json"),
        result: Effect.succeed(succeeded(exit)),
      }),
    );
    const report = decodeReport(JSON.parse(observed.report ?? ""));
    const refusal = report.refusals.find((entry) => entry.code === "PTH-03/missing-parameter");

    expect(refusal?.scope).toBe("operation");
    expect(refusal?.operation).toEqual({
      method: "GET",
      operationId: "teams-get",
      path: "/teams/{teamId}",
    });
    expect(observed.cliTeams).toBeUndefined();
    expect(observed.cliUsers).toBe(readFixture("expected/src/cli/users.ts"));
    expect(
      generatorExitStatus({
        _tag: "Written",
        diagnostics: observed.result.diagnostics,
        strict: false,
      }),
    ).toBe(0);
  });

  test("a text/event-stream request body is refused as EMT-1/unsupported-body; the rest is written", async () => {
    const observed = await run({ spec: withTextBody }, (exit, { out }) =>
      Effect.all({
        cliNotes: readOut(out, "src/cli/notes.ts"),
        cliUsers: readOut(out, "src/cli/users.ts"),
        report: readOut(out, "generation-report.json"),
        result: Effect.succeed(succeeded(exit)),
      }),
    );
    const report = decodeReport(JSON.parse(observed.report ?? ""));
    const refusals = report.refusals.filter((entry) => entry.row === "EMT-1");

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      code: "EMT-1/unsupported-body",
      document,
      element: "Emitted command",
      operation: { method: "POST", operationId: "notes-create", path: "/notes" },
      pointer: "/paths/~1notes/post",
      row: "EMT-1",
      scope: "operation",
      severity: "refusal",
      specSection: "https://spec.openapis.org/oas/v3.1.2.html#operation-object",
    });
    expect(observed.cliNotes).toBeUndefined();
    expect(observed.cliUsers).toBe(readFixture("expected/src/cli/users.ts"));
    expect(observed.result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "EMT-1/unsupported-body",
    );
  });

  test("--strict makes the EMT-1 refusal fatal and writes nothing", async () => {
    const observed = await run({ spec: withTextBody, strict: true }, (exit, { out }) =>
      exists(out).pipe(Effect.map((written) => ({ error: failureOf(exit), written }))),
    );

    expect(observed.error._tag).toBe("GenerateRefused");
    expect(observed.error.reason).toBe("strict");
    expect(observed.error.diagnostics?.map((diagnostic) => diagnostic.code)).toContain(
      "EMT-1/unsupported-body",
    );
    expect(observed.written).toBe(false);
  });

  test("an undecodable author config writes nothing", async () => {
    const observed = await run({ config: "{}" }, (exit, { out }) =>
      exists(out).pipe(Effect.map((written) => ({ error: failureOf(exit), written }))),
    );

    expect(observed.error._tag).toBe("GenerateRefused");
    expect(observed.error.reason).toBe("config");
    expect(observed.written).toBe(false);
  });

  test("an unreadable spec is a document refusal", async () => {
    const observed = await run({}, (_exit, { dir, out }) =>
      Effect.gen(function* rerun() {
        const path = yield* Path.Path;
        const exit = yield* Effect.exit(
          generate(
            {
              document,
              generator,
              outDir: out,
              source: { _tag: "File", path: path.join(dir, "absent.json") },
              strict: false,
            },
            { document: configDocument, path: path.join(dir, "author-config.json") },
          ),
        );

        return { error: failureOf(exit), written: yield* exists(out) };
      }),
    );

    expect(observed.error._tag).toBe("GenerateRefused");
    expect(observed.error.reason).toBe("document");
    expect(observed.error.diagnostics?.map((diagnostic) => diagnostic.code)).toEqual([
      "DOC-14/unreadable",
    ]);
  });

  test("a missing output parent fails before writing", async () => {
    const observed = await run(
      { out: (dir) => nodePath.join(dir, "missing", "out") },
      (exit, { dir }) =>
        exists(nodePath.join(dir, "missing")).pipe(
          Effect.map((written) => ({ error: failureOf(exit), written })),
        ),
    );

    expect(observed.error._tag).toBe("WriteRefused");
    expect(observed.error.reason).toBe("output-parent-missing");
    expect(observed.written).toBe(false);
  });

  test("src/index.ts exports generate and its refusal, and runs nothing on import", () => {
    expect(Arr.sort(Object.keys(Library), Order.String)).toEqual(["GenerateRefused", "generate"]);
    expect(Library.generate).toBe(generate);
  });
});
