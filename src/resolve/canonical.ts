import type { DocumentUri } from "../model/brands.ts";

type Document = typeof DocumentUri.Type;

/**
 * The canonical identity of a node in the document set: a document URI and an RFC 6901 pointer
 * (design 3.3). Every `$ref` target and use site is named this way, never by the reference text.
 */
export interface CanonicalKey {
  readonly document: Document;
  readonly pointer: string;
}

/**
 * The string form of a canonical key, used as a map key.
 */
export const keyOf = (key: CanonicalKey): string => `${key.document}#${key.pointer}`;

const componentName = /^[a-zA-Z0-9.\-_]+$/u;

/**
 * The `$defs` key a schema target is lifted under (design 2.2 SchemaStore key rule). A target at
 * `#/components/schemas/<n>` in the entry document uses `<n>`; any other target uses its pointer,
 * which starts with `/` and so never equals a component name. A component name outside the CMP-13
 * pattern also uses its pointer, so two targets never share a key.
 */
export const defsKey = (entry: Document, key: CanonicalKey): string => {
  if (key.document !== entry) {
    return keyOf(key);
  }

  const [empty, components, schemas, name, ...rest] = key.pointer.split("/");
  const isComponent =
    empty === "" &&
    components === "components" &&
    schemas === "schemas" &&
    name !== undefined &&
    rest.length === 0 &&
    componentName.test(name);

  return isComponent ? name : key.pointer;
};
