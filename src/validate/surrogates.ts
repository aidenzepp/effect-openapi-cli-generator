import { Effect, Predicate, Record } from "effect";
import type { Schema } from "effect";
import { diagnosticOf } from "../model/diagnostic.ts";
import { formatPointer } from "../model/pointer.ts";
import type { DocumentUri } from "../model/brands.ts";
import type { Json } from "../model/pointer.ts";
import type { Refusal } from "./disagreements.ts";
import type { Line } from "./dispatch.ts";

// A high surrogate not followed by a low one, or a low surrogate not preceded by a high one.
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

const loneSurrogates = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

const isList = (value: Json): value is readonly Json[] => Array.isArray(value);

const printable = (text: string): string =>
  text.replace(
    loneSurrogates,
    (unit) => `\\u${(unit.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
  );

const pointerOf = (tokens: readonly string[]): string => formatPointer(tokens.map(printable));

/**
 * The pointers of every property name that holds a lone surrogate, in document order, with the
 * surrogate shown as `\uXXXX`. The validator library percent-encodes names, which throws on one.
 */
export const surrogateSites = (value: Json, tokens: readonly string[] = []): readonly string[] => {
  if (isList(value)) {
    return value.flatMap((item, index) => surrogateSites(item, [...tokens, String(index)]));
  }

  return Predicate.isObject(value)
    ? Record.toEntries(value).flatMap(([key, member]) => [
        ...(loneSurrogate.test(key) ? [pointerOf([...tokens, key])] : []),
        ...surrogateSites(member, [...tokens, key]),
      ])
    : [];
};

interface Where {
  readonly document: typeof DocumentUri.Type;
  readonly line: Line;
  readonly openapi: string;
}

/**
 * A document refusal for one property name that is not well-formed Unicode.
 */
export const surrogateRefusal = (
  where: Where,
  pointer: string,
): Effect.Effect<Refusal, Schema.SchemaError> =>
  diagnosticOf({
    code: "DOC-14/invalid-encoding",
    document: where.document,
    element: "document",
    message: `A property name at ${pointer} holds a lone UTF-16 surrogate, which is not valid Unicode text.`,
    openapi: where.openapi,
    pointer,
    scope: "document",
    severity: "refusal",
    specSection: "https://spec.openapis.org/oas/v3.1.2.html#format",
  }).pipe(Effect.map((diagnostic) => ({ context: [], diagnostic, keywordLocation: "" })));
