import { Schema } from "effect";
import { JsonPointer } from "./brands.ts";

const Count = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)));

const Entry = Schema.Struct({
  code: Schema.String,
  pointer: JsonPointer,
  row: Schema.String,
});

/**
 * The corpus verdict file for one pinned specification (design 8.2). Fields are alphabetical.
 */
export const Verdict = Schema.Struct({
  corpusVersion: Count,
  counts: Schema.Struct({
    informational: Count,
    notices: Count,
    operations: Schema.Struct({ generated: Count, refused: Count, total: Count }),
    refusals: Schema.Struct({ document: Count, element: Count, operation: Count }),
  }),
  coverage: Schema.Struct({ checked: Schema.Boolean, missing: Schema.Array(Schema.String) }),
  generator: Schema.Struct({ config: Schema.String, configSha256: Sha256, version: Schema.String }),
  notices: Schema.Array(Entry),
  refusals: Schema.Array(
    Schema.Struct({
      ...Entry.fields,
      scope: Schema.Literals(["document", "operation", "element"]),
    }),
  ),
  spec: Schema.Struct({ id: Schema.String, openapi: Schema.String, sha256: Sha256 }),
  twinEquality: Schema.Struct({ checked: Schema.Boolean, equal: Schema.Boolean }),
  verdict: Schema.Literals(["accepted", "partly-refused", "refused"]),
});
