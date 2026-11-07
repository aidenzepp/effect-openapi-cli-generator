import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import { emitApi } from "../../src/emit/api.ts";
import { runtimeFiles } from "../../src/emit/runtime-files.generated.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Api, Server } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { nonStandardEntries } from "../../src/report/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

// Audit S1 (design 6.1 querystring row): a 3.2 `querystring` parameter's form-urlencoded content
// takes Encoding Objects as for bodies. Normalize decides them by the body form rules, the model
// carries them on the content serialization, and `api/` passes them to `Serialize.querystring`, so
// the query string is the bytes a form body with the same encoding would carry.

const root = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const read = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const decodeObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

const golden = decodeObject(JSON.parse(read("openapi.json")));

const goldenConfig = decodeObject(JSON.parse(read("author-config.json")));

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const configWith = (deepObjectBrackets: boolean) =>
  Effect.runPromise(
    decodeAuthorConfig(decodeJson({ ...goldenConfig, nonStandard: { deepObjectBrackets } }), {
      document: configDocument,
    }),
  );

const strings = { items: { type: "string" }, type: "array" };

const form = "application/x-www-form-urlencoded";

const schema = {
  properties: {
    filter: { properties: { color: { type: "string" } }, type: "object" },
    ids: strings,
    note: { type: "string" },
    tags: strings,
  },
  type: "object",
};

const encoding = {
  filter: { explode: true, style: "deepObject" },
  ids: { explode: false, style: "pipeDelimited" },
  note: { allowReserved: true },
  tags: { explode: false, style: "form" },
};

const parameterPointer = "/paths/~1search/get/parameters/0";

// `GET /search` with one required querystring parameter whose form content has `encoding`.
const specWith = (encodingMap: Schema.Json, members: Schema.Json = schema): Schema.Json => ({
  ...golden,
  openapi: "3.2.0",
  paths: {
    "/search": {
      get: {
        operationId: "items-search",
        parameters: [
          {
            content: { [form]: { encoding: encodingMap, schema: members } },
            in: "querystring",
            name: "qs",
            required: true,
          },
        ],
        responses: { "200": { description: "ok" } },
        tags: ["items"],
      },
    },
  },
});

const generate = (spec: Schema.Json, deepObjectBrackets = false) =>
  Effect.runPromise(
    Effect.gen(function* generated() {
      const config = yield* Effect.promise(() => configWith(deepObjectBrackets));
      const resolution = yield* resolve({ document, line: "3.2", value: spec });
      const normalized = yield* normalize(resolution, {
        checkFindings: [],
        config,
        configDocument,
      });
      const { api } = normalized;
      const plan = yield* planNames(api, { config, configDocument, strict: false });
      const context = { config, configDocument, document, openapi: api.openapi };
      const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;
      const files = yield* emitApi({ api, boundOrigins: bound, plan });

      return { api, diagnostics: normalized.diagnostics, files };
    }),
  );

const querystringOf = (api: Api) => {
  const serialization = api.operations[0]?.parameters[0]?.serialization;
  if (serialization?.kind !== "content") {
    throw new Error("expected the querystring parameter's content serialization");
  }

  return serialization;
};

// The emitted modules and the runtime, written under the worktree's git-ignored `work/` and loaded
// in process, so the request is built by the code a generated CLI runs.
const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "querystring-encoding-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

interface SearchModule {
  readonly search: (input: { readonly qs: Serialize.Json }) => Serialize.Request;
}

const isSearchModule = (value: unknown): value is SearchModule =>
  typeof value === "object" && value !== null && "search" in value;

const load = async (files: readonly { readonly content: string; readonly path: string }[]) => {
  const all = [
    ...files,
    ...Object.entries(runtimeFiles).map(([key, content]) => ({ content, path: `src/${key}` })),
  ];
  for (const file of all) {
    const target = nodePath.join(work, ...file.path.split("/"));
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true });
    nodeFs.writeFileSync(target, file.content);
  }

  if (!nodeFs.existsSync(nodePath.join(work, "node_modules"))) {
    nodeFs.symlinkSync(nodePath.join(root, "node_modules"), nodePath.join(work, "node_modules"));
  }

  const loaded: unknown = await import(nodePath.join(work, "src/api/items.ts"));
  if (!isSearchModule(loaded)) {
    throw new Error("the emitted items module has no search builder");
  }

  return loaded;
};

const value = {
  filter: { color: "red" },
  ids: ["a", "b"],
  note: "a/b c",
  tags: ["x", "y"],
} satisfies Serialize.Json;

// The design 6.1 bytes: each property by its Encoding Object as for a form body (design 6.3): the
// pipe delimiter is form-encoded (audit S1), the form style's comma is the delimiter and stays, and
// `allowReserved` keeps the slash. The default rules would send `ids=a&ids=b` and `tags=x&tags=y`.
const expectedQuery = "filter%5Bcolor%5D=red&ids=a%7Cb&note=a/b+c&tags=x,y";

const accepted = await generate(specWith(encoding));

describe("querystring form content with Encoding Objects (audit S1, design 6.1)", () => {
  test("normalize keeps the parameter and carries one rule per property in document order", () => {
    const serialization = querystringOf(accepted.api);

    expect(accepted.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([]);
    expect(
      serialization.encoding.map((rule) => [
        rule.target.kind === "property" ? String(rule.target.name) : rule.target.index,
        rule.serialization ?? {},
      ]),
    ).toEqual([
      ["filter", { explode: true, style: "deepObject" }],
      ["ids", { explode: false, style: "pipeDelimited" }],
      ["note", { allowReserved: true }],
      ["tags", { explode: false, style: "form" }],
    ]);
  });

  test("the emitted builder sends exactly the bytes design 6.1 prescribes", async () => {
    const module = await load(accepted.files);
    const built = await Effect.runPromise(module.search({ qs: value }));

    expect(built.url).toBe(`/search?${expectedQuery}`);
  });

  test("the query string equals the form body bytes for the same encoding", async () => {
    const body = await Effect.runPromise(
      Serialize.urlEncode(value, {
        properties: [
          ["filter", { explode: true, style: "deepObject" }],
          ["ids", { explode: false, style: "pipeDelimited" }],
          ["note", { allowReserved: true }],
          ["tags", { explode: false, style: "form" }],
        ],
      }),
    );

    expect(body).toBe(expectedQuery);
  });

  test("a style the query style table marks not applicable refuses the parameter, and its operation", async () => {
    const refused = await generate(
      specWith(
        { ids: { explode: true, style: "pipeDelimited" } },
        { properties: { ids: strings } },
      ),
    );
    const codes = refused.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.scope,
      diagnostic.pointer,
    ]);

    expect(codes).toContainEqual([
      "STY-22/explode-not-applicable",
      "element",
      `${parameterPointer}/content/application~1x-www-form-urlencoded`,
    ]);
    expect(refused.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "STY-43/querystring-encoding",
    );
    expect(refused.api.operations).toEqual([]);
  });

  test("a nested deepObject entry is refused strict and marked non-standard under the switch", async () => {
    const nested = {
      properties: {
        filter: {
          properties: { owner: { properties: { name: { type: "string" } }, type: "object" } },
          type: "object",
        },
      },
      type: "object",
    };
    const spec = specWith({ filter: { explode: true, style: "deepObject" } }, nested);
    const strict = await generate(spec);
    const marked = await generate(spec, true);

    expect(strict.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "PRM-27/compound-nested",
    );
    expect(strict.api.operations).toEqual([]);
    expect(querystringOf(marked.api).encoding[0]?.nonStandard).toBe("deepObjectBrackets");
    expect(
      nonStandardEntries(marked.api, [document]).map((entry) => [String(entry.pointer), entry.row]),
    ).toEqual([
      [`${parameterPointer}/content/application~1x-www-form-urlencoded/encoding/filter`, "PRM-27"],
    ]);
  });
});
