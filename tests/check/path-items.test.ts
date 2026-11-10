import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { checkStructure } from "../../src/check/structure.ts";
import { DocumentUri } from "../../src/model/brands.ts";
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
