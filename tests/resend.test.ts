import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, FileSystem, Layer, Order, Path, Schema } from "effect";
import { Corpus } from "../corpus/tools/fetch.ts";
import generatorPackage from "../package.json" with { type: "json" };
import generatorTsconfig from "../tsconfig.json" with { type: "json" };
import { generate } from "../src/generate.ts";
import { DocumentUri } from "../src/model/brands.ts";
import { GenerationReport } from "../src/report/index.ts";
import { Description } from "../src/runtime-src/runtime/describe.ts";
import { sha256Hex } from "../src/write/manifest.ts";
import { pinnedSpec } from "./support/pinned-spec.ts";
import { generateFixture, preparePackage, runBin } from "./support/generated-cli.ts";
import type { GeneratedPackage } from "./support/generated-cli.ts";

// The Milestone 1 witness (CP-4): the pinned Resend spec generates a package that passes the
// static proof, builds and runs, and whose commands plus refusals account for every operation.

const root = nodePath.resolve(import.meta.dir, "..");

const memguard = nodePath.join(root, "tools/memguard.sh");

const ceilingMib = process.env.MEMGUARD_MIB ?? "4096";

const vp = nodePath.join(root, "node_modules/.bin/vp");

const { spec: specPath, twin: pinnedTwin } = await pinnedSpec("resend");

const twinPath = pinnedTwin ?? "";

const configPath = nodePath.join(root, "corpus/config/resend.json");

const reportFile = "generation-report.json";

const methods = ["delete", "get", "head", "options", "patch", "post", "put", "trace"] as const;

const SpecOperation = Schema.Struct({ operationId: Schema.String });

const PathItem = Schema.Struct({
  delete: Schema.optionalKey(SpecOperation),
  get: Schema.optionalKey(SpecOperation),
  head: Schema.optionalKey(SpecOperation),
  options: Schema.optionalKey(SpecOperation),
  patch: Schema.optionalKey(SpecOperation),
  post: Schema.optionalKey(SpecOperation),
  put: Schema.optionalKey(SpecOperation),
  trace: Schema.optionalKey(SpecOperation),
});

const Spec = Schema.Struct({ paths: Schema.Record(Schema.String, PathItem) });

const OperationIdsFile = Schema.Struct({
  operationIds: Schema.Array(Schema.String),
  source: Schema.String,
  specSha256: Schema.String,
});

const readJson = <A, I>(file: string, schema: Schema.Codec<A, I>): A =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(nodeFs.readFileSync(file, "utf-8"));

const fixture = readJson(
  nodePath.join(root, "tests/fixtures/seeds/resend-operation-ids.json"),
  OperationIdsFile,
);

const resend = readJson(nodePath.join(root, "corpus/corpus.json"), Corpus).specs.find(
  (entry) => entry.id === "resend",
);

// RFC 6901: `~` before `/`, so an escaped `/` is never read back as `~1`.
const escapeToken = (token: string): string => token.replaceAll("~", "~0").replaceAll("/", "~1");

// Every operation of the pinned spec, keyed by the pointer `--describe` reports for its command.
const specOperations = Object.entries(readJson(specPath, Spec).paths).flatMap(([path, item]) =>
  methods.flatMap((method) => {
    const operation = item[method];

    return operation === undefined
      ? []
      : [{ operationId: operation.operationId, pointer: `/paths/${escapeToken(path)}/${method}` }];
  }),
);

const sorted = (values: readonly string[]): readonly string[] => Arr.sort(values, Order.String);

const decoder = new TextDecoder();

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(GenerationReport));

const decodeDescription = Schema.decodeUnknownEffect(Schema.fromJsonString(Description));

// The repository's own `vp`, run from the repository root so its formatter and lint config apply,
// under the memory ceiling. Exit status 0 is a pass.
const vpCheck = (args: readonly string[]): Effect.Effect<number | null> =>
  Effect.suspend(() => {
    const result = Bun.spawnSync([memguard, ceilingMib, "--", vp, ...args], {
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });

    return result.exitCode === 0
      ? Effect.succeed(result.exitCode)
      : Effect.logError(decoder.decode(result.stdout), decoder.decode(result.stderr)).pipe(
          Effect.as(result.exitCode),
        );
  });

// Lint needs the installed dependencies for its type-aware rules; `src` keeps `node_modules` out.
const builtProof = (generated: GeneratedPackage) =>
  Effect.gen(function* built() {
    const lint = yield* vpCheck(["lint", "--type-aware", nodePath.join(generated.dir, "src")]);
    const help = yield* runBin(generated, { args: ["--help"], timeoutMs: 30_000 });
    const describeRun = yield* runBin(generated, { args: ["--describe"], timeoutMs: 30_000 });
    const description = yield* decodeDescription(decoder.decode(describeRun.stdout));

    return {
      commands: description.commands,
      help: { exitCode: help.exitCode, printed: help.stdout.length > 0 },
      lint,
    };
  });

const witness = Effect.gen(function* run() {
  const fs = yield* FileSystem.FileSystem;
  const generated = yield* generateFixture({ configPath, specPath });
  const report = yield* fs
    .readFileString(nodePath.join(generated.dir, reportFile))
    .pipe(Effect.flatMap(decodeReport));
  // Formatting runs before the install, so the whole package is checked and no dependency is.
  const fmt = yield* vpCheck(["fmt", "--check", generated.dir]);
  // A failed step names itself (`typecheck`, `build`) in the comparison and logs its output.
  const prepared = yield* preparePackage(generated).pipe(
    Effect.as("ok"),
    Effect.catchTag("GeneratedCliStepFailed", (failure) =>
      Effect.logError(decoder.decode(failure.stdout), decoder.decode(failure.stderr)).pipe(
        Effect.as(`${failure.step} failed`),
      ),
    ),
  );
  if (prepared !== "ok") {
    return { built: undefined, fmt, prepared, report };
  }

  const built = yield* builtProof(generated);

  return { built, fmt, prepared: "ok", report };
});

// One run of `generate` into a scoped temp directory, naming the spec by `document`.
const generateInto = (source: string, document: typeof DocumentUri.Type) =>
  Effect.gen(function* run() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "resend-twin-" }), "out");
    const result = yield* generate(
      { document, generator, outDir: dir, source: { _tag: "File", path: source }, strict: false },
      {
        document: Schema.decodeUnknownSync(DocumentUri)("file:///fixture/resend-config.json"),
        path: configPath,
      },
    );

    return { dir, files: result.files };
  });

describe("Resend witness", () => {
  test("the pins agree: fixture, corpus manifest and the cached JSON and YAML bytes", () => {
    expect(resend).toBeDefined();
    expect(fixture.specSha256).toBe(resend?.sha256 ?? "");
    expect(sha256Hex(nodeFs.readFileSync(specPath))).toBe(fixture.specSha256);
    expect(sha256Hex(nodeFs.readFileSync(twinPath))).toBe(resend?.twin?.sha256 ?? "");
    // A pin move changes the spec's operations and fails here until the fixture follows (E13).
    expect(sorted(specOperations.map((operation) => operation.operationId))).toEqual(
      fixture.operationIds,
    );
  });

  test("the package passes fmt, lint and tsc, builds, runs --help, and covers every operation", async () => {
    const observed = await Effect.runPromise(Effect.scoped(witness).pipe(Effect.provide(layer)));

    expect({
      fmt: observed.fmt,
      help: observed.built?.help,
      lint: observed.built?.lint,
      prepared: observed.prepared,
    }).toEqual({ fmt: 0, help: { exitCode: 0, printed: true }, lint: 0, prepared: "ok" });

    const byPointer = new Map(
      specOperations.map((operation) => [operation.pointer, operation.operationId]),
    );
    // A command bound to a pointer the spec does not have is an invented command; it stays
    // visible in the comparison under its pointer.
    const commandIds = (observed.built?.commands ?? []).map(
      (command) => byPointer.get(command.pointer) ?? command.pointer,
    );
    const refusedIds = Arr.dedupe(
      observed.report.refusals.flatMap((diagnostic) =>
        diagnostic.scope === "operation" ? [diagnostic.operation?.operationId ?? "(no id)"] : [],
      ),
    );

    // No dedupe across the two: an operation both generated and refused appears twice and fails.
    expect(sorted([...commandIds, ...refusedIds])).toEqual(fixture.operationIds);
  }, 600_000);

  test("the YAML twin generates a byte-identical package", async () => {
    const document = Schema.decodeUnknownSync(DocumentUri)("file:///fixture/resend.json");
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* twins() {
          const fs = yield* FileSystem.FileSystem;
          const json = yield* generateInto(specPath, document);
          const yaml = yield* generateInto(twinPath, document);
          // The report records each input's digest and diagnostic lines, which differ by format.
          const packageFiles = json.files.filter((file) => file !== reportFile);
          const differing = yield* Effect.all(
            packageFiles.map((file) =>
              Effect.all([
                fs.readFile(nodePath.join(json.dir, file)),
                fs.readFile(nodePath.join(yaml.dir, file)),
              ]).pipe(Effect.map(([a, b]) => (sha256Hex(a) === sha256Hex(b) ? [] : [file]))),
            ),
          ).pipe(Effect.map((lists) => lists.flat()));

          return { differing, jsonFiles: json.files, yamlFiles: yaml.files };
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(observed.yamlFiles).toEqual(observed.jsonFiles);
    expect(observed.jsonFiles).toContain("src/cli/root.ts");
    expect(observed.differing).toEqual([]);
  }, 300_000);
});
