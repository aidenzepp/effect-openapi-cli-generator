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

// An api of untagged operations, one per operationId, each a root command.
const untaggedApi = (operationIds: readonly string[]): Api =>
  Schema.decodeUnknownSync(Api)({
    documents: [document],
    entry: document,
    info: {},
    informational: [],
    line: "3.1",
    openapi: "3.1.0",
    operations: operationIds.map((operationId) => ({
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
      tags: [],
    })),
    origin: origin(""),
    rows: [],
    schemas: { document: { $defs: {} }, origin: origin("/components/schemas"), rows: [] },
    securitySchemes: [],
    servers: [],
    tags: [],
  });

describe("planNames: the cli/root.ts bindings", () => {
  test("a root command folding to a root binding is renamed, not left to clash", () => {
    const plan = Effect.runSync(
      planNames(untaggedApi(folding), {
        config: Schema.decodeUnknownSync(AuthorConfig)({
          binName: "example",
          package: { name: "example-cli", version: "1.0.0" },
        }),
        configDocument: Schema.decodeUnknownSync(DocumentUri)("file:///spec/author-config.json"),
        strict: false,
      }),
    );
    const identifiers = plan.root.map((command) => String(command.identifier));

    expect(identifiers).toHaveLength(folding.length);
    for (const identifier of identifiers) {
      expect(rootBindings).not.toContain(identifier);
    }
  });
});
