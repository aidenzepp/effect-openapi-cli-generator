import { Effect, Schema } from "effect";
import { printJson } from "../emit/printer.ts";
import { DocumentUri, JsonLiteral, JsonPointer } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import type { SecurityScheme } from "../model/entities.ts";

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)));

// Where a command's group or command name came from (design 8.1, D-NAME4); `none` is a root
// command's group.
const NameSource = Schema.Literals([
  "config",
  "none",
  "operationId",
  "route",
  "tag",
  "x-fern",
  "x-forge",
]);

/**
 * One emitted command (design 8.1 `commandNames`): its visible path (group names, then the
 * command), the operation's use site, the source of each name, and for an alias command its index
 * in the author-config `aliases` or else in `x-forge-aliases`.
 */
export const CommandName = Schema.Struct({
  alias: Schema.optionalKey(Schema.Int),
  command: NameSource,
  document: DocumentUri,
  group: NameSource,
  path: Schema.Array(Schema.String),
  pointer: JsonPointer,
});

/**
 * `generation-report.json` (design 8.1, 3.7): what one run refused, noticed, renamed and accepted,
 * and the digests of its inputs. There is no timestamp, so equal inputs give equal bytes. Fields
 * are alphabetical; the order that matters is carried by arrays.
 */
export const GenerationReport = Schema.Struct({
  acceptedServers: Schema.Array(Schema.String),
  // Present only when the author config added a scheme (D-OQ3 (b)): the scheme and the key that
  // added it.
  authorSuppliedSchemes: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, name: Schema.String })),
  ),
  commandNames: Schema.Array(CommandName),
  generator: Schema.Struct({ version: Schema.String }),
  inputs: Schema.Array(Schema.Struct({ document: DocumentUri, sha256: Sha256 })),
  notices: Schema.Array(Diagnostic),
  refusals: Schema.Array(Diagnostic),
  renames: Schema.Array(
    Schema.Struct({ from: Schema.String, pointer: JsonPointer, to: Schema.String }),
  ),
});

export type GenerationReportValue = typeof GenerationReport.Type;

/**
 * What one run knows. `diagnostics` arrive already in diagnostic order (design 3.7), `inputs` in
 * document order and `commandNames` in command order; the report keeps each order.
 */
export interface GenerationReportInput {
  readonly acceptedServers: GenerationReportValue["acceptedServers"];
  // The emitted commands in command order; absent, the run emitted none.
  readonly commandNames?: GenerationReportValue["commandNames"];
  readonly diagnostics: readonly Diagnostic[];
  readonly inputs: GenerationReportValue["inputs"];
  readonly renames: GenerationReportValue["renames"];
  readonly schemes?: readonly SecurityScheme[];
  readonly version: string;
}

/**
 * How a generator run ended, as far as the exit status is concerned: output was written (with
 * these diagnostics, under `--strict` or not), or another run holds the output directory's lock.
 */
export type GeneratorOutcome =
  | {
      readonly _tag: "Written";
      readonly diagnostics: readonly Diagnostic[];
      readonly strict: boolean;
    }
  | { readonly _tag: "LockHeld" };

/**
 * Splits the diagnostics by severity into the report value, keeping their order.
 */
export const makeGenerationReport = (input: GenerationReportInput): GenerationReportValue => {
  const added = (input.schemes ?? [])
    .filter((scheme) => scheme.source === "author-supplied")
    .map((scheme) => ({ key: `security.add.schemes.${scheme.name}`, name: scheme.name }));

  const report: GenerationReportValue = {
    acceptedServers: input.acceptedServers,
    commandNames: input.commandNames ?? [],
    generator: { version: input.version },
    inputs: input.inputs,
    notices: input.diagnostics.filter((diagnostic) => diagnostic.severity === "notice"),
    refusals: input.diagnostics.filter((diagnostic) => diagnostic.severity === "refusal"),
    renames: input.renames,
  };

  return added.length === 0 ? report : { ...report, authorSuppliedSchemes: added };
};

/**
 * Prints the report file: the value is encoded through `GenerationReport`, so a bad digest fails
 * here, then written in the `docs/printer.md` JSON layout with sorted keys and a final newline.
 */
export const printGenerationReport = (
  report: GenerationReportValue,
): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(GenerationReport)(report).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(JsonLiteral)),
    Effect.map(printJson),
  );

/**
 * Design 8.1: 0 when output was written, 1 on a document refusal, on any refusal under `--strict`,
 * and on a held lock.
 */
export const generatorExitStatus = (outcome: GeneratorOutcome): 0 | 1 => {
  if (outcome._tag === "LockHeld") {
    return 1;
  }

  const refusals = outcome.diagnostics.filter((diagnostic) => diagnostic.severity === "refusal");

  if (refusals.some((diagnostic) => diagnostic.scope === "document")) {
    return 1;
  }

  return outcome.strict && refusals.length > 0 ? 1 : 0;
};
