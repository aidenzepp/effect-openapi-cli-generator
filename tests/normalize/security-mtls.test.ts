import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

// A `mutualTLS` scheme is a usable client certificate on 3.1 and 3.2 (design 6.5, D-SEC3): its
// alternative is kept, never refused as staged.

// The subjects are entities with branded fields; `expect`'s own parameter would reject the plain
// literals they are compared with.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- test helper, the value is only compared
const see = (value: unknown) => expect(value);

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const configUri = Schema.decodeUnknownSync(DocumentUri)("file:///spec/author.json");

const config = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "acme",
  package: { name: "acme-cli", version: "1.0.0" },
});

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

const ok: Json = { responses: { "200": { description: "ok" } } };

const schemes: Json = {
  client: { type: "mutualTLS" },
  key: { in: "header", name: "X-Key", type: "apiKey" },
};

const run = (line: Line, security: Json) =>
  Effect.runSync(
    resolve({
      document: entry,
      line,
      value: {
        components: { securitySchemes: schemes },
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

describe("a mutualTLS scheme is usable", () => {
  for (const line of ["3.1", "3.2"] as const) {
    test(`on ${line} its alternative is kept with no SSC-20/not-implemented`, () => {
      const { api, diagnostics } = run(line, [{ client: [] }]);

      see(codes(diagnostics)).toEqual([]);
      see(api.operations.map((operation) => operation.key.path)).toEqual(["/a"]);
      see(api.operations[0]?.security.alternatives).toEqual([
        { uses: [{ scheme: "client", scopes: [] }] },
      ]);
      see(api.securitySchemes.map((scheme) => [scheme.name, scheme.kind.type])).toEqual([
        ["client", "mutualTls"],
        ["key", "apiKey"],
      ]);
    });
  }

  test("an AND alternative with an apiKey keeps both schemes", () => {
    const { api, diagnostics } = run("3.1", [{ client: [], key: [] }]);

    see(codes(diagnostics)).toEqual([]);
    see(api.operations[0]?.security.alternatives).toEqual([
      {
        uses: [
          { scheme: "client", scopes: [] },
          { scheme: "key", scopes: [] },
        ],
      },
    ]);
  });
});
