import { describe, expect, test } from "bun:test";
import { Runtime, Schema } from "effect";
import { CliError } from "effect/cli";
import {
  ApiResponseError,
  CredentialMissing,
  OutputError,
  RedirectRefused,
  ResponseStreamError,
  TransportError,
  UsageError,
} from "../../src/runtime-src/domain/errors.ts";

const api = (status: number) =>
  new ApiResponseError({
    bodyExcerpt: "",
    matched: "undeclared",
    operation: "users-update",
    status,
  });

const cases = [
  ["UsageError", new UsageError({ message: "bad flag" }), 2],
  [
    "CredentialMissing",
    new CredentialMissing({ alternatives: ["bearerAuth (env)"], operation: "users-update" }),
    3,
  ],
  ["ApiResponseError", api(404), 1],
  ["ApiResponseError", api(500), 1],
  ["ApiResponseError", api(302), 1],
  ["ApiResponseError", api(401), 3],
  ["ApiResponseError", api(403), 3],
  [
    "TransportError",
    new TransportError({ reason: "dns", url: "https://api.example.com/users" }),
    4,
  ],
  [
    "RedirectRefused",
    new RedirectRefused({ from: "https://a.example", reason: "downgrade", to: "http://a.example" }),
    4,
  ],
  ["ResponseStreamError", new ResponseStreamError({ reason: "truncated" }), 5],
  ["OutputError", new OutputError({ path: "out.json", reason: "exists" }), 5],
] as const;

describe("CLI error classes", () => {
  test.each(cases)("%s exits with the table's code", (tag, error, code) => {
    expect(error._tag).toBe(tag);
    expect(Runtime.getErrorExitCode(error)).toBe(code);
  });

  test.each(cases)("%s carries a non-empty userMessage", (_tag, error) => {
    expect(CliError.getUserMessage(error)).toBeString();
    expect(CliError.getUserMessage(error)?.length).toBeGreaterThan(0);
  });

  test("an ApiResponseError message never contains the body excerpt or request id", () => {
    const error = new ApiResponseError({
      bodyExcerpt: "SECRET-BODY",
      matched: "404",
      operation: "users-update",
      requestId: "REQ-1",
      status: 404,
    });
    const message = CliError.getUserMessage(error) ?? "";

    expect(message).not.toContain("SECRET-BODY");
    expect(message).not.toContain("REQ-1");
  });
});

describe("error schemas", () => {
  const strict = { onExcessProperty: "error" } as const;
  const decode = (schema: Schema.Decoder<unknown>) => (input: Schema.Json) =>
    Schema.decodeUnknownExit(schema)(input, strict)._tag;
  const valid = {
    _tag: "ApiResponseError",
    bodyExcerpt: "",
    matched: "404",
    operation: "users-update",
    status: 404,
  };

  test("accepts a well-formed ApiResponseError", () => {
    expect(decode(ApiResponseError)(valid)).toBe("Success");
  });

  test("rejects a raw header-map field", () => {
    expect(decode(ApiResponseError)({ ...valid, headers: { authorization: "x" } })).toBe("Failure");
    expect(
      decode(TransportError)({ _tag: "TransportError", headers: {}, reason: "dns", url: "u" }),
    ).toBe("Failure");
  });

  test("rejects a credential field", () => {
    expect(
      decode(CredentialMissing)({
        _tag: "CredentialMissing",
        alternatives: [],
        credential: "s",
        operation: "o",
      }),
    ).toBe("Failure");
  });

  test("rejects an unbounded body excerpt and request id", () => {
    expect(decode(ApiResponseError)({ ...valid, bodyExcerpt: "x".repeat(65_537) })).toBe("Failure");
    expect(decode(ApiResponseError)({ ...valid, bodyExcerpt: "x".repeat(65_536) })).toBe("Success");
    expect(decode(ApiResponseError)({ ...valid, requestId: "x".repeat(257) })).toBe("Failure");
  });

  test("rejects an undeclared reason or matched literal", () => {
    expect(decode(ApiResponseError)({ ...valid, matched: "5XX" })).toBe("Failure");
    expect(decode(ResponseStreamError)({ _tag: "ResponseStreamError", reason: "other" })).toBe(
      "Failure",
    );
  });
});
