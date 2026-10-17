import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { normalize } from "../src/core/normalize.js";
import { normalizeSchema } from "../src/core/schema.js";
import { schemaSource } from "../src/core/emit-schema.js";
import { setArray } from "../src/core/templates/query.js";

test("unconstrained request values and primitive type unions retain their JSON domains", async () => {
  const any = await Effect.runPromise(normalizeSchema({}, {}, "/schema", "3.1"));
  expect(schemaSource(any)).toBe("Schema.Json");

  const union = await Effect.runPromise(
    normalizeSchema({}, { type: ["string", "number", "boolean", "null"] }, "/schema", "3.1"),
  );
  expect(schemaSource(union)).toBe(
    "Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null])",
  );
});

test("form query arrays distinguish omission, empty arrays and scalar values", async () => {
  const request = HttpClientRequest.get("https://api.example.com").pipe(
    HttpClientRequest.setUrlParam("other", "retained"),
  );
  const omitted = await Effect.runPromise(setArray("items", undefined, false)(request));
  expect(omitted.urlParams.params).toEqual([["other", "retained"]]);

  const empty = await Effect.runPromise(Effect.flip(setArray("items", [], false)(request)));
  expect(empty.userMessage).toContain("cannot represent an empty array");

  const emptyItem = await Effect.runPromise(setArray("items", [""], false)(request));
  expect(emptyItem.urlParams.params).toEqual([
    ["items", ""],
    ["other", "retained"],
  ]);

  const scalar = await Effect.runPromise(setArray("items", [false, 0, "x"], false)(request));
  expect(scalar.urlParams.params).toEqual([
    ["items", "false,0,x"],
    ["other", "retained"],
  ]);

  const repeated = await Effect.runPromise(setArray("items", ["a,b", "c"], true)(request));
  expect(repeated.urlParams.params).toEqual([
    ["items", "a,b"],
    ["items", "c"],
    ["other", "retained"],
  ]);

  const failure = await Effect.runPromise(
    Effect.flip(setArray("items", ["private,a"], false)(request)),
  );
  expect(failure.userMessage).toContain("cannot be represented unambiguously");
  expect(failure.userMessage).not.toContain("private");
  expect(Schema.is(Schema.String)(failure.userMessage)).toBe(true);
});

test.each([
  { enum: ["value", 1], type: ["string", "number"] },
  { minLength: 2, type: ["string", "number"] },
])("multi-type union constraints fail explicitly instead of being dropped %#", async (schema) => {
  const failure = await Effect.runPromise(
    Effect.flip(normalizeSchema({}, schema, "/schema", "3.1")),
  );
  expect(failure.code).toBe("unsupported");
  expect(failure.message).toContain("Constraints alongside multi-type unions");
});

test("inbound webhooks are 3.1 object metadata, not outbound commands", async () => {
  const input = {
    info: { title: "API", version: "1" },
    openapi: "3.1.0",
    paths: {
      "/items": {
        get: {
          operationId: "list",
          responses: { "200": { description: "OK" } },
          "x-fern-sdk-group-name": "items",
        },
      },
    },
    webhooks: { incoming: {} },
  };
  const model = await Effect.runPromise(normalize(input));
  expect(model.operations).toHaveLength(1);
  expect(model.operations[0]?.path).toBe("/items");

  const wrongVersion = await Effect.runPromise(
    Effect.flip(normalize({ ...input, openapi: "3.0.3" })),
  );
  expect(wrongVersion.location).toBe("/webhooks");

  const invalidWebhooks = await Effect.runPromise(
    Effect.flip(normalize({ ...input, webhooks: [] })),
  );
  expect(invalidWebhooks.location).toBe("/webhooks");
});
