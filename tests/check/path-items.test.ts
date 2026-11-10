import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { expressionsOf, pathItems } from "../../src/check/path-items.ts";
import { checkStructure } from "../../src/check/structure.ts";
import { ComponentName, DocumentUri } from "../../src/model/brands.ts";
import { resolve } from "../../src/resolve/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

describe("component names", () => {
  test("CMP-13 message names the component-name pattern", () => {
    const found = Effect.runSync(
      resolve({
        document: entry,
        line: "3.1",
        value: {
          components: { schemas: { "bad key": {} } },
          info: { title: "t", version: "1" },
          openapi: "3.1.2",
          paths: {},
        },
      }).pipe(Effect.flatMap(checkStructure)),
    );

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.message])).toEqual([
      ["CMP-13/invalid-key", "A component key is outside ^[a-zA-Z0-9.\\-_]+$."],
    ]);
  });
});

describe("ComponentName", () => {
  test("accepts letters, digits, '.', '-' and '_' and refuses anything else", () => {
    const isName = Schema.is(ComponentName);

    expect(["Pet.v1-x_y", "a", "0"].map(isName)).toEqual([true, true, true]);
    expect(["", "bad key", "a$b", "no/slash"].map(isName)).toEqual([false, false, false, false]);
  });
});

describe("expressionsOf", () => {
  test("returns expression names in order, repeats kept", () => {
    expect(expressionsOf("/a/{id}/{name}/{id}")).toEqual(["id", "name", "id"]);
    expect(expressionsOf("https://{host}:{port}/v1")).toEqual(["host", "port"]);
    expect(expressionsOf("/plain")).toEqual([]);
  });
});

describe("pathItems", () => {
  test("walks the entry paths in order and follows a path-item reference", () => {
    const resolution = Effect.runSync(
      resolve({
        document: entry,
        line: "3.1",
        value: {
          components: { pathItems: { Shared: { get: { responses: {} } } } },
          info: { title: "t", version: "1" },
          openapi: "3.1.2",
          paths: {
            "/a": { get: { responses: {} } },
            "/b": { $ref: "#/components/pathItems/Shared" },
          },
        },
      }),
    );

    expect(
      pathItems(resolution).map((item) => [item.key, item.use, item.pointer] as const),
    ).toEqual([
      ["/a", "/paths/~1a", "/paths/~1a"],
      ["/b", "/paths/~1b", "/components/pathItems/Shared"],
    ]);
  });
});
