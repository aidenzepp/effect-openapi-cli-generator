import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { normalizeSchema } from "../src/core/schema.js";
import { resolveReference } from "../src/core/references.js";

const parse = (schema: Schema.Json, version: "3.0" | "3.1" = "3.1", document: Schema.Json = {}) =>
  Effect.runPromise(normalizeSchema(document, schema, "/schema", version));

const failure = async (schema: Schema.Json, location: string, version: "3.0" | "3.1" = "3.1") => {
  const error = await Effect.runPromise(
    Effect.flip(normalizeSchema({}, schema, "/schema", version)),
  );
  expect(error._tag).toBe("GenerationError");
  expect(error.location).toBe(location);
};

test("retains nested wire keys, extras policy and documentation without applying defaults", async () => {
  const input = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
    '{"type":"object","description":"outer","additionalProperties":false,"required":["__proto__"],"properties":{"__proto__":{"type":"object","properties":{"a/b":{"type":"string","default":"x","deprecated":true,"externalDocs":{"url":"https://example.test","description":"docs"}}}}}}',
  );
  const original = JSON.stringify(input);
  const result = await parse(input);
  expect(result.kind).toBe("object");
  if (result.kind !== "object") {
    return;
  }

  expect(result.additionalProperties).toBe(false);
  expect(result.docs.description).toBe("outer");
  expect(result.properties[0]?.name).toBe("__proto__");
  expect(result.properties[0]?.required).toBe(true);

  const nested = result.properties[0]?.schema;
  if (nested?.kind !== "object") {
    throw new Error("expected object");
  }

  expect(nested.additionalProperties).toBe(true);
  expect(nested.properties[0]?.schema.docs).toEqual({
    deprecated: true,
    externalDocs: { description: "docs", url: "https://example.test" },
  });
  expect(JSON.stringify(input)).toBe(original);
});

test("resolves escaped and percent encoded own-property pointers without changing active refs", async () => {
  const document = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
    '{"defs":{"a/b~c":{"type":"string"},"__proto__":{"type":"boolean"}}}',
  );
  const active = new Set<string>();
  const resolved = await Effect.runPromise(
    resolveReference(document, "#/defs/a~1b%7E0c", "/schema/$ref", active),
  );
  expect(resolved.value).toEqual({ type: "string" });
  expect(resolved.location).toBe("/defs/a~1b~0c");
  expect(active.size).toBe(0);

  const prototypeSchema = await parse({ $ref: "#/defs/__proto__" }, "3.1", document);
  expect(prototypeSchema.kind).toBe("boolean");
});

test("shared references are not cycles but recursive references are", async () => {
  const document = { defs: { loop: { $ref: "#/defs/loop" }, text: { type: "string" } } };
  const result = await parse(
    { properties: { a: { $ref: "#/defs/text" }, b: { $ref: "#/defs/text" } }, type: "object" },
    "3.1",
    document,
  );
  expect(result.kind).toBe("object");

  const error = await Effect.runPromise(
    Effect.flip(normalizeSchema(document, { $ref: "#/defs/loop" }, "/schema", "3.1")),
  );
  expect(error.location).toBe("/defs/loop/$ref");
});

test.each([
  "#/missing",
  "#/toString",
  "#/bad~2escape",
  "#/%FF",
  "https://example.test/schema",
  "#",
])("rejects invalid reference %s", async (ref) => {
  const error = await Effect.runPromise(
    Effect.flip(resolveReference({}, ref, "/schema/$ref", new Set())),
  );
  expect(error.location).toBe("/schema/$ref");
});

test("supports version-sensitive nullability and typed enums", async () => {
  expect(await parse({ enum: ["a", null], nullable: true, type: "string" }, "3.0")).toMatchObject({
    enum: ["a", null],
    kind: "string",
    nullable: true,
  });
  expect(await parse({ enum: [0, null], type: ["null", "integer"] })).toMatchObject({
    enum: [0, null],
    kind: "integer",
    nullable: true,
  });
  expect(await parse({ type: "null" })).toMatchObject({ kind: "null", nullable: true });
  expect(await parse({ items: { type: "boolean" }, type: "array" })).toMatchObject({
    items: { kind: "boolean" },
    kind: "array",
    nullable: false,
  });
});

test.each([
  [{ minimum: 1, type: "string" }, "/schema/minimum"],
  [{ format: "date", type: "string" }, "/schema/format"],
  [{ additionalProperties: { type: "string" }, type: "object" }, "/schema/additionalProperties"],
  [{ required: ["missing"], type: "object" }, "/schema/required/0"],
  [
    { properties: { a: { type: "string" } }, required: ["a", "a"], type: "object" },
    "/schema/required/1",
  ],
  [{ nullable: true, type: "string" }, "/schema/nullable"],
  [{ type: ["string", "number"] }, "/schema/type"],
  [{ enum: [1.5], type: "integer" }, "/schema/enum/0"],
  [{ enum: [null], type: "string" }, "/schema/enum/0"],
  [{ enum: ["a", "a"], type: "string" }, "/schema/enum/1"],
  [{ enum: [{}], type: "object" }, "/schema/enum"],
  [{ type: "array" }, "/schema/items"],
  [{ properties: {}, type: "string" }, "/schema/properties"],
  [
    { properties: { "a/b": { maximum: 2, type: "number" } }, type: "object" },
    "/schema/properties/a~1b/maximum",
  ],
  [true, "/schema"],
  [{ description: "missing" }, "/schema/type"],
])("rejects unsupported or malformed schema at exact pointer %#", async (schema, location) => {
  await failure(schema, location);
});

test("rejects validation siblings on refs while retaining descriptive siblings", async () => {
  const document = { defs: { text: { description: "base", type: "string" } } };
  expect(await parse({ $ref: "#/defs/text", description: "local" }, "3.1", document)).toMatchObject(
    { docs: { description: "local" } },
  );

  const error = await Effect.runPromise(
    Effect.flip(
      normalizeSchema(document, { $ref: "#/defs/text", type: "string" }, "/schema", "3.1"),
    ),
  );
  expect(error.location).toBe("/schema/type");
  await failure({ type: "null" }, "/schema/type", "3.0");
  await failure({ type: ["string", "null"] }, "/schema/type", "3.0");
});
