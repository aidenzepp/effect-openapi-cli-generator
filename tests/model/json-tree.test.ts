import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { foldJson, isObject, stringMember } from "../../src/model/json-tree.ts";
import type { JsonFold } from "../../src/model/json-tree.ts";
import type { Json } from "../../src/model/pointer.ts";

describe("isObject", () => {
  test("new pin: rejects null", () => {
    expect(isObject(null)).toBe(false);
  });

  test("new pin: rejects an array", () => {
    expect(isObject([1, "a"])).toBe(false);
  });

  test("new pin: accepts an object", () => {
    expect(isObject({ a: 1 })).toBe(true);
  });

  test("new pin: rejects a string", () => {
    expect(isObject("text")).toBe(false);
  });
});

describe("stringMember", () => {
  test("new pin: reads an own string member", () => {
    expect(stringMember({ name: "pets" }, "name")).toBe("pets");
  });

  test("new pin: returns undefined for an inherited name", () => {
    expect(stringMember({ name: "pets" }, "constructor")).toBeUndefined();
    expect(stringMember({ name: "pets" }, "__proto__")).toBeUndefined();
  });

  test("new pin: returns undefined for a non-string member", () => {
    expect(stringMember({ list: ["a"], name: 7, nested: { a: "b" } }, "name")).toBeUndefined();
    expect(stringMember({ list: ["a"] }, "list")).toBeUndefined();
    expect(stringMember({ nested: { a: "b" } }, "nested")).toBeUndefined();
  });

  test("new pin: returns undefined for a non-object value", () => {
    const values: readonly Json[] = ["name", 1, true, null, ["name"]];
    for (const value of values) {
      expect(stringMember(value, "name")).toBeUndefined();
    }
  });
});

describe("foldJson", () => {
  // Records every node as "<kind> <tokens joined by />" in the order the fold returns them.
  const visits: JsonFold<readonly string[]> = {
    array: (items, tokens) => [...items.flat(), `array /${tokens.join("/")}`],
    leaf: (value, tokens) => [`leaf /${tokens.join("/")} ${JSON.stringify(value)}`],
    object: (members, tokens) => [
      ...members.flatMap(({ folded, key }) => [`key ${key}`, ...folded]),
      `object /${tokens.join("/")}`,
    ],
  };

  test("foldJson visits members in document order", () => {
    // Parsed from text so the keys keep an unsorted document order.
    const value = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
      '{"z": 1, "a": [true, {"y": null, "b": "x"}], "m": []}',
    );

    expect(foldJson(value, visits)).toEqual([
      "key z",
      "leaf /z 1",
      "key a",
      "leaf /a/0 true",
      "key y",
      "leaf /a/1/y null",
      "key b",
      'leaf /a/1/b "x"',
      "object /a/1",
      "array /a",
      "key m",
      "array /m",
      "object /",
    ]);
  });

  test("starts from the given tokens and passes a member's own value", () => {
    const keys: JsonFold<readonly string[]> = {
      array: (items) => items.flat(),
      leaf: () => [],
      object: (members, tokens) =>
        members.flatMap(({ folded, key, value }) => [
          `/${[...tokens, key].join("/")}=${JSON.stringify(value)}`,
          ...folded,
        ]),
    };

    expect(foldJson({ a: { b: 2 } }, keys, ["root", "0"])).toEqual([
      '/root/0/a={"b":2}',
      "/root/0/a/b=2",
    ]);
  });
});
