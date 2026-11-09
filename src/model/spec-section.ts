import { Schema } from "effect";

/**
 * An OpenAPI line: the major.minor of a supported specification release. Defined once here so
 * every stage can cite the specification without importing validate.
 */
// oxlint-disable-next-line no-redeclare -- a type and its schema value share one name
export const SpecLine = Schema.Literals(["3.0", "3.1", "3.2"]);

export type SpecLine = typeof SpecLine.Type;

/**
 * The published patch release of each OpenAPI line: the version diagnostics cite when a document's
 * own `openapi` value is not usable.
 */
export const patchVersion = {
  "3.0": "3.0.4",
  "3.1": "3.1.2",
  "3.2": "3.2.1",
} as const satisfies Record<SpecLine, string>;

/**
 * The specification section a diagnostic cites: the anchor on the line's published patch release.
 */
export const specSectionUrl = (line: SpecLine, anchor: string): string =>
  `https://spec.openapis.org/oas/v${patchVersion[line]}.html#${anchor}`;
