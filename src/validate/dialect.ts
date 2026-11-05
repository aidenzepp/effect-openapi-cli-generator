import { Effect, Predicate, Record } from "effect";
import { escapeToken } from "../resolve/pointer.ts";
import { lineOf } from "./dispatch.ts";
import type { UnsupportedOpenApiVersion, ValidatorInput } from "./dispatch.ts";

/**
 * A validation-only copy of a document and the pointers of the values rewritten in it.
 */
export interface DialectRewrite {
  readonly copy: ValidatorInput;
  readonly occurrences: readonly string[];
}

const textBase = "https://spec.openapis.org/oas/3.1/dialect/base";

const schemaBase = "https://spec.openapis.org/oas/3.1/dialect/2024-11-10";

const pointerOf = (tokens: readonly string[]): string =>
  tokens.map((token) => `/${escapeToken(token)}`).join("");

const isDialectId = (tokens: readonly string[], key: string, member: ValidatorInput): boolean =>
  member === textBase &&
  (key === "$schema" || (tokens.length === 0 && key === "jsonSchemaDialect"));

const sitesOf = (value: ValidatorInput, tokens: readonly string[]): readonly string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => sitesOf(item, [...tokens, String(index)]));
  }

  return Predicate.isObject(value)
    ? Record.toEntries(value).flatMap(([key, member]) =>
        isDialectId(tokens, key, member)
          ? [pointerOf([...tokens, key])]
          : sitesOf(member, [...tokens, key]),
      )
    : [];
};

const rewriteValue = (value: ValidatorInput, tokens: readonly string[]): ValidatorInput => {
  if (Array.isArray(value)) {
    return value.map((item, index) => rewriteValue(item, [...tokens, String(index)]));
  }

  return Predicate.isObject(value)
    ? Object.fromEntries(
        Record.toEntries(value).map(([key, member]) => [
          key,
          isDialectId(tokens, key, member) ? schemaBase : rewriteValue(member, [...tokens, key]),
        ]),
      )
    : value;
};

/**
 * Rewrites `jsonSchemaDialect` and Schema Object `$schema` values equal to the 3.1.2 text's own
 * dialect id into the dated id `schema-base` pins (design 3.2 Dialect id substitution), in a deep
 * copy; the input is never changed. A copy is built only when such a site exists; otherwise `copy`
 * is the input itself and `occurrences` is empty. Only the 3.1 line has this id. Every `$schema`
 * property equal to the id counts, wherever it sits, because the walk does not distinguish Schema
 * Objects from other values.
 */
export const rewriteDialect = (
  document: ValidatorInput,
): Effect.Effect<DialectRewrite, UnsupportedOpenApiVersion> =>
  lineOf(document).pipe(
    Effect.map((line): DialectRewrite => {
      const occurrences = line === "3.1" ? sitesOf(document, []) : [];

      return occurrences.length === 0
        ? { copy: document, occurrences }
        : { copy: rewriteValue(document, []), occurrences };
    }),
  );
