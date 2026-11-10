import { safeTextCategories } from "../model/brands.ts";

// Controls, format characters, U+2028, U+2029 and lone surrogates; LF and TAB are kept.
const unsafeText = new RegExp(`(?![\\n\\t])[${safeTextCategories}]`, "gu");

/**
 * Source text with every unsafe code point removed, for docs fields and diagnostic messages.
 */
export const sanitize = (text: string): string => text.replaceAll(unsafeText, "");

/**
 * The docs fields of a normalized body or parameter.
 */
export interface Docs {
  description?: string;
  summary?: string;
}

/**
 * The sanitized docs fields that are present.
 */
export const docsOf = (description: string | undefined, summary: string | undefined): Docs => {
  const docs: Docs = {};
  if (description !== undefined) {
    docs.description = sanitize(description);
  }

  if (summary !== undefined) {
    docs.summary = sanitize(summary);
  }

  return docs;
};
