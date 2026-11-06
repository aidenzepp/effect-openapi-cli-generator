import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import { foldIdentifier } from "../../src/names/fold.ts";
import { reservedIdentifiers } from "../../src/names/reserved.ts";

describe("reservedIdentifiers", () => {
  test.each([
    "interface",
    "keyof",
    "readonly",
    "declare",
    "namespace",
    "string",
    "number",
    "boolean",
    "unknown",
    "never",
    "any",
    "object",
    "symbol",
    "require",
    "exports",
    "module",
    "Error",
    "Date",
    "Map",
    "Set",
    "Object",
    "Array",
    "Promise",
    "JSON",
    "Math",
    "URL",
    "Uint8Array",
    "globalThis",
  ])("%s is reserved", (name) => {
    expect(reservedIdentifiers.has(name)).toBe(true);
  });

  test.each([
    ["error", "pascal", "Error_"],
    ["date", "pascal", "Date_"],
    ["map", "pascal", "Map_"],
    ["string", "camel", "string_"],
    ["keyof", "camel", "keyof_"],
  ] as const)("%s folds %s to a suffixed name", (input, casing, expected) => {
    const folded = foldIdentifier(input, casing);
    expect(Result.isSuccess(folded) ? String(folded.success.name) : undefined).toBe(expected);
  });
});
