/**
 * The published patch release of each OpenAPI line: the version diagnostics cite when a document's
 * own `openapi` value is not usable.
 */
export const patchVersion = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.1" } as const;

/**
 * An OpenAPI line (structurally the validate stage's `Line`; kept here so every stage can cite
 * the specification without importing validate).
 */
export type SpecLine = keyof typeof patchVersion;

/**
 * The specification section a diagnostic cites: the anchor on the line's published patch release.
 */
export const specSectionUrl = (line: SpecLine, anchor: string): string =>
  `https://spec.openapis.org/oas/v${patchVersion[line]}.html#${anchor}`;
