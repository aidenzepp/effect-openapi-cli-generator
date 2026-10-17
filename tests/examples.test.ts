import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { normalize } from "../src/core/normalize.js";
import { normalizeSchema } from "../src/core/schema.js";
import { commandExamples, shellQuote } from "../src/core/examples.js";
import { exampleSchema } from "../src/core/example-schema.js";

const examples = async (
  operation: Readonly<Record<string, Schema.Json>>,
  components: Schema.JsonObject = {},
  version = "3.1.0",
) => {
  const model = await Effect.runPromise(
    normalize({
      components,
      info: { title: "Examples", version: "1" },
      openapi: version,
      paths: {
        "/records": {
          post: {
            operationId: "records/create",
            responses: { "200": { description: "OK" } },
            ...operation,
          },
        },
      },
    }),
  );

  return model.operations.flatMap((entry) => commandExamples(entry, "examples"));
};

const body = (media: Schema.JsonObject) => ({
  requestBody: { content: { "application/json": media }, required: true },
});

test("complete media examples win over schema and property examples, retaining named descriptions", async () => {
  const output = await examples(
    body({
      examples: { named: { $ref: "#/components/examples/Alias" } },
      schema: {
        example: { message: "schema" },
        properties: { message: { example: "property", type: "string" } },
        required: ["message"],
        type: "object",
      },
    }),
    {
      examples: {
        Alias: { $ref: "#/components/examples/Full" },
        Full: { description: "Original example description", value: { message: "media" } },
      },
    },
  );
  expect(output).toEqual([
    {
      command:
        // oxlint-disable-next-line eslint/no-template-curly-in-string -- Assert literal shell environment placeholders.
        'examples records create --base-url="${API_BASE_URL:?Set API_BASE_URL}" --body=\'{"message":"media"}\'',
      description: "Original example description",
    },
  ]);
});

test("complete examples preserve falsy values and bounded named order", async () => {
  const output = await examples(
    body({
      examples: { a: { value: null }, b: { value: false }, c: { value: 0 }, z: { value: "" } },
      schema: {},
    }),
  );
  expect(output.map(({ command }) => command.split("--body=")[1])).toEqual([
    "'null'",
    "'false'",
    "'0'",
  ]);

  const empty = await examples(body({ example: "", schema: { type: "string" } }));
  expect(empty[0]?.command).toEndWith("--body='\"\"'");
});

test("schema refs and aliases retain full examples, and three-zero ref siblings cannot override", async () => {
  const components = {
    schemas: {
      Alias: { $ref: "#/components/schemas/Base" },
      Base: { example: "base", type: "string" },
    },
  };
  await Promise.all(
    [
      ["3.0.3", "base"],
      ["3.1.0", "local"],
    ].map(async ([version, expected]) => {
      const output = await examples(
        body({ schema: { $ref: "#/components/schemas/Alias", example: "local" } }),
        components,
        version,
      );
      expect(output[0]?.command).toEndWith(`--body='"${expected}"'`);
    }),
  );
});

test("property composition is complete and validated; no default or enum fabrication", async () => {
  const schema = {
    additionalProperties: false,
    properties: {
      absent: { default: "not-example", enum: ["not-example"], type: "string" },
      count: { example: 0, type: "integer" },
      enabled: { example: false, type: "boolean" },
    },
    required: ["enabled", "count"],
    type: "object",
  };
  const output = await examples(body({ schema }));
  expect(output[0]?.command).toEndWith('--body=\'{"count":0,"enabled":false}\'');
  expect(await examples(body({ schema: { ...schema, required: ["absent"] } }))).toEqual([]);
  expect(
    await examples(
      body({
        schema: {
          properties: { code: { example: "bad", pattern: "^GOOD$", type: "string" } },
          required: ["code"],
          type: "object",
        },
      }),
    ),
  ).toEqual([]);
});

test("exclusive alternatives are validated as complete bodies and never assembled across branches", async () => {
  const schema = { oneOf: [{ type: "number" }, { type: "integer" }] };
  expect(await examples(body({ example: 2, schema }))).toEqual([]);

  const output = await examples(body({ example: 2.5, schema }));
  expect(output[0]?.command).toEndWith("--body='2.5'");
  expect(
    await examples(
      body({
        schema: {
          oneOf: [
            {
              properties: { a: { example: "a", type: "string" } },
              required: ["a"],
              type: "object",
            },
            {
              properties: { b: { example: "b", type: "string" } },
              required: ["b"],
              type: "object",
            },
          ],
        },
      }),
    ),
  ).toEqual([]);
});

test("native validators enforce typed rest, code points, numeric bounds and array checks", async () => {
  const cases: readonly [Schema.Json, Schema.Json, boolean][] = [
    [
      {
        additionalProperties: { type: "number" },
        properties: { id: { type: "string" } },
        required: ["id"],
        type: "object",
      },
      { extra: 1, id: "x" },
      true,
    ],
    [
      {
        additionalProperties: { type: "number" },
        properties: { id: { type: "string" } },
        required: ["id"],
        type: "object",
      },
      { extra: "bad", id: "x" },
      false,
    ],
    [{ maxLength: 1, type: "string" }, "😀", true],
    [{ maxLength: 1, type: "string" }, "ab", false],
    [{ exclusiveMinimum: 0, multipleOf: 0.5, type: "number" }, 0, false],
    [{ exclusiveMinimum: 0, multipleOf: 0.5, type: "number" }, 1.5, true],
    [{ items: { type: "string" }, minItems: 1, type: "array" }, [], false],
    [{ type: ["string", "null"] }, null, true],
    [{ additionalProperties: false, type: "object" }, { extra: false }, false],
  ];
  await Promise.all(
    cases.map(async ([input, value, valid]) => {
      const normalized = await Effect.runPromise(normalizeSchema({}, input, "/schema", "3.1"));
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(exampleSchema(normalized))(value, {
            onExcessProperty: "error",
          }),
        ),
        JSON.stringify(input),
      ).toBe(valid);
    }),
  );
});

test("required API inputs without valid examples suppress commands; optional inputs may be omitted", async () => {
  const parameter = { in: "query", name: "value", required: true, schema: { type: "string" } };
  expect(
    await examples({
      ...body({ example: {}, schema: { type: "object" } }),
      parameters: [parameter],
    }),
  ).toEqual([]);

  const output = await examples({
    ...body({ example: {}, schema: { type: "object" } }),
    parameters: [{ ...parameter, required: false }],
  });
  expect(output[0]?.command).not.toContain("--value");
});

test("parameter refs, falsy values and actual overrides retain their CLI spellings", async () => {
  const output = await examples(
    {
      parameters: [
        { $ref: "#/components/parameters/Flag" },
        { example: 0, in: "query", name: "count", schema: { type: "integer" } },
      ],
      "x-fern-sdk-group-name": "custom.nested",
      "x-fern-sdk-method-name": "run",
    },
    {
      parameters: {
        Flag: { example: false, in: "query", name: "is_active", schema: { type: "boolean" } },
      },
    },
  );
  expect(output[0]?.command).toContain("examples custom nested run");
  expect(output[0]?.command).toContain("--is-active='false'");
  expect(output[0]?.command).toContain("--count='0'");
});

test("unrepresentable arrays and argv/header bytes do not become runnable examples", async () => {
  await Promise.all(
    [
      {
        example: [],
        in: "query",
        name: "value",
        schema: { items: { type: "string" }, type: "array" },
      },
      {
        example: ["a,b"],
        explode: false,
        in: "query",
        name: "value",
        schema: { items: { type: "string" }, type: "array" },
      },
      { example: "nul\0byte", in: "query", name: "value", schema: { type: "string" } },
      { example: "bad\r\nheader", in: "header", name: "value", schema: { type: "string" } },
    ].map(async (parameter) => {
      expect(await examples({ parameters: [{ ...parameter, required: true }] })).toEqual([]);
    }),
  );
});

test("unusable references and external examples are skipped without fetching", async () => {
  expect(
    await examples(
      body({
        examples: {
          cycle: { $ref: "#/components/examples/Cycle" },
          missing: { $ref: "#/components/examples/Missing" },
          remote: { externalValue: "https://example.com/value.json" },
        },
        schema: {},
      }),
      { examples: { Cycle: { $ref: "#/components/examples/Cycle" } } },
    ),
  ).toEqual([]);
});

test("multipart content examples never become local paths", async () => {
  expect(
    await examples({
      requestBody: {
        content: {
          "multipart/form-data": {
            example: { file: "secret.csv" },
            schema: {
              properties: { file: { example: "secret.csv", format: "binary", type: "string" } },
              required: ["file"],
              type: "object",
            },
          },
        },
        required: true,
      },
    }),
  ).toEqual([]);
});

test("shell source quoting preserves literal substitutions, single quotes and newline", () => {
  const value = "-value ' $(printf injected) `printf injected`\nnext";
  const result = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${shellQuote(value)}`]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(value);
});

test("annotation-only allOf retains target examples under three-zero reference rules", async () => {
  const output = await examples(
    body({
      schema: {
        allOf: [
          { $ref: "#/components/schemas/Base", example: "ignored" },
          { description: "Local description" },
        ],
      },
    }),
    { schemas: { Base: { example: "base", type: "string" } } },
    "3.0.3",
  );
  expect(output[0]?.command).toEndWith(`--body='"base"'`);
});

test("named example descriptions follow reference dialect, preserving explicit emptiness", async () => {
  const components = {
    examples: { Sample: { description: "Original description", value: false } },
  };
  const input = body({
    examples: { example: { $ref: "#/components/examples/Sample", description: "" } },
    schema: { type: "boolean" },
  });
  const old = await examples(input, components, "3.0.3");
  const modern = await examples(input, components);
  expect(old[0]?.description).toBe("Original description");
  expect(modern[0]?.description).toBe("");
});
