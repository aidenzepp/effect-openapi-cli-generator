import { Schema } from "effect";
import { DocumentUri, JsonPointer } from "./brands.ts";

const Count = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)));

const Entry = Schema.Struct({
  code: Schema.String,
  pointer: JsonPointer,
  row: Schema.String,
});

// A walk element (design 8.3) by its use site, its kind and the kind's value, or a `field` refusal
// no command agrees with (rule 6) by its pointer, request media type and property name.
const site = { document: DocumentUri, pointer: JsonPointer };

const Element = Schema.Union([
  Schema.Struct({ ...site, kind: Schema.Literal("operation") }),
  Schema.Struct({
    ...site,
    in: Schema.String,
    kind: Schema.Literal("parameter"),
    name: Schema.String,
  }),
  Schema.Struct({
    ...site,
    kind: Schema.Literal("refusedField"),
    mediaType: Schema.String,
    name: Schema.String,
  }),
  Schema.Struct({ ...site, kind: Schema.Literal("requestMedia"), mediaType: Schema.String }),
  Schema.Struct({ ...site, key: Schema.String, kind: Schema.Literal("response") }),
  Schema.Struct({
    ...site,
    kind: Schema.Literal("securityAlternative"),
    schemes: Schema.Array(Schema.String),
  }),
  Schema.Struct({ ...site, kind: Schema.Literal("server"), url: Schema.String }),
]);

// A `--describe` claim nothing in the spec stands behind, by the command's path and the value.
const claim = { path: Schema.Array(Schema.String) };

const Invented = Schema.Union([
  Schema.Struct({ ...claim, kind: Schema.Literal("command") }),
  Schema.Struct({
    ...claim,
    kind: Schema.Literal("refusedField"),
    mediaType: Schema.String,
    name: Schema.String,
  }),
  Schema.Struct({ ...claim, kind: Schema.Literal("requestMedia"), mediaType: Schema.String }),
  Schema.Struct({ ...claim, key: Schema.String, kind: Schema.Literal("response") }),
  Schema.Struct({
    ...claim,
    kind: Schema.Literal("securityAlternative"),
    schemes: Schema.Array(Schema.String),
  }),
  Schema.Struct({ ...claim, kind: Schema.Literal("server"), url: Schema.String }),
]);

/**
 * The coverage join (design 8.2, revision 19): `missing` lists what nothing accounts for,
 * `byNotice` what only a notice accounts for, and `invented` what nothing in the spec stands
 * behind.
 */
export const VerdictCoverage = Schema.Struct({
  byNotice: Schema.Array(Element),
  checked: Schema.Boolean,
  invented: Schema.Array(Invented),
  missing: Schema.Array(Element),
});

/**
 * The corpus verdict file for one pinned specification (design 8.2). Fields are alphabetical.
 */
export const Verdict = Schema.Struct({
  // Commands by the source of their command name; `fold` covers `operationId` and route names.
  commandSources: Schema.Struct({ config: Count, fern: Count, fold: Count, forge: Count }),
  corpusVersion: Count,
  counts: Schema.Struct({
    informational: Count,
    nonStandard: Count,
    notices: Count,
    operations: Schema.Struct({ generated: Count, refused: Count, total: Count }),
    refusals: Schema.Struct({ document: Count, element: Count, field: Count, operation: Count }),
  }),
  coverage: VerdictCoverage,
  generator: Schema.Struct({ config: Schema.String, configSha256: Sha256, version: Schema.String }),
  // The report's non-standard entries; they never change `verdict`.
  nonStandard: Schema.Array(
    Schema.Struct({ choice: Schema.String, pointer: JsonPointer, row: Schema.String }),
  ),
  notices: Schema.Array(Entry),
  refusals: Schema.Array(
    Schema.Struct({
      ...Entry.fields,
      scope: Schema.Literals(["document", "operation", "element", "field"]),
    }),
  ),
  spec: Schema.Struct({ id: Schema.String, openapi: Schema.String, sha256: Sha256 }),
  twinEquality: Schema.Struct({ checked: Schema.Boolean, equal: Schema.Boolean }),
  verdict: Schema.Literals(["accepted", "partly-refused", "refused"]),
});
