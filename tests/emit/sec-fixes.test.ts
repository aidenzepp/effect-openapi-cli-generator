import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { checkSpecText } from "../../src/check/index.ts";
import { operationHelp } from "../../src/emit/help.ts";
import type { HelpInput } from "../../src/emit/help.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import { Operation, SecurityScheme } from "../../src/model/entities.ts";
import type { Json } from "../../src/model/pointer.ts";
import { normalizeSecurityPolicy, normalizeSecuritySchemes } from "../../src/normalize/security.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const configUri = Schema.decodeUnknownSync(DocumentUri)("file:///spec/author.json");

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

const keyed: Json = { in: "header", name: "X-Key", type: "apiKey" };

const ok: Json = { responses: { "200": { description: "ok" } } };

const summary = (diagnostics: readonly Diagnostic[]) =>
  diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.pointer]);

// Check and normalize over one document; `operation` is the policy's operation pointer.
const run = (line: Line, members: { readonly [key: string]: Json }, operation?: string) =>
  Effect.runSync(
    Effect.gen(function* both() {
      const resolution = yield* resolve({
        document: entry,
        line,
        value: { info: { title: "t", version: "1" }, openapi: openapi[line], ...members },
      });
      const checked = yield* checkSpecText(resolution);
      const schemes = yield* normalizeSecuritySchemes(resolution, undefined, checked);
      const policy = yield* normalizeSecurityPolicy(resolution, schemes, operation);

      return { checked, policy };
    }),
  );

describe("one diagnostic per undeclared requirement name", () => {
  for (const [line, code] of [
    ["3.0", "SEC-09/unresolved-scheme"],
    ["3.1", "SEC-09/unresolved-scheme"],
    ["3.2", "SEC-10/unresolved-scheme"],
  ] as const) {
    test(`a root name is reported once, by check, and its alternative is dropped (${line})`, () => {
      const { checked, policy } = run(line, {
        components: { securitySchemes: { key: keyed } },
        paths: { "/a": { get: ok } },
        security: [{ missing: [] }, { key: [] }],
      });

      expect(summary([...checked, ...policy.diagnostics])).toEqual([[code, "/security/0/missing"]]);
      expect(policy.policy.alternatives.map((one) => one.uses.map((use) => use.scheme))).toEqual([
        ["key"],
      ]);
      expect(policy.listed).toBe(2);
    });
  }

  test("an operation name alongside a declared one drops the whole alternative, once reported", () => {
    const { checked, policy } = run(
      "3.1",
      {
        components: { securitySchemes: { key: keyed } },
        paths: { "/a": { get: { ...ok, security: [{ key: [], missing: [] }] } } },
      },
      "/paths/~1a/get",
    );

    expect(summary([...checked, ...policy.diagnostics])).toEqual([
      ["SEC-09/unresolved-scheme", "/paths/~1a/get/security/0/missing"],
    ]);
    expect([policy.policy.alternatives.length, policy.listed]).toEqual([0, 1]);
  });

  test("a 3.2 URI that reaches a non-scheme node check accepts is still refused, by normalize", () => {
    const { checked, policy } = run("3.2", {
      components: { securitySchemes: { key: keyed } },
      paths: { "/a": { get: ok } },
      security: [{ "#/info": [] }],
    });

    expect(summary(checked)).toEqual([]);
    expect(summary(policy.diagnostics)).toEqual([
      ["SEC-10/undeclared-scheme", "/security/0/#~1info"],
    ]);
    expect(policy.policy.alternatives).toEqual([]);
  });

  test("an undeclared name in the author's requirement is reported by normalize", () => {
    const config = Effect.runSync(
      decodeAuthorConfig(
        {
          binName: "example",
          package: { name: "example-cli", version: "1.0.0" },
          security: { add: { requirement: [{ missing: [] }], schemes: { key: keyed } } },
        },
        { document: configUri },
      ),
    );
    const policy = Effect.runSync(
      Effect.gen(function* supplied() {
        const resolution = yield* resolve({
          document: entry,
          line: "3.1",
          value: {
            info: { title: "t", version: "1" },
            openapi: "3.1.1",
            paths: { "/a": { get: ok } },
          },
        });
        const schemes = yield* normalizeSecuritySchemes(
          resolution,
          { config, configDocument: configUri },
          [],
        );

        return yield* normalizeSecurityPolicy(resolution, schemes, "/paths/~1a/get");
      }),
    );

    expect(
      policy.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.document,
        diagnostic.pointer,
      ]),
    ).toEqual([["SEC-09/undeclared-scheme", configUri, "/security/add/requirement/0/missing"]]);
  });
});

const origin = { document: "file:///spec.json", pointer: "/paths/~1x/get" };

const rows = ["SEC-01"];

const scheme = Schema.decodeUnknownSync(SecurityScheme)({
  credentialSources: ["flag", "env"],
  deprecated: false,
  kind: { in: "header", name: "X-Key", type: "apiKey" },
  name: "headerKey",
  origin,
  rows,
  source: "spec",
});

const helpFor = (security: Json): HelpInput => ({
  credentials: [{ env: "EXAMPLE_HEADER_KEY", flag: "header-key-file", scheme: "headerKey" }],
  diagnostics: [],
  flags: [],
  operation: Schema.decodeUnknownSync(Operation)({
    deprecated: false,
    docs: {},
    key: { method: "GET", path: "/x" },
    origin,
    parameters: [],
    responses: [],
    rows: ["OPR-01"],
    security,
    servers: [],
    tags: [],
  }),
  schemes: [scheme],
});

const auth = (security: Json) =>
  operationHelp(helpFor(security)).sections.find(([title]) => title === "AUTH")?.[1];

const keyUse = { uses: [{ scheme: "headerKey", scopes: [] }] };

const keyLine =
  "headerKey (apiKey header X-Key): --header-key-file <path|->, env EXAMPLE_HEADER_KEY";

describe("AUTH help for empty and absent security", () => {
  test("an empty alternative reads `no authentication`, in document order", () => {
    expect(auth({ alternatives: [keyUse, { uses: [] }], declared: true, origin, rows })).toBe(
      `${keyLine} or no authentication`,
    );
    expect(auth({ alternatives: [{ uses: [] }, keyUse], declared: true, origin, rows })).toBe(
      `no authentication or ${keyLine}`,
    );
  });

  test("absent security reads `no authentication documented`", () => {
    expect(auth({ alternatives: [], declared: false, origin, rows: ["SEC-08"] })).toBe(
      "no authentication documented",
    );
  });

  test("an explicit empty list reads `no authentication`", () => {
    expect(auth({ alternatives: [], declared: true, origin, rows })).toBe("no authentication");
  });
});
