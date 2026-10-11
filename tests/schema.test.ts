import { expect, test } from "bun:test";
import { Effect } from "effect";
import { normalizeSchema } from "../src/schema.js";
import { resolveReference } from "../src/references.js";

const parse = (schema: unknown, version: "3.0" | "3.1" = "3.1", document: unknown = {}) =>
  Effect.runPromise(normalizeSchema(document, schema, "/schema", version));
const failure = (schema: unknown, location: string, version: "3.0" | "3.1" = "3.1") =>
  Effect.runPromise(Effect.flip(normalizeSchema({}, schema, "/schema", version))).then((error) => {
    expect(error._tag).toBe("GenerationError");
    expect(error.location).toBe(location);
  });

test("retains nested wire keys, extras policy and documentation without applying defaults", async () => {
  const input = JSON.parse(
    '{"type":"object","description":"outer","additionalProperties":false,"required":["__proto__"],"properties":{"__proto__":{"type":"object","properties":{"a/b":{"type":"string","default":"x","deprecated":true,"externalDocs":{"url":"https://example.test","description":"docs"}}}}}}',
  );
  const original = JSON.stringify(input);
  const result = await parse(input);
  expect(result.kind).toBe("object");
  if (result.kind !== "object") return;
  expect(result.additionalProperties).toBe(false);
  expect(result.docs.description).toBe("outer");
  expect(result.properties[0]?.name).toBe("__proto__");
  expect(result.properties[0]?.required).toBe(true);
  const nested = result.properties[0]?.schema;
  if (nested?.kind !== "object") throw new Error("expected object");
  expect(nested.additionalProperties).toBe(true);
  expect(nested.properties[0]?.schema.docs).toEqual({
    deprecated: true,
    externalDocs: { url: "https://example.test", description: "docs" },
  });
  expect(JSON.stringify(input)).toBe(original);
});

test("resolves escaped and percent encoded own-property pointers without changing active refs", async () => {
  const document = JSON.parse(
    '{"defs":{"a/b~c":{"type":"string"},"__proto__":{"type":"boolean"}}}',
  );
  const active = new Set<string>();
  const resolved = await Effect.runPromise(
    resolveReference(document, "#/defs/a~1b%7E0c", "/schema/$ref", active),
  );
  expect(resolved.value).toEqual({ type: "string" });
  expect(resolved.location).toBe("/defs/a~1b~0c");
  expect(active.size).toBe(0);
  expect((await parse({ $ref: "#/defs/__proto__" }, "3.1", document)).kind).toBe("boolean");
});

test("shared references are not cycles but recursive references are", async () => {
  const document = { defs: { text: { type: "string" }, loop: { $ref: "#/defs/loop" } } };
  const result = await parse(
    { type: "object", properties: { a: { $ref: "#/defs/text" }, b: { $ref: "#/defs/text" } } },
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
  expect(await parse({ type: "string", nullable: true, enum: ["a", null] }, "3.0")).toMatchObject({
    kind: "string",
    nullable: true,
    enum: ["a", null],
  });
  expect(await parse({ type: ["null", "integer"], enum: [0, null] })).toMatchObject({
    kind: "integer",
    nullable: true,
    enum: [0, null],
  });
  expect(await parse({ type: "null" })).toMatchObject({ kind: "null", nullable: true });
  expect(await parse({ type: "array", items: { type: "boolean" } })).toMatchObject({
    kind: "array",
    nullable: false,
    items: { kind: "boolean" },
  });
});

test.each([
  [{ type: "string", minimum: 1 }, "/schema/minimum"],
  [{ type: "string", format: "date" }, "/schema/format"],
  [{ type: "object", additionalProperties: { type: "string" } }, "/schema/additionalProperties"],
  [{ type: "object", required: ["missing"] }, "/schema/required/0"],
  [
    { type: "object", required: ["a", "a"], properties: { a: { type: "string" } } },
    "/schema/required/1",
  ],
  [{ type: "string", nullable: true }, "/schema/nullable"],
  [{ type: ["string", "number"] }, "/schema/type"],
  [{ type: "integer", enum: [1.5] }, "/schema/enum/0"],
  [{ type: "string", enum: [null] }, "/schema/enum/0"],
  [{ type: "string", enum: ["a", "a"] }, "/schema/enum/1"],
  [{ type: "object", enum: [{}] }, "/schema/enum"],
  [{ type: "array" }, "/schema/items"],
  [{ type: "string", properties: {} }, "/schema/properties"],
  [
    { type: "object", properties: { "a/b": { type: "number", maximum: 2 } } },
    "/schema/properties/a~1b/maximum",
  ],
  [true, "/schema"],
  [{ description: "missing" }, "/schema/type"],
])("rejects unsupported or malformed schema at exact pointer %#", async (schema, location) => {
  await failure(schema, location as string);
});

test("rejects validation siblings on refs while retaining descriptive siblings", async () => {
  const document = { defs: { text: { type: "string", description: "base" } } };
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
