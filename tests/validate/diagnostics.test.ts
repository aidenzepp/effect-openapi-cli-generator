import { describe, expect, test } from "bun:test";
import { Array as Arr, Effect, Order, Schema } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import { rewriteDialect } from "../../src/validate/dialect.ts";
import { groupErrors } from "../../src/validate/locations.ts";
import { diagnoseDocument } from "../../src/validate/index.ts";
import type { Json } from "../../src/model/pointer.ts";

const uri = Schema.decodeUnknownSync(DocumentUri)("https://example.com/openapi.json");

const dialectBase = "https://spec.openapis.org/oas/3.1/dialect/base";

const diagnose = (document: Json) => Effect.runPromise(diagnoseDocument(document, uri));

const ok = { "200": { description: "ok" } };

const document = (openapi: string, extra: Record<string, Json> = {}): Json => ({
  info: { title: "t", version: "1" },
  openapi,
  paths: {},
  ...extra,
});

const operation = (get: Json): Json => ({ "/a{b}": { get } });

const pathParameter: Json = {
  allowReserved: true,
  in: "path",
  name: "b",
  required: true,
  schema: { type: "string" },
};

const link = (parameters: Json): Json =>
  operation({
    responses: { "200": { description: "ok", links: { l: { operationId: "x", parameters } } } },
  });

const classes: {
  readonly code: string;
  readonly document: Json;
  readonly pointer: string;
}[] = [
  { code: "DOC-02/patch-digits", document: document("3.0.10"), pointer: "/openapi" },
  {
    code: "DOC-03/self-fragment",
    document: document("3.2.0", { $self: "https://x.example/a#frag" }),
    pointer: "/$self",
  },
  {
    code: "SCH-01/dialect-base-id",
    document: document("3.1.0", { jsonSchemaDialect: dialectBase }),
    pointer: "/jsonSchemaDialect",
  },
  {
    code: "LNK-04/non-string-parameter",
    document: document("3.1.0", { paths: link({ id: 5 }) }),
    pointer: "/paths/~1a{b}/get/responses/200/links/l/parameters/id",
  },
  {
    code: "LNK-04/non-string-parameter",
    document: document("3.2.0", { paths: link({ id: 5 }) }),
    pointer: "/paths/~1a{b}/get/responses/200/links/l/parameters/id",
  },
  {
    code: "PRM-35/allow-reserved-outside-query",
    document: document("3.1.0", {
      paths: operation({ parameters: [pathParameter], responses: ok }),
    }),
    pointer: "/paths/~1a{b}/get/parameters/0/allowReserved",
  },
];

describe("known disagreements", () => {
  test.each(classes)("$code at $pointer is a notice, not a refusal", async (found) => {
    const result = await diagnose(found.document);

    expect(result.refusals).toEqual([]);
    expect(result.notices.map((notice) => [notice.code, notice.pointer])).toEqual([
      [found.code, found.pointer],
    ]);
    expect(result.notices[0]?.severity).toBe("notice");
    expect(result.notices[0]?.row).toBe(found.code.split("/")[0]);
  });

  test("a valid document has no diagnostics", async () => {
    expect(await diagnose(document("3.1.0"))).toEqual({ notices: [], refusals: [] });
  });
});

describe("refusals", () => {
  test("carry the decoded instance pointer and the keyword location", async () => {
    const result = await diagnose(
      document("3.1.0", {
        paths: operation({
          parameters: [{ foo: 1, in: "query", name: "b", schema: { type: "string" } }],
          responses: ok,
        }),
      }),
    );

    expect(result.notices).toEqual([]);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.diagnostic.code).toBe("VAL-03/schema-invalid");
    expect(result.refusals[0]?.diagnostic.severity).toBe("refusal");
    expect(result.refusals[0]?.diagnostic.scope).toBe("document");
    expect<string | undefined>(result.refusals[0]?.diagnostic.pointer).toBe(
      "/paths/~1a{b}/get/parameters/0/foo",
    );
    expect(result.refusals[0]?.keywordLocation).toBe(
      "https://spec.openapis.org/oas/3.1/schema/2026-08-03#/$defs/parameter/unevaluatedProperties",
    );
  });

  test("use the row of the declared line", async () => {
    const result = await diagnose(document("3.0.3", { paths: { "/a": { get: {} } } }));

    expect(result.refusals.map((refusal) => refusal.diagnostic.row)).toEqual(["VAL-02"]);
  });

  test("a disagreement does not hide another error", async () => {
    const result = await diagnose(
      document("3.0.10", { paths: { "/a": { get: {} } }, servers: "x" }),
    );

    expect(result.notices.map((notice) => notice.code)).toEqual(["DOC-02/patch-digits"]);
    expect(
      Arr.sort(
        result.refusals.map((refusal) => String(refusal.diagnostic.pointer)),
        Order.String,
      ),
    ).toEqual(["/paths/~1a/get", "/servers"]);
  });
});

const schemaDocument = (type: string): Json =>
  document("3.1.0", {
    components: {
      schemas: {
        One: { $schema: dialectBase, type },
        Two: { $schema: dialectBase, type: "object" },
      },
    },
    jsonSchemaDialect: dialectBase,
  });

describe("dialect id rewrite", () => {
  test("leaves the input unchanged and counts one occurrence per rewritten value", async () => {
    const input = schemaDocument("string");
    const before = JSON.stringify(input);
    const rewritten = await Effect.runPromise(rewriteDialect(input));

    expect(JSON.stringify(input)).toBe(before);
    expect(rewritten.copy).not.toBe(input);
    expect(Arr.sort(rewritten.occurrences, Order.String)).toEqual([
      "/components/schemas/One/$schema",
      "/components/schemas/Two/$schema",
      "/jsonSchemaDialect",
    ]);
    expect(JSON.stringify(rewritten.copy)).not.toContain(dialectBase);
  });

  test("yields one SCH-01 notice per occurrence and validates Schema Objects", async () => {
    const input = schemaDocument("string");
    const before = JSON.stringify(input);
    const result = await diagnose(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(result.refusals).toEqual([]);
    expect(result.notices.map((notice) => notice.code)).toEqual([
      "SCH-01/dialect-base-id",
      "SCH-01/dialect-base-id",
      "SCH-01/dialect-base-id",
    ]);
  });

  test("a Schema Object error survives the rewrite", async () => {
    const result = await diagnose(schemaDocument("strng"));

    expect(result.notices).toHaveLength(3);
    expect(result.refusals.map((refusal) => String(refusal.diagnostic.pointer))).toEqual([
      "/components/schemas/One/type",
    ]);
  });

  test("only the 3.1 line is rewritten", async () => {
    const input = document("3.2.0", { jsonSchemaDialect: dialectBase });
    const rewritten = await Effect.runPromise(rewriteDialect(input));

    expect(rewritten.occurrences).toEqual([]);

    const copy: Json = rewritten.copy;

    expect(copy).toEqual(input);
  });

  test("copies the input even when no site exists", async () => {
    const input = document("3.1.0");
    const rewritten = await Effect.runPromise(rewriteDialect(input));

    expect(rewritten.occurrences).toEqual([]);

    const copy: Json = rewritten.copy;

    expect(copy).toEqual(input);
    expect(Object.is(copy, input)).toBe(false);
  });
});

const unit = (instanceLocation: string, keyword = "k") => ({
  absoluteKeywordLocation: `https://example.com/s#/${keyword}`,
  instanceLocation,
  keyword,
});

describe("error grouping", () => {
  test("percent-decodes and groups ancestors under the deepest location", async () => {
    const groups = await Effect.runPromise(
      groupErrors([
        unit("#"),
        unit("#/a"),
        unit("#/a/%7Bn%7D", "deep"),
        unit("#/a/%7Bn%7D", "two"),
      ]),
    );

    expect(groups).toHaveLength(1);
    expect<string | undefined>(groups[0]?.pointer).toBe("/a/{n}");
    expect(groups[0]?.deepest.map((found) => found.keyword)).toEqual(["deep", "two"]);
    expect(groups[0]?.context.map((found) => found.instanceLocation)).toEqual(["#", "#/a"]);
  });

  test("independent branches form separate groups", async () => {
    const groups = await Effect.runPromise(groupErrors([unit("#/b"), unit("#"), unit("#/a")]));

    expect(groups.map((group) => String(group.pointer))).toEqual(["/a", "/b"]);
    expect(groups[0]?.context).toHaveLength(1);
    expect(groups[1]?.context).toHaveLength(0);
  });

  test("a property-name location (#*) groups under the key's own pointer", async () => {
    const groups = await Effect.runPromise(groupErrors([unit("#"), unit("#*/a/b")]));

    expect(groups.map((group) => String(group.pointer))).toEqual(["/a/b"]);
  });

  test("a location that is not a fragment fails", async () => {
    const failure = await Effect.runPromise(Effect.flip(groupErrors([unit("/a")])));

    expect(failure._tag).toBe("InvalidInstanceLocation");
  });
});

const withKey = (key: string): Json =>
  document("3.1.0", {
    components: { schemas: { One: { properties: { [key]: { type: "string" } }, type: "object" } } },
  });

describe("lone surrogates in property names", () => {
  test.each([
    ["high", "\uD800", "\\uD800"],
    ["low", "\uDC00", "\\uDC00"],
    ["high before a letter", "a\uD83Dz", "a\\uD83Dz"],
  ])("a lone %s surrogate is refused with the escaped pointer", async (_name, key, escaped) => {
    const result = await diagnose(withKey(key));

    expect(result.notices).toEqual([]);
    expect(result.refusals).toHaveLength(1);

    const found = result.refusals[0]?.diagnostic;

    expect(found?.code).toBe("DOC-14/invalid-encoding");
    expect(found?.scope).toBe("document");
    expect(found?.severity).toBe("refusal");
    expect<string | undefined>(found?.pointer).toBe(
      `/components/schemas/One/properties/${escaped}`,
    );
    expect(found?.message).toContain(escaped);
    expect(found?.message).not.toContain(key);
  });

  test("a valid surrogate pair is accepted", async () => {
    expect(await diagnose(withKey("\u{1F600}"))).toEqual({ notices: [], refusals: [] });
  });
});

describe("additionalOperations keys equal to a fixed method", () => {
  test.each(["POST", "post", "Post"])(
    "3.2: %s validates; the structure check refuses it (PTH-24)",
    async (key) => {
      const operationObject: Json = { responses: ok };
      const result = await diagnose(
        document("3.2.1", {
          paths: {
            "/a": { additionalOperations: { [key]: operationObject }, post: operationObject },
          },
        }),
      );

      expect(result).toEqual({ notices: [], refusals: [] });
    },
  );
});
