import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import type { Credential } from "../../src/runtime-src/runtime/auth.ts";
import {
  dropTrailingFragment,
  queryWireForm,
  scrub,
} from "../../src/runtime-src/runtime/redact.ts";

// Audit M F1 probe values: each is sent percent-encoded with no `+` for a space, and the URL parser
// encodes a `'` in a special-scheme query, so the wire form differs from the URLSearchParams form.
const queryProbes = [
  { raw: "k e y", searchParams: "k+e+y", wire: "k%20e%20y" },
  { raw: "a!b/c", searchParams: "a%21b%2Fc", wire: "a!b%2Fc" },
  { raw: "a~b c", searchParams: "a%7Eb+c", wire: "a~b%20c" },
  { raw: "x'y z", searchParams: "x%27y+z", wire: "x%27y%20z" },
] as const;

const queryCredential = (value: string): Credential => ({
  definition: { in: "query", kind: "apiKey", name: "api_key" },
  scheme: "apiKey",
  value: Redacted.make(value),
});

describe("every echoed form of a query credential is scrubbed (audit M F1)", () => {
  for (const probe of queryProbes) {
    test(`${JSON.stringify(probe.raw)} has the wire form the request target carries`, () => {
      expect(queryWireForm(probe.raw)).toBe(probe.wire);
    });

    for (const form of ["raw", "searchParams", "wire"] as const) {
      test(`${JSON.stringify(probe.raw)} echoed as its ${form} form`, () => {
        expect(scrub(`echo ${probe[form]} end`, [queryCredential(probe.raw)])).toBe(
          "echo <redacted:apiKey> end",
        );
      });
    }
  }
});

const bearerOf = (value: string): Credential => ({
  definition: { kind: "http", scheme: "bearer" },
  scheme: "bearer",
  value: Redacted.make(value),
});

const stripControls = (text: string): string =>
  text.replaceAll("\u00AD", "").replaceAll("\u0085", "").replaceAll("\u0001", "");

// Audit S2 residual: a read cut inside a credential that stripped characters also split.
describe("a trailing fragment split by stripped characters is dropped (audit S2)", () => {
  for (const split of ["\u00AD", "\u0085", "\u0001"]) {
    test(`split by ${JSON.stringify(split)}`, () => {
      const text = `kept SEC${split}RETTO${split}`;

      expect(dropTrailingFragment(text, [bearerOf("SECRETTOKEN")], stripControls)).toBe("kept ");
    });
  }

  test("a fragment as sent is still dropped", () => {
    expect(dropTrailingFragment("kept SECRET", [bearerOf("SECRETTOKEN")], stripControls)).toBe(
      "kept ",
    );
  });

  test("text with no fragment is unchanged", () => {
    expect(dropTrailingFragment("kept S\u00ADX", [bearerOf("SECRETTOKEN")], stripControls)).toBe(
      "kept S\u00ADX",
    );
  });
});
