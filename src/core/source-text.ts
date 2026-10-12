import { Schema } from "effect";
import type { Documentation } from "./model.js";

/**
 * Encodes JSON as TypeScript without interpreting hostile interpolation text.
 * Surrogate code units are escaped explicitly so formatting cannot replace them.
 *
 * @param value The exact JSON value to embed.
 * @returns A literal expression with the same runtime value.
 */
export const literal = (value: Schema.Json): string => {
  if (Schema.is(Schema.String)(value) && value.includes(`\${`)) {
    return `\`${value
      .replaceAll("\\", "\\\\")
      .replaceAll("`", "\\`")
      .replaceAll("\r", "\\r")
      .replaceAll(`\${`, `\\\${`)
      .replaceAll(/[\uD800-\uDFFF]/gu, (unit) => JSON.stringify(unit).slice(1, -1))}\``;
  }

  if (Schema.is(Schema.Array(Schema.Json))(value)) {
    return `[${value.map(literal).join(",")}]`;
  }

  return JSON.stringify(value);
};

/**
 * Emits an object key while preserving prototype-sensitive and interpolation spelling.
 *
 * @param name The original property name.
 * @returns A literal key, computed when ordinary object syntax changes semantics.
 */
export const propertyKey = (name: string) =>
  name === "__proto__" || name.includes(`\${`) ? `[${literal(name)}]` : JSON.stringify(name);

/**
 * Neutralizes comment terminators and forged JSDoc tags in upstream prose.
 *
 * @param text Untrusted API documentation.
 * @returns Safe comment text.
 */
export const escapeComment = (text: string) =>
  text.replaceAll("*/", "*\\/").replaceAll(/^\s*@/gmu, "\\@");

/**
 * Combines API documentation for native command help.
 *
 * @param docs The selected source annotations.
 * @returns Human-readable help including any deprecation notice.
 */
export const description = (docs: Documentation) =>
  [docs.title, docs.description, docs.deprecated === true ? "Deprecated." : undefined]
    .filter(Boolean)
    .join("\n");

/**
 * Renders safe JSDoc while retaining supported deprecation and external references.
 *
 * @param docs Original API annotations.
 * @returns A multiline comment or an empty string when documentation is absent.
 */
export const comment = (docs: Documentation): string => {
  const lines = description(docs).split("\n").filter(Boolean).map(escapeComment);
  if (docs.deprecated === true) {
    lines.push("@deprecated");
  }

  if (docs.externalDocs) {
    lines.push(
      `@see ${escapeComment(docs.externalDocs.url)} ${escapeComment(docs.externalDocs.description ?? "")}`,
    );
  }

  return lines.length > 0 ? `/**\n${lines.map((line) => ` * ${line}`).join("\n")}\n */\n` : "";
};

// These uses implement upstream APIs that remain supported despite deprecation.
/**
 * References a supported API element even when its upstream contract is deprecated.
 * The suppression applies only to internal registration, not consumer usage.
 *
 * @param identifier The allocated declaration name.
 * @param deprecated Whether the source API marks the element deprecated.
 * @returns A reference with a narrowly scoped suppression when required.
 */
export const internalReference = (identifier: string, deprecated: boolean) =>
  deprecated
    ? `
// oxlint-disable-next-line typescript/no-deprecated -- Required plumbing for a supported deprecated API element.
${identifier}
`
    : identifier;
