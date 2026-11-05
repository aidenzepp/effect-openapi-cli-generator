import { describe, expect, test } from "bun:test";
import { Array as Arr, Effect, Order, Schema } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import {
  codeGenerationCopy,
  normalizeSchemas,
  storeSchemas,
  validationCopy,
} from "../../src/normalize/schemas.ts";
import type { SchemaEdit, SchemaLimits, SchemaNormalization } from "../../src/normalize/schemas.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/resolve/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

interface Members {
  readonly [key: string]: Json;
}

const spec = (line: Line, schemas: Members, paths: Members = {}): Json => ({
  components: { schemas },
  info: { title: "t", version: "1" },
  openapi: openapi[line],
  paths,
});

const run = (line: Line, value: Json, limits: SchemaLimits = {}) =>
  resolve({ document: entry, line, value }).pipe(
    Effect.flatMap((resolution) => normalizeSchemas(resolution, limits)),
  );

const normalize = (line: Line, value: Json): SchemaNormalization =>
  Effect.runSync(run(line, value));

const found = (normalization: SchemaNormalization): string[] =>
  normalization.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.pointer}`);

const sorted = (values: readonly string[]): string[] => [...Arr.sort(values, Order.String)];

const scopes = (normalization: SchemaNormalization): string[] =>
  normalization.diagnostics.map((diagnostic) => `${diagnostic.severity}:${diagnostic.scope}`);

const stored = (normalization: SchemaNormalization, key: string): Json | undefined =>
  normalization.definitions.get(key);

const copied = (normalization: SchemaNormalization, key: string): Json | undefined =>
  normalization.validation.definitions.get(key);

const one = (schema: Json, line: Line = "3.1"): SchemaNormalization =>
  normalize(line, spec(line, { S: schema }));

const parameterPaths = (schema: Json): Members => ({
  "/a": {
    get: {
      parameters: [{ in: "query", name: "q", schema }],
      responses: { "200": { description: "ok" } },
    },
  },
});

const union = (left: string, right: string): Json => ({
  oneOf: [
    { properties: { [left]: { type: "string" } }, required: [left], type: "object" },
    { properties: { [right]: { type: "string" } }, required: [right], type: "object" },
  ],
});

const isRecord = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  Schema.is(Schema.Record(Schema.String, Schema.Json))(value) && !Array.isArray(value);

const isList = (value: Json | undefined): value is readonly Json[] =>
  Schema.is(Schema.Array(Schema.Json))(value);

describe("store", () => {
  test("converts 3.0 schemas to draft 2020-12 under component-name keys", () => {
    const result = normalize(
      "3.0",
      spec("3.0", {
        Holder: { properties: { pet: { $ref: "#/components/schemas/Pet" } }, type: "object" },
        Pet: { exclusiveMinimum: true, minimum: 0, nullable: true, type: "integer" },
      }),
    );

    expect(stored(result, "Pet")).toEqual({ exclusiveMinimum: 0, type: ["integer", "null"] });
    expect(stored(result, "Holder")).toEqual({
      properties: { pet: { $ref: "#/$defs/Pet" } },
      type: "object",
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("converts 3.1 example to examples and keeps keyword values", () => {
    expect(stored(one({ example: "x", type: "string" }), "S")).toEqual({
      examples: ["x"],
      type: "string",
    });
  });

  test("keys inline use-site schemas and non-component targets by their canonical pointer", () => {
    const result = normalize(
      "3.1",
      spec(
        "3.1",
        { Holder: { properties: { name: { type: "string" } }, type: "object" } },
        {
          "/a": {
            post: {
              parameters: [
                { in: "query", name: "q", schema: { type: "integer" } },
                {
                  in: "query",
                  name: "n",
                  schema: { $ref: "#/components/schemas/Holder/properties/name" },
                },
              ],
              requestBody: {
                content: { "application/json": { schema: { items: { type: "boolean" } } } },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      ),
    );

    expect(stored(result, "/paths/~1a/post/parameters/0/schema")).toEqual({ type: "integer" });
    expect(stored(result, "/components/schemas/Holder/properties/name")).toEqual({
      type: "string",
    });
    expect(stored(result, "/paths/~1a/post/parameters/1/schema")).toEqual({
      $ref: "#/$defs/~1components~1schemas~1Holder~1properties~1name",
    });
    expect(stored(result, "/paths/~1a/post/requestBody/content/application~1json/schema")).toEqual({
      items: { type: "boolean" },
    });
    expect([...result.definitions.keys()]).toEqual(sorted([...result.definitions.keys()]));
  });

  test("records the Shape facts flattening and serialization read", () => {
    const result = normalize(
      "3.0",
      spec("3.0", {
        File: { format: "binary", type: "string" },
        Pet: {
          discriminator: { propertyName: "kind" },
          properties: Object.fromEntries([
            ["name", { type: "string" }],
            ["kind", { type: "string" }],
          ]),
          required: ["kind"],
          type: "object",
        },
        Pets: { items: { $ref: "#/components/schemas/Pet" }, type: "array" },
        Ref: { $ref: "#/components/schemas/Pet" },
      }),
    );

    expect(result.facts.get("Pet")).toEqual({
      contentEncoding: undefined,
      contentMediaType: undefined,
      discriminator: "kind",
      format: undefined,
      items: false,
      properties: ["name", "kind"],
      reference: undefined,
      required: ["kind"],
      types: ["object"],
    });
    expect(result.facts.get("Pets")?.items).toBe(true);
    expect(result.facts.get("File")?.format).toBe("binary");
    expect(result.facts.get("Ref")?.reference).toBe("Pet");

    const encoded = one({
      contentEncoding: "base64",
      contentMediaType: "image/png",
      type: "string",
    });

    expect(encoded.facts.get("S")?.contentEncoding).toBe("base64");
    expect(encoded.facts.get("S")?.contentMediaType).toBe("image/png");
  });

  test("leaves the input document unchanged", () => {
    const value = spec("3.1", {
      S: { nullable: true, oneOf: [{ const: 1 }, { const: 2 }], pattern: "^a", type: "string" },
    });
    const before = structuredClone(value);
    normalize("3.1", value);

    expect(value).toEqual(before);
  });
});

describe("validation copy", () => {
  test("SCH-37 and the other server-validated keywords are removed with one notice per occurrence", () => {
    const result = one({
      contains: { type: "string" },
      contentSchema: { type: "object" },
      dependentRequired: { a: ["b"] },
      dependentSchemas: { a: { required: ["c"] } },
      else: { type: "string" },
      format: "email",
      if: { type: "string" },
      maxContains: 3,
      minContains: 1,
      not: { type: "number" },
      pattern: "^a",
      properties: { p: { not: {}, pattern: "^b", type: "string" } },
      // oxlint-disable-next-line unicorn/no-thenable -- the JSON Schema keyword, not a Promise
      then: { type: "string" },
      type: "object",
      unevaluatedItems: false,
      unevaluatedProperties: false,
    });
    const base = "/components/schemas/S";

    expect(sorted(found(result))).toEqual(
      sorted([
        `SCH-12/not-asserted ${base}/contains`,
        `SCH-16/not-asserted ${base}/dependentSchemas`,
        `SCH-18/not-asserted ${base}/if`,
        `SCH-19/not-asserted ${base}/then`,
        `SCH-20/not-asserted ${base}/else`,
        `SCH-24/not-asserted ${base}/not`,
        `SCH-25/not-asserted ${base}/unevaluatedItems`,
        `SCH-26/not-asserted ${base}/unevaluatedProperties`,
        `SCH-37/not-asserted ${base}/pattern`,
        `SCH-37/not-asserted ${base}/properties/p/pattern`,
        `SCH-41/not-asserted ${base}/maxContains`,
        `SCH-42/not-asserted ${base}/minContains`,
        `SCH-46/not-asserted ${base}/dependentRequired`,
        `SCH-54/not-asserted ${base}/format`,
        `SCH-57/not-asserted ${base}/contentSchema`,
      ]),
    );
    expect(new Set(scopes(result))).toEqual(new Set(["notice:element"]));
    expect(copied(result, "S")).toEqual({
      properties: { p: { not: {}, type: "string" } },
      type: "object",
    });
  });

  test("SCO-06 an all-constant oneOf or anyOf becomes one enum with no notice", () => {
    const result = one({
      anyOf: [{ const: "a" }, { const: "b", description: "B" }],
      oneOf: [
        { const: "b", title: "B" },
        { const: "c", "x-name": "C" },
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(copied(result, "S")).toEqual({ enum: ["b"] });
    expect(copied(one({ oneOf: [{ const: "a", title: "A" }, { const: 2 }] }), "S")).toEqual({
      enum: ["a", 2],
    });
    expect(copied(one({ oneOf: [{ const: "a" }, { type: "string" }] }), "S")).toEqual({
      oneOf: [{ const: "a" }, { type: "string" }],
    });
  });

  test("patterns are ignored by the importer, so patternProperties keys raise nothing", () => {
    const result = one({ patternProperties: { "^x-": { type: "string" } }, type: "object" });

    expect(result.diagnostics).toEqual([]);
    expect(copied(result, "S")).toEqual(stored(result, "S"));
  });

  test("SCO-09 a union the importer cannot intersect becomes {} with a notice", () => {
    const result = one({
      properties: { x: { allOf: [union("a", "b"), union("c", "d")] }, y: { type: "string" } },
      type: "object",
    });

    expect(found(result)).toEqual([
      "SCO-09/union-not-asserted /components/schemas/S/properties/x/allOf/1",
    ]);
    expect(scopes(result)).toEqual(["notice:element"]);
    expect(copied(result, "S")).toEqual({
      properties: { x: { allOf: [union("a", "b"), {}] }, y: { type: "string" } },
      type: "object",
    });
  });

  test("SCH-13 properties beside a schema-valued additionalProperties become {} with a notice", () => {
    const result = one({
      additionalProperties: { type: "integer" },
      properties: { a: { type: "string" } },
      type: "object",
    });

    expect(found(result)).toEqual(["SCH-13/not-asserted /components/schemas/S"]);
    expect(copied(result, "S")).toEqual({});
  });

  test("an importer path through merged scopes lands on the deepest existing schema ancestor", () => {
    const result = one({
      allOf: [{ properties: { x: union("c", "d") } }],
      properties: { x: union("a", "b") },
      type: "object",
    });

    expect(found(result)).toEqual(["SCO-09/union-not-asserted /components/schemas/S/allOf/0"]);
    expect(copied(result, "S")).toEqual({
      allOf: [{}],
      properties: { x: union("a", "b") },
      type: "object",
    });
  });

  test("DOC-23 schema-pure-alias-cycle is refused at element scope", () => {
    const loop = normalize(
      "3.1",
      spec(
        "3.1",
        { loop: { $ref: "#/components/schemas/loop" } },
        parameterPaths({ $ref: "#/components/schemas/loop" }),
      ),
    );

    expect(found(loop)).toEqual(["DOC-23/alias-cycle /components/schemas/loop"]);
    expect(scopes(loop)).toEqual(["refusal:element"]);
    expect(copied(loop, "loop")).toEqual({});

    const pair = normalize(
      "3.1",
      spec("3.1", {
        A: { anyOf: [{ $ref: "#/components/schemas/B" }, { type: "string" }] },
        B: { allOf: [{ $ref: "#/components/schemas/A" }] },
        Tree: { properties: { child: { $ref: "#/components/schemas/Tree" } }, type: "object" },
      }),
    );

    expect(found(pair)).toEqual([
      "DOC-23/alias-cycle /components/schemas/A/anyOf/0",
      "DOC-23/alias-cycle /components/schemas/B/allOf/0",
    ]);
    expect(copied(pair, "Tree")).toEqual(stored(pair, "Tree"));
  });

  test("SCH-03 schema-ref-bare-hash-root is refused at element scope", () => {
    const result = one({ properties: { root: { $ref: "#" } }, type: "object" });

    expect(found(result)).toEqual([
      "SCH-03/non-schema-target /components/schemas/S/properties/root",
    ]);
    expect(scopes(result)).toEqual(["refusal:element"]);
    expect(copied(result, "S")).toEqual({ properties: { root: {} }, type: "object" });
  });

  test("SCH-02 a $ref inside a nested $id resource is refused at element scope", () => {
    const result = normalize(
      "3.1",
      spec("3.1", {
        Outer: {
          properties: {
            nested: {
              $defs: { x: { type: "string" } },
              $id: "https://example.test/nested",
              properties: { inner: { $ref: "https://example.test/nested#/$defs/x" } },
            },
          },
          type: "object",
        },
      }),
    );

    expect(found(result)).toEqual([
      "SCH-02/nested-resource /components/schemas/Outer/properties/nested/properties/inner",
    ]);
    expect(scopes(result)).toEqual(["refusal:element"]);
  });

  test("SCH-29 enum members outside the declared type are dropped with a notice each", () => {
    const fraction = one({ enum: [1.5, 2], type: "integer" });

    expect(found(fraction)).toEqual(["SCH-29/outside-type /components/schemas/S/enum/0"]);
    expect(copied(fraction, "S")).toEqual({ enum: [2], type: "integer" });

    const nullMember = one({ enum: [null], type: "string" });

    expect(found(nullMember)).toEqual(["SCH-29/outside-type /components/schemas/S/enum/0"]);
    expect(copied(nullMember, "S")).toEqual({ type: "string" });

    const multiType = one({ enum: ["value", 1], type: ["string", "number"] });
    const kept = [
      multiType,
      one({ enum: [0, null], type: ["null", "integer"] }),
      one({ enum: ["a", null], nullable: true, type: "string" }, "3.0"),
      one({ enum: [1, "a"] }),
    ];

    expect(kept.map(found)).toEqual([[], [], [], []]);
    expect(copied(multiType, "S")).toEqual({ enum: ["value", 1], type: ["string", "number"] });
  });

  test("SCH-29 an object or array enum is removed as server-validated", () => {
    const result = one({ enum: [{}], type: "object" });

    expect(found(result)).toEqual(["SCH-29/not-asserted /components/schemas/S/enum"]);
    expect(copied(result, "S")).toEqual({ type: "object" });
  });

  test("FMT-02 out-of-safe-range integers are asserted as numbers in the validation copy", () => {
    const value = spec("3.0", {
      Big: { maximum: 2 ** 63, type: "integer" },
      Id: { format: "int64", nullable: true, type: "integer" },
      Small: { format: "int32", maximum: 10, type: "integer" },
    });
    const store = Effect.runSync(
      resolve({ document: entry, line: "3.0", value }).pipe(
        Effect.flatMap((resolution) => storeSchemas(resolution)),
      ),
    );
    const copy = Effect.runSync(validationCopy("3.0", store.definitions));
    const edits = copy.edits.map((edit) => `${edit.code} ${edit.key} ${edit.path.join("/")}`);

    expect(sorted(edits)).toEqual([
      "FMT-02/int64-range Big ",
      "FMT-02/int64-range Id ",
      "S30-26/not-asserted Id format",
      "S30-26/not-asserted Small format",
    ]);
    expect(copy.definitions.get("Big")).toEqual({ maximum: 2 ** 63, type: "number" });
    expect(copy.definitions.get("Id")).toEqual({ type: ["number", "null"] });
    expect(copy.definitions.get("Small")).toEqual({ maximum: 10, type: "integer" });
    expect(store.facts.get("Id")?.types).toEqual(["integer", "null"]);

    const range = one({ format: "int64", minimum: 0, type: "integer" });

    expect(found(range)).toEqual([
      "FMT-02/int64-range /components/schemas/S",
      "SCH-54/not-asserted /components/schemas/S/format",
    ]);
    expect(copied(range, "S")).toEqual({ minimum: 0, type: "number" });
  });

  test("SCH-62 a 3.0 nullable in a 3.1 or 3.2 document is a notice with no effect", () => {
    const lines: readonly Line[] = ["3.1", "3.2"];
    for (const line of lines) {
      const result = one({ nullable: true, type: "string" }, line);

      expect(found(result)).toEqual(["SCH-62/nullable-no-effect /components/schemas/S/nullable"]);
      expect(copied(result, "S")).toEqual({ type: "string" });
      expect(result.facts.get("S")?.types).toEqual(["string"]);
    }
  });

  test("SCH-06 refused keywords are removed, and the resolver's SCH-05 refusal is not repeated", () => {
    const result = one({
      properties: { a: { $dynamicRef: "#node" }, b: { $dynamicAnchor: "node", type: "string" } },
      type: "object",
    });

    expect(found(result)).toEqual(["SCH-06/dynamic-anchor /components/schemas/S/properties/b"]);
    expect(scopes(result)).toEqual(["refusal:element"]);
    expect(result.validation.edits.map((edit) => edit.code)).toContain("SCH-05/dynamic-ref");
    expect(copied(result, "S")).toEqual({
      properties: { a: {}, b: { type: "string" } },
      type: "object",
    });
  });
});

// X10: replays the edit list on the stored document, independently of the module's own walk.
const replayType = (node: { readonly [key: string]: Json }): Json => {
  const { type } = node;
  if (!isList(type)) {
    return { ...node, type: "number" };
  }

  return {
    ...node,
    type: [...new Set(type.map((item) => (item === "integer" ? "number" : item)))],
  };
};

const replay = (node: Json, path: readonly string[], edit: SchemaEdit): Json => {
  const [token, ...rest] = path;
  if (token === undefined) {
    if (edit.action === "replace") {
      return {};
    }

    return edit.action === "retype" && isRecord(node) ? replayType(node) : node;
  }

  if (isList(node)) {
    const index = Number(token);
    if (rest.length === 0 && edit.action === "drop-member") {
      return node.filter((_, at) => at !== index);
    }

    return node.map((item, at) => (at === index ? replay(item, rest, edit) : item));
  }

  if (!isRecord(node) || !Object.hasOwn(node, token)) {
    return node;
  }

  if (rest.length === 0 && edit.action === "remove") {
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== token));
  }

  const child = replay(node[token] ?? null, rest, edit);
  const entries = Object.entries(node).map(([key, value]): [string, Json] =>
    key === token ? [key, child] : [key, value],
  );
  const emptied = token === "enum" && isList(child) && child.length === 0;

  return Object.fromEntries(emptied ? entries.filter(([key]) => key !== "enum") : entries);
};

describe("X10", () => {
  test("the validation copy equals the stored document minus the edit list", () => {
    const result = normalize(
      "3.1",
      spec("3.1", {
        A: {
          additionalProperties: { type: "integer" },
          properties: { a: { type: "string" } },
          type: "object",
        },
        B: {
          properties: {
            id: { format: "int64", type: "integer" },
            kind: { enum: ["a", 1, null], type: "string" },
            name: { maxLength: 4, nullable: true, pattern: "^n", type: "string" },
            tags: { contains: { const: "x" }, items: { type: "string" }, type: "array" },
          },
          required: ["id"],
          type: "object",
        },
        C: { $ref: "#/components/schemas/C" },
      }),
    );
    const replayed = new Map<string, Json>();
    for (const [key, value] of result.definitions) {
      let node = value;
      for (const edit of Arr.reverse(result.validation.edits)) {
        node = edit.key === key ? replay(node, edit.path, edit) : node;
      }

      replayed.set(key, node);
    }

    expect(result.validation.edits.length).toBeGreaterThan(5);
    expect(result.validation.definitions).toEqual(replayed);
    expect(new Set(result.diagnostics.map((diagnostic) => diagnostic.code))).toEqual(
      new Set(result.validation.edits.map((edit) => edit.code)),
    );
  });
});

describe("codeGenerationCopy", () => {
  test("keeps request-reachable roots, drops examples, example and default, and sorts properties", () => {
    const result = normalize(
      "3.1",
      spec("3.1", {
        Body: {
          description: "outer",
          properties: Object.fromEntries([
            ["zeta", { default: "z", examples: ["z"], type: "string" }],
            ["__proto__", { $ref: "#/components/schemas/Inner" }],
            [
              "alpha",
              { default: { nested: [0, ""] }, description: "Defaults to the authored value." },
            ],
          ]),
          required: ["__proto__"],
          type: "object",
        },
        Inner: {
          additionalProperties: false,
          properties: { "a/b": { default: false, deprecated: true, type: "string" } },
          type: "object",
        },
        Response: { properties: { r: { type: "string" } }, type: "object" },
      }),
    );
    const code = Effect.runSync(codeGenerationCopy(result.validation.definitions, ["Body"]));
    const body = code.get("Body");
    const properties = isRecord(body) ? body.properties : undefined;

    expect([...code.keys()]).toEqual(["Body", "Inner"]);
    expect(isRecord(properties) ? Object.keys(properties) : []).toEqual([
      "__proto__",
      "alpha",
      "zeta",
    ]);
    expect(isRecord(properties) && Object.hasOwn(properties, "__proto__")).toBe(true);
    expect(body).toEqual({
      description: "outer",
      properties: Object.fromEntries([
        ["__proto__", { $ref: "#/$defs/Inner" }],
        ["alpha", { description: "Defaults to the authored value." }],
        ["zeta", { type: "string" }],
      ]),
      required: ["__proto__"],
      type: "object",
    });
    expect(code.get("Inner")).toEqual({
      additionalProperties: false,
      properties: { "a/b": { deprecated: true, type: "string" } },
      type: "object",
    });
    expect(copied(result, "Inner")).toEqual(stored(result, "Inner"));
  });
});

// D0 to D20: each level refers twice to the next, through properties and through allOf. A walk
// that followed references without memoizing would visit 2^20 schemas.
const diamond = (depth: number): Members =>
  Object.fromEntries(
    Arr.range(0, depth).map((level): [string, Json] => {
      const next = { $ref: `#/components/schemas/D${level + 1}` };
      const leaf = { type: "string" };

      return [
        `D${level}`,
        level === depth
          ? leaf
          : { allOf: [next, next], properties: { a: next, b: next }, type: "object" },
      ];
    }),
  );

describe("node budget", () => {
  test(
    "a depth-20 diamond of references stays linear",
    () => {
      const result = normalize("3.1", spec("3.1", diamond(20)));
      const code = Effect.runSync(codeGenerationCopy(result.validation.definitions, ["D0"]));

      expect(result.diagnostics).toEqual([]);
      expect(code.size).toBe(21);
    },
    { timeout: 2000 },
  );

  test("a walk past maxNodes fails with SchemaBudgetExceeded", () => {
    const failure = Effect.runSync(
      Effect.flip(run("3.1", spec("3.1", diamond(20)), { maxNodes: 50 })),
    );

    expect(failure._tag).toBe("SchemaBudgetExceeded");
  });
});
