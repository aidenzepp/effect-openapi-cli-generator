import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { SafeText } from "../../src/model/brands.ts";
import { sanitize } from "../../src/normalize/docs.ts";

const isSafeText = Schema.is(SafeText);

const characters = [
  ["LF", "\n"],
  ["TAB", "\t"],
  ["NUL", "\u0000"],
  ["U+00AD", String.fromCodePoint(0xad)],
  ["U+200B", String.fromCodePoint(0x20_0b)],
  ["U+2028", String.fromCodePoint(0x20_28)],
  ["U+2029", String.fromCodePoint(0x20_29)],
  ["a lone surrogate", "\uD800"],
  ["a plain letter", "a"],
  ["a plain capital letter", "Z"],
] as const;

describe("sanitize", () => {
  test.each(characters)(
    "sanitize removes exactly what SafeText rejects: %s",
    (_label, character) => {
      expect(sanitize(character) === "").toBe(!isSafeText(character));
    },
  );

  test("sanitize keeps LF, TAB and plain letters and removes the rest", () => {
    expect(sanitize(characters.map(([, character]) => character).join(""))).toBe("\n\taZ");
  });
});
