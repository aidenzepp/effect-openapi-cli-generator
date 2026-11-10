import { describe, expect, test } from "bun:test";
import { isSpecificationExtension } from "../../src/model/extension.ts";

describe("isSpecificationExtension", () => {
  test("x- marks a specification extension", () => {
    expect(["x-a", "x-"].map(isSpecificationExtension)).toEqual([true, true]);
    expect(["X-a", "-x", ""].map(isSpecificationExtension)).toEqual([false, false, false]);
  });
});
