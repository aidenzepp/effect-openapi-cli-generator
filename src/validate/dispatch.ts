import { Data, Effect, Option, Schema } from "effect";
import type { Validator } from "@hyperjump/json-schema/draft-2020-12";

/**
 * A parsed JSON document in the validator library's own (mutable) JSON type.
 */
export type ValidatorInput = Parameters<Validator>[0];

/**
 * The OpenAPI line a document declares.
 */
export type Line = "3.0" | "3.1" | "3.2";

/**
 * The document has no `openapi` string, or names a line other than 3.0, 3.1 or 3.2.
 */
export class UnsupportedOpenApiVersion extends Data.TaggedError("UnsupportedOpenApiVersion")<{
  readonly openapi: string | undefined;
}> {}

/**
 * The dated official schema each line validates against (design 3.2): `schema-base` for 3.1 and
 * 3.2, because the plain schema validates no Schema Object.
 */
export const schemaUri: Record<Line, string> = {
  "3.0": "https://spec.openapis.org/oas/3.0/schema/2024-10-18",
  "3.1": "https://spec.openapis.org/oas/3.1/schema-base/2026-08-03",
  "3.2": "https://spec.openapis.org/oas/3.2/schema-base/2026-08-30",
};

const linePattern = /^(?<line>3\.[012])\.[0-9]+$/u;

const Declared = Schema.Struct({ openapi: Schema.String });

const lineOfVersion = (openapi: string): Line | undefined => {
  const line = linePattern.exec(openapi)?.groups?.line;

  return line === "3.0" || line === "3.1" || line === "3.2" ? line : undefined;
};

/**
 * Selects the line from the document's `openapi` major.minor.
 */
export const lineOf = (
  document: ValidatorInput,
): Effect.Effect<Line, UnsupportedOpenApiVersion> => {
  const declared = Schema.decodeUnknownOption(Declared)(document);
  const openapi = declared.pipe(
    Option.map((found) => found.openapi),
    Option.getOrUndefined,
  );
  const line = openapi === undefined ? undefined : lineOfVersion(openapi);

  return line === undefined
    ? Effect.fail(new UnsupportedOpenApiVersion({ openapi }))
    : Effect.succeed(line);
};
