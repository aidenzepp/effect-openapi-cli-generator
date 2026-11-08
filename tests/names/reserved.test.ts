import { describe, expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Api } from "../../src/model/entities.ts";
import { foldIdentifier } from "../../src/names/fold.ts";
import { planNames } from "../../src/names/index.ts";
import { reservedIdentifiers } from "../../src/names/reserved.ts";

describe("reservedIdentifiers", () => {
  test.each([
    "interface",
    "keyof",
    "readonly",
    "declare",
    "namespace",
    "string",
    "number",
    "boolean",
    "unknown",
    "never",
    "any",
    "object",
    "symbol",
    "require",
    "exports",
    "module",
    "Error",
    "Date",
    "Map",
    "Set",
    "Object",
    "Array",
    "Promise",
    "JSON",
    "Math",
    "URL",
    "Uint8Array",
    "globalThis",
  ])("%s is reserved", (name) => {
    expect(reservedIdentifiers.has(name)).toBe(true);
  });

  test.each([
    ["error", "pascal", "Error_"],
    ["date", "pascal", "Date_"],
    ["map", "pascal", "Map_"],
    ["string", "camel", "string_"],
    ["keyof", "camel", "keyof_"],
  ] as const)("%s folds %s to a suffixed name", (input, casing, expected) => {
    const folded = foldIdentifier(input, casing);
    expect(Result.isSuccess(folded) ? String(folded.success.name) : undefined).toBe(expected);
  });
});

// The bindings `cli/root.ts` declares or imports beside the fixed namespaces: the lazy root's
// `table`, `root`, `args`, `groups`, `Groups` and `Arr`.
const rootBindings = ["table", "root", "args", "groups", "Groups", "Arr"];

// The operation ids that fold to a distinct command identifier each.
const folding = ["table", "root", "args", "groups"];

const document = "file:///spec/openapi.json";

const origin = (pointer: string) => ({ document, pointer });

// An api with one operation per [operationId, tags] pair; an untagged one is a root command.
const apiOf = (operations: readonly (readonly [string, readonly string[]])[]): Api =>
  Schema.decodeUnknownSync(Api)({
    documents: [document],
    entry: document,
    info: {},
    informational: [],
    line: "3.1",
    openapi: "3.1.0",
    operations: operations.map(([operationId, tags]) => ({
      deprecated: false,
      docs: {},
      key: { method: "GET", path: `/${operationId}` },
      operationId,
      origin: origin(`/paths/~1${operationId}/get`),
      parameters: [],
      responses: [],
      rows: [],
      security: { alternatives: [], declared: false, origin: origin("/"), rows: [] },
      servers: [],
      tags,
    })),
    origin: origin(""),
    rows: [],
    schemas: { document: { $defs: {} }, origin: origin("/components/schemas"), rows: [] },
    securitySchemes: [],
    servers: [],
    tags: [...new Set(operations.flatMap(([, tags]) => tags))].map((name) => ({ name })),
  });

const untaggedApi = (operationIds: readonly string[]): Api =>
  apiOf(operationIds.map((operationId) => [operationId, []]));

const planOf = (api: Api) =>
  Effect.runSync(
    planNames(api, {
      config: Schema.decodeUnknownSync(AuthorConfig)({
        binName: "example",
        package: { name: "example-cli", version: "1.0.0" },
      }),
      configDocument: Schema.decodeUnknownSync(DocumentUri)("file:///spec/author-config.json"),
      strict: false,
    }),
  );

// Tags whose Pascal fold is a binding of `cli/root.ts` or a namespace every cli module imports.
const clashingTags = ["Groups", "Arr", "Command", "Effect"];

describe("planNames: the cli/root.ts bindings", () => {
  test("a root command folding to a root binding is renamed, not left to clash", () => {
    const plan = planOf(untaggedApi(folding));
    const identifiers = plan.root.map((command) => String(command.identifier));

    expect(identifiers).toHaveLength(folding.length);
    for (const identifier of identifiers) {
      expect(rootBindings).not.toContain(identifier);
    }
  });

  test("a tag folding to a root binding gets a renamed api namespace, not left to clash", () => {
    const plan = planOf(
      apiOf(clashingTags.map((tag) => [`${tag.toLowerCase()}-list`, [tag]] as const)),
    );
    const namespaces = plan.groups.map((group) => String(group.namespace));

    expect(plan.groups.map((group) => group.tag)).toEqual(clashingTags);
    expect(new Set(namespaces).size).toBe(clashingTags.length);
    for (const namespace of namespaces) {
      expect(rootBindings).not.toContain(namespace);
      expect(clashingTags).not.toContain(namespace);
    }
    expect(plan.diagnostics.filter((d) => d.code === "TAG-02/renamed")).toHaveLength(
      clashingTags.length,
    );
  });
});
