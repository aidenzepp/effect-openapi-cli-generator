import { Effect } from "effect";
import { keyOf } from "../resolve/canonical.ts";
import type { CanonicalKey } from "../resolve/canonical.ts";
import type { Resolution, ResolvedReference } from "../resolve/index.ts";
import { PointerMemberNotFound, childPointer, evaluatePointer } from "../model/pointer.ts";
import type { Json, PointerEvalError, PointerSyntaxError } from "../model/pointer.ts";

/**
 * The resolved reference whose use site is `site`, in whichever document of the set holds it.
 */
export const referenceIn = (
  resolution: Resolution,
  site: CanonicalKey,
): ResolvedReference | undefined => resolution.references.get(keyOf(site));

/**
 * The object a use site stands for: the end of its reference chain, or the site itself.
 */
export const follow = (resolution: Resolution, site: CanonicalKey): CanonicalKey =>
  referenceIn(resolution, site)?.target ?? site;

/**
 * The node at `key`, read from its own document of the set. A document outside the set has no
 * member for its URI.
 */
export const nodeIn = (
  resolution: Resolution,
  key: CanonicalKey,
): Effect.Effect<Json, PointerSyntaxError | PointerEvalError> => {
  const value = resolution.documents.get(key.document);

  return value === undefined
    ? Effect.fail(new PointerMemberNotFound({ pointer: key.pointer, token: key.document }))
    : evaluatePointer(value, key.pointer);
};

/**
 * The key `tokens` below `key`, in the same document.
 */
export const childKey = (key: CanonicalKey, ...tokens: readonly string[]): CanonicalKey => {
  let { pointer } = key;
  for (const token of tokens) {
    pointer = childPointer(pointer, token);
  }

  return { document: key.document, pointer };
};
