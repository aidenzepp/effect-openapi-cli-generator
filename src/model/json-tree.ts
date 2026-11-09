import { Predicate, Result } from "effect";
import type { Schema } from "effect";
import { evaluatePointerResult } from "./pointer.ts";
import type { Json } from "./pointer.ts";

/**
 * A JSON object value.
 */
export type JsonObject = Schema.JsonObject;

/**
 * Whether a JSON value is an object (not an array, not null).
 */
export const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a JSON value is an array.
 */
export const isArray = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);

/**
 * The node at `pointer`, or undefined when the pointer is malformed or names no node.
 */
export const nodeAt = (root: Json, pointer: string): Json | undefined =>
  Result.getOrUndefined(evaluatePointerResult(root, pointer));

/**
 * The own member `name` of an object when it is a string.
 */
export const stringMember = (node: JsonObject, name: string): string | undefined => {
  const value = Object.hasOwn(node, name) ? node[name] : undefined;

  return Predicate.isString(value) ? value : undefined;
};
