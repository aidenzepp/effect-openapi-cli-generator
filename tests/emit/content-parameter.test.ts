import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Layer, Path, Predicate, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import type { GenerateResult } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { GenerationReport } from "../../src/report/index.ts";

// A `content` parameter in `query`, `header` or `cookie` is serialized by its one media type
// (PRM-15, PRM-23, PRM-24). Path content, and form-urlencoded content outside `querystring`, have
// no builder: each operation is refused alone (`EMT-1/unsupported-parameter`), never the run.

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

const noContent = { "204": { description: "Done." } };

// The golden spec plus three operations: one with JSON query, text header and text cookie content,
// one with path content and one with form-urlencoded query content.
const withContent: Schema.Json = {
  ...goldenSpec,
  paths: {
    ...decodeRecord(goldenSpec.paths),
    "/notes": {
      get: {
        operationId: "notes-list",
        parameters: [
          {
            content: { "application/json": { schema: { type: "object" } } },
            in: "query",
            name: "coordinates",
            required: true,
          },
          {
            content: { "text/plain": { schema: { type: "string" } } },
            in: "header",
            name: "X-Trace",
          },
          { content: { "text/plain": { schema: { type: "string" } } }, in: "cookie", name: "c" },
        ],
        responses: noContent,
        tags: ["notes"],
      },
      put: {
        operationId: "notes-search",
        parameters: [
          {
            content: { "application/x-www-form-urlencoded": { schema: { type: "object" } } },
            in: "query",
            name: "filter",
          },
        ],
        responses: noContent,
        tags: ["notes"],
      },
    },
    "/notes/{id}": {
      get: {
        operationId: "notes-read",
        parameters: [
          {
            content: { "application/json": { schema: { type: "object" } } },
            in: "path",
            name: "id",
            required: true,
          },
        ],
        responses: noContent,
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
  readonly out: string;
  readonly report: string | undefined;
  readonly written: boolean;
}

// Generated packages live under the worktree's git-ignored `work/`, so an emitted module resolves
// `effect` from the generator's own `node_modules`.
const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "content-parameter-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

// Generates the spec into its own directory under `work` and reads what was written.
const run = (strict: boolean): Promise<Observed> =>
  Effect.runPromise(
    Effect.gen(function* prepare() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(work, strict ? "strict" : "lenient");
      yield* fs.makeDirectory(dir, { recursive: true });

      const specPath = path.join(dir, "openapi.json");
      const configPath = path.join(dir, "author-config.json");
      const out = path.join(dir, "out");
      yield* fs.writeFileString(specPath, JSON.stringify(withContent));
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
        out,
        report: yield* read("generation-report.json"),
        written: yield* fs.exists(out),
      };
    }).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  );

const RunFailure = Schema.Struct({
  _tag: Schema.String,
  diagnostics: Schema.Array(Schema.Struct({ code: Schema.String })),
  reason: Schema.String,
});

let lenient: Promise<Observed> | undefined;

const generated = async (): Promise<Observed> => {
  lenient ??= run(false);
  const observed = await lenient;
  if (Exit.isFailure(observed.exit)) {
    throw new Error(`generate failed: ${String(observed.exit.cause)}`);
  }

  return observed;
};

interface BuiltRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

interface ListInput {
  readonly c: string;
  readonly coordinates: { readonly lat: number };
  readonly xTrace: string;
}

type Builder = (input: ListInput) => Effect.Effect<BuiltRequest, unknown>;

const isBuilder = (value: unknown): value is Builder => Predicate.isFunction(value);

describe("generate: content parameters in query, header and cookie", () => {
  test("builds each with its location's content constructor and media type", async () => {
    const { apiNotes } = await generated();

    expect(apiNotes).toContain(
      'Serialize.queryContent("coordinates", "application/json", input.coordinates, {',
    );
    expect(apiNotes).toContain(
      'Serialize.headerContent("X-Trace", "text/plain", input.xTrace, { required: false })',
    );
    expect(apiNotes).toContain(
      'Serialize.cookieContent("c", "text/plain", input.c, { required: false })',
    );
    expect(apiNotes).toContain("  readonly coordinates: Serialize.Json;");
    expect(apiNotes).toContain("  readonly xTrace?: Serialize.Json | undefined;");
  });

  test("the built request carries the query, header and cookie values", async () => {
    const { out } = await generated();
    const emitted: unknown = await import(nodePath.join(out, "src/api/notes.ts"));
    const builder = Predicate.isObject(emitted) && "list" in emitted ? emitted.list : undefined;
    expect(isBuilder(builder)).toBe(true);
    if (!isBuilder(builder)) {
      return;
    }

    const request = await Effect.runPromise(
      builder({ c: "v", coordinates: { lat: 1 }, xTrace: "trace-1" }),
    );

    expect(request.url).toBe("/notes?coordinates=%7B%22lat%22%3A1%7D");
    expect(request.headers["x-trace"]).toBe("trace-1");
    expect(request.headers.cookie).toBe("c=v");
  });

  test("a JSON content flag is decoded as JSON, any other media is a string flag", async () => {
    const { cliNotes } = await generated();

    expect(cliNotes).toContain('coordinates: Input.jsonFlag("coordinates")');
    expect(cliNotes).toContain('xTrace: Flag.String("x-trace").pipe(Flag.optional');
    expect(cliNotes).toContain('c: Flag.String("c").pipe(Flag.optional');
  });

  test("a JSON content flag is named json in help, as an object parameter's is (W1)", async () => {
    const { cliNotes } = await generated();

    expect(cliNotes).toContain(
      'coordinates: Input.jsonFlag("coordinates").pipe(Flag.withMetavar("json"))',
    );
    expect(cliNotes).not.toContain('Flag.String("x-trace").pipe(Flag.withMetavar');
  });
});

describe("generate: path content and form content outside querystring", () => {
  test("refuse each operation as EMT-1/unsupported-parameter and write the rest", async () => {
    const observed = await generated();
    const report = decodeReport(JSON.parse(observed.report ?? ""));
    const refusals = report.refusals.filter((entry) => entry.row === "EMT-1");
    const byOperation = (operationId: string) =>
      refusals.find((entry) => entry.operation?.operationId === operationId);

    expect(refusals).toHaveLength(2);
    for (const refusal of refusals) {
      expect(Object.keys(refusal)).not.toContain("hint");
    }

    expect(byOperation("notes-read")).toMatchObject({
      code: "EMT-1/unsupported-parameter",
      operation: { method: "GET", operationId: "notes-read", path: "/notes/{id}" },
      pointer: "/paths/~1notes~1{id}/get",
      scope: "operation",
      severity: "refusal",
    });
    expect(byOperation("notes-read")?.message).toContain('"path:id"');
    expect(byOperation("notes-search")).toMatchObject({
      code: "EMT-1/unsupported-parameter",
      operation: { method: "PUT", operationId: "notes-search", path: "/notes" },
      scope: "operation",
    });
    expect(byOperation("notes-search")?.message).toContain('"query:filter"');
    expect(observed.apiNotes).not.toContain("export const read ");
    expect(observed.apiNotes).not.toContain("export const search ");
    expect(observed.cliUsers).toBe(readFixture("expected/src/cli/users.ts"));
  });

  test("--strict makes the refusals fatal and writes nothing", async () => {
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
