import { describe, expect, test } from "bun:test";
import { Array as Arr, Exit, Order, Schema } from "effect";
import {
  Api,
  Body,
  EncodingRule,
  Informational,
  MediaAlternative,
  Operation,
  Origin,
  Parameter,
  SchemaStore,
  SecurityPolicy,
  SecurityScheme,
  Serialization,
  Server,
  ResponseCase,
} from "../../src/model/entities.ts";
import { nonStandardUses } from "../../src/model/non-standard.ts";

type Plain = Record<string, Schema.Json>;

const origin = { document: "file:///spec.json", pointer: "/paths/~1users" };

const rows = ["PRM-01"];

const docs = { description: "Text." };

const schemaRef = { key: "User" };

const serialization = {
  allowReserved: false,
  explode: true,
  kind: "style",
  objectValued: false,
  origin,
  rows,
  rules: "rfc3986-3.1+",
  style: "form",
};

const partHeader = {
  deprecated: false,
  name: "X-Rate",
  required: false,
  schema: schemaRef,
  serialization: { ...serialization, explode: false, style: "simple" },
};

const encodingRule = {
  contentType: ["application/json"],
  headers: [partHeader],
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
  headers: [{ deprecated: false, name: "Retry-After", required: false }],
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
  source: "spec",
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
  tags: ["users", "admin"],
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

  test("an operation carries its tags in order and requires the field", () => {
    const decoded: { readonly tags: readonly unknown[] } =
      Schema.decodeUnknownSync(Operation)(operation);

    expect(decoded.tags).toEqual(["users", "admin"]);

    const { tags: _tags, ...untagged } = operation;

    expect(decodes(Operation, untagged)).toBe(false);
    expect(decodes(Operation, { ...operation, tags: [1] })).toBe(false);
    expect(decodes(Operation, { ...operation, tags: ["bad\u0000tag"] })).toBe(false);
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
      decodes(EncodingRule, { ...encodingRule, headers: [{ ...partHeader, name: "Bad Name" }] }),
    ).toBe(false);
  });

  test("a media alternative lists its refused fields in order, and absent means none", () => {
    const form = {
      ...mediaAlternative,
      codec: "form",
      mediaType: "application/x-www-form-urlencoded",
    };
    const refused = { ...form, refusedFields: ["metadata", "expand"] };
    const decoded = Schema.decodeUnknownSync(MediaAlternative)(refused);

    expect(decoded.refusedFields?.map(String)).toEqual(["metadata", "expand"]);
    expect(Schema.encodeSync(MediaAlternative)(decoded).refusedFields).toEqual([
      "metadata",
      "expand",
    ]);
    expect(Schema.decodeUnknownSync(MediaAlternative)(form).refusedFields).toBeUndefined();
    expect(decodes(MediaAlternative, { ...form, refusedFields: "metadata" })).toBe(false);
    expect(decodes(MediaAlternative, { ...form, refusedFields: [""] })).toBe(false);
  });

  test("an encoding rule's transfer encoding is base64 or absent", () => {
    expect(decodes(EncodingRule, { ...encodingRule, contentEncoding: "base64" })).toBe(true);
    expect(decodes(EncodingRule, { ...encodingRule, contentEncoding: "base64url" })).toBe(false);
  });

  test("a content serialization carries its querystring form rules, and states none explicitly", () => {
    const content = {
      kind: "content",
      mediaType: "application/x-www-form-urlencoded",
      origin,
      rows,
      rules: "oas-3.2",
      schema: schemaRef,
    };
    const formRule = {
      contentType: [],
      headers: [],
      origin,
      rows,
      serialization: { explode: false, style: "pipeDelimited" },
      target: { kind: "property", name: "ids" },
    };

    expect(decodes(Serialization, { ...content, encoding: [formRule] })).toBe(true);
    expect(decodes(Serialization, { ...content, encoding: [] })).toBe(true);
    expect(decodes(Serialization, content)).toBe(false);
    expect(
      decodes(Serialization, { ...content, encoding: [{ ...formRule, target: { kind: "x" } }] }),
    ).toBe(false);
  });

  test("a cookie or header apiKey name must be a token", () => {
    const cookie = (name: string) => ({
      ...securityScheme,
      kind: { in: "cookie", name, type: "apiKey" },
    });
    const header = { ...securityScheme, kind: { in: "header", name: "a; b", type: "apiKey" } };

    expect(decodes(SecurityScheme, cookie("sid"))).toBe(true);
    expect(decodes(SecurityScheme, cookie("a; admin=1"))).toBe(false);
    expect(decodes(SecurityScheme, header)).toBe(false);
    expect(
      decodes(SecurityScheme, { ...header, kind: { in: "header", name: "X-Key", type: "apiKey" } }),
    ).toBe(true);
  });

  test("the scalar marker is its own literal beside the bracket marker", () => {
    expect(
      decodes(Serialization, { ...serialization, nonStandardScalars: "deepObjectScalars" }),
    ).toBe(true);
    expect(
      decodes(EncodingRule, { ...encodingRule, nonStandardScalars: "deepObjectScalars" }),
    ).toBe(true);
    expect(
      decodes(Serialization, {
        ...serialization,
        nonStandard: "deepObjectBrackets",
        nonStandardScalars: "deepObjectScalars",
      }),
    ).toBe(true);
    expect(
      decodes(Serialization, { ...serialization, nonStandardScalars: "deepObjectBrackets" }),
    ).toBe(false);
    expect(decodes(EncodingRule, { ...encodingRule, nonStandard: "deepObjectScalars" })).toBe(
      false,
    );
    expect(Schema.decodeUnknownSync(EncodingRule)(encodingRule).nonStandardScalars).toBeUndefined();
  });
});

const style = (marks: Plain) =>
  Schema.decodeUnknownSync(Serialization)({ ...serialization, ...marks });

const choices = (marks: Plain) => nonStandardUses(style(marks)).map((use) => use.choice);

describe("non-standard use sites", () => {
  test("a scalar-marked style serialization is one use site with the scalar choice", () => {
    const marked = style({ nonStandardScalars: "deepObjectScalars" });

    expect(nonStandardUses(marked)).toEqual([
      { choice: "deepObjectScalars", origin: Schema.decodeUnknownSync(Origin)(origin) },
    ]);
  });

  test("each marker is its own use site, bracket choice first", () => {
    expect(choices({ nonStandard: "deepObjectBrackets" })).toEqual(["deepObjectBrackets"]);
    expect(
      choices({ nonStandard: "deepObjectBrackets", nonStandardScalars: "deepObjectScalars" }),
    ).toEqual(["deepObjectBrackets", "deepObjectScalars"]);
    expect(choices({})).toEqual([]);
  });

  test("querystring form rules give one use site per marker, at each rule's origin", () => {
    const ruleOrigin = { document: "file:///spec.json", pointer: "/paths/~1q/encoding/ids" };
    const content = Schema.decodeUnknownSync(Serialization)({
      encoding: [
        { contentType: [], headers: [], origin, rows, target: { kind: "property", name: "a" } },
        {
          contentType: [],
          headers: [],
          nonStandardScalars: "deepObjectScalars",
          origin: ruleOrigin,
          rows,
          target: { kind: "property", name: "ids" },
        },
      ],
      kind: "content",
      mediaType: "application/x-www-form-urlencoded",
      origin,
      rows,
      rules: "oas-3.2",
      schema: schemaRef,
    });

    expect(nonStandardUses(content)).toEqual([
      { choice: "deepObjectScalars", origin: Schema.decodeUnknownSync(Origin)(ruleOrigin) },
    ]);
  });
});
