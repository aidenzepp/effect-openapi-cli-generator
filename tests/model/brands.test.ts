import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import hostile from "../fixtures/seeds/hostile.json" with { type: "json" };
import paths from "../fixtures/seeds/paths.json" with { type: "json" };
import {
  CookieName,
  DocumentUri,
  HeaderName,
  JsonLiteral,
  JsonPointer,
  MediaRange,
  MediaType,
  MethodToken,
  PathTemplate,
  SafeText,
  ServerTemplate,
  WireName,
} from "../../src/model/brands.ts";
import { methodTokens } from "../../src/model/method-tokens.ts";
import { parsePointer } from "../../src/model/pointer.ts";

const decode = (codec: Schema.Decoder<unknown>, input: Schema.Json) =>
  Schema.decodeUnknownExit(codec)(input);

const issueTag = (codec: Schema.Decoder<unknown>, input: Schema.Json): string => {
  const exit = decode(codec, input);
  if (Exit.isSuccess(exit)) {
    return "accepted";
  }

  return "rejected";
};

const HostileCases = Schema.Struct({
  cases: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      input: Schema.Union([
        Schema.String,
        Schema.Struct({ codeUnits: Schema.Array(Schema.Number) }),
      ]),
    }),
  ),
});

const hostileStrings: readonly string[] = Schema.decodeUnknownSync(HostileCases)(hostile).cases.map(
  ({ input }) =>
    Schema.is(Schema.String)(input) ? input : String.fromCodePoint(...input.codeUnits),
);

const PathCases = Schema.Struct({
  cases: Schema.Array(
    Schema.Struct({
      expected: Schema.Struct({
        outcome: Schema.Literals(["accepted", "refused"]),
        rows: Schema.optional(Schema.Array(Schema.String)),
      }),
      id: Schema.String,
      input: Schema.Struct({ path: Schema.String }),
    }),
  ),
});

const pathCases = Schema.decodeUnknownSync(PathCases)(paths).cases;

// The once-per-expression rule belongs to the cross-check slice, not the brand.
const brandAcceptsAnyway = new Set(["path-reject-duplicate-expression"]);

const brands = [
  ["WireName", WireName, "page[size]", ""],
  ["HeaderName", HeaderName, "X-Request-Id", "bad name"],
  ["CookieName", CookieName, "session_id", "a=b"],
  ["MediaType", MediaType, "application/json; charset=utf-8", "application/*"],
  ["MediaRange", MediaRange, "image/*", "image"],
  ["PathTemplate", PathTemplate, "/users/{id}/posts", "users/{id}"],
  ["ServerTemplate", ServerTemplate, "https://{region}.example.com/v1", "https://a b/{"],
  ["MethodToken", MethodToken, "PROPFIND", "patch"],
  ["SafeText", SafeText, "Line one\nline\ttwo", "bell\u0007"],
  ["DocumentUri", DocumentUri, "file:///specs/api.yaml", "no scheme"],
  ["JsonPointer", JsonPointer, "/a~1b/0", "a/b"],
] as const;

describe("branded codecs", () => {
  for (const [name, codec, valid, invalid] of brands) {
    test(`${name} accepts a valid value and rejects an invalid one`, () => {
      const ok = decode(codec, valid);
      expect(Exit.isSuccess(ok) ? ok.value : undefined).toBe(valid);
      expect(issueTag(codec, invalid)).toBe("rejected");
      expect(issueTag(codec, 42)).toBe("rejected");
    });
  }

  test("rejection is stable across repeated decodes", () => {
    for (const [, codec, , invalid] of brands) {
      const first = decode(codec, invalid);
      const second = decode(codec, invalid);
      expect(Exit.isFailure(first)).toBe(true);
      expect(String(first)).toBe(String(second));
    }
  });

  test("path templates reject unbalanced and empty expressions", () => {
    for (const bad of ["/a/{", "/a/}", "/a/{}", "/a/{x{y}}", "/a b", "/a?x=1"]) {
      expect(issueTag(PathTemplate, bad)).toBe("rejected");
    }
    expect(issueTag(PathTemplate, "/")).toBe("accepted");
  });

  test("PathTemplate agrees with every seeded path case it owns (seeds/paths.json)", () => {
    expect(pathCases.length).toBeGreaterThan(100);
    for (const { id, input, expected } of pathCases) {
      const owned =
        expected.outcome === "accepted" ||
        (expected.rows ?? []).some((row) => row === "PTH-02" || row === "PTH-07");
      const want =
        expected.outcome === "accepted" || brandAcceptsAnyway.has(id) ? "accepted" : "rejected";
      if (owned) {
        expect([id, issueTag(PathTemplate, input.path)]).toEqual([id, want]);
      }
    }
  });

  test("PathTemplate refuses dot segments, interior empty segments and control characters in names", () => {
    for (const bad of [
      "/a/%2E%2e/b",
      "/a//b",
      "//a",
      "/a/./b",
      "/a/..",
      `/a/{b${String.fromCodePoint(1)}}`,
      "/a/{b\uD800}",
    ]) {
      expect([bad, issueTag(PathTemplate, bad)]).toEqual([bad, "rejected"]);
    }
    for (const good of ["/", "/a/", "/a/%ff", "/a/{café}", "/a/%2e%2ex", "/a/..a", "/a/.b"]) {
      expect([good, issueTag(PathTemplate, good)]).toEqual([good, "accepted"]);
    }
  });

  test("JsonLiteral accepts finite JSON of any size and refuses non-JSON values", () => {
    expect(issueTag(JsonLiteral, { a: [1, "x", null, true] })).toBe("accepted");
    expect(issueTag(JsonLiteral, "x".repeat(2 ** 20 + 1))).toBe("accepted");
    expect(
      issueTag(
        JsonLiteral,
        Array.from({ length: 100_000 }, () => 0),
      ),
    ).toBe("accepted");

    const wide = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, [i]]));
    expect(Exit.isSuccess(Schema.decodeUnknownExit(JsonLiteral)(wide))).toBe(true);
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      [Number.NEGATIVE_INFINITY],
      { a: { b: [Number.NaN] } },
      () => 0,
      undefined,
      { f: () => 0 },
      Symbol("v"),
      10n,
    ]) {
      expect(Exit.isFailure(Schema.decodeUnknownExit(JsonLiteral)(bad))).toBe(true);
    }
  });

  test("JsonLiteral accepts what decoded JSON holds", () => {
    const bare: unknown = Object.setPrototypeOf({ a: [1, { b: "c" }] }, null);
    for (const good of [{}, [], { a: [1, { b: [null, true, "x"] }] }, bare, 0, -1.5, 1e308]) {
      expect(Exit.isSuccess(Schema.decodeUnknownExit(JsonLiteral)(good))).toBe(true);
    }

    class Point {
      readonly x = 1;
    }
    const sparse: unknown[] = [];
    sparse[2] = 1;
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      new Date(0),
      new Point(),
      () => 0,
      sparse,
    ]) {
      expect(Exit.isFailure(Schema.decodeUnknownExit(JsonLiteral)(bad))).toBe(true);
    }
  });

  test("JsonLiteral survives 10,000-deep nesting", () => {
    type Nested = number | readonly Nested[];
    let deep: Nested = 0;
    for (let i = 0; i < 10_000; i += 1) {
      deep = [deep];
    }
    expect(() => Schema.decodeUnknownExit(JsonLiteral)(deep)).not.toThrow();
    expect(Exit.isSuccess(Schema.decodeUnknownExit(JsonLiteral)(deep))).toBe(true);
  });

  test("hostile strings never throw and the token brands reject all syntax-bearing ones", () => {
    expect(hostileStrings.length).toBeGreaterThanOrEqual(12);
    for (const text of hostileStrings) {
      for (const [, codec] of brands) {
        expect(() => decode(codec, text)).not.toThrow();
      }
    }
    const nonTokens = hostileStrings.filter((s) => !/^[A-Za-z_]+$/u.test(s));
    for (const text of nonTokens) {
      for (const codec of [HeaderName, CookieName, MethodToken, MediaType, MediaRange]) {
        expect(issueTag(codec, text)).toBe("rejected");
      }
      expect(issueTag(PathTemplate, text)).toBe("rejected");
      expect(issueTag(DocumentUri, text)).toBe("rejected");
    }
  });

  test("text brands reject control, lone-surrogate and line-separator input and keep plain text", () => {
    for (const bad of ["\uD800", "\uDC00", "a\rb", String.fromCodePoint(0x20_28, 0x20_29)]) {
      expect(issueTag(SafeText, bad)).toBe("rejected");
    }
    for (const bad of ["\uD800", "\uDC00", "a\rb"]) {
      expect(issueTag(WireName, bad)).toBe("rejected");
    }
    for (const good of [
      ["a", "{b}c"].join("$"),
      "`\\",
      "text */ more",
      "first line\n  @deprecated forged tag",
      "😀",
    ]) {
      expect(issueTag(SafeText, good)).toBe("accepted");
    }
    for (const good of ["__proto__", "constructor", "prototype", ["a", "{b}c"].join("$"), "😀"]) {
      expect(issueTag(WireName, good)).toBe("accepted");
    }
    for (const good of ["__proto__", "constructor", "prototype"]) {
      expect(issueTag(HeaderName, good)).toBe("accepted");
    }
  });
});

describe("method-token allowlist", () => {
  test("has 35 unique uppercase entries", () => {
    expect(methodTokens.length).toBe(35);
    expect(new Set(methodTokens).size).toBe(35);
    for (const token of methodTokens) {
      expect(token.toUpperCase()).toBe(token);
    }
  });

  test("MethodToken accepts every allowlisted token and rejects others", () => {
    for (const token of methodTokens) {
      expect(issueTag(MethodToken, token)).toBe("accepted");
    }
    for (const bad of ["patch", "Query", "PTH-23", "BAD TOKEN", "", "FOO"]) {
      expect(issueTag(MethodToken, bad)).toBe("rejected");
    }
  });
});

describe("JsonPointer brand", () => {
  test("accepts exactly what parsePointer accepts", () => {
    for (const text of ["", "/", "//", "a", "/a~1b/m~0n", "/~", "/~2", "/~01", "/\uD800"]) {
      expect(Schema.is(JsonPointer)(text)).toBe(
        Exit.isSuccess(Effect.runSyncExit(parsePointer(text))),
      );
    }
  });
});
