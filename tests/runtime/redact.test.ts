import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import type { Credential } from "../../src/runtime-src/runtime/auth.ts";
import { queryWireForm, scrub } from "../../src/runtime-src/runtime/redact.ts";

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
