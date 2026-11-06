import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Array as Arr, Effect, Order, Schema } from "effect";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Api } from "../../src/model/entities.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import {
  GenerationReport,
  makeGenerationReport,
  NonStandardEntry,
  nonStandardEntries,
  printGenerationReport,
} from "../../src/report/index.ts";

// The report's `nonStandard` list (design 8.1, revision 19) is read from the normalized model's
// marker (`nonStandard: "deepObjectBrackets"`), which only the author config switch sets. These
// models are normalized with `nonStandard.deepObjectBrackets` named on and off.

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

const goldenConfig = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
  JSON.parse(read("author-config.json")),
);

// The switch is never defaulted or inferred: each model names it in the author config.
const configWith = (deepObjectBrackets: boolean) =>
  decodeAuthorConfig(decodeJson({ ...goldenConfig, nonStandard: { deepObjectBrackets } }), {
    document: configDocument,
  });

const filter = {
  properties: { owner: { properties: { name: { type: "string" } }, type: "object" } },
  type: "object",
};

const formSchema = { properties: { filter, title: { type: "string" } }, type: "object" };

const formEncoding = { filter: { explode: true, style: "deepObject" } };

// `/choices` (form and JSON bodies), `/forms` (form body) and `/items` (query `filter` and a plain
// `page`); the models below hold them in the reverse order, so the list's order is the report's.
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

type Encoded = typeof Api.Encoded;

const normalizedWith = (deepObjectBrackets: boolean) =>
  Effect.runPromise(
    Effect.gen(function* build() {
      const config = yield* configWith(deepObjectBrackets);
      const resolution = yield* resolve({ document, line: "3.1", value: spec });
      const { api, diagnostics } = yield* normalize(resolution, { config, configDocument });
      const encoded: Encoded = Schema.encodeSync(Api)(api);
      const reversed = Schema.decodeUnknownSync(Api)({
        ...encoded,
        operations: Arr.reverse(encoded.operations),
      });

      return { api: reversed, diagnostics };
    }),
  );

// The switch on: normalize marks the `filter` query parameter and each form `filter` rule.
const { api: marked } = await normalizedWith(true);

// The switch off: the nested deepObject entries are refused, so nothing is marked.
const { api: strict, diagnostics: strictDiagnostics } = await normalizedWith(false);

const documents = [document, configDocument];

const entryAt = (pointer: string) =>
  Schema.decodeUnknownSync(NonStandardEntry)({
    choice: "deepObjectBrackets",
    configKey: "nonStandard.deepObjectBrackets",
    document,
    pointer,
    row: "PRM-27",
  });

const sha = "a".repeat(64);

const reportOf = (api: Api) =>
  makeGenerationReport({
    acceptedServers: [],
    diagnostics: [],
    inputs: [{ document, sha256: sha }],
    nonStandard: nonStandardEntries(api, documents),
    renames: [],
    version: "0.1.0",
  });

describe("the report's nonStandard list", () => {
  test("a model with no marker lists none, and the key is still present", () => {
    expect(nonStandardEntries(strict, documents)).toEqual([]);

    const text = Effect.runSync(printGenerationReport(reportOf(strict)));

    expect(JSON.parse(text)).toHaveProperty("nonStandard", []);
  });

  test("a report made without the input lists none", () => {
    const report = makeGenerationReport({
      acceptedServers: [],
      diagnostics: [],
      inputs: [{ document, sha256: sha }],
      renames: [],
      version: "0.1.0",
    });

    expect(report.nonStandard).toEqual([]);
  });

  test("one entry per marked element, with the choice, key, use site and row", () => {
    const entries = nonStandardEntries(marked, documents);
    const query = entries.filter((entry) => entry.pointer.startsWith("/paths/~1items/get"));

    expect(query).toHaveLength(1);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        choice: "deepObjectBrackets",
        configKey: "nonStandard.deepObjectBrackets",
        document,
        row: "PRM-27",
      });
    }
  });

  test("marked query parameters and form encoding entries are listed, unmarked ones are not", () => {
    const pointers = nonStandardEntries(marked, documents).map((entry) => entry.pointer);
    const under = (prefix: string) => pointers.filter((pointer) => pointer.startsWith(prefix));

    expect(under("/paths/~1forms/post")).toHaveLength(1);
    expect(under("/paths/~1choices/post")).toHaveLength(1);
    expect(pointers.filter((pointer) => pointer.includes("application~1json"))).toEqual([]);
    expect(pointers.filter((pointer) => pointer.includes("/parameters/1"))).toEqual([]);
  });

  test("entries come in diagnostic order, not model order", () => {
    const entries = nonStandardEntries(marked, documents);
    const pointers = entries.map((entry) => entry.pointer);
    const sorted = Arr.sort(pointers, Order.String);

    expect(pointers).toHaveLength(3);
    expect(marked.operations.map((operation) => operation.operationId)).toEqual([
      "items-list",
      "forms-create",
      "choices-create",
    ]);
    expect(pointers[0]?.startsWith("/paths/~1choices/post")).toBe(true);
    expect(pointers[1]?.startsWith("/paths/~1forms/post")).toBe(true);
    expect(pointers[2]?.startsWith("/paths/~1items/get")).toBe(true);
    expect(pointers).toEqual(sorted);
  });

  test("the printed report carries the entries and decodes against the schema", () => {
    const text = Effect.runSync(printGenerationReport(reportOf(marked)));
    const report = Schema.decodeUnknownSync(GenerationReport)(JSON.parse(text));

    expect(report.nonStandard).toEqual(
      nonStandardEntries(marked, documents).map((entry) => entryAt(entry.pointer)),
    );
  });

  test("the switch off refuses the nested deepObject entries instead of listing them", () => {
    const refused = strictDiagnostics
      .filter((diagnostic) => diagnostic.code === "PRM-27/compound-nested")
      .map((diagnostic) => diagnostic.pointer.split("/").slice(0, 4).join("/"));

    expect(Arr.sort(Arr.dedupe(refused), Order.String)).toEqual([
      "/paths/~1choices/post",
      "/paths/~1forms/post",
      "/paths/~1items/get",
    ]);
    expect(nonStandardEntries(strict, documents)).toEqual([]);
  });
});
