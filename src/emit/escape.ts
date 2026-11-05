import { Schema } from "effect";

const lineWidth = 100;

// Code points never left raw in a string literal (R10): controls, format characters (bidi controls
// included), U+2028, U+2029 and lone surrogates.
const unsafePattern = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

const shortEscapes = new Map([
  ["\b", "\\b"],
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\f", "\\f"],
  ["\r", "\\r"],
]);

const unitEscape = (unit: number): string =>
  `\\u${unit.toString(16).toUpperCase().padStart(4, "0")}`;

// One escape per UTF-16 code unit: a code point outside the BMP becomes its two surrogates.
const unitEscapes = (char: string): string => {
  const point = char.codePointAt(0) ?? 0;
  if (point <= 0xff_ff) {
    return unitEscape(point);
  }

  const offset = point - 0x1_00_00;

  return (
    unitEscape(0xd8_00 + Math.floor(offset / 0x4_00)) + unitEscape(0xdc_00 + (offset % 0x4_00))
  );
};

const count = (text: string, char: string): number => text.split(char).length - 1;

const literal = (value: string, asciiOnly: boolean): string => {
  const quote = count(value, '"') > count(value, "'") ? "'" : '"';
  let body = "";
  for (const char of value) {
    const short = shortEscapes.get(char);
    if (char === "\\" || char === quote) {
      body += `\\${char}`;
    } else if (short !== undefined) {
      body += short;
    } else if (unsafePattern.test(char) || (asciiOnly && char > "~")) {
      body += unitEscapes(char);
    } else {
      body += char;
    }
  }

  return `${quote}${body}${quote}`;
};

/**
 * Prints a string literal: `JSON.stringify` escapes, the formatter's quote choice, and `\uXXXX`
 * for controls, format characters, U+2028, U+2029 and lone surrogates. Printable non-ASCII stays
 * literal (Mind ruling R10).
 */
export const stringLiteral = (value: string): string => literal(value, false);

/**
 * Prints a string literal with every code unit above U+007E escaped, so the formatter never reads
 * it as an identifier name. Used for quoted object keys.
 */
export const asciiStringLiteral = (value: string): string => literal(value, true);

// One space between words; printable ASCII without * _ ` # < > [ ] { } | \ @ ~; no word starts
// with -, + or a digit.
const jsDocPattern =
  /^[A-Z][!"$%&'()+,\-./0-9:;=?A-Z^a-z]*(?: [!"$%&'(),./:;=?A-Z^a-z][!"$%&'()+,\-./0-9:;=?A-Z^a-z]*)*$/u;

/**
 * Generator-owned JSDoc text from a fixed template (`docs/printer.md` JSDoc). Spec prose never
 * decodes to it.
 */
export const JsDocText = Schema.String.pipe(
  Schema.check(Schema.isPattern(jsDocPattern)),
  Schema.brand("JsDocText"),
);

/**
 * Prints the JSDoc block for a top-level statement: one paragraph, filled greedily to column 100.
 */
export const jsDoc = (text: typeof JsDocText.Type): string => {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") {
      current = word;
    } else if (` * ${current} ${word}`.length <= lineWidth) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  lines.push(current);

  return ["/**", ...lines.map((line) => ` * ${line}`), " */"].join("\n");
};

// oxlint reads the cooked value of a literal, so no escape hides `${...}` from
// `no-template-curly-in-string`; the statement is fenced with a disable range instead.
const templateCurlyPattern = /\$\{[^]*\}/u;

const templateCurlyRule = "no-template-curly-in-string";

/**
 * Fences a printed statement that holds a `${...}` string literal in a disable/enable range for
 * `no-template-curly-in-string`; any other statement is returned as it is.
 */
export const guardTemplateCurly = (statement: string): string =>
  templateCurlyPattern.test(statement)
    ? [
        `/* oxlint-disable ${templateCurlyRule} -- a spec string holds a template placeholder */`,
        statement,
        `/* oxlint-enable ${templateCurlyRule} */`,
      ].join("\n")
    : statement;
