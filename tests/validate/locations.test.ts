import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { groupErrors } from "../../src/validate/locations.ts";

const unit = (instanceLocation: string, keyword = "k") => ({
  absoluteKeywordLocation: `https://example.com/s#/${keyword}`,
  instanceLocation,
  keyword,
});

describe("groupErrors", () => {
  test("new pin: a deepest pointer reported twice yields one group holding both units in input order", async () => {
    const groups = await Effect.runPromise(
      groupErrors([unit("#/a", "first"), unit("#/b"), unit("#/a", "second")]),
    );

    expect(groups.map((group) => String(group.pointer))).toEqual(["/a", "/b"]);
    expect(groups[0]?.deepest.map((found) => found.keyword)).toEqual(["first", "second"]);
  });

  test("new pin: a context unit belongs to the first leaf in pointer order that contains it", async () => {
    const groups = await Effect.runPromise(
      groupErrors([unit("#/b/c"), unit("#", "root"), unit("#/a")]),
    );

    expect(groups.map((group) => String(group.pointer))).toEqual(["/a", "/b/c"]);
    expect(groups[0]?.context.map((found) => found.keyword)).toEqual(["root"]);
    expect(groups[1]?.context).toEqual([]);
  });

  test("new pin: leaves come out in pointer order", async () => {
    const groups = await Effect.runPromise(groupErrors([unit("#/c"), unit("#/a"), unit("#/b")]));

    expect(groups.map((group) => String(group.pointer))).toEqual(["/a", "/b", "/c"]);
  });
});
