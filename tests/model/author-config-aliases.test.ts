import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { AuthorConfig, decodeAuthorConfig } from "../../src/model/author-config.ts";
import type { AuthorConfigContext } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";

const document = Schema.decodeUnknownSync(DocumentUri)("file:///work/author.json");

const context: AuthorConfigContext = { document };

const base = { binName: "example", package: { name: "example-cli", version: "1.0.0" } };

const withAliases = (aliases: Schema.Json) => ({
  ...base,
  naming: { operations: { fetch: { aliases } } },
});

const decode = (input: Schema.Json) => Effect.runSync(decodeAuthorConfig(input, context));

const refusals = (input: Schema.Json) => {
  const exit = Effect.runSyncExit(decodeAuthorConfig(input, context));
  if (Exit.isSuccess(exit)) {
    throw new Error("expected a refusal");
  }

  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (failure === undefined) {
    throw new Error("expected a typed failure");
  }

  return failure.error.diagnostics.map((d) => `${d.pointer}|${d.code}`);
};

const at = "/naming/operations/fetch/aliases";

describe("author config naming aliases", () => {
  test("an empty list decodes", () => {
    expect(decode(withAliases([])).naming?.operations?.fetch?.aliases).toEqual([]);
  });

  test("a dotted group, an array group and a method decode and round-trip", () => {
    const aliases = [
      { group: "zones.settings", method: "pause" },
      { group: ["zones"] },
      { method: "halt" },
    ];
    const config = decode(withAliases(aliases));

    const decoded: unknown = config.naming?.operations?.fetch?.aliases;
    const encoded: unknown = Schema.encodeSync(AuthorConfig)(config);

    expect(decoded).toEqual(aliases);
    expect(encoded).toEqual(withAliases(aliases));
  });

  test("an entry naming neither a group nor a method is an invalid value", () => {
    expect(refusals(withAliases([{}]))).toEqual([`${at}/0|CFG-1/invalid-value`]);
  });

  test("an empty method, an empty group and an empty segment are invalid values", () => {
    expect(
      refusals(
        withAliases([{ method: "" }, { group: "" }, { group: "a..b" }, { group: ["a", ""] }]),
      ),
    ).toEqual([
      `${at}/0/method|CFG-1/invalid-value`,
      `${at}/1/group|CFG-1/invalid-value`,
      `${at}/2/group|CFG-1/invalid-value`,
      `${at}/3/group/1|CFG-1/invalid-value`,
    ]);
  });

  test("a non-list and a non-object entry are invalid values", () => {
    expect(refusals(withAliases({ method: "x" }))).toEqual([`${at}|CFG-1/invalid-value`]);
    expect(refusals(withAliases(["x"]))).toEqual([`${at}/0|CFG-1/invalid-value`]);
  });

  test("an unknown key in an entry is refused", () => {
    expect(refusals(withAliases([{ command: "x", method: "y" }]))).toEqual([
      `${at}/0/command|CFG-1/unknown-key`,
    ]);
  });
});
