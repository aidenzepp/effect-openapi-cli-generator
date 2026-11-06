import { Array as Arr, Effect, Order, Schema } from "effect";
import { printJson } from "../emit/printer.ts";
import { DocumentUri, JsonLiteral, JsonPointer } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import type { Api, SecurityScheme } from "../model/entities.ts";

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
 * One element the author config made non-standard (design 8.1 `nonStandard`, 6.1): the choice and
 * the config key that made it, the element's use site, and the row it departs from.
 */
export const NonStandardEntry = Schema.Struct({
  choice: Schema.Literal("deepObjectBrackets"),
  configKey: Schema.Literal("nonStandard.deepObjectBrackets"),
  document: DocumentUri,
  pointer: JsonPointer,
  row: Schema.Literal("PRM-27"),
});

export type NonStandardEntryValue = typeof NonStandardEntry.Type;

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
  // Always present, empty unless the author config switched a non-standard choice on.
  nonStandard: Schema.Array(NonStandardEntry),
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
  // The non-standard elements in diagnostic order; absent, none.
  readonly nonStandard?: GenerationReportValue["nonStandard"];
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

const tokenOrder = Order.make<string>((left, right) =>
  /^(?:0|[1-9][0-9]*)$/u.test(left) && /^(?:0|[1-9][0-9]*)$/u.test(right)
    ? Order.Number(Number(left), Number(right))
    : Order.String(left, right),
);

// Diagnostic order (design 3.7) over use sites: document index, then pointer token by token with
// array indices numerically. `diagnostic.ts` keeps its pointer order private, so this repeats it.
const useSiteOrder = (documents: readonly string[]): Order.Order<NonStandardEntryValue> =>
  Order.combine(
    Order.mapInput(Order.Number, (entry: NonStandardEntryValue) => {
      const index = documents.indexOf(entry.document);

      return index === -1 ? documents.length : index;
    }),
    Order.mapInput(Order.Array(tokenOrder), (entry: NonStandardEntryValue) =>
      entry.pointer.split("/").slice(1),
    ),
  );

const entryAt = (origin: { readonly document: string; readonly pointer: string }) =>
  Schema.decodeUnknownSync(NonStandardEntry)({
    choice: "deepObjectBrackets",
    configKey: "nonStandard.deepObjectBrackets",
    document: origin.document,
    pointer: origin.pointer,
    row: "PRM-27",
  });

/**
 * The elements of the normalized model that carry the non-standard marker (design 6.1): query
 * parameters and form Encoding entries the author config sends in the bracket convention. The
 * marker is read as the model holds it, never inferred; a model with none lists none. Entries are
 * in diagnostic order over `documents`.
 */
export const nonStandardEntries = (
  api: Api,
  documents: readonly string[],
): GenerationReportValue["nonStandard"] => {
  const marked = api.operations.flatMap((operation) => [
    ...operation.parameters.flatMap(({ serialization }) =>
      serialization.kind === "style" && serialization.nonStandard !== undefined
        ? [entryAt(serialization.origin)]
        : [],
    ),
    ...(operation.body?.alternatives ?? []).flatMap((alternative) =>
      alternative.encoding.flatMap((rule) =>
        rule.nonStandard === undefined ? [] : [entryAt(rule.origin)],
      ),
    ),
  ]);

  return Arr.sort(marked, useSiteOrder(documents));
};

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
    nonStandard: input.nonStandard ?? [],
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
