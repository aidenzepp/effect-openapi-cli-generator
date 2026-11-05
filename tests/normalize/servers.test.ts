import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri, JsonPointer } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import { boundOrigins, effectiveServers } from "../../src/normalize/servers.ts";
import type { ServerSource, ServersContext } from "../../src/normalize/servers.ts";
import type { Json } from "../../src/resolve/pointer.ts";

const uri = Schema.decodeUnknownSync(DocumentUri);

const pointer = Schema.decodeUnknownSync(JsonPointer);

const config = (extra: Record<string, Json> = {}) =>
  Schema.decodeUnknownSync(AuthorConfig)({
    binName: "example",
    package: { name: "example-cli", version: "1.0.0" },
    ...extra,
  });

const context = (extra: Record<string, Json> = {}, openapi = "3.1.0"): ServersContext => ({
  config: config(extra),
  configDocument: uri("file:///work/author.json"),
  document: uri("https://example.com/openapi.json"),
  openapi,
});

const accepting = (...accepted: string[]) => ({ servers: { accepted } });

const root = (value?: Json): ServerSource => ({ pointer: pointer("/servers"), value });

const operationSource = (value: Json | undefined): ServerSource => ({
  pointer: pointer("/paths/~1a/get/servers"),
  value,
});

const pathItemSource = (value: Json | undefined): ServerSource => ({
  pointer: pointer("/paths/~1a/servers"),
  value,
});

const see = (value: readonly unknown[] | string | boolean | undefined) => expect(value);

const codes = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => d.code);

const normalize = (value: Json | undefined, ctx: ServersContext) =>
  effectiveServers({ root: root(value) }, ctx);

const url = (template: string, extra: Record<string, Json> = {}): Json => ({
  url: template,
  ...extra,
});

describe("effective servers", () => {
  test("the operation level wins over the path item and the root", () => {
    const result = effectiveServers(
      {
        operation: operationSource([url("https://op.example.com")]),
        pathItem: pathItemSource([url("https://item.example.com")]),
        root: root([url("https://root.example.com")]),
      },
      context(),
    );
    see(result.servers.map((s) => [s.template, s.level])).toEqual([
      ["https://op.example.com", "operation"],
    ]);
  });

  test("the path item level wins over the root", () => {
    const result = effectiveServers(
      {
        pathItem: pathItemSource([url("https://item.example.com")]),
        root: root([url("https://root.example.com")]),
      },
      context(),
    );
    see(result.servers.map((s) => [s.template, s.level])).toEqual([
      ["https://item.example.com", "pathItem"],
    ]);
  });

  test("the root applies when no other level declares servers", () => {
    const result = effectiveServers({ root: root([url("https://root.example.com")]) }, context());
    see(result.servers.map((s) => [s.template, s.level])).toEqual([
      ["https://root.example.com", "root"],
    ]);
  });

  test("an empty root or an absent root means the single server /", () => {
    const absent = normalize(undefined, context());
    const empty = normalize([], context());
    see(absent.servers.map((s) => [s.template, s.level])).toEqual([["/", "root"]]);
    see(empty.servers.map((s) => s.template)).toEqual(["/"]);
    see(codes([...absent.diagnostics, ...empty.diagnostics])).toEqual([]);
  });

  test("an empty override at the operation or path item is refused with SRV-16", () => {
    const operationLevel = effectiveServers(
      { operation: operationSource([]), root: root([url("https://root.example.com")]) },
      context(),
    );
    const pathLevel = effectiveServers(
      { pathItem: pathItemSource([]), root: root([url("https://root.example.com")]) },
      context(),
    );
    see(codes(operationLevel.diagnostics)).toEqual(["SRV-16/empty-override"]);
    see(operationLevel.diagnostics.map((d) => [d.scope, d.severity, d.pointer])).toEqual([
      ["operation", "refusal", "/paths/~1a/get/servers"],
    ]);
    see(codes(pathLevel.diagnostics)).toEqual(["SRV-16/empty-override"]);
    see(pathLevel.diagnostics.map((d) => d.pointer)).toEqual(["/paths/~1a/servers"]);
    see(operationLevel.servers).toEqual([]);
    see(pathLevel.servers).toEqual([]);
  });

  test("a servers value that is not a list of server objects is refused with SRV-01", () => {
    const notList = normalize("https://example.com", context());
    const notObject = normalize(["https://example.com"], context());
    see(codes(notList.diagnostics)).toEqual(["SRV-01/invalid-server"]);
    see(codes(notObject.diagnostics)).toEqual(["SRV-01/invalid-server"]);
    see(notObject.diagnostics.map((d) => d.pointer)).toEqual(["/servers/0"]);
    see([...notList.servers, ...notObject.servers]).toEqual([]);
  });

  test("a template that is not a legal server URL template is refused with SRV-19", () => {
    const result = normalize([url("https://exa mple.com")], context());
    see(codes(result.diagnostics)).toEqual(["SRV-19/invalid-template"]);
    see(result.servers).toEqual([]);
  });

  test("a variable that is used but not declared is refused with SRV-11", () => {
    const result = normalize([url("https://{host}.example.com")], context());
    see(codes(result.diagnostics)).toEqual(["SRV-11/undeclared-variable"]);
    see(result.servers).toEqual([]);
  });
});

describe("acceptance comes only from the author config", () => {
  test("a spec server is not accepted unless the config lists it", () => {
    const result = normalize([url("https://api.example.com")], context());
    see(result.servers.map((s) => [s.accepted, s.origins])).toEqual([[false, []]]);
    see(result.diagnostics).toEqual([]);
  });

  test("a server listed by URL is accepted and contributes its origin without the path", () => {
    const result = normalize(
      [url("https://api.example.com/v1"), url("https://other.example.com")],
      context(accepting("https://api.example.com/v1")),
    );
    see(result.servers.map((s) => [s.template, s.accepted, s.origins])).toEqual([
      ["https://api.example.com/v1", true, ["https://api.example.com"]],
      ["https://other.example.com", false, []],
    ]);
  });

  test("a 3.2 server is accepted by name, and a name means nothing in 3.1", () => {
    const servers: Json = [url("https://api.example.com", { name: "prod" })];
    const byName = normalize(servers, context(accepting("prod"), "3.2.0"));
    const ignored = normalize(servers, context(accepting("prod"), "3.1.0"));
    see(byName.servers.map((s) => [s.name, s.accepted])).toEqual([["prod", true]]);
    see(ignored.servers.map((s) => [s.name ?? null, s.accepted])).toEqual([[null, false]]);
  });

  test("the server keeps the use site pointer and its inventory rows", () => {
    const result = effectiveServers(
      { operation: operationSource([url("https://api.example.com")]), root: root() },
      context(),
    );
    see(result.servers.map((s) => s.origin.pointer)).toEqual(["/paths/~1a/get/servers/0"]);
    see(result.servers.every((s) => s.rows.map(String).includes("SRV-15"))).toBe(true);
  });
});

const refused = (template: string, extra: Record<string, Json> = {}) =>
  normalize([url(template)], context({ ...accepting(template), ...extra }));

describe("baked defaults", () => {
  test("http is refused without allowInsecure and accepted with it", () => {
    const without = refused("http://localhost:8080");
    const withFlag = refused("http://localhost:8080", { allowInsecure: true });
    see(codes(without.diagnostics)).toEqual(["SRV-02/insecure-scheme"]);
    see(without.diagnostics.map((d) => [d.scope, d.document, d.pointer])).toEqual([
      ["document", "file:///work/author.json", "/servers/accepted/0"],
    ]);
    see(without.servers.map((s) => [s.accepted, s.origins])).toEqual([[false, []]]);
    see(withFlag.servers.map((s) => s.origins)).toEqual([["http://localhost:8080"]]);
    see(withFlag.diagnostics).toEqual([]);
  });

  test("a scheme other than http and https is refused even with allowInsecure", () => {
    const result = refused("ftp://files.example.com", { allowInsecure: true });
    see(codes(result.diagnostics)).toEqual(["SRV-02/unsupported-scheme"]);
  });

  test("userinfo is refused and never echoed", () => {
    const result = refused("https://user:canary-secret@api.example.com");
    see(codes(result.diagnostics)).toEqual(["SRV-02/userinfo"]);
    see(JSON.stringify(result.diagnostics)).not.toContain("canary-secret");
  });

  test("a query or a fragment in the template is refused", () => {
    see(codes(refused("https://api.example.com/v1?key=1").diagnostics)).toEqual([
      "SRV-18/query-or-fragment",
    ]);
    see(codes(refused("https://api.example.com/v1#top").diagnostics)).toEqual([
      "SRV-18/query-or-fragment",
    ]);
  });

  test("a server that is not accepted is not checked against the baked-default rules", () => {
    const result = normalize([url("http://localhost:8080")], context());
    see(result.diagnostics).toEqual([]);
    see(result.servers.map((s) => s.accepted)).toEqual([false]);
  });
});

describe("relative servers", () => {
  test("a relative server needs retrievalUri to be accepted", () => {
    const result = normalize([url("/v1")], context(accepting("/v1")));
    see(codes(result.diagnostics)).toEqual(["SRV-17/relative-needs-retrieval-uri"]);
    see(result.servers.map((s) => [s.accepted, s.origins])).toEqual([[false, []]]);
  });

  test("with retrievalUri the relative server's origin is the retrieval origin", () => {
    const result = normalize(
      [url("/v1")],
      context({ ...accepting("/v1"), retrievalUri: "https://docs.example.com/specs/openapi.json" }),
    );
    see(result.diagnostics).toEqual([]);
    see(result.servers.map((s) => s.origins)).toEqual([["https://docs.example.com"]]);
  });

  test("the implicit / server is accepted only through retrievalUri", () => {
    const without = normalize(undefined, context(accepting("/")));
    const withUri = normalize(
      undefined,
      context({ ...accepting("/"), retrievalUri: "https://docs.example.com/openapi.json" }),
    );
    see(codes(without.diagnostics)).toEqual(["SRV-17/relative-needs-retrieval-uri"]);
    see(withUri.servers.map((s) => s.origins)).toEqual([["https://docs.example.com"]]);
  });

  test("an insecure retrievalUri is refused like any baked default", () => {
    const result = normalize(
      [url("/v1")],
      context({ ...accepting("/v1"), retrievalUri: "http://docs.example.com/openapi.json" }),
    );
    see(codes(result.diagnostics)).toEqual(["SRV-02/insecure-scheme"]);
  });

  test("a relative form that could change scheme is refused", () => {
    const result = normalize(
      [url("v1:evil")],
      context({ ...accepting("v1:evil"), retrievalUri: "https://docs.example.com/openapi.json" }),
    );
    see(codes(result.diagnostics)).toEqual(["SRV-02/unsupported-form"]);
  });
});

const check = (entry: string, extra: Record<string, Json> = {}) =>
  boundOrigins([], context({ acceptedOrigins: [entry], ...extra }));

describe("server variables and the bound origin set", () => {
  const regional = url("https://{region}.example.com/v1", {
    variables: { region: { default: "eu", enum: ["us", "eu"] } },
  });

  test("an enumerated host variable contributes every member as an origin", () => {
    const ctx = context(accepting("https://{region}.example.com/v1"));
    const result = normalize([regional], ctx);
    see(result.diagnostics).toEqual([]);
    see(result.servers.map((s) => s.origins)).toEqual([
      ["https://eu.example.com", "https://us.example.com"],
    ]);
    see(boundOrigins(result.servers, ctx).origins).toEqual([
      "https://eu.example.com",
      "https://us.example.com",
    ]);
  });

  test("the default is expanded as an origin even when the enum omits it", () => {
    const result = normalize(
      [
        url("https://{region}.example.com", {
          variables: { region: { default: "ap", enum: ["us"] } },
        }),
      ],
      context(accepting("https://{region}.example.com")),
    );
    see(result.servers.map((s) => s.origins)).toEqual([
      ["https://ap.example.com", "https://us.example.com"],
    ]);
  });

  test("a scheme or authority variable without an enum is refused", () => {
    const host = url("https://{host}/v1", { variables: { host: { default: "api.example.com" } } });
    const scheme = url("{scheme}://api.example.com", {
      variables: { scheme: { default: "https" } },
    });
    const hostResult = normalize([host], context(accepting("https://{host}/v1")));
    const schemeResult = normalize([scheme], context(accepting("{scheme}://api.example.com")));
    see(codes(hostResult.diagnostics)).toEqual(["SRV-05/variable-needs-enum"]);
    see(codes(schemeResult.diagnostics)).toEqual(["SRV-05/variable-needs-enum"]);
    see(hostResult.servers.map((s) => [s.accepted, s.origins])).toEqual([[false, []]]);
  });

  test("a scheme variable member that is http is refused unless allowInsecure", () => {
    const scheme = url("{scheme}://api.example.com", {
      variables: { scheme: { default: "https", enum: ["https", "http"] } },
    });
    const without = normalize([scheme], context(accepting("{scheme}://api.example.com")));
    const withFlag = normalize(
      [scheme],
      context({ ...accepting("{scheme}://api.example.com"), allowInsecure: true }),
    );
    see(codes(without.diagnostics)).toEqual(["SRV-02/insecure-scheme"]);
    see(withFlag.servers.map((s) => s.origins)).toEqual([
      ["http://api.example.com", "https://api.example.com"],
    ]);
  });

  test("an enum member that smuggles userinfo or a query into the authority is refused", () => {
    const userinfo = url("https://{host}", {
      variables: {
        host: { default: "api.example.com", enum: ["api.example.com", "a@evil.example"] },
      },
    });
    const query = url("https://{host}", {
      variables: {
        host: { default: "api.example.com", enum: ["api.example.com", "evil.example?x"] },
      },
    });
    see(codes(normalize([userinfo], context(accepting("https://{host}"))).diagnostics)).toEqual([
      "SRV-02/userinfo",
    ]);
    see(codes(normalize([query], context(accepting("https://{host}"))).diagnostics)).toEqual([
      "SRV-18/query-or-fragment",
    ]);
  });

  test("a path variable default or enum member carrying ? or # is refused without echoing it", () => {
    const template = "https://api.example.com/{v}";
    const withDefault = (fallback: string) =>
      normalize(
        [url(template, { variables: { v: { default: fallback } } })],
        context(accepting(template)),
      );
    const withMember = (member: string) =>
      normalize(
        [url(template, { variables: { v: { default: "v1", enum: ["v1", member] } } })],
        context(accepting(template)),
      );
    const query = withDefault("v1?canary-secret=1");
    const fragment = withDefault("v1#canary-secret");
    const queryMember = withMember("v2?canary-secret=1");
    const fragmentMember = withMember("v2#canary-secret");
    for (const result of [query, fragment, queryMember, fragmentMember]) {
      see(codes(result.diagnostics)).toEqual(["SRV-18/query-or-fragment"]);
      see(result.servers.map((s) => [s.accepted, s.origins])).toEqual([[false, []]]);
      see(JSON.stringify(result.diagnostics)).not.toContain("canary-secret");
    }
  });

  test("a path variable value that leaves the template authority is refused", () => {
    const relative = normalize(
      [url("/{x}", { variables: { x: { default: "/evil.com" } } })],
      context({ ...accepting("/{x}"), retrievalUri: "https://api.example.com/spec.json" }),
    );
    const member = normalize(
      [url("/{x}", { variables: { x: { default: "v1", enum: ["v1", "/evil.com"] } } })],
      context({ ...accepting("/{x}"), retrievalUri: "https://api.example.com/spec.json" }),
    );
    for (const result of [relative, member]) {
      see(codes(result.diagnostics)).toEqual(["SRV-02/value-leaves-authority"]);
      see(result.servers.map((s) => [s.accepted, s.origins])).toEqual([[false, []]]);
      see(JSON.stringify(result.diagnostics)).not.toContain("evil.com");
    }
  });

  test("a path variable needs no enum and adds no origin", () => {
    const result = normalize(
      [url("https://api.example.com/{version}", { variables: { version: { default: "v1" } } })],
      context(accepting("https://api.example.com/{version}")),
    );
    see(result.diagnostics).toEqual([]);
    see(result.servers.map((s) => s.origins)).toEqual([["https://api.example.com"]]);
  });

  test("variables are listed in name order", () => {
    const result = normalize(
      [
        url("https://api.example.com/{b}/{a}", {
          variables: { a: { default: "2" }, b: { default: "1" } },
        }),
      ],
      context(),
    );
    see(result.servers.map((s) => s.variables.map((v) => v.name))).toEqual([["a", "b"]]);
  });

  test("an expansion count above the cap is refused with SRV-05", () => {
    const members = Array.from({ length: 20 }, (_, index) => `h${index}`);
    const variable = { default: "h0", enum: members };
    const result = normalize(
      [url("https://{a}.{b}.example.com", { variables: { a: variable, b: variable } })],
      context(accepting("https://{a}.{b}.example.com")),
    );
    see(codes(result.diagnostics)).toEqual(["SRV-05/too-many-origins"]);
    see(result.servers.map((s) => s.origins)).toEqual([[]]);
  });

  test("the bound set adds acceptedOrigins, drops duplicates and sorts", () => {
    const ctx = context({
      ...accepting("https://{region}.example.com/v1"),
      acceptedOrigins: ["https://zz.example.com", "https://eu.example.com"],
    });
    const spec = normalize([regional, url("https://other.example.com")], ctx);
    const bound = boundOrigins(spec.servers, ctx);
    see(bound.diagnostics).toEqual([]);
    see(bound.origins).toEqual([
      "https://eu.example.com",
      "https://us.example.com",
      "https://zz.example.com",
    ]);
  });

  test("an unaccepted server adds nothing to the bound set", () => {
    const ctx = context();
    const spec = normalize([regional], ctx);
    see(boundOrigins(spec.servers, ctx).origins).toEqual([]);
  });

  test("acceptedOrigins entries follow the baked-default rules and must be origins", () => {
    const refusal = check("http://a.example.com").diagnostics.at(0);

    see(codes(check("http://a.example.com").diagnostics)).toEqual(["SRV-02/insecure-scheme"]);
    see(check("http://a.example.com", { allowInsecure: true }).origins).toEqual([
      "http://a.example.com",
    ]);
    see(codes(check("https://u:p@a.example.com").diagnostics)).toEqual(["SRV-02/userinfo"]);
    see(codes(check("https://a.example.com/v1").diagnostics)).toEqual(["SRV-02/not-an-origin"]);
    see(codes(check("https://a.example.com?x=1").diagnostics)).toEqual([
      "SRV-18/query-or-fragment",
    ]);
    see(check("https://a.example.com/").origins).toEqual(["https://a.example.com"]);
    see(refusal?.pointer).toBe("/acceptedOrigins/0");
    see(refusal?.document).toBe("file:///work/author.json");
    see(check("http://a.example.com").origins).toEqual([]);
  });
});
