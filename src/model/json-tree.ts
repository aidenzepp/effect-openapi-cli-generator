import { Effect, Exit, Predicate } from "effect";
import { evaluatePointer } from "./pointer.ts";
import type { Json } from "./pointer.ts";

/**
 * A JSON object value.
 */
export interface JsonObject {
  readonly [key: string]: Json;
}

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
export const nodeAt = (root: Json, pointer: string): Json | undefined => {
  const exit = Effect.runSyncExit(evaluatePointer(root, pointer));

  return Exit.isSuccess(exit) ? exit.value : undefined;
};

/**
 * The own member `name` of an object when it is a string.
 */
export const stringMember = (node: JsonObject, name: string): string | undefined => {
  const value = Object.hasOwn(node, name) ? node[name] : undefined;

  return Predicate.isString(value) ? value : undefined;
};
