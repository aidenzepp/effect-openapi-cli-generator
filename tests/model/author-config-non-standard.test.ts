import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { AuthorConfig, decodeAuthorConfig } from "../../src/model/author-config.ts";
import type { AuthorConfigContext } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";

const document = Schema.decodeUnknownSync(DocumentUri)("file:///work/author.json");

const context: AuthorConfigContext = { document };

const base = { binName: "example", package: { name: "example-cli", version: "1.0.0" } };

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

describe("author config nonStandard.deepObjectBrackets", () => {
  test("absent nonStandard decodes and means strict", () => {
    expect(decode(base).nonStandard).toBeUndefined();
  });

  test("an empty nonStandard decodes", () => {
    expect(decode({ ...base, nonStandard: {} }).nonStandard).toEqual({});
  });

  test("deepObjectBrackets false decodes", () => {
    const config = decode({ ...base, nonStandard: { deepObjectBrackets: false } });
    expect(config.nonStandard?.deepObjectBrackets).toBe(false);
  });

  test("deepObjectBrackets true decodes and round-trips", () => {
    const config = decode({ ...base, nonStandard: { deepObjectBrackets: true } });
    expect(config.nonStandard?.deepObjectBrackets).toBe(true);
    expect(Schema.encodeSync(AuthorConfig)(config)).toEqual({
      ...base,
      nonStandard: { deepObjectBrackets: true },
    });
  });

  test("a string is refused as an invalid value", () => {
    expect(refusals({ ...base, nonStandard: { deepObjectBrackets: "true" } })).toEqual([
      "/nonStandard/deepObjectBrackets|CFG-1/invalid-value",
    ]);
  });

  test("a number is refused as an invalid value", () => {
    expect(refusals({ ...base, nonStandard: { deepObjectBrackets: 1 } })).toEqual([
      "/nonStandard/deepObjectBrackets|CFG-1/invalid-value",
    ]);
  });

  test("an unknown key under nonStandard is refused", () => {
    expect(refusals({ ...base, nonStandard: { deepObjectBrackets: true, x: 1 } })).toEqual([
      "/nonStandard/x|CFG-1/unknown-key",
    ]);
  });

  test("an M1 config decodes unchanged", () => {
    const config = decode(base);
    expect(Schema.encodeSync(AuthorConfig)(config)).toEqual(base);
  });
});
