import { describe, expect, test } from "bun:test";
import { Array as Arr, Effect, Order, Schema } from "effect";
import { checkGrammar } from "../../src/check/grammar.ts";
import { checkSpecText } from "../../src/check/index.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.1" };

interface Members {
  readonly [key: string]: Json;
}

const responses: Json = { "200": { description: "ok" } };

const op = (members: Members = {}): Json => ({ responses, ...members });

const spec = (line: Line, members: Members): Json => ({
  info: { title: "t", version: "1" },
  openapi: openapi[line],
  paths: {},
  ...members,
});

const resolved = (line: Line, members: Members) =>
  resolve({ document: entry, line, value: spec(line, members) });

const check = (line: Line, members: Members) =>
  Effect.runSync(resolved(line, members).pipe(Effect.flatMap(checkGrammar)));

const checkAll = (line: Line, members: Members) =>
  Effect.runSync(resolved(line, members).pipe(Effect.flatMap(checkSpecText)));

const paths = (value: Members): Members => ({ paths: value });

const summary = (line: Line, members: Members) =>
  check(line, members).map(
    (diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope] as const,
  );

const pointers = (found: readonly Diagnostic[]) =>
  found.map((diagnostic) => String(diagnostic.pointer));

const sorted = (values: readonly string[]) => Arr.sort(values, Order.String);

const schemaAt = (schema: Json): Members =>
  paths({
    "/a": {
      post: op({
        requestBody: { content: { "application/json": { schema } } },
      }),
    },
  });

describe("clean documents", () => {
  test("a document with no grammar defect has no diagnostics on every line", () => {
    const members = {
      components: {
        schemas: {
          Cat: { properties: { kind: { type: "string" } }, required: ["kind"], type: "object" },
          Pet: {
            discriminator: { mapping: { cat: "Cat" }, propertyName: "kind" },
            oneOf: [{ $ref: "#/components/schemas/Cat" }],
            properties: { kind: { type: "string" } },
            required: ["kind"],
            type: "object",
          },
          Zip: { pattern: "^[a-z]+$", type: "string" },
        },
        securitySchemes: {
          key: { in: "header", name: "X-Key", type: "apiKey" },
          oauth: { flows: {}, type: "oauth2" },
        },
      },
      paths: {
        "/a": {
          get: {
            parameters: [{ in: "header", name: "X-Request-Id", schema: { type: "string" } }],
            responses: {
              "200": {
                content: { "*/*": {}, "application/vnd.github.v3+json": {}, "text/*": {} },
                description: "ok",
                headers: { "X-Rate": { schema: { type: "string" } } },
              },
              "4XX": { description: "bad" },
              default: { description: "other" },
            },
            security: [{ key: [] }, { oauth: ["read"] }, {}],
            servers: [
              {
                url: "https://{region}.example.com/v1",
                variables: { region: { default: "eu", enum: ["eu", "us"] } },
              },
            ],
          },
        },
      },
      security: [{ key: [] }],
    };

    expect(check("3.0", members)).toEqual([]);
    expect(check("3.1", members)).toEqual([]);
    expect(check("3.2", members)).toEqual([]);
  });
});

const server = (variables: Json): Json => ({
  url: "https://{v}.example.com",
  variables: { v: variables },
});

describe("SRV server rules, at operation scope for the operations that use the server", () => {
  test("SRV-12: a default outside its enum is a refusal in 3.1 and 3.2, naming the variable", () => {
    const members = {
      ...paths({ "/a": { get: op(), servers: [server({ default: "x", enum: ["a"] })] } }),
    };
    const found = check("3.1", members);

    expect(
      found.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope]),
    ).toEqual([["SRV-12/default-not-in-enum", "refusal", "operation"]]);
    expect(pointers(found)).toEqual(["/paths/~1a/servers/0/variables/v"]);
    expect(found[0]?.operation).toEqual({ method: "GET", path: "/a" });
    expect(summary("3.2", members)).toEqual([
      ["SRV-12/default-not-in-enum", "refusal", "operation"],
    ]);
  });

  test("SRV-12: the same defect in 3.0 is a notice", () => {
    expect(
      summary("3.0", {
        ...paths({ "/a": { get: op(), servers: [server({ default: "x", enum: ["a"] })] } }),
      }),
    ).toEqual([["SRV-12/default-not-in-enum", "notice", "operation"]]);
  });

  test("a root server is reported once per operation that inherits it, an overriding server hides it", () => {
    const members = {
      ...paths({
        "/a": { get: op(), put: op({ servers: [{ url: "https://ok.example.com" }] }) },
        "/b": { post: op() },
      }),
      servers: [server({ default: "x", enum: ["a"] })],
    };

    expect(
      check("3.1", members).map((diagnostic) => [
        diagnostic.operation?.method,
        diagnostic.operation?.path,
      ]),
    ).toEqual([
      ["GET", "/a"],
      ["POST", "/b"],
    ]);
  });

  test("a server no operation uses is not reported", () => {
    expect(
      check("3.1", {
        ...paths({ "/a": { get: op({ servers: [{ url: "https://ok.example.com" }] }) } }),
        servers: [server({ default: "x", enum: ["a"] })],
      }),
    ).toEqual([]);
  });

  test("SRV-19: a variable expression used twice in one URL is refused", () => {
    const found = check("3.1", {
      ...paths({
        "/a": {
          get: op({
            servers: [
              {
                url: "https://{v}.example.com/{v}",
                variables: { v: { default: "x" } },
              },
            ],
          }),
        },
      }),
    });

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["SRV-19/repeated-variable", "operation"],
    ]);
    expect(pointers(found)).toEqual(["/paths/~1a/get/servers/0/url"]);
  });

  test("SRV-04: a 3.2 server name used twice in one list is refused at the later name", () => {
    const found = check("3.2", {
      ...paths({
        "/a": {
          get: op({
            servers: [
              { name: "prod", url: "https://a.example.com" },
              { name: "stage", url: "https://b.example.com" },
              { name: "prod", url: "https://c.example.com" },
            ],
          }),
        },
      }),
    });

    expect(
      found.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope]),
    ).toEqual([["SRV-04/duplicate-name", "refusal", "operation"]]);
    expect(pointers(found)).toEqual(["/paths/~1a/get/servers/2/name"]);
    expect(found[0]?.operation).toEqual({ method: "GET", path: "/a" });
  });

  test("SRV-04: distinct names, or names in different lists, raise nothing", () => {
    expect(
      check("3.2", {
        ...paths({
          "/a": {
            get: op({ servers: [{ name: "prod", url: "https://a.example.com" }] }),
            put: op(),
          },
        }),
        servers: [
          { name: "prod", url: "https://a.example.com" },
          { name: "stage", url: "https://b.example.com" },
        ],
      }),
    ).toEqual([]);
  });

  test("SRV-18: a query or fragment in a server URL is refused in every line", () => {
    for (const line of ["3.0", "3.1", "3.2"] as const) {
      for (const url of ["https://example.com/v1?x=1", "https://example.com/v1#top"]) {
        expect(summary(line, { ...paths({ "/a": { get: op({ servers: [{ url }] }) } }) })).toEqual([
          ["SRV-18/query-or-fragment", "refusal", "operation"],
        ]);
      }
    }
  });
});

const schemes = { securitySchemes: { key: { in: "header", name: "X", type: "apiKey" } } };

const named = (name: string) => ({
  components: schemes,
  ...paths({ "/a": { get: op({ security: [{ [name]: [] }, {}] }) } }),
});

describe("SEC security requirement names", () => {
  test("SEC-09: an unknown name is an element refusal when another alternative remains", () => {
    const members = {
      components: schemes,
      ...paths({ "/a": { get: op({ security: [{ nope: [] }, { key: [] }] }) } }),
    };
    const found = check("3.1", members);

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["SEC-09/unresolved-scheme", "element"],
    ]);
    expect(pointers(found)).toEqual(["/paths/~1a/get/security/0/nope"]);
  });

  test("SEC-09: no remaining alternative makes the refusal operation scope, with the operation", () => {
    const found = check("3.0", {
      components: schemes,
      ...paths({ "/a": { get: op({ security: [{ nope: [] }, { key: [], other: [] }] }) } }),
    });

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["SEC-09/unresolved-scheme", "operation"],
      ["SEC-09/unresolved-scheme", "operation"],
    ]);
    expect(found[0]?.operation).toEqual({ method: "GET", path: "/a" });
  });

  test("an empty alternative `{}` remains, so the list is not exhausted", () => {
    expect(
      summary("3.1", {
        components: schemes,
        ...paths({ "/a": { get: op({ security: [{ nope: [] }, {}] }) } }),
      }),
    ).toEqual([["SEC-09/unresolved-scheme", "refusal", "element"]]);
  });

  test("a root list whose alternatives are all bad is refused per operation that inherits it", () => {
    const found = check("3.1", {
      components: schemes,
      ...paths({
        "/a": { get: op(), put: op({ security: [] }) },
      }),
      security: [{ nope: [] }],
    });

    expect(found.map((diagnostic) => [diagnostic.scope, diagnostic.operation?.method])).toEqual([
      ["operation", "GET"],
    ]);
    expect(pointers(found)).toEqual(["/security/0/nope"]);
  });

  test("a root list with a remaining alternative is one element refusal", () => {
    const found = check("3.1", {
      components: schemes,
      ...paths({ "/a": { get: op() } }),
      security: [{ nope: [] }, { key: [] }],
    });

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["SEC-09/unresolved-scheme", "element"],
    ]);
  });

  test("SEC-10: in 3.2 a name resolves as a component name or a Security Scheme URI", () => {
    expect(check("3.2", named("key"))).toEqual([]);
    expect(check("3.2", named("#/components/securitySchemes/key"))).toEqual([]);
    expect(summary("3.2", named("missing"))).toEqual([
      ["SEC-10/unresolved-scheme", "refusal", "element"],
    ]);
  });

  test("SEC-12: a non-OAuth scheme with scopes is refused in 3.0 only", () => {
    const members = {
      components: {
        securitySchemes: {
          key: { in: "header", name: "X", type: "apiKey" },
          oauth: { flows: {}, type: "oauth2" },
          oidc: { openIdConnectUrl: "https://example.com/.well-known", type: "openIdConnect" },
        },
      },
      ...paths({
        "/a": { get: op({ security: [{ key: ["read"], oauth: ["read"], oidc: ["x"] }] }) },
      }),
    };
    const found = check("3.0", members);

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["SEC-12/non-empty-scopes", "element"],
    ]);
    expect(pointers(found)).toEqual(["/paths/~1a/get/security/0/key"]);
    expect(check("3.1", members)).toEqual([]);
    expect(check("3.2", members)).toEqual([]);
  });
});

describe("MED-24 media type keys", () => {
  test("a key that is not a media type or range is an element refusal, in every content map", () => {
    const members = {
      components: {
        parameters: { P: { content: { "not a type": {} }, in: "query", name: "q" } },
        requestBodies: { B: { content: { string: {} } } },
      },
      ...paths({
        "/a": {
          post: op({
            requestBody: { content: { "application/json": {}, examples: {} } },
            responses: { "200": { content: { "text/": {} }, description: "ok" } },
          }),
        },
      }),
    };

    for (const line of ["3.0", "3.1", "3.2"] as const) {
      const found = check(line, members);

      expect(
        found.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope]),
      ).toEqual(
        Array.from({ length: 4 }, () => ["MED-24/invalid-media-type", "refusal", "element"]),
      );
      expect(sorted(pointers(found))).toEqual([
        "/components/parameters/P/content/not a type",
        "/components/requestBodies/B/content/string",
        "/paths/~1a/post/requestBody/content/examples",
        "/paths/~1a/post/responses/200/content/text~1",
      ]);
    }
  });
});

describe("header name tokens", () => {
  test("PRM-20: a header parameter name that is not a token", () => {
    const found = check("3.1", {
      ...paths({
        "/a": {
          get: op({
            parameters: [
              { in: "header", name: "X Bad" },
              { in: "header", name: "X-Good" },
              { in: "query", name: "any thing" },
            ],
          }),
        },
      }),
    });

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["PRM-20/invalid-header-name", "element"],
    ]);
    expect(pointers(found)).toEqual(["/paths/~1a/get/parameters/0/name"]);
  });

  test("RSP-09: a response header key that is not a token", () => {
    const found = check("3.0", {
      ...paths({
        "/a": {
          get: op({
            responses: { "200": { description: "ok", headers: { "X Rate": {}, "X-Rate": {} } } },
          }),
        },
      }),
    });

    expect(found.map((diagnostic) => diagnostic.code)).toEqual(["RSP-09/invalid-header-name"]);
    expect(pointers(found)).toEqual(["/paths/~1a/get/responses/200/headers/X Rate"]);
  });

  test("HDR-01: an encoding header key that is not a token", () => {
    const found = check("3.2", {
      ...paths({
        "/a": {
          post: op({
            requestBody: {
              content: {
                "multipart/form-data": { encoding: { file: { headers: { "bad:name": {} } } } },
              },
            },
          }),
        },
      }),
    });

    expect(found.map((diagnostic) => diagnostic.code)).toEqual(["HDR-01/invalid-header-name"]);
    expect(pointers(found)).toEqual([
      "/paths/~1a/post/requestBody/content/multipart~1form-data/encoding/file/headers/bad:name",
    ]);
  });
});

describe("DSC discriminator rules", () => {
  const cat: Json = {
    properties: { kind: { type: "string" } },
    required: ["kind"],
    type: "object",
  };

  const pet = (discriminator: Json, extra: Members = {}): Members => ({
    components: {
      schemas: {
        Cat: cat,
        Loose: { type: "object" },
        Pet: {
          discriminator,
          oneOf: [{ $ref: "#/components/schemas/Loose" }],
          properties: { kind: { type: "string" } },
          ...extra,
        },
      },
    },
  });

  test("DSC-09: 3.0 and 3.1 refuse a discriminating property that is not required", () => {
    for (const line of ["3.0", "3.1"] as const) {
      const found = check(line, pet({ propertyName: "kind" }));

      expect(
        found.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope]),
      ).toEqual([["DSC-09/property-not-required", "refusal", "element"]]);
      expect(pointers(found)).toEqual(["/components/schemas/Pet/discriminator/propertyName"]);
    }
  });

  test("a property every oneOf branch requires counts as required", () => {
    const members = pet({ propertyName: "kind" });

    expect(check("3.1", members).map((diagnostic) => diagnostic.code)).toEqual([
      "DSC-09/property-not-required",
    ]);
    expect(
      check("3.1", {
        components: {
          schemas: {
            Cat: cat,
            Pet: {
              discriminator: { propertyName: "kind" },
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
            },
          },
        },
      }),
    ).toEqual([]);
  });

  test("DSC-10: 3.2 refuses an optional property without defaultMapping, and accepts one with it", () => {
    const found = check("3.2", pet({ propertyName: "kind" }));

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["DSC-10/missing-default-mapping", "element"],
    ]);
    expect(pointers(found)).toEqual(["/components/schemas/Pet/discriminator"]);
    expect(check("3.2", pet({ defaultMapping: "Cat", propertyName: "kind" }))).toEqual([]);
    expect(check("3.2", pet({ propertyName: "kind" }, { required: ["kind"] }))).toEqual([]);
  });

  test("DSC-03: a mapping target that is neither a component name nor a schema in the set", () => {
    const found = check(
      "3.1",
      pet(
        {
          mapping: {
            cat: "Cat",
            dog: "Dog",
            ref: "#/components/schemas/Cat",
            remote: "https://example.com/other.json#/Dog",
          },
          propertyName: "kind",
        },
        { required: ["kind"] },
      ),
    );

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["DSC-03/unresolved-target", "element"],
      ["DSC-03/unresolved-target", "element"],
    ]);
    expect(sorted(pointers(found))).toEqual([
      "/components/schemas/Pet/discriminator/mapping/dog",
      "/components/schemas/Pet/discriminator/mapping/remote",
    ]);
  });

  test("DSC-04: a defaultMapping target that does not resolve", () => {
    const found = check(
      "3.2",
      pet({ defaultMapping: "Dog", propertyName: "kind" }, { required: ["kind"] }),
    );

    expect(found.map((diagnostic) => diagnostic.code)).toEqual(["DSC-04/unresolved-target"]);
    expect(pointers(found)).toEqual(["/components/schemas/Pet/discriminator/defaultMapping"]);
  });

  test("DSC-05: a discriminator with no oneOf, anyOf or allOf is refused at the discriminator", () => {
    const loose = {
      components: {
        schemas: {
          Pet: {
            discriminator: { propertyName: "kind" },
            properties: { kind: { type: "string" } },
            required: ["kind"],
            type: "object",
          },
        },
      },
    };

    for (const line of ["3.0", "3.1", "3.2"] as const) {
      const found = check(line, loose);

      expect(
        found.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope]),
      ).toEqual([["DSC-05/no-composition", "refusal", "element"]]);
      expect(pointers(found)).toEqual(["/components/schemas/Pet/discriminator"]);
    }
  });

  test("DSC-05: the base schema an allOf child references is the allOf use and is not refused", () => {
    const members = {
      components: {
        schemas: {
          Cat: { allOf: [{ $ref: "#/components/schemas/Pet" }, { type: "object" }] },
          Pet: {
            discriminator: { mapping: { cat: "Cat" }, propertyName: "kind" },
            properties: { kind: { type: "string" } },
            required: ["kind"],
            type: "object",
          },
        },
      },
    };

    for (const line of ["3.0", "3.1", "3.2"] as const) {
      expect(check(line, members)).toEqual([]);
    }
  });

  test("DSC-05: a partial mapping is valid; an unmapped branch keeps its implicit name", () => {
    const dog: Json = {
      properties: { kind: { type: "string" } },
      required: ["kind"],
      type: "object",
    };
    const partial = (keyword: "anyOf" | "oneOf"): Members => ({
      components: {
        schemas: {
          Cat: cat,
          Dog: dog,
          Pet: {
            discriminator: { mapping: { cat: "Cat" }, propertyName: "kind" },
            [keyword]: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
          },
        },
      },
    });

    for (const line of ["3.0", "3.1", "3.2"] as const) {
      for (const keyword of ["oneOf", "anyOf"] as const) {
        expect(check(line, partial(keyword))).toEqual([]);
      }
    }
  });

  test("DSC-05: an inline branch beside an explicit mapping is not refused", () => {
    const inline = {
      ...schemaAt({
        discriminator: { mapping: { cat: "#/components/schemas/Cat" }, propertyName: "kind" },
        oneOf: [{ $ref: "#/components/schemas/Cat" }, cat],
      }),
      components: { schemas: { Cat: cat } },
    };

    for (const line of ["3.0", "3.1", "3.2"] as const) {
      expect(check(line, inline)).toEqual([]);
    }
  });

  test("an inline schema in a request body is checked too", () => {
    const found = check(
      "3.1",
      schemaAt({ discriminator: { propertyName: "kind" }, oneOf: [{ type: "object" }] }),
    );

    expect(pointers(found)).toEqual([
      "/paths/~1a/post/requestBody/content/application~1json/schema/discriminator/propertyName",
    ]);
  });
});

describe("RSS-10 status keys", () => {
  test("keys outside 100-599, 1XX-5XX and default are element refusals", () => {
    const found = check("3.1", {
      ...paths({
        "/a": {
          get: {
            responses: {
              "099": { description: "x" },
              "200": { description: "x" },
              "2XX": { description: "x" },
              "600": { description: "x" },
              "6XX": { description: "x" },
              default: { description: "x" },
              ok: { description: "x" },
              "x-note": "ignored",
            },
          },
        },
      }),
    });

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["RSS-10/invalid-status", "element"],
      ["RSS-10/invalid-status", "element"],
      ["RSS-10/invalid-status", "element"],
      ["RSS-10/invalid-status", "element"],
    ]);
    expect(sorted(pointers(found))).toEqual([
      "/paths/~1a/get/responses/099",
      "/paths/~1a/get/responses/600",
      "/paths/~1a/get/responses/6XX",
      "/paths/~1a/get/responses/ok",
    ]);
  });
});

describe("RSS-04 response codes", () => {
  test("a 3.0 Responses Object of x- keys alone is a document refusal at the Responses Object", () => {
    const found = check("3.0", {
      ...paths({ "/a": { get: { responses: { "x-note": "only an extension" } } } }),
    });

    expect(
      found.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope]),
    ).toEqual([["RSS-04/no-response-code", "refusal", "document"]]);
    expect(pointers(found)).toEqual(["/paths/~1a/get/responses"]);
  });

  test("default beside an x- key is a response code; the 3.1 and 3.2 schemas own the rule", () => {
    const extensionOnly = { ...paths({ "/a": { get: { responses: { "x-note": "x" } } } }) };

    expect(
      check("3.0", {
        ...paths({
          "/a": { get: { responses: { default: { description: "x" }, "x-note": "x" } } },
        }),
      }),
    ).toEqual([]);
    expect([check("3.1", extensionOnly), check("3.2", extensionOnly)]).toEqual([[], []]);
  });
});

const header = (fields: Members): Members => ({
  ...paths({
    "/a": {
      get: op({
        responses: {
          "200": { description: "ok", headers: { "X-Rate": { schema: {}, ...fields } } },
        },
      }),
    },
  }),
});

describe("HDR-13 Header Object fields", () => {
  test("allowEmptyValue or allowReserved on a 3.0 Header Object is a document refusal at the field", () => {
    const found = check("3.0", header({ allowEmptyValue: true, allowReserved: false }));

    expect(
      found.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope]),
    ).toEqual([
      ["HDR-13/parameter-only-field", "refusal", "document"],
      ["HDR-13/parameter-only-field", "refusal", "document"],
    ]);
    expect(pointers(found)).toEqual([
      "/paths/~1a/get/responses/200/headers/X-Rate/allowEmptyValue",
      "/paths/~1a/get/responses/200/headers/X-Rate/allowReserved",
    ]);
  });

  test("a component header and an encoding header are checked; a parameter keeps both fields", () => {
    const found = check("3.0", {
      components: { headers: { Rate: { allowReserved: true, schema: {} } } },
      ...paths({
        "/a": {
          post: op({
            parameters: [{ allowEmptyValue: true, in: "query", name: "q", schema: {} }],
            requestBody: {
              content: {
                "multipart/form-data": {
                  encoding: {
                    file: { headers: { "X-Part": { allowEmptyValue: true, schema: {} } } },
                  },
                  schema: {},
                },
              },
            },
          }),
        },
      }),
    });

    expect(sorted(pointers(found))).toEqual([
      "/components/headers/Rate/allowReserved",
      "/paths/~1a/post/requestBody/content/multipart~1form-data/encoding/file/headers/X-Part/allowEmptyValue",
    ]);
  });

  test("the 3.1 and 3.2 schemas own the rule", () => {
    expect([
      check("3.1", header({ allowEmptyValue: true })),
      check("3.2", header({ allowReserved: true })),
    ]).toEqual([[], []]);
  });
});

describe("SCH-37 pattern", () => {
  test("a pattern that does not compile with the u flag is a notice at the pattern", () => {
    const members = {
      components: {
        schemas: { A: { pattern: "^\\d+\\-$", type: "string" }, B: { pattern: "^[a-z]+$" } },
      },
    };
    const found = check("3.1", members);

    expect(
      found.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope]),
    ).toEqual([["SCH-37/not-unicode-compilable", "notice", "element"]]);
    expect(pointers(found)).toEqual(["/components/schemas/A/pattern"]);
    expect(summary("3.2", members)).toEqual([
      ["SCH-37/not-unicode-compilable", "notice", "element"],
    ]);
  });

  test("a 3.0 pattern is reported under S30-09", () => {
    expect(
      summary("3.0", { components: { schemas: { A: { pattern: "\\-", type: "string" } } } }),
    ).toEqual([["S30-09/not-unicode-compilable", "notice", "element"]]);
  });

  test("a schema keyword named pattern inside properties is a property, not a pattern", () => {
    expect(
      check("3.1", {
        components: {
          schemas: { A: { properties: { pattern: { type: "string" } }, type: "object" } },
        },
      }),
    ).toEqual([]);
  });
});

const schemas = (A: Json): Members => ({ components: { schemas: { A } } });

describe("3.0 schema rules", () => {
  test("S30-22: type array without items is refused at the items pointer", () => {
    const found = check("3.0", schemas({ type: "array" }));

    expect(
      found.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope]),
    ).toEqual([["S30-22/array-without-items", "refusal", "element"]]);
    expect(pointers(found)).toEqual(["/components/schemas/A/items"]);
  });

  test("S30-22: items present, or another line, or another type, is clean", () => {
    expect(check("3.0", schemas({ items: {}, type: "array" }))).toEqual([]);
    expect(check("3.1", schemas({ type: "array" }))).toEqual([]);
    expect(check("3.0", schemas({ type: "object" }))).toEqual([]);
  });

  test("S30-30: readOnly and writeOnly both true is refused at the schema", () => {
    const found = check("3.0", schemas({ readOnly: true, type: "string", writeOnly: true }));

    expect(
      found.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope]),
    ).toEqual([["S30-30/read-and-write-only", "refusal", "element"]]);
    expect(pointers(found)).toEqual(["/components/schemas/A"]);
  });

  test("S30-30: one of the two, or false, is clean", () => {
    expect(check("3.0", schemas({ readOnly: true, writeOnly: false }))).toEqual([]);
    expect(check("3.0", schemas({ writeOnly: true }))).toEqual([]);
  });
});

// S0 .. Sdepth: every level lists the next level twice, so the paths double at each level.
const diamond = (depth: number, keyword: "allOf" | "anyOf" | "oneOf", leaf?: Json): Members => ({
  components: {
    schemas: Object.fromEntries(
      Array.from({ length: depth + 1 }, (_, level) => [
        `S${level}`,
        level === depth
          ? (leaf ?? { type: "object" })
          : {
              [keyword]: [
                { $ref: `#/components/schemas/S${level + 1}` },
                { $ref: `#/components/schemas/S${level + 1}` },
              ],
              discriminator: { propertyName: "kind" },
            },
      ]),
    ),
  },
});

const refused = (depth: number, keyword: "allOf" | "anyOf" | "oneOf") =>
  pointers(check("3.1", diamond(depth, keyword)));

describe("requires() on a reused schema graph", () => {
  test("a depth-20 diamond finishes and finds the property not required", () => {
    const found = refused(20, "allOf");

    expect(found).toHaveLength(20);
    expect(found[0]).toBe("/components/schemas/S0/discriminator/propertyName");
  }, 2000);

  test("a depth-64 diamond finishes fast under oneOf, anyOf and allOf", () => {
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      expect(refused(64, keyword)).toHaveLength(64);
    }
  }, 2000);

  test("a property required on every leaf path is found through the diamond", () => {
    expect(check("3.1", diamond(20, "oneOf", { required: ["kind"], type: "object" }))).toEqual([]);
  }, 2000);

  test("a cycle does not hide a requirement reached by another branch", () => {
    expect(
      check("3.1", {
        components: {
          schemas: {
            A: {
              allOf: [{ $ref: "#/components/schemas/B" }, { $ref: "#/components/schemas/C" }],
              discriminator: { propertyName: "kind" },
            },
            B: { allOf: [{ $ref: "#/components/schemas/B" }, { $ref: "#/components/schemas/A" }] },
            C: { required: ["kind"] },
          },
        },
      }),
    ).toEqual([]);
  });

  test("past the step budget the only finding is a document-scope refusal", () => {
    const found = Effect.runSync(
      resolved("3.1", diamond(20, "allOf")).pipe(
        Effect.flatMap((resolution) => checkGrammar(resolution, { maxNodes: 10 })),
      ),
    );

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["REF-18/node-budget", "document"],
    ]);
    expect(pointers(found)).toEqual([""]);
  }, 2000);
});

describe("the check entry", () => {
  const members = {
    components: {
      parameters: { P: { content: { string: {} }, in: "query", name: "q" } },
      schemas: { "bad key": { pattern: "\\-" } },
    },
    ...paths({
      "/a/{x}": {
        get: op({
          parameters: [{ in: "header", name: "X Bad" }],
          servers: [{ url: "https://example.com?x=1" }],
        }),
      },
    }),
  };

  test("runs the structure and grammar checks and orders findings by pointer", () => {
    const found = checkAll("3.1", members);

    expect(found.map((diagnostic) => [String(diagnostic.pointer), diagnostic.code])).toEqual([
      ["/components/parameters/P/content/string", "MED-24/invalid-media-type"],
      ["/components/schemas/bad key", "CMP-13/invalid-key"],
      ["/components/schemas/bad key/pattern", "SCH-37/not-unicode-compilable"],
      ["/paths/~1a~1{x}/get", "PTH-03/missing-parameter"],
      ["/paths/~1a~1{x}/get/parameters/0/name", "PRM-20/invalid-header-name"],
      ["/paths/~1a~1{x}/get/servers/0/url", "SRV-18/query-or-fragment"],
    ]);
  });

  test("a clean document has no findings", () => {
    expect(checkAll("3.2", paths({ "/a": { get: op() } }))).toEqual([]);
  });
});
