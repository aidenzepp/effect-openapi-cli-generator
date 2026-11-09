import { describe, expect, test } from "bun:test";
import { Effect, Runtime } from "effect";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import { JsonNumber } from "../../src/runtime-src/runtime/input.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";
import type { FormEncoding, Json, Nested } from "../../src/runtime-src/runtime/serialize.ts";

const strict = { allowReserved: false, explode: true, required: false };

const scalars = { ...strict, scalars: true };

const both = { ...scalars, brackets: true };

const query = (value: Nested, options: Serialize.QueryOptions = scalars) =>
  Effect.runPromise(Serialize.deepObject("a", value, options).expand);

const deepObjectForm: FormEncoding = { scalars: true, style: "deepObject" };

const encode = (value: Json, encoding: FormEncoding = deepObjectForm) =>
  Effect.runPromise(Serialize.urlEncode({ a: value }, { properties: [["a", encoding]] }));

const expectUsage = async (effect: Effect.Effect<unknown, UsageError>) => {
  const error = await Effect.runPromise(Effect.flip(effect));

  expect(error).toBeInstanceOf(UsageError);
  expect(error[Runtime.errorExitCode]).toBe(2);

  return error.message;
};

// 2^53 + 1, which a JS number cannot hold.
const unsafe = "9007199254740993";

describe("query deepObject with scalars", () => {
  test("an empty string sends the name with an empty value", async () => {
    expect(await query("")).toBe("a=");
  });

  test("a string is sent as given, percent-encoded as a query value", async () => {
    expect(await query("now")).toBe("a=now");
    expect(await query("x y/z")).toBe("a=x%20y%2Fz");
    expect(await query("x/z", { ...scalars, allowReserved: true })).toBe("a=x/z");
  });

  test("numbers keep their digit text", async () => {
    expect(await query(1_700_000_000)).toBe("a=1700000000");
    expect(await query(new JsonNumber(unsafe))).toBe(`a=${unsafe}`);
  });

  test("a boolean is true or false", async () => {
    expect(await query(true)).toBe("a=true");
    expect(await query(false)).toBe("a=false");
  });

  test("an object keeps its rule", async () => {
    expect(await query({ k: "v" })).toBe("a%5Bk%5D=v");
  });

  test("with brackets too, a scalar is one pair and a nested object keeps the brackets", async () => {
    expect(await query("now", both)).toBe("a=now");
    expect(await query("", both)).toBe("a=");
    expect(await query({ a: { b: "v" } }, both)).toBe("a%5Ba%5D%5Bb%5D=v");
  });

  test("an array without brackets is refused", async () => {
    await expectUsage(Serialize.deepObject("a", [1, 2], scalars).expand);
  });

  test("without the option a scalar is refused", async () => {
    await expectUsage(Serialize.deepObject("a", "now", strict).expand);
    await expectUsage(Serialize.deepObject("a", "now", { ...strict, brackets: true }).expand);
  });
});

describe("form deepObject with scalars", () => {
  test("an empty string sends the name with an empty value", async () => {
    expect(await encode("")).toBe("a=");
  });

  test("a string is sent as given, WHATWG-encoded", async () => {
    expect(await encode("now")).toBe("a=now");
    expect(await encode("x y")).toBe("a=x+y");
  });

  test("numbers keep their digit text and a boolean is true or false", async () => {
    expect(await encode(1_700_000_000)).toBe("a=1700000000");
    expect(await encode(new JsonNumber(unsafe))).toBe(`a=${unsafe}`);
    expect(await encode(true)).toBe("a=true");
  });

  test("an object keeps its rule, and with brackets too a nested object", async () => {
    expect(await encode({ k: "v" })).toBe("a%5Bk%5D=v");
    expect(await encode({ a: { b: "v" } }, { ...deepObjectForm, brackets: true })).toBe(
      "a%5Ba%5D%5Bb%5D=v",
    );
    expect(await encode("now", { ...deepObjectForm, brackets: true })).toBe("a=now");
  });

  test("an array without brackets is refused", async () => {
    await expectUsage(Serialize.urlEncode({ a: [1, 2] }, { properties: [["a", deepObjectForm]] }));
  });

  test("without the option a scalar is refused", async () => {
    await expectUsage(
      Serialize.urlEncode({ a: "now" }, { properties: [["a", { style: "deepObject" }]] }),
    );
  });
});
