import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Layer, Path, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import {
  GenerationReport,
  SkippedOperation,
  makeGenerationReport,
  printGenerationReport,
} from "../../src/report/index.ts";
import type { GenerationReportInput } from "../../src/report/index.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const scratch = nodePath.join(root, "work/skipped");

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const update = "/paths/~1users~1{id}/patch";

const setAvatar = "/paths/~1users~1{id}~1avatar/put";

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(GenerationReport));

const decodeSkipped = Schema.decodeUnknownSync(SkippedOperation);

const skippedAt = (pointer: string, operationId?: string) =>
  decodeSkipped(
    operationId === undefined
      ? { document, pointer, reason: "config-skip" }
      : { document, operationId, pointer, reason: "config-skip" },
  );

const bareInput: GenerationReportInput = {
  acceptedServers: [],
  diagnostics: [],
  inputs: [],
  renames: [],
  version: "0.1.0",
};

const reportOf = (input: GenerationReportInput) =>
  decodeReport(Effect.runSync(printGenerationReport(makeGenerationReport(input))));

// The golden config with `users-set-avatar` skipped.
const skippingConfig = (): string => {
  const config: unknown = JSON.parse(
    nodeFs.readFileSync(nodePath.join(fixture, "author-config.json"), "utf-8"),
  );
  const golden = Schema.decodeUnknownSync(
    Schema.Struct({
      naming: Schema.Struct({ operations: Schema.Record(Schema.String, Schema.Json) }),
    }),
  )(config);

  return JSON.stringify({
    ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(config),
    naming: {
      ...golden.naming,
      operations: { ...golden.naming.operations, "users-set-avatar": { skip: true } },
    },
  });
};

// Generates the golden spec under `config` into a scoped directory below `work/`.
const generateWith = (config: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* run() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(scratch, { recursive: true });

        const dir = yield* fs.makeTempDirectoryScoped({ directory: scratch, prefix: "skip-" });
        const configPath = path.join(dir, "author-config.json");
        yield* fs.writeFileString(configPath, config);

        const exit = yield* Effect.exit(
          generate(
            {
              document,
              generator: {
                packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
                tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
              },
              outDir: path.join(dir, "out"),
              source: { _tag: "File", path: nodePath.join(fixture, "openapi.json") },
              strict: false,
            },
            { document: configDocument, path: configPath },
          ),
        );

        if (Exit.isFailure(exit)) {
          return yield* Effect.die(`generate failed: ${String(exit.cause)}`);
        }

        return decodeReport(yield* fs.readFileString(path.join(dir, "out/generation-report.json")));
      }),
    ).pipe(Effect.provide(layer)),
  );

describe("author-skipped operations in the generation report", () => {
  test("skipped is always present, empty when nothing was skipped", () => {
    expect(reportOf(bareInput).skipped).toEqual([]);
  });

  test("each skipped operation keeps its document, pointer, operationId and reason", () => {
    const entries = [skippedAt(update, "users-update"), skippedAt(setAvatar)];

    expect(reportOf({ ...bareInput, skipped: entries }).skipped).toEqual(entries);
  });

  test("a generation run records the operation the author config skips, and emits no command for it", async () => {
    const report = await generateWith(skippingConfig());
    const pointers: readonly string[] = report.commandNames.map((name) => name.pointer);

    expect(report.skipped).toEqual([skippedAt(setAvatar, "users-set-avatar")]);
    expect(pointers).toEqual([update]);
  });

  test("a generation run without a skip records none", async () => {
    const config = nodeFs.readFileSync(nodePath.join(fixture, "author-config.json"), "utf-8");

    const report = await generateWith(config);

    expect(report.skipped).toEqual([]);
  });
});
