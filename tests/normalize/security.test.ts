import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { checkSpecText } from "../../src/check/index.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Diagnostic } from "../../src/model/diagnostic.ts";
import { normalizeSecurityPolicy, normalizeSecuritySchemes } from "../../src/normalize/security.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

interface Members {
  readonly [key: string]: Json;
}

// `checked` replaces check's own findings for the run; omitted, check runs on the spec.
const run = (line: Line, members: Members, operation?: string, checked?: readonly Diagnostic[]) =>
  Effect.runSync(
    Effect.gen(function* normalize() {
      const resolution = yield* resolve({
        document: entry,
        line,
        value: {
          info: { title: "t", version: "1" },
          openapi: openapi[line],
          paths: {},
          ...members,
        },
      });
      const findings = checked ?? (yield* checkSpecText(resolution));
      const schemes = yield* normalizeSecuritySchemes(resolution, undefined, findings);
      const policy = yield* normalizeSecurityPolicy(resolution, schemes, operation);

      return { policy, schemes };
    }),
  );

const withSchemes = (securitySchemes: Json, rest: Members = {}): Members => ({
  components: { securitySchemes },
  ...rest,
});

const codes = (diagnostics: readonly Diagnostic[]): readonly string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

const kinds = (schemes: Json, line: Line = "3.1"): readonly Json[] =>
  run(line, withSchemes(schemes)).schemes.schemes.map((scheme): Json => scheme.kind);

describe("cookie apiKey names", () => {
  test("a cookie name that is not a token is refused at element scope", () => {
    for (const name of ["a; admin=1", "a b", "a=b", "a,b", "a\u0007b", ""]) {
      const result = run("3.1", withSchemes({ c: { in: "cookie", name, type: "apiKey" } }));

      expect(result.schemes.schemes).toEqual([]);
      expect(result.schemes.unusable).toEqual(["c"]);
      expect(result.schemes.diagnostics.map((d) => [d.code, d.scope, d.severity])).toEqual([
        ["SSC-14/invalid-cookie-name", "element", "refusal"],
      ]);
      expect(JSON.stringify(result.schemes.diagnostics)).not.toContain("admin=1");
    }
  });

  test("a header apiKey name that is not a token is refused at element scope", () => {
    for (const name of ["a; b", "X Key", "x-key\u00E9", ""]) {
      const result = run("3.1", withSchemes({ h: { in: "header", name, type: "apiKey" } }));

      expect(result.schemes.schemes).toEqual([]);
      expect(result.schemes.unusable).toEqual(["h"]);
      expect(result.schemes.diagnostics.map((d) => [d.code, d.scope, d.severity])).toEqual([
        ["SSC-12/invalid-header-name", "element", "refusal"],
      ]);
      expect(JSON.stringify(result.schemes.diagnostics)).not.toContain("a; b");
    }
  });

  test("a query apiKey name and a token header name are accepted", () => {
    expect(kinds({ h: { in: "header", name: "X-Key", type: "apiKey" } }).length).toBe(1);
    expect(kinds({ q: { in: "query", name: "api key", type: "apiKey" } }).length).toBe(1);
  });
});

describe("scheme kinds", () => {
  test("apiKey in header, query and cookie", () => {
    expect(
      kinds({
        c: { in: "cookie", name: "sid", type: "apiKey" },
        h: { in: "header", name: "X-Key", type: "apiKey" },
        q: { in: "query", name: "key", type: "apiKey" },
      }),
    ).toEqual([
      { in: "cookie", name: "sid", type: "apiKey" },
      { in: "header", name: "X-Key", type: "apiKey" },
      { in: "query", name: "key", type: "apiKey" },
    ]);
  });

  test("http basic and bearer match case-insensitively", () => {
    expect(
      kinds({
        a: { scheme: "Basic", type: "http" },
        b: { scheme: "BEARER", type: "http" },
        c: { scheme: "bearer", type: "http" },
      }),
    ).toEqual([
      { scheme: "basic", type: "http" },
      { scheme: "bearer", type: "http" },
      { scheme: "bearer", type: "http" },
    ]);
  });

  test("oauth2, openIdConnect and mutualTLS are modelled", () => {
    const result = run(
      "3.1",
      withSchemes({
        m: { type: "mutualTLS" },
        o: {
          flows: { clientCredentials: { scopes: {}, tokenUrl: "https://a.example/t" } },
          type: "oauth2",
        },
        p: { openIdConnectUrl: "https://a.example/.well-known", type: "openIdConnect" },
      }),
    ).schemes.schemes.map((scheme) => scheme.kind.type);

    expect(result).toEqual(["mutualTls", "oauth2Token", "oidcToken"]);
  });

  test("a 3.2 deprecated scheme keeps its flag", () => {
    const { schemes } = run(
      "3.2",
      withSchemes({ k: { deprecated: true, in: "header", name: "K", type: "apiKey" } }),
    ).schemes;

    expect(schemes.map((scheme) => scheme.deprecated)).toEqual([true]);
  });

  test("an http scheme other than basic and bearer is refused at element scope", () => {
    const { schemes } = run(
      "3.1",
      withSchemes({
        d: { scheme: "digest", type: "http" },
        k: { in: "header", name: "K", type: "apiKey" },
      }),
    );

    expect(schemes.schemes.map((scheme) => scheme.name)).toEqual(["k"]);
    expect(schemes.unusable).toEqual(["d"]);
    expect(schemes.diagnostics.map((d) => [d.code, d.scope, d.severity, d.pointer])).toEqual([
      ["SSC-17/unsupported-scheme", "element", "refusal", "/components/securitySchemes/d"],
    ]);
  });
});

const keyed: Json = { in: "header", name: "K", type: "apiKey" };

const bearer: Json = { scheme: "bearer", type: "http" };

describe("policy shapes", () => {
  const schemes = withSchemes({ bearer, key: keyed });

  test("absent everywhere is undeclared", () => {
    const { policy } = run("3.1", schemes).policy;

    expect([policy.declared, policy.alternatives.length]).toEqual([false, 0]);
  });

  test("root list gives ordered alternatives with AND uses", () => {
    const result = run("3.1", {
      ...schemes,
      security: [{ bearer: ["a"], key: [] }, { bearer: [] }],
    }).policy;

    expect(result.policy.declared).toBe(true);
    expect(result.listed).toBe(2);
    expect(result.policy.alternatives).toEqual([
      {
        uses: [
          { scheme: "bearer", scopes: ["a"] },
          { scheme: "key", scopes: [] },
        ],
      },
      { uses: [{ scheme: "bearer", scopes: [] }] },
    ]);
  });

  test("{} is an anonymous alternative", () => {
    const { policy } = run("3.1", { ...schemes, security: [{ key: [] }, {}] }).policy;

    expect(policy.alternatives.map((alternative) => alternative.uses.length)).toEqual([1, 0]);
  });

  test("[] declares no alternatives", () => {
    const result = run("3.1", { ...schemes, security: [] }).policy;

    expect([result.policy.declared, result.policy.alternatives.length, result.listed]).toEqual([
      true,
      0,
      0,
    ]);
  });

  test("an operation list replaces the root list, including with []", () => {
    const members = {
      ...schemes,
      paths: { "/a": { get: { security: [] } }, "/b": { get: { security: [{ bearer: [] }] } } },
      security: [{ key: [] }],
    };

    expect(run("3.1", members, "/paths/~1a/get").policy.policy.alternatives).toEqual([]);
    expect(
      run("3.1", members, "/paths/~1b/get").policy.policy.alternatives.map(
        (a) => a.uses[0]?.scheme,
      ),
    ).toEqual(["bearer"]);
    expect(
      run("3.1", { ...members, paths: { "/c": { get: {} } } }, "/paths/~1c/get").policy.policy
        .alternatives.length,
    ).toBe(1);
  });
});

describe("undeclared names", () => {
  // Check raises SEC-09 or SEC-10 `unresolved-scheme` at the name; normalize adds no second one.
  test("remove only their alternative, leaving the refusal to check", () => {
    const { policy } = run("3.1", {
      ...withSchemes({ key: keyed }),
      security: [{ missing: [] }, { key: [] }],
    });

    expect(policy.policy.alternatives).toEqual([{ uses: [{ scheme: "key", scopes: [] }] }]);
    expect(policy.listed).toBe(2);
    expect(policy.diagnostics).toEqual([]);
  });

  test("the only alternative gone leaves none with listed 1", () => {
    const { policy } = run("3.1", { security: [{ missing: [] }] });

    expect([policy.policy.alternatives.length, policy.listed]).toEqual([0, 1]);
  });

  test("an alternative naming a refused http scheme is refused with it", () => {
    const { policy } = run("3.1", {
      ...withSchemes({ d: { scheme: "digest", type: "http" } }),
      security: [{ d: [] }],
    });

    expect(policy.policy.alternatives).toEqual([]);
    expect(codes(policy.diagnostics)).toEqual(["SEC-02/unusable-scheme"]);
  });
});

const certified = withSchemes({ key: keyed, mtls: { type: "mutualTLS" } });

describe("mutualTLS alternatives are kept", () => {
  for (const line of ["3.1", "3.2"] as const) {
    test(`mtls on ${line} is kept beside another alternative with no refusal`, () => {
      const { policy } = run(line, { ...certified, security: [{ mtls: [] }, { key: [] }] });

      expect(policy.policy.alternatives).toEqual([
        { uses: [{ scheme: "mtls", scopes: [] }] },
        { uses: [{ scheme: "key", scopes: [] }] },
      ]);
      expect(policy.diagnostics).toEqual([]);
    });
  }

  test("an AND alternative naming mtls keeps every scheme", () => {
    const { policy } = run("3.1", { ...certified, security: [{ key: [], mtls: [] }] });

    expect(policy.policy.alternatives).toEqual([
      {
        uses: [
          { scheme: "key", scopes: [] },
          { scheme: "mtls", scopes: [] },
        ],
      },
    ]);
    expect(policy.diagnostics).toEqual([]);
  });
});

describe("token acquisition stays refused", () => {
  const flowCases: readonly (readonly [string, string, boolean])[] = [
    ["implicit", "OAF-02/token-acquisition", true],
    ["password", "OAF-03/token-acquisition", true],
    ["clientCredentials", "OAF-04/token-acquisition", false],
    ["authorizationCode", "OAF-05/token-acquisition", false],
    ["deviceAuthorization", "OAF-06/token-acquisition", false],
  ];

  for (const [flow, code, permanent] of flowCases) {
    test(`oauth2 ${flow} is refused at its flow pointer and the hint never names Milestone 3`, () => {
      const { schemes } = run(
        "3.2",
        withSchemes({
          o: { flows: { [flow]: { scopes: {}, tokenUrl: "https://a.example/t" } }, type: "oauth2" },
        }),
      );
      const [refusal] = schemes.diagnostics;

      expect(schemes.schemes).toHaveLength(1);
      expect(refusal?.code).toBe(code);
      expect(refusal?.scope).toBe("element");
      expect(String(refusal?.pointer)).toBe(`/components/securitySchemes/o/flows/${flow}`);
      expect(refusal?.hint).not.toContain("Milestone 3");
      expect(refusal?.hint?.includes("permanent")).toBe(permanent);
    });
  }

  test("openIdConnect acquisition is refused at the scheme", () => {
    const { schemes } = run(
      "3.1",
      withSchemes({
        o: { openIdConnectUrl: "https://a.example/.well-known", type: "openIdConnect" },
      }),
    );

    expect(codes(schemes.diagnostics)).toEqual(["SSC-19/token-acquisition"]);
    expect(schemes.diagnostics[0]?.hint).not.toContain("Milestone 3");
  });
});

// A check finding at `pointer`, for a run that replaces check's own.
const unresolved = (code: string, pointer: string): Diagnostic =>
  Schema.decodeUnknownSync(Diagnostic)({
    code,
    document: entry,
    element: "Security Requirement Object",
    message: "The requirement names a security scheme that does not resolve.",
    openapi: "3.2.0",
    pointer,
    row: code.split("/")[0],
    scope: "element",
    severity: "refusal",
    specSection: "https://spec.openapis.org/oas/v3.2.0#security-requirement-object",
  });

describe("names check refused", () => {
  // Normalize reads check's findings and never re-derives them. Each spec below is one where the
  // implicit connection and the findings disagree, so only reading the findings passes.
  test("a finding at the name suppresses normalize's own, though the name reaches an object", () => {
    // The URI reaches an object that is no component scheme: the connection finds it, check has
    // no finding of its own, and only the injected one says refused.
    const name = "#/components/schemas/X";
    const members = {
      components: { schemas: { X: { type: "object" } }, securitySchemes: { key: keyed } },
      security: [{ [name]: [] }],
    };
    const pointer = "/security/0/#~1components~1schemas~1X";

    expect(codes(run("3.2", members, undefined, []).policy.diagnostics)).toEqual([
      "SEC-10/undeclared-scheme",
    ]);

    const { policy } = run("3.2", members, undefined, [
      unresolved("SEC-10/unresolved-scheme", pointer),
    ]);

    expect(policy.policy.alternatives).toEqual([]);
    expect(codes(policy.diagnostics)).toEqual([]);
  });

  test("no finding at the name keeps normalize's own, though the name reaches nothing", () => {
    const { policy } = run("3.1", { security: [{ missing: [] }] }, undefined, []);

    expect(policy.policy.alternatives).toEqual([]);
    expect(policy.diagnostics.map((d) => [d.code, d.scope, d.pointer])).toEqual([
      ["SEC-09/undeclared-scheme", "element", "/security/0/missing"],
    ]);
  });

  test("a finding with another code or pointer suppresses nothing", () => {
    const { policy } = run("3.1", { security: [{ missing: [] }] }, undefined, [
      unresolved("SEC-09/unresolved-scheme", "/security/0/other"),
      unresolved("SEC-06/no-satisfiable-alternative", "/security/0/missing"),
    ]);

    expect(codes(policy.diagnostics)).toEqual(["SEC-09/undeclared-scheme"]);
  });
});

describe("3.2 scheme URIs (SEC-10)", () => {
  const uriName = "https://evil.example/s";

  test("a SEC-10-refused scheme attaches no credential and refuses its alternatives", () => {
    const { policy, schemes } = run("3.2", {
      ...withSchemes({ [uriName]: bearer, key: keyed }),
      security: [{ [uriName]: [] }, { key: [] }],
    });

    expect(schemes.schemes.map((scheme) => scheme.name)).toEqual(["key"]);
    expect(schemes.unusable).toEqual([uriName]);
    expect(policy.policy.alternatives).toEqual([{ uses: [{ scheme: "key", scopes: [] }] }]);
    expect(codes(policy.diagnostics)).toEqual(["SEC-02/unusable-scheme"]);
  });

  test("a requirement by scheme URI resolves to the component", () => {
    const { policy } = run("3.2", {
      ...withSchemes({ key: keyed }),
      security: [{ "#/components/securitySchemes/key": ["a"] }],
    });

    expect(codes(policy.diagnostics)).toEqual([]);
    expect(policy.policy.alternatives).toEqual([{ uses: [{ scheme: "key", scopes: ["a"] }] }]);
  });

  test("a requirement by scheme URI is undeclared before 3.2", () => {
    const { policy } = run("3.1", {
      ...withSchemes({ key: keyed }),
      security: [{ "#/components/securitySchemes/key": [] }],
    });

    expect(policy.policy.alternatives).toEqual([]);
    // Check refuses the name (SEC-09/unresolved-scheme); normalize adds nothing.
    expect(codes(policy.diagnostics)).toEqual([]);
  });

  test("a scheme URI outside the component names stays undeclared", () => {
    const { policy } = run("3.2", {
      ...withSchemes({ key: keyed }),
      security: [{ "#/components/securitySchemes/missing": [] }],
    });

    expect(policy.policy.alternatives).toEqual([]);
    // Check refuses the name (SEC-10/unresolved-scheme); normalize adds nothing.
    expect(codes(policy.diagnostics)).toEqual([]);
  });
});

// The scheme list's element reads while `normalizeSecurityPolicy` resolves one alternative that
// names all `count` schemes. A lookup built once reads each scheme a bounded number of times; a
// scan per requirement name reads about count² of them.
const elementReads = (count: number): number => {
  const securitySchemes: Record<string, Json> = {};
  const requirement: Record<string, Json> = {};
  for (let index = 0; index < count; index += 1) {
    securitySchemes[`s${index}`] = keyed;
    requirement[`s${index}`] = [];
  }

  let reads = 0;
  const reader =
    <T>(item: T) =>
    (): T => {
      reads += 1;

      return item;
    };
  // A copy of `items` whose elements count each read.
  const counted = <T>(items: readonly T[]): readonly T[] => {
    const tracked: T[] = [];
    for (const [index, item] of items.entries()) {
      Object.defineProperty(tracked, index, { enumerable: true, get: reader(item) });
    }

    return tracked;
  };

  const uses = Effect.runSync(
    Effect.gen(function* normalize() {
      const resolution = yield* resolve({
        document: entry,
        line: "3.1",
        value: {
          info: { title: "t", version: "1" },
          openapi: openapi["3.1"],
          paths: {},
          ...withSchemes(securitySchemes, { security: [requirement] }),
        },
      });
      const schemes = yield* normalizeSecuritySchemes(
        resolution,
        undefined,
        yield* checkSpecText(resolution),
      );
      const policy = yield* normalizeSecurityPolicy(resolution, {
        ...schemes,
        schemes: counted(schemes.schemes),
        unusable: counted(schemes.unusable),
      });

      return policy.policy.alternatives[0]?.uses.length ?? 0;
    }),
  );
  expect(uses).toBe(count);

  return reads;
};

describe("scheme lookup budget", () => {
  test("resolving an alternative of every scheme reads each scheme a bounded number of times (linear, not quadratic)", () => {
    const count = 2000;

    expect(elementReads(count)).toBeLessThanOrEqual(2 * count);
  });
});
