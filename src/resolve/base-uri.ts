import { Predicate } from "effect";
import type { Line } from "../validate/index.ts";
import type { Json } from "../model/pointer.ts";

const isObject = (value: Json): value is { readonly [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Resolves a URI reference against a base (RFC 3986 section 5.2 through WHATWG `URL`). Fails with
 * `undefined` when the result is not a URI, for example a relative path against a `urn:` base.
 */
export const resolveUri = (reference: string, base: string): string | undefined =>
  URL.parse(reference, base)?.href;

/**
 * Drops the fragment, so the result names a resource (RFC 3986 section 5.2.1).
 */
export const stripFragment = (uri: string): string => {
  const hash = uri.indexOf("#");

  return hash === -1 ? uri : uri.slice(0, hash);
};

/**
 * The string member `name` of a JSON object, or `undefined`.
 */
export const stringMember = (value: Json, name: string): string | undefined => {
  if (!isObject(value) || !Object.hasOwn(value, name)) {
    return undefined;
  }

  const member = value[name];

  return Predicate.isString(member) ? member : undefined;
};

/**
 * The base URI of a document's non-schema objects (design 3.3): the retrieval URI for 3.0 and 3.1;
 * for 3.2 the `$self` value resolved against the retrieval URI with its fragment stripped, else the
 * retrieval URI. `undefined` when `$self` does not resolve to a URI.
 */
export const documentBase = (line: Line, retrieval: string, root: Json): string | undefined => {
  const normalized = stripFragment(resolveUri(retrieval, retrieval) ?? retrieval);
  const self = line === "3.2" ? stringMember(root, "$self") : undefined;
  if (self === undefined) {
    return normalized;
  }

  const resolved = resolveUri(self, normalized);

  return resolved === undefined ? undefined : stripFragment(resolved);
};

/**
 * The base URI inside a Schema Object (design 3.3): for 3.1 and 3.2 the schema's own `$id`
 * resolved against the enclosing base with its fragment stripped, else the enclosing base; 3.0 has
 * no `$id`. `undefined` when `$id` does not resolve to a URI.
 */
export const schemaBase = (line: Line, enclosing: string, schema: Json): string | undefined => {
  const id = line === "3.0" ? undefined : stringMember(schema, "$id");
  if (id === undefined) {
    return enclosing;
  }

  const resolved = resolveUri(id, enclosing);

  return resolved === undefined ? undefined : stripFragment(resolved);
};
