import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { emitApi } from "../../src/emit/api.ts";
import { emitDomainSchemas } from "../../src/emit/domain.ts";
import { emitPackageFiles } from "../../src/emit/package.ts";
import type { EmittedFile } from "../../src/emit/package.ts";
import { runtimeFiles } from "../../src/emit/runtime-files.generated.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Api } from "../../src/model/entities.ts";
import type { Server } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { normalizeSchemas } from "../../src/normalize/schemas.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { resolve } from "../../src/resolve/index.ts";

// The bracket convention (design 6.1, D-OQ1 (b)) is a model marker, `nonStandard:
// "deepObjectBrackets"`, on a query parameter's `StyleSerialization` or a form property's
// `EncodingRule`. No normalizer sets it yet (m2-br4, m2-br5), so these fixtures mark the
// normalized model by hand. A marked entry emits `brackets: true`; an unmarked one emits M1 text.

const root = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const read = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const golden = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
  JSON.parse(read("openapi.json")),
);

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const config = await Effect.runPromise(
  decodeAuthorConfig(decodeJson(JSON.parse(read("author-config.json"))), {
    document: configDocument,
  }),
);

const filter = {
  properties: { owner: { properties: { name: { type: "string" } }, type: "object" } },
  type: "object",
};

const formSchema = { properties: { filter, title: { type: "string" } }, type: "object" };

const formEncoding = { filter: { explode: true, style: "deepObject" } };

// `GET /items` with a deepObject query parameter and a plain one; `POST /forms` with a lone
// form body; `POST /choices` with form and JSON alternatives (the alternatives table).
const spec: Schema.Json = {
  ...golden,
  paths: {
    "/choices": {
      post: {
        operationId: "choices-create",
        requestBody: {
          content: {
            "application/json": { schema: formSchema },
            "application/x-www-form-urlencoded": { encoding: formEncoding, schema: formSchema },
          },
          required: true,
        },
        responses: { "200": { description: "ok" } },
        tags: ["items"],
      },
    },
    "/forms": {
      post: {
        operationId: "forms-create",
        requestBody: {
          content: {
            "application/x-www-form-urlencoded": { encoding: formEncoding, schema: formSchema },
          },
          required: true,
        },
        responses: { "200": { description: "ok" } },
        tags: ["items"],
      },
    },
    "/items": {
      get: {
        operationId: "items-list",
        parameters: [
          { explode: true, in: "query", name: "filter", schema: filter, style: "deepObject" },
          { in: "query", name: "page", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
        tags: ["items"],
      },
    },
  },
};

const nonStandard = "deepObjectBrackets" as const;

type Encoded = typeof Api.Encoded;

type EncodedOperation = Encoded["operations"][number];

// The `filter` form encoding rules of one operation's body, marked.
const markBody = (body: EncodedOperation["body"]) =>
  body === undefined
    ? {}
    : {
        body: {
          ...body,
          alternatives: body.alternatives.map((alternative) => ({
            ...alternative,
            encoding: alternative.encoding.map((rule) =>
              rule.target.kind === "property" && rule.target.name === "filter"
                ? { ...rule, nonStandard }
                : rule,
            ),
          })),
        },
      };

// The marked model: the `filter` query parameter and every form `filter` encoding rule, edited in
// the model's encoded form and decoded back, so the marked model passes the model's own schema.
const mark = (api: Api): Api => {
  const encoded = Schema.encodeSync(Api)(api);

  return Schema.decodeUnknownSync(Api)({
    ...encoded,
    operations: encoded.operations.map((operation) => ({
      ...operation,
      ...markBody(operation.body),
      parameters: operation.parameters.map((parameter) =>
        parameter.wireName === "filter" && parameter.serialization.kind === "style"
          ? { ...parameter, serialization: { ...parameter.serialization, nonStandard } }
          : parameter,
      ),
    })),
  });
};

const generated = await Effect.runPromise(
  Effect.gen(function* generated() {
    const resolution = yield* resolve({ document, line: "3.1", value: spec });
    const { api } = yield* normalize(resolution, { config, configDocument });
    const schemas = yield* normalizeSchemas(resolution);
    const planOf = (model: Api) => planNames(model, { config, configDocument, strict: false });
    const plan = yield* planOf(api);
    const context = { config, configDocument, document, openapi: api.openapi };
    const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;
    const roots = api.operations.flatMap((operation) =>
      (operation.body?.alternatives ?? []).flatMap((alternative) =>
        alternative.schema === undefined ? [] : [alternative.schema.key],
      ),
    );
    const domain = yield* emitDomainSchemas(schemas.validation.definitions, roots, plan.domain);
    const plain = yield* emitApi({ api, boundOrigins: bound, plan });
    // The name plan carries each command's operation, so the marked model is planned too.
    const markedApi = mark(api);
    const marked = yield* emitApi({
      api: markedApi,
      boundOrigins: bound,
      plan: yield* planOf(markedApi),
    });

    return { domain, marked, plain };
  }),
);

const items = (files: readonly EmittedFile[]): string =>
  files.find((file) => file.path === "src/api/items.ts")?.content ?? "";

const lines = (text: string, needle: string): readonly string[] =>
  text.split("\n").filter((line) => line.includes(needle));

// The emitted call that starts with `head`, through its closing `})`, whatever its line layout.
const callOf = (text: string, head: string): string => {
  const start = text.indexOf(head);

  return start === -1 ? "" : text.slice(start, text.indexOf("})", start) + 2);
};

// The text with every `brackets: true` option removed, line layout and trailing commas aside: the
// printer may wrap a call once its options grow.
const withoutBrackets = (text: string): string =>
  text
    .replaceAll(/brackets: true,\s*/gu, "")
    .replaceAll(/\s+/gu, "")
    .replaceAll(/,(?<close>[}\]])/gu, "$<close>");

describe("emitApi: the non-standard bracket marker", () => {
  test("a marked deepObject query parameter emits brackets: true", () => {
    const text = items(generated.marked);

    expect(callOf(text, 'Serialize.deepObject("filter"')).toContain("brackets: true");
    expect(callOf(text, 'Serialize.form("page"')).toContain("explode: true");
    expect(callOf(text, 'Serialize.form("page"')).not.toContain("brackets");
  });

  test("a marked form property emits brackets: true, lone and among alternatives", () => {
    const entries = lines(items(generated.marked), '["filter", {');

    expect(entries.length).toBe(2);
    for (const entry of entries) {
      expect(entry).toContain("brackets: true");
      expect(entry).toContain('style: "deepObject"');
    }
  });

  test("the marker adds brackets: true and nothing else", () => {
    expect(items(generated.marked).match(/brackets: true/gu)?.length).toBe(3);
    expect(withoutBrackets(items(generated.marked))).toBe(withoutBrackets(items(generated.plain)));
  });

  test("unmarked entries emit no brackets", () => {
    expect(items(generated.plain)).toContain('Serialize.deepObject("filter"');
    for (const file of generated.plain) {
      expect(file.content).not.toContain("brackets");
    }
  });
});

// The marked modules and the runtime, written under the worktree's git-ignored `work/` and
// type-checked together: the emitted options satisfy `QueryOptions` and `FormEncoding`.
const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "bracket-mode-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

describe("emitApi: the marked options against the runtime types", () => {
  test("the emitted modules type-check", async () => {
    const scaffold = await Effect.runPromise(
      emitPackageFiles(config, {
        packageJson: decodeJson(generatorPackage),
        tsconfig: decodeJson(generatorTsconfig),
      }),
    );
    const files: readonly EmittedFile[] = [
      generated.domain,
      ...generated.marked,
      ...Object.entries(runtimeFiles).map(([key, content]) => ({ content, path: `src/${key}` })),
      {
        content: scaffold.find((file) => file.path === "tsconfig.json")?.content ?? "",
        path: "tsconfig.json",
      },
    ];
    for (const file of files) {
      const target = nodePath.join(work, ...file.path.split("/"));
      nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true });
      nodeFs.writeFileSync(target, file.content);
    }

    nodeFs.symlinkSync(nodePath.join(root, "node_modules"), nodePath.join(work, "node_modules"));

    const tsc = nodePath.join(root, "node_modules/.bin/tsc");
    const result = Bun.spawnSync([tsc, "--noEmit", "-p", nodePath.join(work, "tsconfig.json")], {
      cwd: work,
    });

    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
