import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import { sortDiagnostics } from "../../src/model/diagnostic.ts";
import type { Operation } from "../../src/model/entities.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

// The subjects are entities with branded fields; `expect`'s own parameter would reject the plain
// literals they are compared with.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- test helper, the value is only compared
const see = (value: unknown) => expect(value);

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const configUri = Schema.decodeUnknownSync(DocumentUri)("file:///spec/author.json");

const config = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "example",
  package: { name: "example-cli", version: "1.0.0" },
});

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

interface Members {
  readonly [key: string]: Json;
}

const run = (line: Line, paths: Json, rest: Members = {}) =>
  Effect.runSync(
    resolve({
      document: entry,
      line,
      value: { info: { title: "t", version: "1" }, openapi: openapi[line], paths, ...rest },
    }).pipe(
      Effect.flatMap((resolution) =>
        normalize(resolution, { checkFindings: [], config, configDocument: configUri }),
      ),
    ),
  );

const ok: Json = { responses: { "200": { description: "ok" } } };

const operation = (line: Line, paths: Json, method: string, path = "/a"): Operation | undefined =>
  run(line, paths).api.operations.find(
    (found) => found.key.method === method && found.key.path === path,
  );

const codes = (diagnostics: readonly Diagnostic[]): readonly string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

const stringSchema: Json = { type: "string" };

const query = (name: string, schema: Json = stringSchema, extra: Members = {}): Json => ({
  in: "query",
  name,
  schema,
  ...extra,
});

const jsonBody: Json = { content: { "application/json": { schema: { type: "string" } } } };

describe("operation keys", () => {
  test("the key is the upper-case method token and the path template", () => {
    const { api } = run("3.1", {
      "/a": { get: ok },
      "/b/{id}": {
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        put: ok,
      },
    });

    see(api.operations.map((found) => `${found.key.method} ${found.key.path}`)).toEqual([
      "GET /a",
      "PUT /b/{id}",
    ]);
  });

  test("3.2 query and additionalOperations keys are sent as spelled", () => {
    const { api } = run("3.2", { "/a": { additionalOperations: { PURGE: ok }, query: ok } });

    // Canonical order (design 3.7): `/paths/~1a/additionalOperations/PURGE` sorts before `query`.
    see(api.operations.map((found) => found.key.method)).toEqual(["PURGE", "QUERY"]);
  });

  test("operationId, deprecated and docs are read from the operation", () => {
    const found = operation(
      "3.1",
      {
        "/a": {
          get: { ...ok, deprecated: true, description: "d", operationId: "getA", summary: "s" },
        },
      },
      "GET",
    );

    see(found?.operationId).toBe("getA");
    see(found?.deprecated).toBe(true);
    see(found?.docs).toEqual({ description: "d", summary: "s" });
    see(operation("3.1", { "/a": { get: ok } }, "GET")?.deprecated).toBe(false);
  });

  test("tags are kept in document order, sanitized, and empty when absent", () => {
    const { api } = run("3.1", {
      "/a": { get: { ...ok, tags: ["users", "ad\u0000min"] }, put: ok },
    });
    const tagsOf = (method: string) =>
      api.operations.find((found) => found.key.method === method)?.tags;

    see(tagsOf("GET")).toEqual(["users", "admin"]);
    see(tagsOf("PUT")).toEqual([]);
  });

  test("a path item reached through $ref yields its operations", () => {
    const { api } = run(
      "3.1",
      { "/a": { $ref: "#/components/pathItems/Shared" } },
      { components: { pathItems: { Shared: { get: ok } } } },
    );

    see(api.operations.map((found) => found.key.path)).toEqual(["/a"]);
  });
});

describe("parameter merge", () => {
  const paths: Json = {
    "/a": {
      get: {
        ...ok,
        parameters: [
          query("q", { type: "integer" }),
          query("extra"),
          { in: "header", name: "x-id", schema: { type: "integer" } },
        ],
      },
      parameters: [
        query("q"),
        { in: "header", name: "X-Id", schema: { type: "string" } },
        query("kept"),
      ],
    },
  };

  test("the operation parameter overrides the path item parameter of the same name and in", () => {
    const found = operation("3.1", paths, "GET");
    const q = found?.parameters.find((parameter) => parameter.wireName === "q");

    see(q?.origin.pointer).toBe("/paths/~1a/get/parameters/0");
    see(found?.parameters.filter((parameter) => parameter.wireName === "q")).toHaveLength(1);
  });

  test("a header name is compared case-insensitively and the operation spelling wins", () => {
    const found = operation("3.1", paths, "GET");

    see(found?.parameters.map((parameter) => parameter.wireName)).toContain("x-id");
    see(found?.parameters.map((parameter) => parameter.wireName)).not.toContain("X-Id");
  });

  test("path item order with overrides in place, then the other operation parameters", () => {
    const found = operation("3.1", paths, "GET");

    see(found?.parameters.map((parameter) => parameter.wireName)).toEqual([
      "q",
      "x-id",
      "kept",
      "extra",
    ]);
  });

  test("the same name in another location is not an override", () => {
    const found = operation(
      "3.1",
      {
        "/a": {
          get: { ...ok, parameters: [{ in: "header", name: "q", schema: { type: "string" } }] },
          parameters: [query("q")],
        },
      },
      "GET",
    );

    see(found?.parameters.map((parameter) => parameter.location)).toEqual(["query", "header"]);
  });

  test("a path item parameter reaches every operation of the item", () => {
    const { api } = run("3.1", { "/a": { get: ok, parameters: [query("kept")], post: ok } });

    see(api.operations.map((found) => found.parameters.map((p) => p.wireName))).toEqual([
      ["kept"],
      ["kept"],
    ]);
  });

  test("a notice on a path item parameter is reported once however many operations share it", () => {
    const { diagnostics } = run("3.1", {
      "/a": {
        get: ok,
        parameters: [{ in: "header", name: "Accept", schema: { type: "string" } }],
        post: ok,
      },
    });

    see(
      diagnostics.filter((diagnostic) => diagnostic.pointer === "/paths/~1a/parameters/0"),
    ).toHaveLength(1);
  });
});

describe("bodies on GET, HEAD, DELETE, OPTIONS and TRACE", () => {
  const bodyless = ["get", "head", "delete", "options", "trace"] as const;

  for (const method of bodyless) {
    const upper = method.toUpperCase();
    test(`3.0 ${upper}: notice, no body, the operation remains`, () => {
      const { api, diagnostics } = run("3.0", {
        "/a": { [method]: { ...ok, requestBody: jsonBody } },
      });
      const notices = diagnostics.filter((diagnostic) => diagnostic.row === "OPR-10");

      see(api.operations.map((found) => found.key.method)).toEqual([upper]);
      see(api.operations[0]?.body).toBeUndefined();
      see(
        notices.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope]),
      ).toEqual([["OPR-10/body-ignored", "notice", "element"]]);
      see(notices[0]?.pointer).toBe(`/paths/~1a/${method}/requestBody`);
    });
  }

  for (const line of ["3.1", "3.2"] as const) {
    for (const method of ["get", "head", "trace"] as const) {
      const upper = method.toUpperCase();
      test(`${line} ${upper}: element-scope refusal, no body, the operation remains`, () => {
        const { api, diagnostics } = run(line, {
          "/a": { [method]: { ...ok, requestBody: jsonBody } },
        });

        see(api.operations.map((found) => found.key.method)).toEqual([upper]);
        see(api.operations[0]?.body).toBeUndefined();
        see(
          diagnostics
            .filter((diagnostic) => diagnostic.row === "OPR-10")
            .map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope]),
        ).toEqual([["OPR-10/body-refused", "refusal", "element"]]);
      });
    }

    for (const method of ["delete", "options"] as const) {
      const upper = method.toUpperCase();
      test(`${line} ${upper}: the body is sent`, () => {
        const { api, diagnostics } = run(line, {
          "/a": { [method]: { ...ok, requestBody: jsonBody } },
        });

        see(
          api.operations[0]?.body?.alternatives.map((alternative) => alternative.mediaType),
        ).toEqual(["application/json"]);
        see(diagnostics.filter((diagnostic) => diagnostic.row === "OPR-10")).toEqual([]);
      });
    }
  }

  test("3.0 POST keeps its body", () => {
    see(
      operation("3.0", { "/a": { post: { ...ok, requestBody: jsonBody } } }, "POST")?.body,
    ).toBeDefined();
  });

  test("3.2 QUERY keeps its body", () => {
    see(
      operation("3.2", { "/a": { query: { ...ok, requestBody: jsonBody } } }, "QUERY")?.body,
    ).toBeDefined();
  });
});

// A parameter that stays refused: a query parameter in matrix style (STY-40).
const refusedQuery = (required: boolean): Json => ({
  in: "query",
  name: "sid",
  required,
  schema: { type: "string" },
  style: "matrix",
});

// A body that stays refused: multipart with no schema on 3.0 and 3.1 (ENC-33).
const refusedBody = (required: boolean): Json => ({
  content: { "multipart/form-data": {} },
  required,
});

const oauthSchemes: Members = {
  components: {
    securitySchemes: {
      key: { in: "header", name: "X-K", type: "apiKey" },
      oauth: { flows: {}, type: "oauth2" },
    },
  },
};

const raised = (diagnostics: readonly Diagnostic[]) =>
  diagnostics
    .filter((diagnostic) => diagnostic.scope === "operation")
    .map((diagnostic) => diagnostic.code);

describe("operation-scope refusals", () => {
  test("a required parameter that is refused removes the operation", () => {
    const { api, diagnostics } = run("3.1", {
      "/a": { get: { ...ok, parameters: [refusedQuery(true)] }, post: ok },
    });

    see(api.operations.map((found) => found.key.method)).toEqual(["POST"]);
    see(raised(diagnostics)).toEqual(["OPR-08/required-parameter-refused"]);
  });

  test("an optional parameter that is refused leaves the operation", () => {
    const { api, diagnostics } = run("3.1", {
      "/a": { get: { ...ok, parameters: [refusedQuery(false)] } },
    });

    see(api.operations).toHaveLength(1);
    see(raised(diagnostics)).toEqual([]);
    see(diagnostics.map((diagnostic) => diagnostic.scope)).toEqual(["element"]);
  });

  test("a required path item parameter that is refused removes every operation of the item", () => {
    const { api, diagnostics } = run("3.1", {
      "/a": { get: ok, parameters: [refusedQuery(true)], post: ok },
    });

    see(api.operations).toEqual([]);
    see(raised(diagnostics)).toEqual([
      "OPR-08/required-parameter-refused",
      "OPR-08/required-parameter-refused",
    ]);
  });

  test("a refused required parameter that an operation overrides does not remove it", () => {
    const { api } = run("3.1", {
      "/a": {
        get: { ...ok, parameters: [{ in: "query", name: "sid", schema: { type: "string" } }] },
        parameters: [refusedQuery(true)],
      },
    });

    see(api.operations).toHaveLength(1);
  });

  test("a required body whose only alternative is refused removes the operation", () => {
    const { api, diagnostics } = run("3.1", {
      "/a": { post: { ...ok, requestBody: refusedBody(true) } },
    });

    see(api.operations).toEqual([]);
    see(raised(diagnostics)).toEqual(["OPR-09/required-body-refused"]);
  });

  test("an optional body whose only alternative is refused leaves the operation without a body", () => {
    const { api, diagnostics } = run("3.1", {
      "/a": { post: { ...ok, requestBody: refusedBody(false) } },
    });

    see(api.operations).toHaveLength(1);
    see(api.operations[0]?.body).toBeUndefined();
    see(raised(diagnostics)).toEqual([]);
  });

  test("a body with another surviving alternative stays", () => {
    const { api } = run("3.1", {
      "/a": {
        post: {
          ...ok,
          requestBody: {
            content: {
              "application/json": { schema: { type: "string" } },
              "multipart/form-data": {},
            },
            required: true,
          },
        },
      },
    });

    see(api.operations[0]?.body?.alternatives).toHaveLength(1);
  });

  test("every declared security alternative refused removes the operation", () => {
    const { api, diagnostics } = run(
      "3.1",
      { "/a": { get: { ...ok, security: [{ oauth: [] }] } } },
      oauthSchemes,
    );

    see(api.operations).toEqual([]);
    see(raised(diagnostics)).toEqual(["SEC-06/no-satisfiable-alternative"]);
    see(codes(diagnostics)).toContain("SSC-18/not-implemented");
  });

  test("an alternative naming an undeclared scheme counts as refused", () => {
    const { api, diagnostics } = run("3.1", {
      "/a": { get: { ...ok, security: [{ nowhere: [] }] } },
    });

    see(api.operations).toEqual([]);
    see(raised(diagnostics)).toEqual(["SEC-06/no-satisfiable-alternative"]);
  });

  test("an inherited root policy that is fully refused removes each operation that inherits it", () => {
    const { api, diagnostics } = run(
      "3.1",
      { "/a": { get: ok }, "/b": { get: { ...ok, security: [] } } },
      { ...oauthSchemes, security: [{ oauth: [] }] },
    );

    see(api.operations.map((found) => found.key.path)).toEqual(["/b"]);
    see(raised(diagnostics)).toEqual(["SEC-06/no-satisfiable-alternative"]);
  });

  test("a {} alternative that remains keeps the operation", () => {
    const { api, diagnostics } = run(
      "3.1",
      { "/a": { get: { ...ok, security: [{ oauth: [] }, {}] } } },
      oauthSchemes,
    );

    see(api.operations).toHaveLength(1);
    see(api.operations[0]?.security.alternatives).toEqual([{ uses: [] }]);
    see(raised(diagnostics)).toEqual([]);
  });

  test("a surviving alternative keeps the operation", () => {
    const { api } = run(
      "3.1",
      { "/a": { get: { ...ok, security: [{ oauth: [] }, { key: [] }] } } },
      oauthSchemes,
    );

    see(api.operations[0]?.security.alternatives).toHaveLength(1);
  });

  test("security [] is declared with no alternatives and is not raised", () => {
    const { api, diagnostics } = run(
      "3.1",
      { "/a": { get: { ...ok, security: [] } } },
      oauthSchemes,
    );

    see(api.operations).toHaveLength(1);
    see(api.operations[0]?.security.declared).toBe(true);
    see(api.operations[0]?.security.alternatives).toEqual([]);
    see(raised(diagnostics)).toEqual([]);
  });

  test("the raise names the operation and points at the refused element", () => {
    const { diagnostics } = run("3.1", {
      "/a": { get: { ...ok, operationId: "g", parameters: [refusedQuery(true)] } },
    });
    const found = diagnostics.find((diagnostic) => diagnostic.scope === "operation");

    see(found?.operation).toEqual({ method: "GET", operationId: "g", path: "/a" });
    see(found?.pointer).toBe("/paths/~1a/get");
    see(found?.related?.map((site) => site.pointer)).toEqual(["/paths/~1a/get/parameters/0"]);
  });
});

describe("the Api", () => {
  test("carries the line, the openapi string, info, tags, schemes, servers and schemas", () => {
    const { api } = run(
      "3.1",
      { "/a": { get: { ...ok, parameters: [query("q", { type: "integer" })] } } },
      {
        components: { securitySchemes: { key: { in: "header", name: "X-K", type: "apiKey" } } },
        info: { description: "d", summary: "s", title: "t", version: "1" },
        servers: [{ url: "/v1" }],
        tags: [{ description: "td", name: "pets" }, { name: "owners" }],
      },
    );

    see(api.line).toBe("3.1");
    see(api.openapi).toBe("3.1.1");
    see(api.entry).toBe(entry);
    see(api.documents).toEqual([entry]);
    see(api.info).toEqual({ description: "d", summary: "s" });
    see(api.tags).toEqual([{ docs: { description: "td" }, name: "pets" }, { name: "owners" }]);
    see(api.securitySchemes.map((scheme) => scheme.name)).toEqual(["key"]);
    see(api.servers.map((server) => server.template)).toEqual(["/v1"]);
    see(Object.keys(api.schemas.document)).toContain("$defs");
  });

  test("an absent root servers list is the single server /", () => {
    see(run("3.1", {}).api.servers.map((server) => server.template)).toEqual(["/"]);
  });

  test("webhooks and extensions are recorded as informational", () => {
    const { api } = run("3.1", {}, { webhooks: { ping: { post: ok } }, "x-a": 1 });

    see(api.informational.map((record) => record.row)).toEqual(["INF-01", "EXT-01", "DOC-08"]);
  });

  test("the effective servers of an operation follow operation, path item, root", () => {
    const { api } = run(
      "3.1",
      {
        "/a": { get: { ...ok, servers: [{ url: "/op" }] }, post: ok, servers: [{ url: "/item" }] },
        "/b": { get: ok },
      },
      { servers: [{ url: "/root" }] },
    );

    see(
      api.operations.map((found) => found.servers.map((server) => [server.level, server.template])),
    ).toEqual([[["operation", "/op"]], [["pathItem", "/item"]], [["root", "/root"]]]);
  });

  test("a reference to a response and a request body is followed", () => {
    const { api } = run(
      "3.1",
      {
        "/a": {
          post: {
            requestBody: { $ref: "#/components/requestBodies/B" },
            responses: { "204": { $ref: "#/components/responses/R" } },
          },
        },
      },
      {
        components: {
          requestBodies: { B: jsonBody },
          responses: { R: { description: "none" } },
        },
      },
    );

    see(api.operations[0]?.body?.alternatives).toHaveLength(1);
    see(api.operations[0]?.responses.map((response) => response.key)).toEqual([{ code: 204 }]);
  });
});

// Written /b first, so the order under test is the pointer's and not the document's.
const mixedPaths: Json = Object.fromEntries([
  [
    "/b",
    {
      delete: {
        ...ok,
        requestBody: refusedBody(true),
        security: [{ oauth: [] }],
      },
    },
  ],
  [
    "/a",
    {
      get: {
        ...ok,
        parameters: [refusedQuery(false)],
        requestBody: jsonBody,
      },
      parameters: [{ in: "header", name: "Accept", schema: { type: "string" } }],
    },
  ],
]);

const mixed = () =>
  run("3.1", mixedPaths, {
    components: { securitySchemes: { oauth: { flows: {}, type: "oauth2" } } },
    "x-extra": true,
  });

describe("diagnostic order", () => {
  test("diagnostics come in document order: pointer by tokens, then code", () => {
    const { diagnostics } = mixed();

    see(diagnostics).toEqual(sortDiagnostics([entry], diagnostics));
    see(diagnostics.map((diagnostic) => [diagnostic.pointer, diagnostic.code])).toEqual([
      ["/paths/~1a/get/parameters/0", "STY-40/style-location"],
      ["/paths/~1a/get/requestBody", "OPR-10/body-refused"],
      ["/paths/~1a/parameters/0", "PRM-19/ignored-header"],
      ["/paths/~1b/delete", "OPR-09/required-body-refused"],
      ["/paths/~1b/delete", "SEC-06/no-satisfiable-alternative"],
      ["/paths/~1b/delete/requestBody/content/multipart~1form-data", "ENC-33/missing-schema"],
      ["/paths/~1b/delete/security/0", "SSC-18/not-implemented"],
    ]);
  });

  test("the same input yields the same diagnostics twice", () => {
    see(mixed().diagnostics).toEqual(mixed().diagnostics);
  });
});
