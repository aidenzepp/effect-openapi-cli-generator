import { Effect, Schema } from "effect";
import { Diagnostic } from "../model/diagnostic.ts";
import type { DocumentUri } from "../model/brands.ts";
import type { Line } from "./dispatch.ts";
import type { ErrorGroup, ErrorUnit } from "./locations.ts";

type Uri = typeof DocumentUri.Type;

/**
 * One place where an official schema rejects what the text allows (design 10.4 D-OC1). Keyed by
 * inventory row and diagnostic code; `research` names the provenance ids, which are not keys.
 * `match` is absent when the dialect rewrite already removed the schema error (SCH-01).
 */
export interface Disagreement {
  readonly anchor: string;
  readonly code: string;
  readonly element: string;
  readonly lines: readonly Line[];
  readonly match:
    | {
        readonly instance: (tokens: readonly string[]) => boolean;
        readonly keywordLocationSuffix: string;
      }
    | undefined;
  readonly research: readonly string[];
  readonly row: string;
  readonly text: string;
}

const tail = (tokens: readonly string[], offset: number): string | undefined =>
  tokens[tokens.length - offset];

/**
 * The known-disagreement table. `VAL-01` is the umbrella row and has no entry of its own; `DOC-05`
 * and `VAL-03` meet D2 only through the SCH-01 rewrite, so they have none either.
 */
export const knownDisagreements: readonly Disagreement[] = [
  {
    anchor: "oas-version",
    code: "DOC-02/patch-digits",
    element: "openapi",
    lines: ["3.0"],
    match: {
      instance: (tokens) => tokens.length === 1 && tokens[0] === "openapi",
      keywordLocationSuffix: "#/properties/openapi/pattern",
    },
    research: ["3443e76d D5"],
    row: "DOC-02",
    text: "any 3.0.x patch version is allowed",
  },
  {
    anchor: "oas-self",
    code: "DOC-03/self-fragment",
    element: "$self",
    lines: ["3.2"],
    match: {
      instance: (tokens) => tokens.length === 1 && tokens[0] === "$self",
      keywordLocationSuffix: "#/properties/$self/pattern",
    },
    research: ["3443e76d D7"],
    row: "DOC-03",
    text: "$self is a URI reference and does not forbid a fragment",
  },
  {
    anchor: "json-schema-keywords",
    code: "SCH-01/dialect-base-id",
    element: "$schema",
    lines: ["3.1"],
    match: undefined,
    research: ["3443e76d D2", "a02cf45b D-1"],
    row: "SCH-01",
    text: "the OAS dialect id is https://spec.openapis.org/oas/3.1/dialect/base",
  },
  {
    anchor: "link-parameters",
    code: "LNK-04/non-string-parameter",
    element: "Link parameters",
    lines: ["3.1", "3.2"],
    match: {
      instance: (tokens) => tail(tokens, 2) === "parameters" && tail(tokens, 4) === "links",
      keywordLocationSuffix: "#/$defs/map-of-strings/additionalProperties/type",
    },
    research: ["a02cf45b D-2"],
    row: "LNK-04",
    text: "a Link parameter value may be any constant or runtime expression",
  },
  {
    anchor: "parameter-allow-reserved",
    code: "PRM-35/allow-reserved-outside-query",
    element: "allowReserved",
    lines: ["3.1"],
    match: {
      instance: (tokens) => tail(tokens, 1) === "allowReserved",
      keywordLocationSuffix: "#/$defs/parameter/unevaluatedProperties",
    },
    research: ["3443e76d D14"],
    row: "PRM-35",
    text: "allowReserved only applies to query parameters and is not forbidden elsewhere",
  },
];

const specVersion: Record<Line, string> = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.1" };

const specUrl = (line: Line, anchor: string): string =>
  `https://spec.openapis.org/oas/v${specVersion[line]}.html#${anchor}`;

/**
 * Finds the entry that explains every deepest error of a group, or none.
 */
export const matchDisagreement = (line: Line, group: ErrorGroup): Disagreement | undefined => {
  const tokens = group.pointer.split("/").slice(1);

  return knownDisagreements.find(
    ({ lines, match }) =>
      match !== undefined &&
      lines.includes(line) &&
      match.instance(tokens) &&
      group.deepest.every((unit) =>
        unit.absoluteKeywordLocation.endsWith(match.keywordLocationSuffix),
      ),
  );
};

interface Where {
  readonly document: Uri;
  readonly line: Line;
  readonly openapi: string;
}

/**
 * A notice citing both sides: the text, and the schema keyword location that rejected it.
 */
export const noticeFor = (
  entry: Disagreement,
  where: Where,
  pointer: string,
  schemaSide: string,
): Effect.Effect<Diagnostic, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(Diagnostic)({
    code: entry.code,
    document: where.document,
    element: entry.element,
    message: `The text says ${JSON.stringify(entry.text)}; ${schemaSide} (${entry.research.join(", ")}). Accepted per the text.`,
    openapi: where.openapi,
    pointer,
    row: entry.row,
    scope: "element",
    severity: "notice",
    specSection: specUrl(where.line, entry.anchor),
  });

/**
 * A document refusal: a schema error no table entry explains.
 */
export interface Refusal {
  readonly context: readonly ErrorUnit[];
  readonly diagnostic: Diagnostic;
  readonly keywordLocation: string;
}

const refusalRows: Record<Line, { readonly anchor: string; readonly row: string }> = {
  "3.0": { anchor: "schema-0", row: "VAL-02" },
  "3.1": { anchor: "schema-0", row: "VAL-03" },
  "3.2": { anchor: "objects-and-fields", row: "VAL-04" },
};

export const refusalFor = (
  where: Where,
  group: ErrorGroup,
): Effect.Effect<Refusal, Schema.SchemaError> => {
  const { anchor, row } = refusalRows[where.line];
  const locations = group.deepest.map((unit) => unit.absoluteKeywordLocation);

  return Schema.decodeUnknownEffect(Diagnostic)({
    code: `${row}/schema-invalid`,
    document: where.document,
    element: "OpenAPI document",
    message: `The official schema rejects the value at this pointer: ${JSON.stringify(locations)}.`,
    openapi: where.openapi,
    pointer: group.pointer,
    row,
    scope: "document",
    severity: "refusal",
    specSection: specUrl(where.line, anchor),
  }).pipe(
    Effect.map((diagnostic) => ({
      context: group.context,
      diagnostic,
      keywordLocation: locations[0] ?? "",
    })),
  );
};
