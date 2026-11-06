import { describe, expect, test } from "bun:test";
import { Effect, Runtime } from "effect";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";
import type { Value } from "../../src/runtime-src/runtime/serialize.ts";

const base = { allowReserved: false, explode: true, required: false } as const;

const form30 = { ...base, line: "3.0", style: "form" } as const;

const form31 = { ...base, line: "3.1", style: "form" } as const;

const form32 = { ...base, line: "3.2", style: "form" } as const;

const style32 = { ...base, line: "3.2", style: "cookie" } as const;

const expand = (name: string, value: Value, options: Serialize.CookieOptions) =>
  Effect.runPromise(Serialize.cookie(name, value, options).expand);

const expectUsage = async (name: string, value: Value, options: Serialize.CookieOptions) => {
  const error = await Effect.runPromise(Effect.flip(Serialize.cookie(name, value, options).expand));

  expect(error).toBeInstanceOf(UsageError);
  expect(error).toMatchObject({ _tag: "UsageError" });
  expect(error[Runtime.errorExitCode]).toBe(2);
};

describe("cookie form on 3.0 and 3.1", () => {
  test.each([form30, form31])("encodes as RFC 6570 does", async (options) => {
    expect(await expand("c", "blue", options)).toBe("c=blue");
    expect(await expand("c", 42, options)).toBe("c=42");
    expect(await expand("c", "a b;c,d", options)).toBe("c=a%20b%3Bc%2Cd");
    expect(await expand("c", "é", options)).toBe("c=%C3%A9");
    expect(await expand("c", "", options)).toBe("c=");
  });

  test("allowReserved is not honored", async () => {
    expect(await expand("c", "a/b", { ...form31, allowReserved: true })).toBe("c=a%2Fb");
  });

  test("PRM-34: a non-exploded array or object is refused", async () => {
    await expectUsage("c", ["a", 2, true], { ...form31, explode: false });
    await expectUsage("c", { G: "x y", R: 100 }, { ...form30, explode: false });
  });

  test("PRM-34: an exploded array or object is refused", async () => {
    await expectUsage("c", ["a", "b"], form31);
    await expectUsage("c", { R: 100 }, form30);
  });
});

describe("cookie form on 3.2", () => {
  test("encodes as RFC 6570 does", async () => {
    expect(await expand("c", "a b;c,d", form32)).toBe("c=a%20b%3Bc%2Cd");
    expect(await expand("c", 7, form32)).toBe("c=7");
  });

  test("allowReserved passes reserved characters except , and ;", async () => {
    const reserved = { ...form32, allowReserved: true };

    expect(await expand("c", "a/b?c=d&e+f", reserved)).toBe("c=a/b?c=d&e+f");
    expect(await expand("c", 'a b;c,d"e\\f', reserved)).toBe("c=a%20b%3Bc%2Cd%22e%5Cf");
    expect(await expand("c", "é%41", reserved)).toBe("c=%C3%A9%41");
  });

  test("PRM-34: explode false and an exploded array or object are refused", async () => {
    await expectUsage("c", "x", { ...form32, explode: false });
    await expectUsage("c", ["a"], form32);
    await expectUsage("c", { R: 1 }, form32);
  });
});

describe("cookie style on 3.2", () => {
  test("sends text unencoded", async () => {
    expect(await expand("c", "blue", style32)).toBe("c=blue");
    expect(await expand("c", 3, style32)).toBe("c=3");
    expect(await expand("c", "a/b=c%20", style32)).toBe("c=a/b=c%20");
    expect(await expand("c", "", style32)).toBe("c=");
  });

  test("an exploded array repeats the name and an object sends its members", async () => {
    expect(await expand("c", ["blue", "black", 3], style32)).toBe("c=blue; c=black; c=3");
    expect(await expand("c", { B: 150, G: 200, R: 100 }, style32)).toBe("B=150; G=200; R=100");
  });

  test.each(["a;b", "a b", "a,b", 'a"b', "a\\b", "é", "a\tb"])("refuses %p", async (value) => {
    await expectUsage("c", value, style32);
    await expectUsage("c", [value], style32);
    await expectUsage("c", { k: value }, style32);
  });

  test("refuses explode false, a member name that is not a token, and a pre-3.2 line", async () => {
    await expectUsage("c", "x", { ...style32, explode: false });
    await expectUsage("c", { "a;b": 1 }, style32);
    await expectUsage("c", "x", { ...style32, line: "3.1" });
  });
});

describe("cookie undefined and refusals", () => {
  test.each([form31, form32, style32])("an undefined optional adds no pair", async (options) => {
    expect(await expand("c", undefined, options)).toBeUndefined();
    expect(await expand("c", null, options)).toBeUndefined();
    expect(await expand("c", [], options)).toBeUndefined();
    expect(await expand("c", {}, options)).toBeUndefined();
  });

  test.each([form31, form32, style32])("an undefined required one is refused", async (options) => {
    await expectUsage("c", undefined, { ...options, required: true });
    await expectUsage("c", [], { ...options, required: true });
  });

  test.each([form31, form32, style32])("a lone surrogate is refused", async (options) => {
    await expectUsage("c", "a\uD800", options);
    await expectUsage("c", ["\uDC00"], { ...options, explode: false });
  });

  test("a name that is not a token is refused", async () => {
    await expectUsage("a b", "x", form31);
    await expectUsage("a;b", "x", style32);
  });
});
