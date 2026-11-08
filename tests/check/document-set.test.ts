import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { checkSpecText } from "../../src/check/index.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";

const uri = (value: string) => Schema.decodeUnknownSync(DocumentUri)(value);

const entry = uri("file:///spec/openapi.json");

const common = uri("file:///spec/common.json");

const responses: Json = { "200": { description: "ok" } };

const codes = (members: Record<string, Json>, fragment: Json): readonly string[] =>
  Effect.runSync(
    resolve({
      document: entry,
      line: "3.1",
      members: [{ document: common, value: fragment }],
      value: { info: { title: "t", version: "1" }, openapi: "3.1.2", paths: {}, ...members },
    }).pipe(Effect.flatMap(checkSpecText)),
  ).map((diagnostic) => `${diagnostic.code} ${diagnostic.pointer}`);

const cat = (required: readonly string[]): Json => ({
  components: {
    schemas: {
      Cat: { properties: { kind: { type: "string" } }, required, type: "object" },
    },
  },
});

const pets = (fragment: Json): readonly string[] =>
  codes(
    {
      components: {
        schemas: {
          Pet: {
            discriminator: { propertyName: "kind" },
            oneOf: [{ $ref: "common.json#/components/schemas/Cat" }],
          },
        },
      },
    },
    fragment,
  );

describe("spec-text checks across the document set", () => {
  test("a parameter from a second document is read there, so a repeat of it is found", () => {
    const found = codes(
      {
        paths: {
          "/a": {
            get: {
              parameters: [
                { in: "query", name: "limit", schema: { type: "integer" } },
                { $ref: "common.json#/components/parameters/Limit" },
              ],
              responses,
            },
          },
        },
      },
      { components: { parameters: { Limit: { in: "query", name: "limit", schema: {} } } } },
    );

    expect(found).toEqual(["PTH-28/duplicate-parameter /paths/~1a/get/parameters/1"]);
  });

  test("a discriminator branch from a second document is read there", () => {
    const propertyName = "/components/schemas/Pet/discriminator/propertyName";

    expect(pets(cat(["kind"]))).toEqual([]);
    expect(pets(cat([]))).toEqual([`DSC-09/property-not-required ${propertyName}`]);
  });
});
