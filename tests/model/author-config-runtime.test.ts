import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import {
  AuthorConfig,
  decodeAuthorConfig,
  runtimeSettings,
} from "../../src/model/author-config.ts";
import type { AuthorConfigContext } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";

const document = Schema.decodeUnknownSync(DocumentUri)("file:///work/author.json");

const context: AuthorConfigContext = { document };

const base = { binName: "example", package: { name: "example-cli", version: "1.0.0" } };

const decode = (input: Schema.Json) => Effect.runSync(decodeAuthorConfig(input, context));

const encode = (input: Schema.Json) => Schema.encodeSync(AuthorConfig)(decode(input));

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

describe("author config runtime settings", () => {
  test("a valid runtime object decodes to its values", () => {
    const config = decode({
      ...base,
      runtime: { idleTimeoutSeconds: 86_400, retries: 10, timeoutSeconds: 0 },
    });

    expect(runtimeSettings(config)).toEqual({
      idleTimeoutSeconds: 86_400,
      retries: 10,
      timeoutSeconds: 0,
    });
  });

  test("the lower bounds decode", () => {
    const config = decode({
      ...base,
      runtime: { idleTimeoutSeconds: 1, retries: 0, timeoutSeconds: 3600 },
    });

    expect(runtimeSettings(config)).toEqual({
      idleTimeoutSeconds: 1,
      retries: 0,
      timeoutSeconds: 3600,
    });
  });

  test("an absent runtime object gives the defaults", () => {
    expect(runtimeSettings(decode(base))).toEqual({
      idleTimeoutSeconds: 300,
      retries: 2,
      timeoutSeconds: 30,
    });
  });

  test("an empty runtime object gives the defaults", () => {
    expect(runtimeSettings(decode({ ...base, runtime: {} }))).toEqual({
      idleTimeoutSeconds: 300,
      retries: 2,
      timeoutSeconds: 30,
    });
  });

  test("an absent field gives its default", () => {
    expect(runtimeSettings(decode({ ...base, runtime: { retries: 5 } }))).toEqual({
      idleTimeoutSeconds: 300,
      retries: 5,
      timeoutSeconds: 30,
    });
  });

  test.each([
    ["retries above 10", { retries: 11 }, "/runtime/retries|CFG-1/invalid-value"],
    ["fractional retries", { retries: 1.5 }, "/runtime/retries|CFG-1/invalid-value"],
    ["negative retries", { retries: -1 }, "/runtime/retries|CFG-1/invalid-value"],
    ["negative timeout", { timeoutSeconds: -1 }, "/runtime/timeoutSeconds|CFG-1/invalid-value"],
    ["timeout above 3600", { timeoutSeconds: 3601 }, "/runtime/timeoutSeconds|CFG-1/invalid-value"],
    ["fractional timeout", { timeoutSeconds: 2.5 }, "/runtime/timeoutSeconds|CFG-1/invalid-value"],
    [
      "zero idle timeout",
      { idleTimeoutSeconds: 0 },
      "/runtime/idleTimeoutSeconds|CFG-1/invalid-value",
    ],
    [
      "idle timeout above 86400",
      { idleTimeoutSeconds: 86_401 },
      "/runtime/idleTimeoutSeconds|CFG-1/invalid-value",
    ],
    [
      "fractional idle timeout",
      { idleTimeoutSeconds: 1.5 },
      "/runtime/idleTimeoutSeconds|CFG-1/invalid-value",
    ],
    ["an unknown key", { foo: 1 }, "/runtime/foo|CFG-1/unknown-key"],
  ])("%s is refused", (_name, runtime, expected) => {
    expect(refusals({ ...base, runtime })).toEqual([expected]);
  });

  test("a config without runtime keeps no runtime and round-trips", () => {
    expect(decode(base).runtime).toBeUndefined();
    expect(encode(base)).toEqual(base);
  });

  test("a config with a partial runtime round-trips unchanged", () => {
    const input = { ...base, runtime: { retries: 5 } };

    expect(encode(input)).toEqual(input);
  });

  test("a config with a full runtime round-trips unchanged", () => {
    const input = { ...base, runtime: { idleTimeoutSeconds: 300, retries: 2, timeoutSeconds: 30 } };

    expect(encode(input)).toEqual(input);
  });
});
