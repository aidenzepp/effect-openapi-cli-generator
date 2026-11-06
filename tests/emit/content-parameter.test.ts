import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Layer, Path, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import type { GenerateResult } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { GenerationReport } from "../../src/report/index.ts";

// A parameter outside `in: querystring` that declares `content` instead of `schema` has no `api/`
// builder yet. Its operation is refused alone (`EMT-1/unsupported-parameter`), never the run.

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

const decodeReport = Schema.decodeUnknownSync(GenerationReport);

// The golden spec plus one operation with a header parameter that declares `content`.
const withContentHeader: Schema.Json = {
  ...goldenSpec,
  paths: {
    ...decodeRecord(goldenSpec.paths),
    "/notes": {
      get: {
        operationId: "notes-list",
        parameters: [
          {
            content: { "application/json": { schema: { type: "object" } } },
            in: "header",
            name: "X-Filter",
          },
        ],
        responses: { "204": { description: "Listed." } },
        tags: ["notes"],
      },
    },
  },
};

interface Observed {
  readonly apiNotes: string | undefined;
  readonly cliNotes: string | undefined;
  readonly cliUsers: string | undefined;
  readonly exit: Exit.Exit<GenerateResult, unknown>;
  readonly report: string | undefined;
  readonly written: boolean;
}

// Generates the spec into a scoped temp directory and reads what was written before removal.
const run = (strict: boolean): Promise<Observed> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* prepare() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cp-" });
        const specPath = path.join(dir, "openapi.json");
        const configPath = path.join(dir, "author-config.json");
        const out = path.join(dir, "out");
        yield* fs.writeFileString(specPath, JSON.stringify(withContentHeader));
        yield* fs.writeFileString(configPath, goldenConfig);

        const exit = yield* Effect.exit(
          generate(
            { document, generator, outDir: out, source: { _tag: "File", path: specPath }, strict },
            { document: configDocument, path: configPath },
          ),
        );
        const read = (relative: string) =>
          Effect.gen(function* readOut() {
            const target = path.join(out, ...relative.split("/"));

            return (yield* fs.exists(target)) ? yield* fs.readFileString(target) : undefined;
          });

        return {
          apiNotes: yield* read("src/api/notes.ts"),
          cliNotes: yield* read("src/cli/notes.ts"),
          cliUsers: yield* read("src/cli/users.ts"),
          exit,
          report: yield* read("generation-report.json"),
          written: yield* fs.exists(out),
        };
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  );

const RunFailure = Schema.Struct({
  _tag: Schema.String,
  diagnostics: Schema.Array(Schema.Struct({ code: Schema.String })),
  reason: Schema.String,
});

describe("generate: a content-based parameter", () => {
  test("refuses its operation as EMT-1/unsupported-parameter and writes the rest", async () => {
    const observed = await run(false);
    if (Exit.isFailure(observed.exit)) {
      throw new Error(`generate failed: ${String(observed.exit.cause)}`);
    }

    const report = decodeReport(JSON.parse(observed.report ?? ""));
    const refusals = report.refusals.filter((entry) => entry.row === "EMT-1");

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      code: "EMT-1/unsupported-parameter",
      operation: { method: "GET", operationId: "notes-list", path: "/notes" },
      pointer: "/paths/~1notes/get",
      scope: "operation",
      severity: "refusal",
    });
    expect(refusals[0]?.message).toContain('"header:X-Filter"');
    expect(observed.apiNotes).toBeUndefined();
    expect(observed.cliNotes).toBeUndefined();
    expect(observed.cliUsers).toBe(readFixture("expected/src/cli/users.ts"));
  });

  test("--strict makes the refusal fatal and writes nothing", async () => {
    const observed = await run(true);
    const failure = Schema.decodeUnknownSync(RunFailure)(
      Exit.isFailure(observed.exit)
        ? observed.exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
        : undefined,
    );

    expect(failure._tag).toBe("GenerateRefused");
    expect(failure.reason).toBe("strict");
    expect(failure.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "EMT-1/unsupported-parameter",
    );
    expect(observed.written).toBe(false);
  });
});
