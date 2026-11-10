import { describe, expect, test } from "bun:test";
import { fixedMethods, methodMembers, queryMethod } from "../../src/model/path-item.ts";

const fixed: readonly string[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];

describe("fixedMethods", () => {
  test("lists the fixed methods in the specification's order", () => {
    expect<readonly string[]>(fixedMethods).toEqual(fixed);
  });
});

describe("methodMembers", () => {
  test("is the fixed methods on 3.0 and 3.1", () => {
    expect(methodMembers("3.0")).toEqual(fixed);
    expect(methodMembers("3.1")).toEqual(fixed);
  });

  test("appends query after the fixed methods on 3.2", () => {
    expect(queryMethod).toBe("query");
    expect(methodMembers("3.2")).toEqual([...fixed, "query"]);
  });
});
