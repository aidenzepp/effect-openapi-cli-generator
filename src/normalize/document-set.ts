import { Array as Arr, Effect, Result } from "effect";
import type { Option } from "effect";
import { keyOf } from "../resolve/canonical.ts";
import type { CanonicalKey } from "../resolve/canonical.ts";
import type { Resolution, ResolvedReference } from "../resolve/index.ts";
import { PointerMemberNotFound, childPointer, evaluatePointerResult } from "../model/pointer.ts";
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
export const nodeInResult = (
  resolution: Resolution,
  key: CanonicalKey,
): Result.Result<Json, PointerSyntaxError | PointerEvalError> => {
  const value = resolution.documents.get(key.document);

  return value === undefined
    ? Result.fail(new PointerMemberNotFound({ pointer: key.pointer, token: key.document }))
    : evaluatePointerResult(value, key.pointer);
};

/**
 * The node at `key`, read from its own document of the set, or none when the document is outside
 * the set or the pointer names no node.
 */
export const nodeOption = (resolution: Resolution, key: CanonicalKey): Option.Option<Json> =>
  Result.getSuccess(nodeInResult(resolution, key));

/**
 * The node at `key`, read from its own document of the set.
 */
export const nodeIn = (
  resolution: Resolution,
  key: CanonicalKey,
): Effect.Effect<Json, PointerSyntaxError | PointerEvalError> =>
  Effect.suspend(() => Effect.fromResult(nodeInResult(resolution, key)));

/**
 * The key `tokens` below `key`, in the same document.
 */
export const childKey = (key: CanonicalKey, ...tokens: readonly string[]): CanonicalKey => ({
  document: key.document,
  pointer: Arr.reduce(tokens, key.pointer, (pointer, token) => childPointer(pointer, token)),
});
