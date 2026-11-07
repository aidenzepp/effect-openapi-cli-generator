import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Json } from "../../src/model/pointer.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";

// The 3.0 schema fixes of m2-s30fx, in process: a `default` that does not conform to its schema's
// type is refused at element scope (S30-27, D-OC3, D-SCH4), and the operation is still assembled.

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const config = {
  config: Schema.decodeUnknownSync(AuthorConfig)({
    binName: "s30",
    package: { name: "s30-fixes-cli", version: "0.1.0" },
  }),
  configDocument: Schema.decodeUnknownSync(DocumentUri)("file:///spec/author.json"),
};

// The refusals of one 3.0 operation whose JSON body property `size` has `size`, and whether the
// operation was assembled with its body.
const normalized = (size: Json) => {
  const value: Json = {
    info: { title: "t", version: "1" },
    openapi: "3.0.4",
    paths: {
      "/a": {
        post: {
          requestBody: {
            content: {
              "application/json": { schema: { properties: { size }, type: "object" } },
            },
            required: true,
          },
          responses: { "204": { description: "done" } },
        },
      },
    },
  };
  const resolution = Effect.runSync(resolve({ document: entry, line: "3.0", value }));
  const result = Effect.runSync(normalize(resolution, config));

  return {
    assembled: result.api.operations.map((operation) => operation.body !== undefined),
    refusals: [...resolution.diagnostics, ...result.diagnostics]
      .filter((diagnostic) => diagnostic.severity === "refusal")
      .map((diagnostic) => `${diagnostic.code} ${diagnostic.scope} ${diagnostic.pointer}`),
  };
};

describe("S30-27 a 3.0 default that does not conform to its type", () => {
  const at = "/paths/~1a/post/requestBody/content/application~1json/schema/properties/size";

  test("is refused at element scope; the operation keeps its body", () => {
    expect(normalized({ default: "x", type: "integer" })).toEqual({
      assembled: [true],
      refusals: [`S30-27/nonconforming-default element ${at}`],
    });
  });

  test("a conforming default is not refused", () => {
    expect(normalized({ default: 10, type: "integer" })).toEqual({
      assembled: [true],
      refusals: [],
    });
  });
});
