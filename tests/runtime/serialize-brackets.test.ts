import { describe, expect, test } from "bun:test";
import { Effect, Runtime } from "effect";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";
import type { Json, Nested } from "../../src/runtime-src/runtime/serialize.ts";

const strict = { allowReserved: false, explode: true, required: false };

const brackets = { ...strict, brackets: true };

const query = (value: Nested, options: Serialize.QueryOptions = brackets) =>
  Effect.runPromise(Serialize.deepObject("a", value, options).expand);

const encode = (value: { readonly [property: string]: Json }, bracketed = true) =>
  Effect.runPromise(
    Serialize.urlEncode(value, {
      properties: [["a", { brackets: bracketed, style: "deepObject" }]],
    }),
  );

const expectUsage = async (effect: Effect.Effect<unknown, UsageError>) => {
  const error = await Effect.runPromise(Effect.flip(effect));

  expect(error).toBeInstanceOf(UsageError);
  expect(error[Runtime.errorExitCode]).toBe(2);

  return error.message;
};

// `{ k: { k: … { k: leaf } } }` with `depth` keys, so its one leaf sits `depth` brackets deep.
const nestedTo = (depth: number, leaf: string): Json => {
  let value: Json = leaf;

  for (let level = 0; level < depth; level += 1) {
    value = { k: value };
  }

  return value;
};

const sample = { b: { c: 1 }, d: [1, { e: "x y" }] };

describe("query deepObject with brackets", () => {
  test("each leaf is named by its path, brackets encoded, array members from 0", async () => {
    expect(await query(sample)).toBe(
      "a%5Bb%5D%5Bc%5D=1&a%5Bd%5D%5B0%5D=1&a%5Bd%5D%5B1%5D%5Be%5D=x%20y",
    );
  });

  test("a top-level array is indexed from 0", async () => {
    expect(await query([1, 2])).toBe("a%5B0%5D=1&a%5B1%5D=2");
  });

  test("an object with scalar members is sent as the one-level form", async () => {
    const flat = { B: 150, "G B": "x/y", R: true };

    expect(await query(flat)).toBe(await query(flat, strict));
  });

  test("an empty nested object or array adds no pair", async () => {
    expect(await query({ b: {}, c: 1, d: [] })).toBe("a%5Bc%5D=1");
    expect(await query({ b: {}, d: [] })).toBeUndefined();
    await expectUsage(Serialize.deepObject("a", { b: {} }, { ...brackets, required: true }).expand);
  });

  test("32 levels are sent and 33 are refused, naming the parameter and not the value", async () => {
    expect(await query(nestedTo(32, "leaf"))).toBe(`a${"%5Bk%5D".repeat(32)}=leaf`);

    const message = await expectUsage(
      Serialize.deepObject("filter", nestedTo(33, "secret-leaf"), brackets).expand,
    );

    expect(message).toContain("filter");
    expect(message).not.toContain("secret-leaf");
  });

  test("two leaves with one bracketed name are refused", async () => {
    await expectUsage(Serialize.deepObject("a", { b: { c: 1 }, "b][c": 2 }, brackets).expand);
  });

  test("a null leaf and a scalar top-level value are refused", async () => {
    await expectUsage(Serialize.deepObject("a", { b: { c: null } }, brackets).expand);
    await expectUsage(Serialize.deepObject("a", "x", brackets).expand);
  });

  test("without the option a nested value is still refused", async () => {
    await expectUsage(Serialize.deepObject("a", sample, strict).expand);
    await expectUsage(Serialize.deepObject("a", [1, 2], strict).expand);
  });
});

describe("form deepObject with brackets", () => {
  test("a body property uses the WHATWG encoder, so a space is +", async () => {
    expect(await encode({ a: sample })).toBe(
      "a%5Bb%5D%5Bc%5D=1&a%5Bd%5D%5B0%5D=1&a%5Bd%5D%5B1%5D%5Be%5D=x+y",
    );
  });

  test("an empty nested object adds no pair", async () => {
    expect(await encode({ a: { b: {}, c: "z" } })).toBe("a%5Bc%5D=z");
    expect(await encode({ a: { b: {} } })).toBe("");
  });

  test("depth 33 is refused, naming the property and not the value", async () => {
    const message = await expectUsage(
      Serialize.urlEncode(
        { filter: nestedTo(33, "secret-leaf") },
        { properties: [["filter", { brackets: true, style: "deepObject" }]] },
      ),
    );

    expect(message).toContain("filter");
    expect(message).not.toContain("secret-leaf");
  });

  test("a bracket pair named like a declared property is refused", async () => {
    await expectUsage(
      Serialize.urlEncode(
        { a: { b: { c: 1 } }, "a[b][c]": "x" },
        {
          properties: [
            ["a", { brackets: true, style: "deepObject" }],
            ["a[b][c]", {}],
          ],
        },
      ),
    );
  });

  test("without the option a nested value is still refused", async () => {
    await expectUsage(
      Serialize.urlEncode({ a: sample }, { properties: [["a", { style: "deepObject" }]] }),
    );
    await expectUsage(
      Serialize.urlEncode(
        { a: sample },
        { properties: [["a", { brackets: false, style: "deepObject" }]] },
      ),
    );
  });
});
