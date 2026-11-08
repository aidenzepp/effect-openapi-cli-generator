import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Json } from "../../src/model/pointer.ts";
import { normalizeParameter } from "../../src/normalize/parameters.ts";
import { resolve } from "../../src/resolve/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const outcome = (parameter: Json, schemas: Record<string, Json> = {}) => {
  const value: Json = {
    components: { schemas },
    info: { title: "t", version: "1" },
    openapi: "3.1.1",
    paths: {
      "/a": { get: { parameters: [parameter], responses: { "200": { description: "ok" } } } },
    },
  };
  const resolution = Effect.runSync(resolve({ document: entry, line: "3.1", value }));

  return Effect.runSync(
    normalizeParameter(resolution, { openapi: "3.1.1", pointer: "/paths/~1a/get/parameters/0" }),
  );
};

const holder = { $dynamicAnchor: "node", type: "string" };

const schemasUnderTest: readonly (readonly [string, Json, Record<string, Json>])[] = [
  ["a $dynamicRef", { $dynamicRef: "#node" }, {}],
  ["a $recursiveRef", { $recursiveRef: "#" }, {}],
  [
    "a $ref to a $dynamicAnchor holder",
    { $ref: "#/components/schemas/Holder" },
    { Holder: holder },
  ],
  [
    "a $ref to a $recursiveAnchor holder",
    { $ref: "#/components/schemas/Holder" },
    { Holder: { $recursiveAnchor: true, type: "string" } },
  ],
];

describe("a parameter whose schema reaches a dynamic or recursive keyword", () => {
  for (const [label, schema, schemas] of schemasUnderTest) {
    test(`a required query parameter with ${label} is refused and raises`, () => {
      const result = outcome({ in: "query", name: "q", required: true, schema }, schemas);
      expect(result).toMatchObject({ _tag: "Refused", required: true });
      expect(result.diagnostics).toEqual([]);
    });

    test(`an optional query parameter with ${label} is refused, never sent unchecked`, () => {
      const result = outcome({ in: "query", name: "q", schema }, schemas);
      expect(result).toMatchObject({ _tag: "Refused", required: false });
    });
  }

  test("a required path parameter is refused", () => {
    const result = outcome({
      in: "path",
      name: "id",
      required: true,
      schema: { $dynamicRef: "#node" },
    });
    expect(result).toMatchObject({ _tag: "Refused", required: true });
  });

  test("a content-entry schema is held to the same rule", () => {
    const result = outcome({
      content: { "application/json": { schema: { $dynamicRef: "#node" } } },
      in: "query",
      name: "q",
      required: true,
    });
    expect(result).toMatchObject({ _tag: "Refused", required: true });
  });

  test("a plain schema still builds", () => {
    const result = outcome({ in: "query", name: "q", schema: { type: "string" } });
    expect(result._tag).toBe("Implemented");
  });
});
