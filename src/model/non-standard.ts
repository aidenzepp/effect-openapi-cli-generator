import type { Origin, Serialization } from "./entities.ts";

/**
 * A switch of the author config's `nonStandard` (design 6.1, D-OQ1): the bracket convention or the
 * scalar `name=value` form.
 */
export type NonStandardChoice = "deepObjectBrackets" | "deepObjectScalars";

/**
 * One element the author config marked non-standard, with the switch that marked it.
 */
export interface NonStandardUse {
  readonly choice: NonStandardChoice;
  readonly origin: typeof Origin.Type;
}

/**
 * An element that can carry the markers: a `style` serialization or a form Encoding rule.
 */
export interface Markable {
  readonly nonStandard?: "deepObjectBrackets" | undefined;
  readonly nonStandardScalars?: "deepObjectScalars" | undefined;
  readonly origin: typeof Origin.Type;
}

/**
 * The use sites of one marked element, one per marker it carries, bracket choice first. Help and
 * the report both read the markers through this, so they cannot disagree.
 */
export const markedUses = (element: Markable): readonly NonStandardUse[] => [
  ...(element.nonStandard === undefined
    ? []
    : [{ choice: element.nonStandard, origin: element.origin }]),
  ...(element.nonStandardScalars === undefined
    ? []
    : [{ choice: element.nonStandardScalars, origin: element.origin }]),
];

/**
 * The use sites of a parameter serialization that the author config marked non-standard (design
 * 6.1, D-OQ1), one per marker: a `style` serialization's own, or each marked form Encoding rule's
 * of `content` (a 3.2 `querystring` parameter). Empty when nothing is marked.
 */
export const nonStandardUses = (
  serialization: typeof Serialization.Type,
): readonly NonStandardUse[] =>
  serialization.kind === "content"
    ? serialization.encoding.flatMap(markedUses)
    : markedUses(serialization);

/**
 * The origins of a parameter serialization's bracket-marked use sites, which the report lists as
 * `deepObjectBrackets` entries.
 */
export const nonStandardOrigins = (
  serialization: typeof Serialization.Type,
): readonly (typeof Origin.Type)[] =>
  nonStandardUses(serialization).flatMap((use) =>
    use.choice === "deepObjectBrackets" ? [use.origin] : [],
  );

/**
 * Whether the author config marked any part of a parameter serialization non-standard, by either
 * switch.
 */
export const isNonStandard = (serialization: typeof Serialization.Type): boolean =>
  nonStandardUses(serialization).length > 0;
