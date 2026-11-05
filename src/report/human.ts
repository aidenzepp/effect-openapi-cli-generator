import type { Diagnostic } from "../model/diagnostic.ts";

const unsafeCharacter = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

const escapeCharacter = (character: string): string =>
  `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`;

/**
 * Neutralizes control, format, separator and lone surrogate characters in one field of a human
 * line by writing each as a visible `\u{hex}` escape. An ANSI escape loses its ESC byte and stays
 * inert text (design 8.1, C8).
 */
export const sanitizeField = (text: string): string =>
  text.replaceAll(unsafeCharacter, escapeCharacter);

const operationLabel = (operation: NonNullable<Diagnostic["operation"]>): string => {
  const route = `${operation.method} ${operation.path}`;
  const label = operation.operationId === undefined ? route : `${route}, ${operation.operationId}`;

  return ` (${sanitizeField(label)})`;
};

/**
 * Renders one diagnostic as one human line (design 8.1): `<refused|notice> <code> at #<pointer>[
 * (<METHOD> <path>[, <operationId>])]: <message>; <specSection>`. Every free-text field is
 * sanitized. `line`, `column`, `hint` and `related` stay out of the line.
 */
export const humanLine = (diagnostic: Diagnostic): string => {
  const severity = diagnostic.severity === "refusal" ? "refused" : "notice";
  const where = `#${sanitizeField(diagnostic.pointer)}`;
  const operation = diagnostic.operation === undefined ? "" : operationLabel(diagnostic.operation);

  return `${severity} ${sanitizeField(diagnostic.code)} at ${where}${operation}: ${sanitizeField(diagnostic.message)}; ${sanitizeField(diagnostic.specSection)}`;
};
