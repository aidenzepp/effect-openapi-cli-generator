import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
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

const ok: Json = { responses: { "200": { description: "ok" } } };

const run = (line: Line, securitySchemes: Json, security: Json) =>
  Effect.runSync(
    resolve({
      document: entry,
      line,
      value: {
        components: { securitySchemes },
        info: { title: "t", version: "1" },
        openapi: openapi[line],
        paths: { "/a": { get: { ...ok, security } } },
      },
    }).pipe(
      Effect.flatMap((resolution) =>
        normalize(resolution, { checkFindings: [], config, configDocument: configUri }),
      ),
    ),
  );

const codes = (diagnostics: readonly Diagnostic[]): readonly string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

const oauth: Json = {
  flows: {
    authorizationCode: {
      authorizationUrl: "https://a.example/authorize",
      refreshUrl: "https://a.example/refresh",
      scopes: { "pets:read": "Read pets", "pets:write": "Write pets" },
      tokenUrl: "https://a.example/token",
    },
    clientCredentials: {
      scopes: { admin: "Administer the store" },
      tokenUrl: "https://a.example/token",
    },
  },
  type: "oauth2",
};

const oidc: Json = {
  openIdConnectUrl: "https://a.example/.well-known/openid-configuration",
  type: "openIdConnect",
};

const key: Json = { in: "header", name: "X-Key", type: "apiKey" };

describe("oauth2 and openIdConnect schemes are usable", () => {
  for (const line of ["3.1", "3.2"] as const) {
    test(`on ${line} neither scheme is refused as not implemented and the operation stays`, () => {
      const { api, diagnostics } = run(line, { oauth, oidc }, [
        { oauth: ["pets:read"] },
        { oidc: [] },
      ]);

      see(codes(diagnostics).filter((code) => code.endsWith("/not-implemented"))).toEqual([]);
      see(api.operations.map((operation) => operation.key.path)).toEqual(["/a"]);
      see(api.operations[0]?.security.alternatives).toEqual([
        { uses: [{ scheme: "oauth", scopes: ["pets:read"] }] },
        { uses: [{ scheme: "oidc", scopes: [] }] },
      ]);
    });

    test(`on ${line} the model carries the flows, their URLs and scopes, and the discovery URL`, () => {
      const { api } = run(line, { oauth, oidc }, [{ oauth: [] }]);
      const kinds = api.securitySchemes.map((scheme) => scheme.kind);

      see(kinds).toEqual([
        {
          flows: {
            authorizationCode: {
              authorizationUrl: "https://a.example/authorize",
              refreshUrl: "https://a.example/refresh",
              scopes: [
                { description: "Read pets", name: "pets:read" },
                { description: "Write pets", name: "pets:write" },
              ],
              tokenUrl: "https://a.example/token",
            },
            clientCredentials: {
              scopes: [{ description: "Administer the store", name: "admin" }],
              tokenUrl: "https://a.example/token",
            },
          },
          type: "oauth2Token",
        },
        {
          openIdConnectUrl: "https://a.example/.well-known/openid-configuration",
          type: "oidcToken",
        },
      ]);
    });
  }

  test("each flow's acquisition stays refused at element scope with its own code", () => {
    const { diagnostics } = run("3.1", { oauth, oidc }, [{ oauth: [] }]);

    see(
      diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.scope, diagnostic.pointer]),
    ).toEqual([
      [
        "OAF-05/token-acquisition",
        "element",
        "/components/securitySchemes/oauth/flows/authorizationCode",
      ],
      [
        "OAF-04/token-acquisition",
        "element",
        "/components/securitySchemes/oauth/flows/clientCredentials",
      ],
      ["SSC-19/token-acquisition", "element", "/components/securitySchemes/oidc"],
    ]);
  });

  test("a scheme whose only flow is permanently refused keeps its operation", () => {
    const implicit: Json = {
      flows: { implicit: { authorizationUrl: "https://a.example/authorize", scopes: {} } },
      type: "oauth2",
    };
    const { api, diagnostics } = run("3.1", { implicit }, [{ implicit: [] }]);

    see(api.operations.map((operation) => operation.key.path)).toEqual(["/a"]);
    see(codes(diagnostics)).toEqual(["OAF-02/token-acquisition"]);
  });

  test("a mutualTLS alternative is still refused as not implemented", () => {
    const { api, diagnostics } = run("3.1", { key, mtls: { type: "mutualTLS" } }, [
      { mtls: [] },
      { key: [] },
    ]);

    see(codes(diagnostics)).toEqual(["SSC-20/not-implemented"]);
    see(api.operations[0]?.security.alternatives).toEqual([
      { uses: [{ scheme: "key", scopes: [] }] },
    ]);
  });
});

describe("two Authorization-setting schemes in one alternative", () => {
  const bearer: Json = { scheme: "bearer", type: "http" };

  test("oauth2 with http bearer is refused at the alternative while another keeps the operation", () => {
    const { api, diagnostics } = run("3.1", { bearer, key, oauth }, [
      { bearer: [], oauth: [] },
      { key: [] },
    ]);
    const conflict = diagnostics.find(
      (diagnostic) => diagnostic.code === "SEC-01/conflicting-authorization",
    );

    see(api.operations[0]?.security.alternatives).toEqual([
      { uses: [{ scheme: "key", scopes: [] }] },
    ]);
    see(conflict?.scope).toBe("element");
    see(conflict?.severity).toBe("refusal");
    see(conflict?.row).toBe("SEC-01");
    see(conflict?.pointer).toBe("/paths/~1a/get/security/0");
    see(conflict?.related?.map((site) => site.pointer)).toEqual([
      "/components/securitySchemes/bearer",
      "/components/securitySchemes/oauth",
    ]);
    see(codes(diagnostics)).not.toContain("SEC-06/no-satisfiable-alternative");
  });

  test("as the only alternative it refuses the operation with SEC-06", () => {
    const { api, diagnostics } = run("3.2", { bearer, oauth }, [{ bearer: [], oauth: [] }]);

    see(api.operations).toEqual([]);
    see(codes(diagnostics)).toContain("SEC-01/conflicting-authorization");
    see(
      diagnostics
        .filter((diagnostic) => diagnostic.scope === "operation")
        .map((diagnostic) => diagnostic.code),
    ).toEqual(["SEC-06/no-satisfiable-alternative"]);
  });

  test("http basic with an apiKey header named authorization is refused the same way", () => {
    const { api, diagnostics } = run(
      "3.1",
      {
        auth: { in: "header", name: "authorization", type: "apiKey" },
        basic: { scheme: "basic", type: "http" },
        key,
      },
      [{ auth: [], basic: [] }, { key: [] }],
    );

    see(codes(diagnostics)).toEqual(["SEC-01/conflicting-authorization"]);
    see(api.operations[0]?.security.alternatives).toEqual([
      { uses: [{ scheme: "key", scopes: [] }] },
    ]);
  });

  test("an apiKey header with another name does not conflict with http basic", () => {
    const { api, diagnostics } = run("3.1", { basic: { scheme: "basic", type: "http" }, key }, [
      { basic: [], key: [] },
    ]);

    see(codes(diagnostics)).toEqual([]);
    see(api.operations[0]?.security.alternatives).toHaveLength(1);
  });
});
