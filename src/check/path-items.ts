import { Array as Arr } from "effect";
import { keyOf } from "../resolve/canonical.ts";
import type { CanonicalKey } from "../resolve/canonical.ts";
import type { Resolution } from "../resolve/index.ts";
import { childPointer } from "../model/pointer.ts";
import type { Json } from "../model/pointer.ts";
import { isObject, nodeAt } from "../model/json-tree.ts";
import type { JsonObject } from "../model/json-tree.ts";

/**
 * An object and where it sits: the document of the set that holds it, and its pointer there.
 */
export interface Place {
  readonly document: CanonicalKey["document"];
  readonly node: JsonObject;
  readonly pointer: string;
}

/**
 * A Path Item Object the checks walk: its `paths` key, the object at the end of its reference
 * chain, that object's pointer, and the use site under `/paths`.
 */
export interface PathItem {
  readonly key: string;
  readonly node: JsonObject;
  readonly pointer: string;
  readonly use: string;
}

/**
 * An Operation Object under a path item. `additional` marks a 3.2 `additionalOperations` entry,
 * whose method is its key as written; a fixed method field's method is upper-cased.
 */
export interface Operation {
  readonly additional: boolean;
  readonly id: string | undefined;
  readonly item: PathItem;
  readonly method: string;
  readonly node: JsonObject;
  readonly pointer: string;
}

/**
 * A path or server template expression, `{name}`, with the name as the `name` group.
 */
export const expression = /\{(?<name>[^{}]+)\}/gu;

/**
 * Return the expression names of a template in order, repeats kept.
 */
export const expressionsOf = (template: string): readonly string[] =>
  Arr.map(Arr.fromIterable(template.matchAll(expression)), (match) => match.groups?.name ?? "");

/**
 * Construct the canonical key of `pointer` in the entry document.
 */
export const site = (resolution: Resolution, pointer: string): CanonicalKey => ({
  document: resolution.document,
  pointer,
});

/**
 * Follow the object at a use site through its Reference Object to the end of the chain, read from
 * the document of the set that holds it. A site with no reference is `node` itself; a target that
 * is not an object yields `undefined`.
 */
export const locate = (
  resolution: Resolution,
  at: CanonicalKey,
  node: Json | undefined,
): Place | undefined => {
  const target = resolution.references.get(keyOf(at))?.target ?? at;
  const document = resolution.documents.get(target.document);
  const read = document === undefined ? undefined : nodeAt(document, target.pointer);
  const value = target === at ? node : read;

  return isObject(value)
    ? { document: target.document, node: value, pointer: target.pointer }
    : undefined;
};

/**
 * Return the entry document's path items in `paths` order. A path item whose reference chain ends
 * in another document of the set is not walked: the checks read entry sites.
 */
export const pathItems = (resolution: Resolution): readonly PathItem[] => {
  const paths = isObject(resolution.value) ? resolution.value.paths : undefined;
  if (!isObject(paths)) {
    return [];
  }

  return Object.entries(paths).flatMap(([key, value]) => {
    const use = childPointer("/paths", key);
    const located = locate(resolution, site(resolution, use), value);

    return located === undefined || located.document !== resolution.document
      ? []
      : [{ key, node: located.node, pointer: located.pointer, use }];
  });
};

/**
 * Convert an operation to a diagnostic's operation identity: method, path key and, when declared,
 * operationId.
 */
export const operationOf = (operation: Operation) =>
  operation.id === undefined
    ? { method: operation.method, path: operation.item.key }
    : { method: operation.method, operationId: operation.id, path: operation.item.key };
