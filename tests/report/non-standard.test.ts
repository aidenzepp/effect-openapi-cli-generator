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
// marker (`nonStandard: "deepObjectBrackets"`), which only the author config switch sets. No
// normalizer sets it yet (m2-br4, m2-br5), so this model is marked by hand, as m2-br3's is.

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

// `/choices` (form and JSON bodies), `/forms` (form body) and `/items` (query `filter`); the model
// below holds them in the reverse order, so the list's order is the report's to make.
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
        ],
        responses: { "200": { description: "ok" } },
        tags: ["items"],
      },
    },
  },
};

type Encoded = typeof Api.Encoded;

const plain = await Effect.runPromise(
  Effect.gen(function* build() {
    const resolution = yield* resolve({ document, line: "3.1", value: spec });

    const { api } = yield* normalize(resolution, { config, configDocument });
    const encoded: Encoded = Schema.encodeSync(Api)(api);

    return Schema.decodeUnknownSync(Api)({
      ...encoded,
      operations: Arr.reverse(encoded.operations),
    });
  }),
);

const nonStandard = "deepObjectBrackets" as const;

// Marks the `filter` query parameter and every form `filter` encoding rule in the model's encoded
// form and decodes it back, so the marked model passes the model's own schema.
const markBody = (body: NonNullable<Encoded["operations"][number]["body"]>) => ({
  ...body,
  alternatives: body.alternatives.map((alternative) => ({
    ...alternative,
    encoding: alternative.encoding.map((rule) =>
      rule.target.kind === "property" && rule.target.name === "filter"
        ? { ...rule, nonStandard }
        : rule,
    ),
  })),
});

const markOperation = (operation: Encoded["operations"][number]) => {
  const { body, ...rest } = operation;
  const parameters = operation.parameters.map((parameter) =>
    parameter.wireName === "filter" && parameter.serialization.kind === "style"
      ? { ...parameter, serialization: { ...parameter.serialization, nonStandard } }
      : parameter,
  );

  return body === undefined
    ? { ...rest, parameters }
    : { ...rest, body: markBody(body), parameters };
};

const mark = (api: Api, only?: readonly string[]): Api => {
  const encoded: Encoded = Schema.encodeSync(Api)(api);

  return Schema.decodeUnknownSync(Api)({
    ...encoded,
    operations: encoded.operations.map((operation) =>
      only === undefined || only.includes(operation.operationId ?? "")
        ? markOperation(operation)
        : operation,
    ),
  });
};

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
    expect(nonStandardEntries(plain, documents)).toEqual([]);

    const text = Effect.runSync(printGenerationReport(reportOf(plain)));

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
    const entries = nonStandardEntries(mark(plain, ["items-list"]), documents);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      choice: "deepObjectBrackets",
      configKey: "nonStandard.deepObjectBrackets",
      document,
      row: "PRM-27",
    });
    expect(entries[0]?.pointer.startsWith("/paths/~1items/get")).toBe(true);
  });

  test("marked query parameters and form encoding entries are listed, unmarked ones are not", () => {
    const entries = nonStandardEntries(mark(plain, ["forms-create"]), documents);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.pointer.startsWith("/paths/~1forms/post")).toBe(true);
  });

  test("entries come in diagnostic order, not model order", () => {
    const entries = nonStandardEntries(mark(plain), documents);
    const pointers = entries.map((entry) => entry.pointer);
    const sorted = Arr.sort(pointers, Order.String);

    expect(pointers).toHaveLength(3);
    expect(plain.operations.map((operation) => operation.operationId)).toEqual([
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
    const api = mark(plain, ["items-list"]);
    const text = Effect.runSync(printGenerationReport(reportOf(api)));
    const report = Schema.decodeUnknownSync(GenerationReport)(JSON.parse(text));

    expect(report.nonStandard).toEqual([
      entryAt(nonStandardEntries(api, documents)[0]?.pointer ?? ""),
    ]);
  });
});
