import type { Validator } from "@hyperjump/json-schema/draft-2020-12";
import { Effect, Predicate, Record } from "effect";
import { formatPointer } from "../model/pointer.ts";
import { lineOf } from "./dispatch.ts";
import type { Json } from "../model/pointer.ts";
import type { UnsupportedOpenApiVersion } from "./dispatch.ts";

// The validator library's own (mutable) JSON type.
type ValidatorInput = Parameters<Validator>[0];

/**
 * A validation-only copy of a document and the pointers of the values rewritten in it.
 */
export interface DialectRewrite {
  readonly copy: ValidatorInput;
  readonly occurrences: readonly string[];
}

const textBase = "https://spec.openapis.org/oas/3.1/dialect/base";

const schemaBase = "https://spec.openapis.org/oas/3.1/dialect/2024-11-10";

// Array.isArray narrows a readonly array only to any[], which loses the element type.
const isList = (value: Json): value is readonly Json[] => Array.isArray(value);

const isDialectId = (tokens: readonly string[], key: string, member: Json): boolean =>
  member === textBase &&
  (key === "$schema" || (tokens.length === 0 && key === "jsonSchemaDialect"));

const sitesOf = (value: Json, tokens: readonly string[]): readonly string[] => {
  if (isList(value)) {
    return value.flatMap((item, index) => sitesOf(item, [...tokens, String(index)]));
  }

  return Predicate.isObject(value)
    ? Record.toEntries(value).flatMap(([key, member]) =>
        isDialectId(tokens, key, member)
          ? [formatPointer([...tokens, key])]
          : sitesOf(member, [...tokens, key]),
      )
    : [];
};

const rewriteValue = (value: Json, tokens: readonly string[], rewrite: boolean): ValidatorInput => {
  if (isList(value)) {
    return value.map((item, index) => rewriteValue(item, [...tokens, String(index)], rewrite));
  }

  return Predicate.isObject(value)
    ? Object.fromEntries(
        Record.toEntries(value).map(([key, member]) => [
          key,
          rewrite && isDialectId(tokens, key, member)
            ? schemaBase
            : rewriteValue(member, [...tokens, key], rewrite),
        ]),
      )
    : value;
};

/**
 * Rewrites `jsonSchemaDialect` and Schema Object `$schema` values equal to the 3.1.2 text's own
 * dialect id into the dated id `schema-base` pins (design 3.2 Dialect id substitution), in a deep
 * copy; the input is never changed. The copy is always built, because it is the validator library's
 * own mutable input type and the readonly input cannot be handed over as one. Only the 3.1 line has
 * this id. Every `$schema` property equal to the id counts, wherever it sits, because the walk does
 * not distinguish Schema Objects from other values.
 */
export const rewriteDialect = (
  document: Json,
): Effect.Effect<DialectRewrite, UnsupportedOpenApiVersion> =>
  lineOf(document).pipe(
    Effect.map((line): DialectRewrite => {
      const occurrences = line === "3.1" ? sitesOf(document, []) : [];

      return { copy: rewriteValue(document, [], line === "3.1"), occurrences };
    }),
  );
