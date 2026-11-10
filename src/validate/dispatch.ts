/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError<Self>()(tag, fields) declares a class; nothing is thrown */
import { Effect, Option, Schema } from "effect";
import type { DocumentUri } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import type { Json } from "../model/pointer.ts";
import { patchVersion, SpecLine, specSectionUrl } from "../model/spec-section.ts";

/**
 * The OpenAPI line a document declares.
 */
export type Line = SpecLine;

/**
 * The document has no `openapi` string, or names a line other than 3.0, 3.1 or 3.2. A run reports
 * it as the `DOC-02` refusal `versionRefusal` builds.
 */
export class UnsupportedOpenApiVersion extends Schema.TaggedError<UnsupportedOpenApiVersion>()(
  "UnsupportedOpenApiVersion",
  { openapi: Schema.UndefinedOr(Schema.String) },
) {}

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

const decodeDeclared = Schema.decodeUnknownOption(Schema.Struct({ openapi: Schema.String }));

/**
 * The `openapi` string a document declares, or `None` when the document has no `openapi` member or
 * its value is not a string. Each caller chooses its own fallback.
 */
export const declaredOpenapi = (document: Json): Option.Option<string> =>
  decodeDeclared(document).pipe(Option.map((found) => found.openapi));

const lineOfVersion = (openapi: string): Line | undefined => {
  const line = linePattern.exec(openapi)?.groups?.line;

  return Schema.is(SpecLine)(line) ? line : undefined;
};

/**
 * Selects the line from the document's `openapi` major.minor.
 */
export const lineOf = (document: Json): Effect.Effect<Line, UnsupportedOpenApiVersion> => {
  const openapi = Option.getOrUndefined(declaredOpenapi(document));
  const line = openapi === undefined ? undefined : lineOfVersion(openapi);

  return line === undefined
    ? Effect.fail(new UnsupportedOpenApiVersion({ openapi }))
    : Effect.succeed(line);
};

const knownLine = /^(?<line>3\.[012])(?![0-9])/u;

/**
 * `DOC-02` (design 8.1): the document-scope refusal at `/openapi` for an `openapi` value that names
 * no supported line. The section is the value's own line when its major.minor is one (`3.1`), and
 * the 3.2.1 text otherwise.
 */
export const versionRefusal = (
  error: UnsupportedOpenApiVersion,
  document: typeof DocumentUri.Type,
): Effect.Effect<Diagnostic, Schema.SchemaError> => {
  const found =
    error.openapi === undefined ? undefined : knownLine.exec(error.openapi)?.groups?.line;
  const line = Schema.is(SpecLine)(found) ? found : "3.2";
  const declare = "Declare a 3.0.x, 3.1.x or 3.2.x version.";

  return Schema.decodeUnknownEffect(Diagnostic)({
    code: error.openapi === undefined ? "DOC-02/missing-version" : "DOC-02/unsupported-version",
    document,
    element: "openapi",
    message:
      error.openapi === undefined
        ? `The document declares no openapi version. ${declare}`
        : `The openapi version ${JSON.stringify(error.openapi)} is not supported. ${declare}`,
    openapi: error.openapi ?? patchVersion[line],
    pointer: "/openapi",
    row: "DOC-02",
    scope: "document",
    severity: "refusal",
    specSection: specSectionUrl(line, "oas-version"),
  });
};
