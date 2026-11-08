import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";

const loopback = [
  "http://127.0.0.1:8080",
  "http://127.9.9.9",
  "http://[::1]",
  "http://[::ffff:127.0.0.1]",
  "http://localhost",
  "http://api.localhost",
];

describe("plaintextWarning", () => {
  test.each(loopback)("an allowed loopback http base %s warns nothing", (baseUrl) => {
    expect(Auth.plaintextWarning(baseUrl, true)).toEqual(Option.none());
  });

  test("an allowed non-loopback http base warns once with its host", () => {
    const warning = Auth.plaintextWarning("http://example.test/v1", true);

    expect(Option.isSome(warning)).toBe(true);

    const line = Option.getOrThrow(warning);
    expect(line).toContain("example.test");
    expect(line).toContain("--allow-credentials-for-base-url");
    expect(line).not.toContain("\n");
  });

  test("the warning never carries the base URL's userinfo", () => {
    const line = Option.getOrThrow(
      Auth.plaintextWarning("http://operator:s3cr3t-value@example.test", true),
    );

    expect(line).toContain("example.test");
    expect(line).not.toContain("s3cr3t-value");
    expect(line).not.toContain("operator");
  });

  test("an allowed https base warns nothing", () => {
    expect(Auth.plaintextWarning("https://example.test", true)).toEqual(Option.none());
  });

  test.each([...loopback, "http://example.test", "https://example.test"])(
    "without the flag %s warns nothing",
    (baseUrl) => {
      expect(Auth.plaintextWarning(baseUrl, false)).toEqual(Option.none());
    },
  );
});
