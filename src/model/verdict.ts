import { Schema } from "effect";
import { JsonPointer, Sha256Hex } from "./brands.ts";
import { DiagnosticScope } from "./diagnostic.ts";
import { Origin } from "./entities.ts";

const Count = Schema.Natural;

const Entry = Schema.Struct({
  code: Schema.String,
  pointer: JsonPointer,
  row: Schema.String,
});

/**
 * Construct a walk element (design 8.3): its use site, then its kind and the kind's value, or a
 * `field` refusal no command agrees with (rule 6) by its pointer, request media type and property
 * name.
 */
const withSite = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct({ ...Origin.fields, ...fields });

// A `--describe` claim nothing in the spec stands behind, by the command's path and the value.
const claim = { path: Schema.Array(Schema.String) };

/**
 * Construct an invented claim: the command's path, then its kind and the kind's value.
 */
const withClaim = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct({ ...claim, ...fields });

const operation = { kind: Schema.Literal("operation") };

const parameter = { in: Schema.String, kind: Schema.Literal("parameter"), name: Schema.String };

const command = { kind: Schema.Literal("command") };

const refusedField = {
  kind: Schema.Literal("refusedField"),
  mediaType: Schema.String,
  name: Schema.String,
};

const requestMedia = { kind: Schema.Literal("requestMedia"), mediaType: Schema.String };

const response = { key: Schema.String, kind: Schema.Literal("response") };

const securityAlternative = {
  kind: Schema.Literal("securityAlternative"),
  schemes: Schema.Array(Schema.String),
};

const server = { kind: Schema.Literal("server"), url: Schema.String };

const Element = Schema.Union([
  withSite(operation),
  withSite(parameter),
  withSite(refusedField),
  withSite(requestMedia),
  withSite(response),
  withSite(securityAlternative),
  withSite(server),
]);

const Invented = Schema.Union([
  withClaim(command),
  withClaim(refusedField),
  withClaim(requestMedia),
  withClaim(response),
  withClaim(securityAlternative),
  withClaim(server),
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
  generator: Schema.Struct({
    config: Schema.String,
    configSha256: Sha256Hex,
    version: Schema.String,
  }),
  // The report's non-standard entries; they never change `verdict`.
  nonStandard: Schema.Array(
    Schema.Struct({ choice: Schema.String, pointer: JsonPointer, row: Schema.String }),
  ),
  notices: Schema.Array(Entry),
  refusals: Schema.Array(Schema.Struct({ ...Entry.fields, scope: DiagnosticScope })),
  spec: Schema.Struct({ id: Schema.String, openapi: Schema.String, sha256: Sha256Hex }),
  twinEquality: Schema.Struct({ checked: Schema.Boolean, equal: Schema.Boolean }),
  verdict: Schema.Literals(["accepted", "partly-refused", "refused"]),
});
