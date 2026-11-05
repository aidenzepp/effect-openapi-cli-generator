import { describe, expect, test } from "bun:test";
import { Array as Arr, Exit, Order, Schema } from "effect";
import {
  Api,
  Body,
  EncodingRule,
  Informational,
  MediaAlternative,
  Operation,
  Parameter,
  SchemaStore,
  SecurityPolicy,
  SecurityScheme,
  Serialization,
  Server,
  ResponseCase,
} from "../../src/model/entities.ts";

type Plain = Record<string, Schema.Json>;

const origin = { document: "file:///spec.json", pointer: "/paths/~1users" };

const rows = ["PRM-01"];

const docs = { description: "Text." };

const schemaRef = { key: "User" };

const serialization = {
  allowReserved: false,
  explode: true,
  kind: "style",
  origin,
  rows,
  rules: "rfc3986-3.1+",
  style: "form",
};

const encodingRule = {
  contentType: ["application/json"],
  headers: [{ name: "X-Rate", required: false }],
  origin,
  rows,
  target: { kind: "property", name: "file" },
};

const mediaAlternative = {
  codec: "json",
  encoding: [encodingRule],
  mediaType: "application/json",
  origin,
  prefixEncoding: [],
  rows,
  schema: schemaRef,
};

const body = { alternatives: [mediaAlternative], docs, origin, required: true, rows };

const parameter = {
  deprecated: false,
  docs,
  location: "query",
  origin,
  required: false,
  rows,
  schema: schemaRef,
  serialization,
  wireName: "limit",
};

const responseCase = {
  alternatives: [mediaAlternative],
  docs,
  headers: [{ name: "Retry-After" }],
  key: { code: 200 },
  origin,
  rows,
};

const server = {
  accepted: true,
  level: "root",
  origin,
  origins: ["https://api.example.com"],
  rows,
  template: "https://{host}/v1",
  variables: [{ default: "api.example.com", name: "host" }],
};

const securityScheme = {
  credentialSources: ["flag"],
  deprecated: false,
  kind: { scheme: "bearer", type: "http" },
  name: "bearerAuth",
  origin,
  rows,
};

const securityPolicy = {
  alternatives: [{ uses: [{ scheme: "bearerAuth", scopes: [] }] }],
  declared: true,
  origin,
  rows,
};

const schemaStore = { document: { $defs: {} }, origin, rows };

const informational = { origin, reason: "Webhooks are read and counted only.", row: "CBK-01" };

const operation = {
  deprecated: false,
  docs,
  key: { method: "GET", path: "/users" },
  origin,
  parameters: [parameter],
  responses: [responseCase],
  rows,
  security: securityPolicy,
  servers: [server],
};

const api = {
  documents: ["file:///spec.json"],
  entry: "file:///spec.json",
  info: docs,
  informational: [informational],
  line: "3.1",
  openapi: "3.1.0",
  operations: [operation],
  origin,
  rows,
  schemas: schemaStore,
  securitySchemes: [securityScheme],
  servers: [server],
  tags: [{ name: "users" }],
};

const entities: readonly (readonly [string, Schema.Codec<unknown, unknown>, Plain])[] = [
  ["Api", Api, api],
  ["Operation", Operation, operation],
  ["Parameter", Parameter, parameter],
  ["Serialization", Serialization, serialization],
  ["Body", Body, body],
  ["MediaAlternative", MediaAlternative, mediaAlternative],
  ["EncodingRule", EncodingRule, encodingRule],
  ["ResponseCase", ResponseCase, responseCase],
  ["Server", Server, server],
  ["SecurityScheme", SecurityScheme, securityScheme],
  ["SecurityPolicy", SecurityPolicy, securityPolicy],
  ["SchemaStore", SchemaStore, schemaStore],
  ["Informational", Informational, informational],
];

const decodes = (codec: Schema.Codec<unknown, unknown>, input: Plain): boolean =>
  Exit.isSuccess(Schema.decodeUnknownExit(codec)(input));

const without = (input: Plain, key: string): Plain =>
  Object.fromEntries(Object.entries(input).filter(([name]) => name !== key));

const isJsonArray = Schema.is(Schema.Array(Schema.Json));

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

const keyOrderSorted = (value: Schema.Json): boolean => {
  if (isJsonArray(value)) {
    return value.every((item) => keyOrderSorted(item));
  }

  if (isJsonObject(value)) {
    const keys = Object.keys(value);
    const sorted = Arr.sort(keys, Order.String);
    const inOrder = keys.every((key, index) => key === sorted[index]);

    return inOrder && Object.values(value).every((item) => keyOrderSorted(item));
  }

  return true;
};

describe("model entities", () => {
  for (const [name, codec, valid] of entities) {
    test(`${name} decodes a minimal valid value`, () => {
      expect(decodes(codec, valid)).toBe(true);
    });

    test(`${name} encodes with alphabetical keys`, () => {
      const encoded = Schema.encodeUnknownSync(codec)(Schema.decodeUnknownSync(codec)(valid));
      expect(keyOrderSorted(Schema.decodeUnknownSync(Schema.Json)(encoded))).toBe(true);
    });
  }

  for (const [name, codec, valid] of entities) {
    test(`${name} rejects a value that is missing origin`, () => {
      expect(decodes(codec, without(valid, "origin"))).toBe(false);
    });
  }

  test("every row id field rejects a value that is not a row id", () => {
    for (const [, codec, valid] of entities) {
      if ("rows" in valid) {
        expect(decodes(codec, { ...valid, rows: ["not a row"] })).toBe(false);
      }
    }

    expect(decodes(Informational, { ...informational, row: "not a row" })).toBe(false);
  });

  test("brands are enforced on entity fields", () => {
    expect(decodes(Operation, { ...operation, key: { method: "FETCH", path: "/users" } })).toBe(
      false,
    );
    expect(decodes(Operation, { ...operation, key: { method: "GET", path: "users" } })).toBe(false);
    expect(decodes(Parameter, { ...parameter, wireName: "" })).toBe(false);
    expect(decodes(Server, { ...server, template: "https://{}/v1" })).toBe(false);
    expect(
      decodes(Body, { ...body, alternatives: [{ ...mediaAlternative, mediaType: "json" }] }),
    ).toBe(false);
    expect(
      decodes(EncodingRule, { ...encodingRule, headers: [{ name: "Bad Name", required: false }] }),
    ).toBe(false);
  });
});
