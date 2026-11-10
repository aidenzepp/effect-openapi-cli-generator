import { describe, expect, test } from "bun:test";
import { defsKeyOf, defsRefPrefix, maxDefsRefHops } from "../../src/model/defs-ref.ts";

describe("defsKeyOf", () => {
  test("unescapes ~1 and ~0 in the key", () => {
    expect(defsKeyOf("#/$defs/a~1b~0c")).toBe("a/b~c");
  });

  test("does not percent-decode the key", () => {
    expect(defsKeyOf("#/$defs/a%20b")).toBe("a%20b");
  });

  test("leaves an unknown escape as written", () => {
    expect(defsKeyOf("#/$defs/a~2")).toBe("a~2");
  });

  test("returns undefined outside the $defs prefix", () => {
    expect(defsKeyOf("#/components/x")).toBeUndefined();
  });

  test("exposes the prefix and hop limit", () => {
    expect(defsRefPrefix).toBe("#/$defs/");
    expect(maxDefsRefHops).toBe(64);
  });
});
