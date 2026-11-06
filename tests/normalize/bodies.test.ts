import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import type { EncodingRule, MediaAlternative } from "../../src/model/entities.ts";
import { BodyNodeBudget, BodyNotReadable, normalizeBody } from "../../src/normalize/bodies.ts";
import type { BodyOutcome } from "../../src/normalize/bodies.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

const specVersion: Record<Line, string> = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.1" };

const lines: readonly Line[] = ["3.0", "3.1", "3.2"];

const site = "/paths/~1a/post/requestBody";

interface Members {
  readonly [key: string]: Json;
}

const documentOf = (line: Line, requestBody: Json, components: Members = {}): Json => ({
  components,
  info: { title: "t", version: "1" },
  openapi: openapi[line],
  paths: {
    "/a": { post: { requestBody, responses: { "200": { description: "ok" } } } },
  },
});

const normalize = (line: Line, requestBody: Json, components: Members = {}): BodyOutcome => {
  const value = documentOf(line, requestBody, components);
  const resolution = Effect.runSync(resolve({ document: entry, line, value }));

  return Effect.runSync(normalizeBody(resolution, { openapi: openapi[line], pointer: site }));
};

const implemented = (line: Line, requestBody: Json, components: Members = {}) => {
  const outcome = normalize(line, requestBody, components);
  if (outcome._tag !== "Implemented") {
    throw new Error(`expected Implemented, got ${outcome._tag}`);
  }

  return outcome;
};

const refused = (line: Line, requestBody: Json) => {
  const outcome = normalize(line, requestBody);
  if (outcome._tag !== "Refused") {
    throw new Error(`expected Refused, got ${outcome._tag}`);
  }

  return outcome;
};

const codes = (outcome: BodyOutcome): readonly string[] =>
  outcome.diagnostics.map((diagnostic) => diagnostic.code);

const plain = (value: string | undefined): string | undefined => value;

const only = <T>(values: readonly T[]): T => {
  const [first] = values;
  if (first === undefined || values.length !== 1) {
    throw new Error(`expected exactly one value, got ${values.length}`);
  }

  return first;
};

const alternativeOf = (line: Line, mediaType: string, media: Json = {}): MediaAlternative =>
  only(implemented(line, { content: { [mediaType]: media } }).body.alternatives);

const targetOf = (rule: EncodingRule): string =>
  rule.target.kind === "property" ? rule.target.name : `#${rule.target.index}`;

const typesOf = (rules: readonly EncodingRule[]): Record<string, string[]> =>
  Object.fromEntries(rules.map((rule) => [targetOf(rule), rule.contentType.map(String)]));

const multipart = (schema: Json, extra: Members = {}): Members => ({
  content: { "multipart/form-data": { schema, ...extra } },
});

const object = (properties: Members, extra: Members = {}): Json => ({
  properties,
  type: "object",
  ...extra,
});

const string: Json = { type: "string" };

const mixed = (media: Members): Json => ({ content: { "multipart/mixed": media } });

const extra = (additionalProperties: Json): Members =>
  multipart(object({ file: { format: "binary", type: "string" } }, { additionalProperties }));

describe("RQB-03 codec is derived from the media type, never from the schema", () => {
  const families: readonly (readonly [string, string])[] = [
    ["application/json", "json"],
    ["application/json; charset=utf-8", "json"],
    ["application/vnd.api+json", "json"],
    ["text/plain", "text"],
    ["text/csv", "text"],
    ["application/octet-stream", "binary"],
    ["image/png", "binary"],
    ["*/*", "binary"],
    ["image/*", "binary"],
    ["application/xml", "xml"],
    ["text/xml", "xml"],
    ["application/atom+xml", "xml"],
    ["text/event-stream", "sse"],
    ["application/x-ndjson", "ndjson"],
    ["application/jsonl", "ndjson"],
    ["application/json-seq", "jsonseq"],
    ["application/geo+json-seq", "jsonseq"],
    ["multipart/form-data", "multipart"],
    ["multipart/mixed", "multipart"],
  ];

  for (const [mediaType, codec] of families) {
    test(`${mediaType} is ${codec} on every line`, () => {
      for (const line of lines) {
        const media: Json = mediaType.startsWith("multipart/") ? { schema: object({}) } : {};
        expect(plain(alternativeOf(line, mediaType, media).codec)).toBe(codec);
      }
    });
  }

  test("a JSON schema does not make a binary or text media type JSON", () => {
    expect(alternativeOf("3.1", "application/octet-stream", { schema: object({}) }).codec).toBe(
      "binary",
    );
    expect(alternativeOf("3.1", "text/plain", { schema: object({}) }).codec).toBe("text");
  });

  test("alternatives keep document order and the media type as written", () => {
    const content = Object.fromEntries(
      ["text/plain", "application/json", "image/*"].map((key) => [key, {}]),
    );
    const { body } = implemented("3.1", { content });

    expect(body.alternatives.map((alternative) => String(alternative.mediaType))).toEqual([
      "text/plain",
      "application/json",
      "image/*",
    ]);
  });
});

describe("RQB-01 RQB-04 body facts and schema references", () => {
  test("required defaults to false and rows name the request body rules", () => {
    const { body } = implemented("3.1", { content: { "application/json": {} } });

    expect(body.required).toBe(false);
    expect(body.rows.map(String)).toEqual(["RQB-01", "RQB-03", "RQB-04"]);
    expect(String(body.origin.pointer)).toBe(site);
  });

  test("required and description are read", () => {
    const { body } = implemented("3.1", {
      content: { "application/json": {} },
      description: "The thing",
      required: true,
    });

    expect(body.required).toBe(true);
    expect(plain(body.docs.description)).toBe("The thing");
  });

  test("an inline schema is keyed by its pointer and a component by its name", () => {
    const inline = alternativeOf("3.1", "application/json", { schema: string });
    const named = only(
      implemented(
        "3.1",
        { content: { "application/json": { schema: { $ref: "#/components/schemas/Point" } } } },
        { schemas: { Point: { type: "object" } } },
      ).body.alternatives,
    );

    expect(inline.schema?.key).toBe("/paths/~1a/post/requestBody/content/application~1json/schema");
    expect(named.schema?.key).toBe("Point");
  });

  test("RQB-09 RQB-10 a media type without a schema carries none", () => {
    for (const line of lines) {
      const alternative = alternativeOf(line, "image/png");

      expect(alternative.schema).toBeUndefined();
      expect(alternative.rows.map(String)).toContain(line === "3.0" ? "RQB-10" : "RQB-09");
    }
  });

  test("a reusable request body resolves, the use site is the operation and the target is related", () => {
    const outcome = implemented(
      "3.1",
      { $ref: "#/components/requestBodies/Thing" },
      {
        requestBodies: {
          Thing: {
            content: { "application/json": {}, "multipart/form-data": {} },
            description: "Shared",
          },
        },
      },
    );
    const diagnostic = only(outcome.diagnostics);

    expect(outcome.body.alternatives.map((alternative) => alternative.codec)).toEqual(["json"]);
    expect(plain(outcome.body.docs.description)).toBe("Shared");
    expect(String(outcome.body.origin.pointer)).toBe(site);
    expect(String(diagnostic.pointer)).toBe(site);
    expect(diagnostic.related?.map((related) => String(related.pointer))).toEqual([
      "/components/requestBodies/Thing/content/multipart~1form-data",
    ]);
    expect(diagnostic.code).toBe("ENC-33/missing-schema");
  });

  test("RQB-07 an empty content map leaves nothing to send and is refused", () => {
    for (const line of lines) {
      const outcome = refused(line, { content: {}, required: true });

      expect(codes(outcome)).toEqual(["RQB-07/empty-content"]);
      expect(outcome.required).toBe(true);
      expect(outcome.diagnostics.map((diagnostic) => diagnostic.scope)).toEqual(["element"]);
    }
  });

  test("MED-24 a key that is not a media range is refused and the others stay", () => {
    const outcome = implemented("3.1", { content: { "not a media type": {}, "text/plain": {} } });

    expect(codes(outcome)).toEqual(["MED-24/invalid-media-type"]);
    expect(outcome.body.alternatives.map((alternative) => String(alternative.mediaType))).toEqual([
      "text/plain",
    ]);
  });
});

describe("ENC-17 to ENC-26 the default contentType table", () => {
  const properties: Members = {
    binary: { format: "binary", type: "string" },
    byte: { format: "byte", type: "string" },
    encoded: { contentEncoding: "base64", type: "string" },
    flag: { type: "boolean" },
    int: { type: "integer" },
    list: { items: { type: "integer" }, type: "array" },
    nothing: { type: "null" },
    num: { type: "number" },
    obj: { type: "object" },
    text: string,
    untyped: {},
  };

  const typesFor = (line: Line) =>
    typesOf(alternativeOf(line, "multipart/form-data", { schema: object(properties) }).encoding);

  test("3.0.4 treats format binary and byte as octet-stream and an untyped value like 3.1", () => {
    expect(typesFor("3.0")).toEqual({
      binary: ["application/octet-stream"],
      byte: ["application/octet-stream"],
      encoded: ["text/plain"],
      flag: ["text/plain"],
      int: ["text/plain"],
      list: ["text/plain"],
      nothing: ["text/plain"],
      num: ["text/plain"],
      obj: ["application/json"],
      text: ["text/plain"],
      untyped: ["application/octet-stream"],
    });
  });

  test("3.1 reads contentEncoding, not format, and types an array by its items", () => {
    expect(typesFor("3.1")).toEqual({
      binary: ["text/plain"],
      byte: ["text/plain"],
      encoded: ["application/octet-stream"],
      flag: ["text/plain"],
      int: ["text/plain"],
      list: ["text/plain"],
      nothing: ["text/plain"],
      num: ["text/plain"],
      obj: ["application/json"],
      text: ["text/plain"],
      untyped: ["application/octet-stream"],
    });
  });

  test("3.2 types every array as application/json", () => {
    expect(typesFor("3.2").list).toEqual(["application/json"]);
  });

  test("an array of binary items is octet-stream in 3.0 by format and in 3.1 by type absent", () => {
    const files: Json = { items: { format: "binary", type: "string" }, type: "array" };
    const typesIn = (line: Line) =>
      typesOf(alternativeOf(line, "multipart/form-data", { schema: object({ files }) }).encoding);

    expect(typesIn("3.0")).toEqual({ files: ["application/octet-stream"] });
    expect(typesIn("3.1")).toEqual({ files: ["text/plain"] });
  });

  test("a type list ignores null and a disagreeing list falls back to octet-stream", () => {
    const types = typesOf(
      alternativeOf("3.1", "multipart/form-data", {
        schema: object({
          maybe: { type: ["string", "null"] },
          mixed: { type: ["string", "object"] },
        }),
      }).encoding,
    );

    expect(types).toEqual({ maybe: ["text/plain"], mixed: ["application/octet-stream"] });
  });

  test("properties are found through a reference and allOf, in document order", () => {
    const alternative = only(
      implemented(
        "3.1",
        {
          content: {
            "multipart/form-data": {
              schema: { allOf: [{ $ref: "#/components/schemas/Base" }, object({ b: string })] },
            },
          },
        },
        { schemas: { Base: object({ a: { type: "integer" } }) } },
      ).body.alternatives,
    );

    expect(alternative.encoding.map(targetOf)).toEqual(["a", "b"]);
  });

  test("rule rows carry the default row of the table", () => {
    const alternative = alternativeOf("3.1", "multipart/form-data", {
      schema: object({ obj: { type: "object" }, untyped: {} }),
    });

    expect(alternative.encoding.map((rule) => rule.rows.map(String))).toEqual([
      ["ENC-01", "ENC-22"],
      ["ENC-01", "ENC-17"],
    ]);
  });
});

describe("ENC-02 ENC-03 ENC-11 ENC-13 explicit encoding", () => {
  test("a comma-separated contentType becomes a list of ranges", () => {
    const alternative = alternativeOf("3.1", "multipart/form-data", {
      encoding: { file: { contentType: "image/png, image/*" } },
      schema: object({ file: { format: "binary", type: "string" } }),
    });

    expect(typesOf(alternative.encoding)).toEqual({ file: ["image/png", "image/*"] });
    expect(only(alternative.encoding).rows.map(String)).toEqual(["ENC-01", "ENC-02"]);
  });

  test("an unparsable contentType refuses the alternative", () => {
    const outcome = refused(
      "3.1",
      multipart(object({ file: string }), {
        encoding: { file: { contentType: "image png" } },
      }),
    );

    expect(codes(outcome)).toEqual(["ENC-02/invalid-content-type"]);
  });

  test("an explicit style makes the part a schema-style value and contentType is ignored", () => {
    const outcome = implemented(
      "3.1",
      multipart(object({ tags: { items: string, type: "array" } }), {
        encoding: { tags: { contentType: "text/plain", explode: false, style: "form" } },
      }),
    );
    const rule = only(only(outcome.body.alternatives).encoding);

    expect(rule.serialization).toEqual({ explode: false, style: "form" });
    expect(rule.contentType).toEqual([]);
    expect(codes(outcome)).toEqual(["ENC-13/content-type-ignored"]);
    expect(rule.rows.map(String)).toEqual(["ENC-01", "ENC-04", "ENC-05", "ENC-13"]);
  });

  test("allowReserved alone is explicit and keeps only the fields given", () => {
    const outcome = implemented(
      "3.2",
      multipart(object({ q: string }), {
        encoding: { q: { allowReserved: true } },
      }),
    );
    const rule = only(only(outcome.body.alternatives).encoding);

    expect(rule.serialization).toEqual({ allowReserved: true });
    expect(rule.contentType).toEqual([]);
    expect(codes(outcome)).toEqual([]);
  });

  test("ENC-12 3.0.4 applies style fields to form-urlencoded only, so multipart ignores them", () => {
    const outcome = implemented(
      "3.0",
      multipart(object({ q: string }), {
        encoding: { q: { style: "form" } },
      }),
    );
    const rule = only(only(outcome.body.alternatives).encoding);

    expect(rule.serialization).toBeUndefined();
    expect(rule.contentType.map(String)).toEqual(["text/plain"]);
    expect(codes(outcome)).toEqual(["ENC-12/style-ignored"]);
  });

  test("ENC-12 style fields on multipart/mixed are ignored in every line", () => {
    const outcome = implemented("3.1", {
      content: {
        "multipart/mixed": {
          encoding: { q: { explode: true } },
          schema: object({ q: string }),
        },
      },
    });

    expect(codes(outcome)).toEqual(["ENC-12/style-ignored"]);
  });

  test("part headers keep their names and required flags, Content-Type is ignored", () => {
    const outcome = implemented(
      "3.1",
      multipart(object({ file: string }), {
        encoding: {
          file: {
            headers: {
              "Content-Type": { schema: string },
              "X-Rate": { required: true, schema: string },
              "X-Trace": { $ref: "#/components/headers/Trace" },
            },
          },
        },
      }),
      { headers: { Trace: { required: true, schema: string } } },
    );
    const rule = only(only(outcome.body.alternatives).encoding);

    expect(rule.headers.map((header) => [String(header.name), header.required])).toEqual([
      ["X-Rate", true],
      ["X-Trace", true],
    ]);
    expect(codes(outcome)).toEqual(["ENC-11/content-type-header-ignored"]);
  });

  test("a header name that is not a token refuses the alternative", () => {
    const outcome = refused(
      "3.1",
      multipart(object({ file: string }), {
        encoding: { file: { headers: { "X Bad": { schema: string } } } },
      }),
    );

    expect(codes(outcome)).toEqual(["ENC-03/invalid-header-name"]);
  });

  test("MED-11 3.0 and 3.1 refuse an encoding key with no schema property", () => {
    for (const line of ["3.0", "3.1"] as const) {
      const outcome = refused(
        line,
        multipart(object({ a: string }), {
          encoding: { missing: { contentType: "text/plain" } },
        }),
      );

      expect(codes(outcome)).toEqual(["MED-11/unknown-property"]);
    }
  });

  test("MED-12 3.2 ignores an encoding key with no property and says so", () => {
    const outcome = implemented(
      "3.2",
      multipart(object({ a: string }), {
        encoding: { missing: { contentType: "text/plain" } },
      }),
    );

    expect(codes(outcome)).toEqual(["MED-12/absent-property-ignored"]);
    expect(only(outcome.body.alternatives).encoding.map(targetOf)).toEqual(["a"]);
  });

  test("MED-10 MED-14 encoding on a non-multipart media type is ignored with a notice", () => {
    const json: Json = {
      content: { "application/json": { encoding: { a: {} }, schema: object({ a: string }) } },
    };

    expect(codes(implemented("3.1", json))).toEqual(["MED-10/encoding-ignored"]);
    expect(codes(implemented("3.2", json))).toEqual(["MED-14/encoding-ignored"]);
    expect(only(implemented("3.1", json).body.alternatives).encoding).toEqual([]);
  });

  test("ENC-33 3.0 and 3.1 require a schema for multipart, 3.2 does not", () => {
    for (const line of ["3.0", "3.1"] as const) {
      expect(codes(refused(line, { content: { "multipart/form-data": {} } }))).toEqual([
        "ENC-33/missing-schema",
      ]);
    }

    expect(
      only(implemented("3.2", { content: { "multipart/form-data": {} } }).body.alternatives)
        .encoding,
    ).toEqual([]);
  });
});

describe("MED-07 MED-08 MED-13 3.2 positional and nested encoding", () => {
  test("prefixEncoding and itemEncoding give positional rules with defaults from the schema", () => {
    const alternative = only(
      implemented(
        "3.2",
        mixed({
          itemEncoding: {},
          prefixEncoding: [{ contentType: "text/csv" }, {}],
          schema: {
            items: { format: "binary", type: "string" },
            prefixItems: [string, { type: "object" }],
            type: "array",
          },
        }),
      ).body.alternatives,
    );

    expect(typesOf(alternative.prefixEncoding)).toEqual({
      "#0": ["text/csv"],
      "#1": ["application/json"],
    });
    expect(
      alternative.itemEncoding === undefined ? undefined : targetOf(alternative.itemEncoding),
    ).toBe("#2");
    expect(alternative.itemEncoding?.contentType.map(String)).toEqual(["text/plain"]);
    expect(alternative.encoding).toEqual([]);
    expect(alternative.rows.map(String)).toEqual(["MED-01", "MED-02", "MED-07", "MED-08"]);
  });

  test("itemEncoding takes its default from itemSchema and keeps the itemSchema key", () => {
    const alternative = only(
      implemented(
        "3.2",
        mixed({
          itemEncoding: {},
          itemSchema: { type: "integer" },
        }),
      ).body.alternatives,
    );

    expect(alternative.itemSchema?.key).toBe(
      "/paths/~1a/post/requestBody/content/multipart~1mixed/itemSchema",
    );
    expect(alternative.itemEncoding?.contentType.map(String)).toEqual(["text/plain"]);
    expect(alternative.itemEncoding?.rows.map(String)).toEqual(["ENC-01", "ENC-21"]);
    expect(alternative.rows.map(String)).toEqual(["MED-01", "MED-03", "MED-08"]);
  });

  test("MED-13 encoding beside prefixEncoding or itemEncoding refuses the alternative", () => {
    const outcome = refused(
      "3.2",
      mixed({
        encoding: { a: {} },
        itemEncoding: {},
        schema: object({ a: string }),
      }),
    );

    expect(codes(outcome)).toEqual(["MED-13/encoding-with-positional"]);
  });

  test("ENC-07 ENC-08 one nested level is kept, by name and by position", () => {
    const outcome = implemented(
      "3.2",
      multipart(object({ batch: { type: "object" } }), {
        encoding: {
          batch: {
            contentType: "multipart/mixed",
            encoding: { note: { contentType: "text/csv" } },
            prefixEncoding: [{ contentType: "image/png" }],
          },
        },
      }),
    );
    const rule = only(only(outcome.body.alternatives).encoding);

    expect(rule.contentType.map(String)).toEqual(["multipart/mixed"]);
    expect(
      rule.nested?.map((nested) => [
        nested.target.kind === "property" ? nested.target.name : String(nested.target.index),
        nested.contentType.map(String),
      ]),
    ).toEqual([
      ["note", ["text/csv"]],
      ["0", ["image/png"]],
    ]);
    expect(codes(outcome)).toEqual([]);
  });

  test("ENC-16 a second nested level is refused", () => {
    const outcome = refused(
      "3.2",
      multipart(object({ batch: { type: "object" } }), {
        encoding: {
          batch: {
            contentType: "multipart/mixed",
            encoding: { note: { contentType: "multipart/mixed", encoding: { deep: {} } } },
          },
        },
      }),
    );

    expect(codes(outcome)).toEqual(["ENC-16/nesting-too-deep"]);
  });

  test("ENC-09 a nested itemEncoding has no place in the model and is refused", () => {
    const outcome = refused(
      "3.2",
      multipart(object({ batch: { type: "object" } }), {
        encoding: { batch: { contentType: "multipart/mixed", itemEncoding: {} } },
      }),
    );

    expect(codes(outcome)).toEqual(["ENC-09/nested-item-encoding"]);
  });
});

describe("SCO-10 XML bodies are opaque", () => {
  const xml: Json = {
    content: {
      "application/xml": {
        schema: {
          properties: { id: { type: "integer", xml: { attribute: true } } },
          type: "object",
        },
      },
    },
  };

  test("an XML alternative is codec xml, sent as supplied, and carries no schema", () => {
    for (const line of lines) {
      const outcome = implemented(line, xml);
      const alternative = only(outcome.body.alternatives);

      expect(alternative.codec).toBe("xml");
      expect(alternative.schema).toBeUndefined();
      expect(alternative.encoding).toEqual([]);
      expect(codes(outcome)).toEqual([]);
    }
  });
});

describe("ENC-27 ENC-28 form-urlencoded request bodies are form alternatives with a rule per property", () => {
  const form: Json = {
    content: { "application/x-www-form-urlencoded": { schema: object({ a: string }) } },
  };

  test("3.0 and 3.1 name ENC-27 and 3.2 names ENC-28, with the schema and one rule per property", () => {
    const expected = { "3.0": "ENC-27", "3.1": "ENC-27", "3.2": "ENC-28" } as const;
    for (const line of lines) {
      const outcome = implemented(line, { ...form, required: true });
      const alternative = only(outcome.body.alternatives);
      const rule = only(alternative.encoding);

      expect(outcome.diagnostics).toEqual([]);
      expect(outcome.body.required).toBe(true);
      expect(alternative.codec).toBe("form");
      expect(alternative.schema).toBeDefined();
      expect(alternative.rows.map(String)).toContain(expected[line]);
      expect(String(alternative.origin.pointer)).toBe(
        "/paths/~1a/post/requestBody/content/application~1x-www-form-urlencoded",
      );
      expect(targetOf(rule)).toBe("a");
      expect(rule.contentType.map(String)).toEqual(["text/plain"]);
      expect(rule.serialization).toBeUndefined();
      expect(alternative.prefixEncoding).toEqual([]);
    }
  });

  test("a media type with parameters or another case is the same form alternative", () => {
    const alternative = alternativeOf("3.1", "Application/X-WWW-Form-Urlencoded; charset=UTF-8");

    expect(alternative.codec).toBe("form");
    expect(String(alternative.mediaType)).toBe("Application/X-WWW-Form-Urlencoded; charset=UTF-8");
  });

  test("a sibling alternative stays beside the form", () => {
    const outcome = implemented("3.1", {
      content: { "application/json": {}, "application/x-www-form-urlencoded": {} },
    });

    expect(codes(outcome)).toEqual([]);
    expect(outcome.body.alternatives.map((alternative) => alternative.codec)).toEqual([
      "json",
      "form",
    ]);
  });
});

describe("SCH-13 S30-24 multipart-extra-fields: a schema-valued additionalProperties map is refused (D-ENC1)", () => {
  test("multipart-extra-fields-map-refused: the map is refused at element scope, the declared parts stay", () => {
    // The slice asks for S30-24 in 3.0; the Diagnostic codec's row pattern rejects `S30`, so every
    // line reports SCH-13 until src/model/diagnostic.ts admits digits in a row prefix.
    for (const line of lines) {
      const outcome = implemented(line, { ...extra({ type: "string" }), required: true });
      const diagnostic = only(outcome.diagnostics);

      expect(diagnostic.code).toBe("SCH-13/multipart-extra-fields");
      expect(plain(diagnostic.row)).toBe("SCH-13");
      expect(diagnostic.scope).toBe("element");
      expect(diagnostic.severity).toBe("refusal");
      expect(diagnostic.hint).toContain("D-ENC1");
      expect(String(diagnostic.pointer)).toBe(
        "/paths/~1a/post/requestBody/content/multipart~1form-data/schema/additionalProperties",
      );
      expect(plain(diagnostic.specSection)).toBe(
        `https://spec.openapis.org/oas/v${specVersion[line]}.html#json-schema-keywords`,
      );
      expect(only(outcome.body.alternatives).encoding.map(targetOf)).toEqual(["file"]);
    }
  });

  test("a boolean additionalProperties is not a map and is not refused", () => {
    for (const value of [true, false]) {
      expect(codes(implemented("3.1", extra(value)))).toEqual([]);
    }
  });

  test("an additionalProperties reached through a reference or allOf is found", () => {
    const schemas: Members = { Open: { additionalProperties: { type: "string" }, type: "object" } };
    const viaRef = implemented("3.1", multipart({ $ref: "#/components/schemas/Open" }), {
      schemas,
    });
    const viaAllOf = implemented(
      "3.1",
      multipart({ allOf: [object({ a: string }), { $ref: "#/components/schemas/Open" }] }),
      { schemas },
    );

    expect(codes(viaRef)).toEqual(["SCH-13/multipart-extra-fields"]);
    expect(String(only(viaRef.diagnostics).pointer)).toBe(
      "/components/schemas/Open/additionalProperties",
    );
    expect(codes(viaAllOf)).toEqual(["SCH-13/multipart-extra-fields"]);
  });

  test("only a multipart root is looked at, so a JSON body with the same map is untouched", () => {
    const json: Json = {
      content: { "application/json": { schema: object({}, { additionalProperties: string }) } },
    };

    expect(codes(implemented("3.1", json))).toEqual([]);
  });
});

describe("BodyNotReadable a site the earlier stages should have stopped", () => {
  test("a site that is not a request body fails with a typed error", () => {
    const value = documentOf("3.1", { content: { "text/plain": {} } });
    const resolution = Effect.runSync(resolve({ document: entry, line: "3.1", value }));
    const failure = Effect.runSync(
      Effect.flip(normalizeBody(resolution, { openapi: openapi["3.1"], pointer: "/info" })),
    );

    expect(failure).toBeInstanceOf(BodyNotReadable);
    expect(failure._tag).toBe("BodyNotReadable");
    expect(failure instanceof BodyNotReadable ? failure.reason : undefined).toBe(
      "not-a-request-body",
    );
  });
});

// Level i is an allOf of `width` references to level i + 1, so the unfolded tree has
// width ** depth nodes while the graph has depth + 1.
const diamond = (depth: number, width: number): Members => ({
  schemas: Object.fromEntries(
    Array.from({ length: depth + 1 }, (_, level): [string, Json] => [
      `L${level}`,
      level === depth
        ? { properties: { leaf: { type: "integer" } }, type: "object" }
        : {
            allOf: Array.from({ length: width }, () => ({
              $ref: `#/components/schemas/L${level + 1}`,
            })),
          },
    ]),
  ),
});

describe("REF-18 node-budget: allOf members shared by many parents are expanded once", () => {
  const body: Json = multipart({ $ref: "#/components/schemas/L0" });

  test("a depth-20 diamond finishes within 2 s and still finds the property", () => {
    const alternative = only(implemented("3.1", body, diamond(20, 5)).body.alternatives);

    expect(alternative.encoding.map(targetOf)).toEqual(["leaf"]);
  }, 2000);

  test("a depth-64 diamond is not cut off by a depth limit", () => {
    const alternative = only(implemented("3.1", body, diamond(64, 8)).body.alternatives);

    expect(alternative.encoding.map(targetOf)).toEqual(["leaf"]);
  }, 2000);

  test("a schema that lists itself in allOf terminates", () => {
    const schemas: Members = {
      Loop: { allOf: [{ $ref: "#/components/schemas/Loop" }], properties: { a: string } },
    };
    const outcome = implemented("3.1", multipart({ $ref: "#/components/schemas/Loop" }), {
      schemas,
    });

    expect(only(outcome.body.alternatives).encoding.map(targetOf)).toEqual(["a"]);
  }, 2000);

  test("a spent node budget fails with the shared REF-18 code", () => {
    const value = documentOf("3.1", body, diamond(20, 5));
    const resolution = Effect.runSync(resolve({ document: entry, line: "3.1", value }));
    const failure = Effect.runSync(
      Effect.flip(
        normalizeBody(
          resolution,
          { openapi: openapi["3.1"], pointer: site },
          { maxHops: 64, maxNodes: 50 },
        ),
      ),
    );

    expect(failure._tag).toBe("BodyNodeBudget");
    expect(failure).toBeInstanceOf(BodyNodeBudget);
    if (failure._tag === "BodyNodeBudget") {
      expect(failure.diagnostic.code).toBe("REF-18/node-budget");
      expect(failure.diagnostic.scope).toBe("document");
    }
  });
});
