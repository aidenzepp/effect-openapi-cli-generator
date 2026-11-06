import { describe, expect, test } from "bun:test";
import { Effect, Predicate, Schema } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import { Api } from "../../src/model/entities.ts";
import { isArray, isObject } from "../../src/model/json-tree.ts";
import type { JsonObject } from "../../src/model/json-tree.ts";
import { normalize } from "../../src/normalize/index.ts";
import type { Normalization } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { ResolveMember } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";

const uri = (value: string) => Schema.decodeUnknownSync(DocumentUri)(value);

const entry = uri("file:///spec/openapi.json");

const common = uri("file:///spec/common.json");

const configUri = uri("file:///spec/author.json");

const config = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "example",
  package: { name: "example-cli", version: "1.0.0" },
});

const run = (paths: Json, members: readonly ResolveMember[] = []): Normalization =>
  Effect.runSync(
    resolve({
      document: entry,
      line: "3.1",
      members,
      value: { info: { title: "t", version: "1" }, openapi: "3.1.1", paths },
    }).pipe(
      Effect.flatMap((resolution) => normalize(resolution, { config, configDocument: configUri })),
    ),
  );

const pet: Json = {
  properties: { name: { pattern: "^a", type: "string" } },
  required: ["name"],
  type: "object",
};

const limit: Json = { in: "query", name: "limit", required: true, schema: { type: "integer" } };

const okResponse = (schema: Json): Json => ({
  content: { "application/json": { schema } },
  description: "ok",
  headers: { "Content-Type": { schema: { type: "string" } } },
});

// The schema, parameter and response live in a fragment beside the entry document.
const fragment: ResolveMember = {
  document: common,
  value: {
    components: {
      parameters: { Limit: limit },
      responses: { Ok: okResponse({ $ref: "#/components/schemas/Pet" }) },
      schemas: { Pet: pet },
    },
  },
};

const referenced: Json = {
  "/pets": {
    get: {
      parameters: [{ $ref: "common.json#/components/parameters/Limit" }],
      responses: { "200": { $ref: "common.json#/components/responses/Ok" } },
    },
    post: {
      requestBody: {
        content: {
          "application/json": { schema: { $ref: "common.json#/components/schemas/Pet" } },
        },
      },
      responses: { "204": { description: "done" } },
    },
  },
};

const inlined: Json = {
  "/pets": {
    get: { parameters: [limit], responses: { "200": okResponse(pet) } },
    post: {
      requestBody: { content: { "application/json": { schema: pet } } },
      responses: { "204": { description: "done" } },
    },
  },
};

// The model as plain JSON, as it is written out.
const encoded = (api: Api): Json =>
  Schema.decodeUnknownSync(Schema.Json)(Schema.encodeSync(Api)(api));

// The stored `$defs` of the model's schema document.
const defsOf = (model: Json): JsonObject => {
  const schemas = isObject(model) ? model.schemas : undefined;
  const document = isObject(schemas) ? schemas.document : undefined;
  const defs = isObject(document) ? document.$defs : undefined;

  return isObject(defs) ? defs : {};
};

// The operations with every schema reference replaced by the stored schema it names and every
// origin dropped, so the two documents compare by meaning rather than by where each element sits.
const meaning = (model: Json): Json => {
  const store = defsOf(model);
  const strip = (value: Json): Json => {
    if (isArray(value)) {
      return value.map(strip);
    }

    if (!isObject(value)) {
      return value;
    }

    const keys = Object.keys(value);
    const { key } = value;
    if (keys.length === 1 && Predicate.isString(key)) {
      // A key the store does not hold stays visible, so the two models differ.
      return Object.hasOwn(store, key) ? strip(store[key] ?? null) : { missing: key };
    }

    return Object.fromEntries(
      keys.filter((name) => name !== "origin").map((name) => [name, strip(value[name] ?? null)]),
    );
  };

  return strip(isObject(model) ? (model.operations ?? null) : null);
};

const located = (diagnostics: readonly Diagnostic[]): readonly string[] =>
  diagnostics.map(
    (diagnostic) => `${diagnostic.code} ${diagnostic.document}#${diagnostic.pointer}`,
  );

describe("normalization across the document set", () => {
  test("a schema, parameter and response from a second document normalize to the inlined model", () => {
    const across = run(referenced, [fragment]);
    const inline = run(inlined);

    expect(meaning(encoded(across.api))).toEqual(meaning(encoded(inline.api)));

    const [get] = across.api.operations;
    expect(get?.parameters.map((parameter) => String(parameter.wireName))).toEqual(["limit"]);
    expect(get?.responses.map((response) => response.alternatives.length)).toEqual([1]);
  });

  test("the store holds the schema roots a reference reaches in the member, under canonical keys", () => {
    const { api } = run(referenced, [fragment]);

    expect(Object.keys(defsOf(encoded(api)))).toEqual([
      "/paths/~1pets/post/requestBody/content/application~1json/schema",
      "file:///spec/common.json#/components/parameters/Limit/schema",
      "file:///spec/common.json#/components/responses/Ok/content/application~1json/schema",
      "file:///spec/common.json#/components/responses/Ok/headers/Content-Type/schema",
      "file:///spec/common.json#/components/schemas/Pet",
    ]);
    expect(api.documents).toEqual([entry, common]);
  });

  test("a diagnostic inside a member names that member's document and pointer", () => {
    const { diagnostics } = run(referenced, [fragment]);

    expect(located(diagnostics)).toEqual([
      "RSP-09/ignored-content-type file:///spec/common.json#/components/responses/Ok/headers/Content-Type",
      "SCH-37/not-asserted file:///spec/common.json#/components/schemas/Pet/properties/name/pattern",
    ]);
  });

  test("a single document normalizes as before: its diagnostics name the entry", () => {
    const { diagnostics } = run(inlined);

    expect(diagnostics.every((diagnostic) => diagnostic.document === entry)).toBe(true);
  });
});
