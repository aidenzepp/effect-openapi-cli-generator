import { describe, expect, test } from "bun:test";
import { Effect, Runtime } from "effect";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";
import type { Json, Nested } from "../../src/runtime-src/runtime/serialize.ts";

const strict = { allowReserved: false, explode: true, required: false };

const expand = (value: Nested, brackets: boolean) =>
  Serialize.deepObject("a", value, { ...strict, brackets }).expand;

const encode = (value: { readonly [property: string]: Json }, brackets: boolean) =>
  Serialize.urlEncode(value, { properties: [["a", { brackets, style: "deepObject" }]] });

const expectRefused = async (effect: Effect.Effect<unknown, UsageError>) => {
  const error = await Effect.runPromise(Effect.flip(effect));

  expect(error).toBeInstanceOf(UsageError);
  expect(error[Runtime.errorExitCode]).toBe(2);
  expect(error.message).toContain(" a has a member name with [ or ]");
  expect(error.message).not.toContain("SECRET");
};

describe("deepObject member keys with brackets", () => {
  for (const key of ["SECRET]b", "SECRET[b", "]", "[SECRET]"]) {
    test(`one-level key ${JSON.stringify(key)} is refused`, async () => {
      await expectRefused(expand({ [key]: "v" }, false));
    });

    test(`bracket-mode nested key ${JSON.stringify(key)} is refused`, async () => {
      await expectRefused(expand({ x: { [key]: "v" } }, true));
    });

    test(`form body key ${JSON.stringify(key)} is refused`, async () => {
      await expectRefused(encode({ a: { [key]: "v" } }, false));
    });
  }

  test("brackets in values are unaffected", async () => {
    expect(await Effect.runPromise(expand({ k: "a[b]" }, false))).toBe("a%5Bk%5D=a%5Bb%5D");
    expect(await Effect.runPromise(expand({ k: ["x]"] }, true))).toBe("a%5Bk%5D%5B0%5D=x%5D");
  });

  test("keys without brackets still expand", async () => {
    expect(await Effect.runPromise(expand({ k: 1 }, false))).toBe("a%5Bk%5D=1");
  });
});
