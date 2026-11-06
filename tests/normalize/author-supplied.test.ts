import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { normalize } from "../../src/normalize/index.ts";
import { normalizeSecurityPolicy, normalizeSecuritySchemes } from "../../src/normalize/security.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";

// The subjects are entities with branded fields; `expect`'s own parameter would reject the plain
// literals they are compared with.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- test helper, the value is only compared
const see = (value: unknown) => expect(value);

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const configUri = Schema.decodeUnknownSync(DocumentUri)("file:///spec/author.json");

const apiKey: Json = { in: "header", name: "X-Api-Key", type: "apiKey" };

const configOf = (add: Json) =>
  Effect.runSync(
    decodeAuthorConfig(
      {
        binName: "example",
        package: { name: "example-cli", version: "1.0.0" },
        security: { add },
      },
      { document: configUri },
    ),
  );

const ok: Json = { responses: { "200": { description: "ok" } } };

const run = (add: Json, rest: { readonly [key: string]: Json } = {}) =>
  Effect.runSync(
    Effect.gen(function* normalizeAll() {
      const resolution = yield* resolve({
        document: entry,
        line: "3.1",
        value: {
          info: { title: "t", version: "1" },
          openapi: "3.1.1",
          paths: {
            "/bare": { get: ok },
            "/empty": { get: { ...ok, security: [] } },
            "/own": { get: { ...ok, security: [{ own: [] }] } },
          },
          ...rest,
        },
      });
      const schemes = yield* normalizeSecuritySchemes(resolution, {
        config: configOf(add),
        configDocument: configUri,
      });
      const policy = (path: string) =>
        normalizeSecurityPolicy(resolution, schemes, `/paths/~1${path}/get`);

      return {
        bare: (yield* policy("bare")).policy,
        empty: (yield* policy("empty")).policy,
        own: (yield* policy("own")).policy,
        schemes,
      };
    }),
  );

const own: Json = { securitySchemes: { own: { scheme: "bearer", type: "http" } } };

const added: Json = { requirement: [{ key: [] }], schemes: { key: apiKey } };

describe("author-supplied security", () => {
  test("the config codec accepts security.add and keeps scheme env names", () => {
    const config = Effect.runSync(
      decodeAuthorConfig(
        {
          binName: "example",
          package: { name: "example-cli", version: "1.0.0" },
          security: { add: added, other: { env: "EXAMPLE_OTHER" } },
        },
        { document: configUri },
      ),
    );

    see(config.security?.add?.requirement).toEqual([{ key: [] }]);
    see(config.security?.other).toEqual({ env: "EXAMPLE_OTHER" });
  });

  test("an invalid security.add is a diagnostic, not a throw", () => {
    const exit = Effect.runSyncExit(
      decodeAuthorConfig(
        {
          binName: "example",
          package: { name: "example-cli", version: "1.0.0" },
          security: { add: { requirement: "key", schemes: {} } },
        },
        { document: configUri },
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("an added apiKey scheme applies only where the spec declares no security", () => {
    const result = run(added, { components: own });

    expect(result.schemes.diagnostics).toEqual([]);
    see(result.bare.declared).toBe(true);
    see(result.bare.alternatives).toEqual([{ uses: [{ scheme: "key", scopes: [] }] }]);
    see(result.empty.alternatives).toEqual([]);
    see(result.own.alternatives).toEqual([{ uses: [{ scheme: "own", scopes: [] }] }]);
  });

  test("an added scheme is author-supplied and a declared one is spec", () => {
    const { schemes } = run(added, { components: own });

    see(schemes.schemes.map((scheme) => [scheme.name, scheme.source])).toEqual([
      ["own", "spec"],
      ["key", "author-supplied"],
    ]);
    see(schemes.schemes[1]?.kind).toEqual({ in: "header", name: "X-Api-Key", type: "apiKey" });
  });

  test("a name that collides with a declared scheme is refused at document scope", () => {
    const { schemes } = run(added, {
      components: { securitySchemes: { key: { scheme: "bearer", type: "http" } } },
    });

    see(
      schemes.diagnostics.map((d) => [d.code, d.scope, d.severity, d.document, d.pointer]),
    ).toEqual([
      [
        "CFG-1/scheme-name-collision",
        "document",
        "refusal",
        configUri,
        "/security/add/schemes/key",
      ],
    ]);
    see(schemes.schemes.map((scheme) => scheme.source)).toEqual(["spec"]);
  });

  test("an added http digest scheme is refused with the declared-scheme code", () => {
    const { schemes } = run({
      requirement: [{ key: [] }],
      schemes: { key: { scheme: "digest", type: "http" } },
    });

    see(schemes.diagnostics.map((d) => [d.code, d.scope, d.severity, d.document])).toEqual([
      ["SSC-17/unsupported-scheme", "element", "refusal", configUri],
    ]);
    see(schemes.schemes).toEqual([]);
    see(schemes.unusable).toEqual(["key"]);
  });

  test("normalize() applies security.add to a spec that declares no security", () => {
    const { api } = Effect.runSync(
      resolve({
        document: entry,
        line: "3.1",
        value: {
          info: { title: "t", version: "1" },
          openapi: "3.1.1",
          paths: { "/bare": { get: ok } },
        },
      }).pipe(
        Effect.flatMap((resolution) =>
          normalize(resolution, { config: configOf(added), configDocument: configUri }),
        ),
      ),
    );

    see(api.operations[0]?.security.alternatives).toEqual([
      { uses: [{ scheme: "key", scopes: [] }] },
    ]);
    see(api.securitySchemes.map((scheme) => [scheme.name, scheme.source])).toEqual([
      ["key", "author-supplied"],
    ]);
  });
});
