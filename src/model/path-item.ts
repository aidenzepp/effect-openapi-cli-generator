import type { SpecLine } from "./spec-section.ts";

/**
 * The fixed HTTP method members of a Path Item Object on every line, in the order the
 * specification lists them. Checks walk a path item's operations in this order, so it orders
 * their findings.
 */
export const fixedMethods = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

/**
 * The method member OpenAPI 3.2 adds to the Path Item Object.
 */
export const queryMethod = "query";

/**
 * Return the method members a Path Item Object has on a line: the fixed methods, then `query` on
 * 3.2.
 */
export const methodMembers = (line: SpecLine): readonly string[] =>
  line === "3.2" ? [...fixedMethods, queryMethod] : fixedMethods;
