import { describe, expect, test } from "bun:test";
import {
  documentBase,
  resolveUri,
  retrievalBase,
  schemaBase,
  stripFragment,
} from "../../src/resolve/base-uri.ts";

const retrieval = "file:///spec/openapi.json#/info";

describe("resolveUri", () => {
  test("a relative path against an absolute base resolves", () => {
    expect(resolveUri("models.json#/A", "file:///spec/openapi.json")).toBe(
      "file:///spec/models.json#/A",
    );
  });

  test("a relative path against a urn: base does not resolve", () => {
    expect(resolveUri("models.json", "urn:example:spec")).toBeUndefined();
  });
});

describe("retrievalBase", () => {
  test("normalizes the retrieval URI and strips its fragment", () => {
    expect(retrievalBase("file:///spec/./a/../openapi.json#/x")).toBe("file:///spec/openapi.json");
  });

  test("keeps a retrieval URI that does not parse, without its fragment", () => {
    expect(retrievalBase("not a uri#frag")).toBe("not a uri");
  });
});

describe("documentBase", () => {
  const self = { $self: "https://example.com/api/root.json#top" };

  test.each(["3.0", "3.1"] as const)("%s ignores $self and uses the retrieval URI", (line) => {
    expect(documentBase(line, retrieval, self)).toBe("file:///spec/openapi.json");
    expect(documentBase(line, retrieval, {})).toBe("file:///spec/openapi.json");
  });

  test("3.2 without $self uses the retrieval URI", () => {
    expect(documentBase("3.2", retrieval, {})).toBe("file:///spec/openapi.json");
  });

  test("3.2 with $self resolves it against the retrieval URI and strips its fragment", () => {
    expect(documentBase("3.2", retrieval, self)).toBe("https://example.com/api/root.json");
    expect(documentBase("3.2", retrieval, { $self: "nested/root.json" })).toBe(
      "file:///spec/nested/root.json",
    );
  });

  test("3.2 with a $self that does not resolve has no base", () => {
    expect(documentBase("3.2", "urn:example:spec", { $self: "root.json" })).toBeUndefined();
  });
});

describe("schemaBase", () => {
  const enclosing = "file:///spec/openapi.json";

  test("3.0 has no $id and keeps the enclosing base", () => {
    expect(schemaBase("3.0", enclosing, { $id: "https://example.com/s.json" })).toBe(enclosing);
  });

  test.each(["3.1", "3.2"] as const)(
    "%s resolves $id against the enclosing base and strips its fragment",
    (line) => {
      expect(schemaBase(line, enclosing, { $id: "schemas/pet.json#x" })).toBe(
        "file:///spec/schemas/pet.json",
      );
      expect(schemaBase(line, enclosing, {})).toBe(enclosing);
    },
  );

  test("a $id that does not resolve has no base", () => {
    expect(schemaBase("3.1", "urn:example:spec", { $id: "pet.json" })).toBeUndefined();
  });
});

describe("fragments", () => {
  test("a fragment splits at the first # only", () => {
    expect(stripFragment("file:///a.json#/b#c")).toBe("file:///a.json");
    expect(stripFragment("file:///a.json")).toBe("file:///a.json");
  });
});
