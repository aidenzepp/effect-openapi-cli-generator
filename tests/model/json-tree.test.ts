import { describe, expect, test } from "bun:test";
import { isObject, stringMember } from "../../src/model/json-tree.ts";

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
});
