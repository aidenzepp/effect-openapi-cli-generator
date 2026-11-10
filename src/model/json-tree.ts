import { Option, Predicate, Record, Result } from "effect";
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
export const isObject = (value: Json | undefined): value is JsonObject => Predicate.isObject(value);

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
 * The own member `name` of a value when the value is an object and the member is a string.
 */
export const stringMember = (value: Json, name: string): string | undefined =>
  isObject(value)
    ? Option.getOrUndefined(Option.filter(Record.get(value, name), Predicate.isString))
    : undefined;

/**
 * One object member as a fold sees it: its key, its value and the value already folded.
 */
export interface JsonMember<A> {
  readonly key: string;
  readonly value: Json;
  readonly folded: A;
}

/**
 * The three steps of a fold over a JSON value, each given the tokens of the node it folds.
 */
export interface JsonFold<A> {
  readonly array: (items: readonly A[], tokens: readonly string[]) => A;
  readonly leaf: (value: null | boolean | number | string, tokens: readonly string[]) => A;
  readonly object: (members: readonly JsonMember<A>[], tokens: readonly string[]) => A;
}

/**
 * Folds a JSON value bottom up in document order: each item is folded with its index appended to
 * `tokens`, each object member (in insertion order) with its key appended.
 */
export const foldJson = <A>(value: Json, fold: JsonFold<A>, tokens: readonly string[] = []): A => {
  if (isArray(value)) {
    return fold.array(
      value.map((item, index) => foldJson(item, fold, [...tokens, String(index)])),
      tokens,
    );
  }

  return isObject(value)
    ? fold.object(
        Record.toEntries(value).map(([key, member]) => ({
          folded: foldJson(member, fold, [...tokens, key]),
          key,
          value: member,
        })),
        tokens,
      )
    : fold.leaf(value, tokens);
};
