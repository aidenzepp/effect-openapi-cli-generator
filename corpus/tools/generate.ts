import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Array as Arr, Effect, FileSystem, Path, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Diagnostic } from "../../src/model/diagnostic.ts";
import { GenerationReport } from "../../src/report/index.ts";
import { sha256Hex } from "../../src/write/manifest.ts";

// The generation half of one corpus entry (design 8.2), run as its own process by `run.ts` so the
// memory generation holds is returned to the system before the package build starts: the guarded
// peak is then the larger of generation and build, not their sum. It generates the package, and
// the YAML twin when one is pinned, and writes what the verdict needs from them as JSON.

export const reportFile = "generation-report.json";

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const Target = Schema.Struct({ outDir: Schema.String, specPath: Schema.String });

/**
 * What `run.ts` asks for: the pinned spec (and twin) on disk, the author config, where each
 * package is written, and the file the result goes to.
 */
export const GenerationRequest = Schema.Struct({
  config: Schema.Struct({ document: DocumentUri, path: Schema.String }),
  document: DocumentUri,
  json: Target,
  result: Schema.String,
  twin: Schema.optionalKey(Target),
});

/**
 * What generation leaves for the verdict: the diagnostics, the report's command names and
 * non-standard entries, and the twin comparison; or the refusal, when nothing was written.
 */
export const Generation = Schema.Union([
  Schema.TaggedStruct("Generated", {
    commandNames: GenerationReport.fields.commandNames,
    diagnostics: Schema.Array(Diagnostic),
    nonStandard: GenerationReport.fields.nonStandard,
    twin: Schema.Struct({ checked: Schema.Boolean, differing: Schema.Array(Schema.String) }),
  }),
  Schema.TaggedStruct("Refused", {
    diagnostics: Schema.Array(Diagnostic),
    reason: Schema.Literals(["config", "document", "strict"]),
  }),
]);

export type GenerationValue = typeof Generation.Type;

const encodeGeneration = Schema.encodeEffect(Schema.fromJsonString(Generation));

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(GenerationRequest));

// Every emitted file but the report (which records each input's digest), compared by bytes.
const twinDifferences = (json: string, yaml: string, files: readonly string[]) =>
  Effect.gen(function* compare() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const differing = yield* Effect.forEach(
      files.filter((file) => file !== reportFile),
      (file) =>
        Effect.all([fs.readFile(path.join(json, file)), fs.readFile(path.join(yaml, file))]).pipe(
          Effect.map(([a, b]) => (sha256Hex(a) === sha256Hex(b) ? [] : [file])),
        ),
    );

    return differing.flat();
  });

const generateBoth = (request: typeof GenerationRequest.Type) =>
  Effect.gen(function* generateRun() {
    const { config, document } = request;
    const into = (target: typeof Target.Type) =>
      generate(
        {
          document,
          generator,
          outDir: target.outDir,
          source: { _tag: "File", path: target.specPath },
          strict: false,
        },
        config,
      );
    const generated = yield* into(request.json);
    const twinTarget = request.twin;
    const twin =
      twinTarget === undefined
        ? { checked: false, differing: [] }
        : yield* Effect.gen(function* twinRun() {
            const yaml = yield* into(twinTarget);
            const files = Arr.union(generated.files, yaml.files);

            return {
              checked: true,
              differing: yield* twinDifferences(request.json.outDir, twinTarget.outDir, files),
            };
          });
    const result: GenerationValue = {
      _tag: "Generated",
      commandNames: generated.report.commandNames,
      diagnostics: generated.diagnostics,
      nonStandard: generated.report.nonStandard,
      twin,
    };

    return result;
  });

const main = (raw: string | undefined) =>
  Effect.gen(function* generateMain() {
    const fs = yield* FileSystem.FileSystem;
    const request = yield* decodeRequest(raw);
    const generation = yield* generateBoth(request).pipe(
      Effect.catchTag("GenerateRefused", (refused) =>
        Effect.succeed<GenerationValue>({
          _tag: "Refused",
          diagnostics: refused.diagnostics,
          reason: refused.reason,
        }),
      ),
    );

    yield* fs.writeFileString(request.result, yield* encodeGeneration(generation));
  });

if (import.meta.main) {
  BunRuntime.runMain(main(process.argv[2]).pipe(Effect.provide(BunServices.layer)));
}
