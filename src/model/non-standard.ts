import type { Origin, Serialization } from "./entities.ts";

/**
 * The use sites of a parameter serialization that the author config marked non-standard (design
 * 6.1, D-OQ1): a `style` serialization's own origin when it carries the marker, or the origin of
 * each marked form Encoding rule of `content` (a 3.2 `querystring` parameter). Empty when nothing
 * is marked. Help and the report both read the marker through this, so they cannot disagree.
 */
export const nonStandardOrigins = (
  serialization: typeof Serialization.Type,
): readonly (typeof Origin.Type)[] => {
  if (serialization.kind === "content") {
    return serialization.encoding.flatMap((rule) =>
      rule.nonStandard === undefined ? [] : [rule.origin],
    );
  }

  return serialization.nonStandard === undefined ? [] : [serialization.origin];
};

/**
 * Whether the author config marked any part of a parameter serialization non-standard.
 */
export const isNonStandard = (serialization: typeof Serialization.Type): boolean =>
  nonStandardOrigins(serialization).length > 0;
