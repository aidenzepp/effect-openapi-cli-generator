import { JsonPointer } from "effect";

/**
 * The only `$ref` form the schema store resolves: a key of the document-level `$defs` map.
 */
export const defsRefPrefix = "#/$defs/";

/**
 * The longest `$ref` chain followed before a reference counts as unresolvable.
 */
export const maxDefsRefHops = 64;

/**
 * The `$defs` key a `$ref` names, or `undefined` when the reference is not under `#/$defs/`.
 * The key is the plain slice after the prefix with `~1` and `~0` unescaped; nothing is
 * percent-decoded.
 */
export const defsKeyOf = (ref: string): string | undefined =>
  ref.startsWith(defsRefPrefix)
    ? JsonPointer.unescapeToken(ref.slice(defsRefPrefix.length))
    : undefined;
