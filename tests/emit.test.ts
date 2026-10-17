import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import * as oxfmt from "oxfmt";
import { generate } from "../src/index.js";
import { formatApplication } from "../src/core/format.js";
import type { GeneratedApplication } from "../src/core/model.js";

// These fixtures emit service-free JSON validators; compilation verifies that contract.
const JsonValidator = Schema.declare<Schema.Codec<Schema.Json>>(
  (value): value is Schema.Codec<Schema.Json> => Schema.isSchema(value),
);

const document = {
  info: { description: "Original help", title: "Sample API", version: "not-semver" },
  openapi: "3.1.0",
  paths: {
    "/items/{id}": {
      post: {
        operationId: "items-get",
        parameters: [
          {
            description: "Identifier",
            in: "path",
            name: "id",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                properties: { ["__proto__"]: { description: "Prototype field", type: "string" } },
                type: "object",
              },
            },
          },
        },
        responses: { "200": { description: "OK" } },
        summary: `Read */ dangerous\n@evil \` \${attack()} `,
        "x-fern-sdk-group-name": "account.items",
      },
    },
  },
};

const source = (output: GeneratedApplication, name: string) =>
  output.files.find((file) => file.path === `src/${name}.ts`)?.content ?? "";

const checkPackage = async (output: GeneratedApplication) => {
  const directory = await mkdtemp(path.join(process.cwd(), ".emission-proof-"));
  try {
    await symlink(path.resolve("node_modules"), path.join(directory, "node_modules"));
    await Promise.all(
      output.files.map(async (file) => {
        const target = path.join(directory, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }),
    );
    for (const command of [
      [path.resolve("node_modules/.bin/tsc"), "--noEmit", "--noUnusedLocals", "-p", directory],
      ["bunx", "vp", "lint", "--type-aware", path.join(directory, "src")],
      ["bunx", "vp", "fmt", "--check", path.join(directory, "src")],
    ]) {
      const result = Bun.spawnSync(command);
      expect(
        { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() },
        command.join(" "),
      ).toMatchObject({ code: 0 });
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

test("standalone modules are deterministic, formatted, selective and independently checked", async () => {
  const output = await Effect.runPromise(generate(document));
  expect(await Effect.runPromise(generate(document))).toEqual(output);
  expect(await Effect.runPromise(formatApplication(output))).toEqual(output);
  expect(output.files.map((file) => file.path)).toEqual([
    "src/main.ts",
    "src/commands.ts",
    "src/builtins/errors.ts",
    "src/builtins/http.ts",
    "src/builtins/url.ts",
    "src/builtins/body.ts",
    "package.json",
    "tsconfig.json",
    ".gitignore",
  ]);
  expect(source(output, "commands")).toContain('Flag.String("id")');
  expect(source(output, "commands")).toContain("HttpClientRequest.post(apiUrl)");
  expect(source(output, "commands")).toContain("const itemsGetCommand");
  expect(source(output, "commands")).not.toContain("Effect.gen");
  expect(source(output, "builtins/errors")).not.toContain("AuthenticationError");
  expect(source(output, "main")).toContain('Command.make("sample-api")');
  await checkPackage(output);
});

test("formatter failures remain typed", async () => {
  const syntaxFailure = await Effect.runPromise(
    Effect.flip(formatApplication({ files: [{ content: "const = ;", path: "bad.ts" }] })),
  );
  expect(syntaxFailure.code).toBe("format");

  const mock = spyOn(oxfmt, "format").mockRejectedValueOnce(new Error("formatter unavailable"));
  try {
    const unavailable = await Effect.runPromise(Effect.flip(generate(document)));
    expect(unavailable.code).toBe("format");
  } finally {
    mock.mockRestore();
  }
});

test.each([false, true])(
  "hostile documentation and deprecated metadata %s remain safe and lintable",
  async (deprecated) => {
    const input = structuredClone(document);
    const hostile = `quote" slash\\ newline\n backtick\` \${globalThis.injected = true} */\n@tag`;
    Object.assign(input.paths["/items/{id}"].post, { deprecated, summary: hostile });
    Object.assign(input.paths["/items/{id}"].post.requestBody.content["application/json"].schema, {
      properties: {
        [hostile]: {
          deprecated,
          description: hostile,
          enum: [hostile],
          externalDocs: { url: "https://example.test/" },
          type: "string",
        },
        ["__proto__"]: { type: "string" },
      },
    });

    const output = await Effect.runPromise(generate(input));
    expect(source(output, "commands")).toContain("\\@tag");
    expect(source(output, "commands")).toContain('["__proto__"]');
    expect(source(output, "commands").includes("@deprecated")).toBe(deprecated);
    for (const file of output.files.filter((entry) => entry.path.endsWith(".ts"))) {
      expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(file.content)).not.toThrow();
    }
    await checkPackage(output);
  },
);

test.each([
  { scheme: "Bearer", type: "http" },
  { scheme: "Basic", type: "http" },
  { in: "header", name: "X-Token", type: "apiKey" },
  { in: "query", name: "key", type: "apiKey" },
  { in: "cookie", name: "key", type: "apiKey" },
])("effective security emits only required adapters %#", async (scheme) => {
  const input = {
    ...document,
    components: { securitySchemes: { token: scheme } },
    security: [{ token: [] }],
  };
  const output = await Effect.runPromise(generate(input));
  const auth = source(output, "builtins/auth");
  if (scheme.type === "http" && scheme.scheme === "Bearer") {
    expect(auth).toBe("");
  }

  if (scheme.type === "http" && scheme.scheme === "Basic") {
    expect(auth).toContain("basicAuth");
    expect(auth).not.toContain("Cookies");
  }

  if (scheme.type === "apiKey") {
    expect(auth).toContain(`${scheme.in}ApiKey`);
    expect(auth.includes("Cookies")).toBe(scheme.in === "cookie");
    expect(source(output, "builtins/errors")).not.toContain("BasicEncodingError");
  }

  await checkPackage(output);
});

test("explicit reference aliases share identity; inline lookalikes remain inline", async () => {
  const input = {
    ...document,
    components: {
      schemas: {
        Alias: { $ref: "#/components/schemas/Auth" },
        Auth: { pattern: "^[a-z]+$", type: "string" },
        Models: {
          properties: {
            first: { $ref: "#/components/schemas/Alias" },
            inline: { pattern: "^[a-z]+$", type: "string" },
            second: { $ref: "#/components/schemas/Auth" },
          },
          type: "object",
        },
      },
    },
  };
  Object.assign(input.paths["/items/{id}"].post.requestBody.content["application/json"], {
    schema: { $ref: "#/components/schemas/Models" },
  });

  const output = await Effect.runPromise(generate(input));
  const models = source(output, "models");
  expect(models).toContain("const Auth2 =");
  expect(models).toContain("const Alias = Auth2");
  expect(models).toContain("export const Models2");
  expect(models.match(/Schema.isPattern/gu)).toHaveLength(2);
  await checkPackage(output);
});

test("model constraints preserve code points, exact oneOf, extras and null enum semantics", async () => {
  const variants = [
    { enum: ["yes", null], type: ["string", "null"] },
    { enum: [null], type: ["string", "null"] },
    { oneOf: [{ type: "number" }, { type: "integer" }] },
    {
      additionalProperties: { oneOf: [{ type: "number" }, { type: "string" }] },
      properties: { fixed: { type: "boolean" } },
      type: "object",
    },
    { maxLength: 2, minLength: 1, type: "string" },
  ];
  const input = structuredClone(document);
  Object.assign(input, {
    components: {
      schemas: Object.fromEntries(variants.map((schema, index) => [`Case${index}`, schema])),
    },
  });
  Object.assign(input.paths["/items/{id}"].post.requestBody.content["application/json"], {
    schema: {
      properties: Object.fromEntries(
        variants.map((_, index) => [`case${index}`, { $ref: `#/components/schemas/Case${index}` }]),
      ),
      type: "object",
    },
  });

  const output = await Effect.runPromise(generate(input));
  const directory = await mkdtemp(path.join(process.cwd(), ".schema-proof-"));
  try {
    await writeFile(path.join(directory, "models.ts"), source(output, "models"));
    const models = Schema.decodeUnknownSync(
      Schema.Struct({
        Case0: JsonValidator,
        Case1: JsonValidator,
        Case2: JsonValidator,
        Case3: JsonValidator,
        Case4: JsonValidator,
      }),
    )(await import(path.join(directory, "models.ts")));
    const validators = [models.Case0, models.Case1, models.Case2, models.Case3, models.Case4];
    const accepts = (index: number, value: Schema.Json) => {
      const validator = validators[index];
      if (validator === undefined) {
        throw new Error("Missing fixture validator.");
      }

      return Schema.is(validator)(value);
    };
    expect(accepts(0, null)).toBe(true);
    expect(accepts(0, "no")).toBe(false);
    expect(accepts(1, null)).toBe(true);
    expect(accepts(1, "yes")).toBe(false);
    expect(accepts(2, 1)).toBe(false);
    expect(accepts(2, 1.5)).toBe(true);
    expect(accepts(3, { a: 1, b: "x", fixed: true })).toBe(true);
    expect(accepts(3, { a: false })).toBe(false);
    for (const key of ["fixedX", "fixed\n", "fixed\r", "fixed\u2028"]) {
      expect(accepts(3, { fixed: true, [key]: false })).toBe(false);
    }
    const value = { extra: 1, fixed: true };
    const decoded = Schema.decodeUnknownSync(models.Case3)(value, { onExcessProperty: "error" });
    expect(Schema.encodeSync(models.Case3)(decoded)).toEqual(value);

    const request = await Effect.runPromise(
      HttpClientRequest.bodyJson(HttpClientRequest.post("http://localhost"), decoded),
    );
    expect(request.body._tag).toBe("Uint8Array");

    expect(accepts(4, "😀😀")).toBe(true);
    expect(accepts(4, "😀😀😀")).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
  await checkPackage(output);
});

test("identifier allocation survives normalized collisions and input key reordering", async () => {
  const operation = { operationId: "root", responses: { "200": { description: "OK" } } };
  const input = {
    info: document.info,
    openapi: "3.1.0",
    paths: {
      "/a": { get: { ...operation, "x-fern-sdk-group-name": ["a-b", "c"] } },
      "/b": { get: { ...operation, "x-fern-sdk-group-name": ["a", "b-c"] } },
    },
  };
  const output = await Effect.runPromise(generate(input));
  const reversed = {
    info: input.info,
    openapi: input.openapi,
    paths: { "/a": input.paths["/a"], "/b": input.paths["/b"] },
  };
  expect(await Effect.runPromise(generate(reversed))).toEqual(output);
  expect(source(output, "commands")).toContain("const rootCommand2");
  expect(source(output, "commands")).toContain("const rootCommand3");
  expect(source(output, "commands")).toContain("const ABCCommand2");
  await checkPackage(output);
});

test("allOf annotations and deprecated shared models preserve their source meaning", async () => {
  const input = structuredClone(document);
  Object.assign(input, {
    components: { schemas: { Legacy: { deprecated: true, type: "string" } } },
  });
  Object.assign(input.paths["/items/{id}"].post.requestBody.content["application/json"], {
    schema: {
      properties: {
        item: {
          allOf: [
            { $ref: "#/components/schemas/Legacy" },
            { description: "Source annotation stays here." },
          ],
        },
      },
      type: "object",
    },
  });

  const output = await Effect.runPromise(generate(input));
  expect(source(output, "commands")).toContain("Source annotation stays here.");
  await checkPackage(output);
});

test("formatted enum literals roundtrip lone surrogates, interpolation and line endings", async () => {
  const values = [
    `\${\uD800`,
    `\${\uDC00`,
    `\${\uD83D\uDE00`,
    `\${\uD800 backtick\` slash\\ CR\r LF\n low\uDC00 pair\uD83D\uDE00`,
  ];
  const input = structuredClone(document);
  Object.assign(input, { components: { schemas: { Text: { enum: values, type: "string" } } } });
  Object.assign(input.paths["/items/{id}"].post.requestBody.content["application/json"], {
    schema: { $ref: "#/components/schemas/Text" },
  });

  const output = await Effect.runPromise(generate(input));
  const directory = await mkdtemp(path.join(process.cwd(), ".literal-proof-"));
  try {
    const models = source(output, "models");
    await writeFile(path.join(directory, "models.ts"), models);
    const { Text } = Schema.decodeUnknownSync(Schema.Struct({ Text: JsonValidator }))(
      await import(path.join(directory, "models.ts")),
    );
    for (const value of values) {
      expect(Schema.is(Text)(value)).toBe(true);
    }
    expect(Schema.is(Text)(`\${\uFFFD`)).toBe(false);
    expect(models).toBe(Buffer.from(models, "utf-8").toString("utf-8"));
    expect(await Effect.runPromise(formatApplication(output))).toEqual(output);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
