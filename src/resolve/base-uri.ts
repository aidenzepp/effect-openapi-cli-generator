import { Option, Result } from "effect";
import { Url } from "effect/http";
import type { Line } from "../validate/index.ts";
import type { Json } from "../model/pointer.ts";
import { stringMember } from "../model/json-tree.ts";

/**
 * Resolves a URI reference against a base (RFC 3986 section 5.2 through WHATWG `URL`). `None` when
 * the result is not a URI, for example a relative path against a `urn:` base.
 */
export const resolveUri = (reference: string, base: string): Option.Option<string> =>
  Option.map(Result.getSuccess(Url.fromString(reference, base)), (url) => url.href);

/**
 * Drops the fragment, so the result names a resource (RFC 3986 section 5.2.1).
 */
export const stripFragment = (uri: string): string => {
  const hash = uri.indexOf("#");

  return hash === -1 ? uri : uri.slice(0, hash);
};

/**
 * Splits a URI reference at its first `#` into the resource part and the fragment, `None` when the
 * reference has no `#`. A `#` inside the fragment stays in the fragment.
 */
export const splitFragment = (
  uri: string,
): readonly [resource: string, fragment: Option.Option<string>] => {
  const hash = uri.indexOf("#");

  return hash === -1
    ? [uri, Option.none()]
    : [uri.slice(0, hash), Option.some(uri.slice(hash + 1))];
};

/**
 * A retrieval URI in normal form with its fragment stripped: the resource a document is in the set
 * as.
 */
export const retrievalBase = (retrieval: string): string =>
  stripFragment(Option.getOrElse(resolveUri(retrieval, retrieval), () => retrieval));

/**
 * The base URI of a document's non-schema objects (design 3.3): the retrieval URI for 3.0 and 3.1;
 * for 3.2 the `$self` value resolved against the retrieval URI with its fragment stripped, else the
 * retrieval URI. `None` when `$self` does not resolve to a URI.
 */
export const documentBase = (line: Line, retrieval: string, root: Json): Option.Option<string> => {
  const normalized = retrievalBase(retrieval);
  const self = line === "3.2" ? stringMember(root, "$self") : undefined;

  return self === undefined
    ? Option.some(normalized)
    : Option.map(resolveUri(self, normalized), stripFragment);
};

/**
 * The base URI inside a Schema Object (design 3.3): for 3.1 and 3.2 the schema's own `$id`
 * resolved against the enclosing base with its fragment stripped, else the enclosing base; 3.0 has
 * no `$id`. `None` when `$id` does not resolve to a URI.
 */
export const schemaBase = (line: Line, enclosing: string, schema: Json): Option.Option<string> => {
  const id = line === "3.0" ? undefined : stringMember(schema, "$id");

  return id === undefined
    ? Option.some(enclosing)
    : Option.map(resolveUri(id, enclosing), stripFragment);
};
