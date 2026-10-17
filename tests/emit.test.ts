import { exampleSchema } from "../src/core/example-schema.js";
import { normalizeSchema } from "../src/core/schema.js";
import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Array, Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import * as oxfmt from "oxfmt";
import { generate } from "../src/index.js";
import { description } from "../src/core/source-text.js";
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

const checkPackage = async (
  output: GeneratedApplication,
  inspect?: (directory: string) => Promise<void>,
) => {
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
    if (inspect) {
      await inspect(directory);
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
  const models = source(output, "components/schemas");
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
    { additionalProperties: false, type: "object" },
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
    await writeFile(path.join(directory, "models.ts"), source(output, "components/schemas"));
    const models = Schema.decodeUnknownSync(
      Schema.Struct({
        Case0: JsonValidator,
        Case1: JsonValidator,
        Case2: JsonValidator,
        Case3: JsonValidator,
        Case4: JsonValidator,
        Case5: JsonValidator,
      }),
    )(await import(path.join(directory, "models.ts")));
    const validators = [
      models.Case0,
      models.Case1,
      models.Case2,
      models.Case3,
      models.Case4,
      models.Case5,
    ];
    const nativeValidators = await Promise.all(
      variants.map(async (variant) =>
        exampleSchema(await Effect.runPromise(normalizeSchema({}, variant, "/schema", "3.1"))),
      ),
    );
    const accepts = (index: number, value: Schema.Json) => {
      const validator = validators[index];
      if (validator === undefined) {
        throw new Error("Missing fixture validator.");
      }

      const native = nativeValidators[index];
      if (native === undefined) {
        throw new Error("Missing native validator.");
      }

      expect(Schema.is(native)(value)).toBe(Schema.is(validator)(value));

      return Schema.is(validator)(value);
    };
    expect(accepts(5, {})).toBe(true);
    expect(accepts(5, { extra: false })).toBe(false);
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
    const models = source(output, "components/schemas");
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

test("multipart capability subsets compile without unused models or imports", async () => {
  await Effect.runPromise(
    Effect.forEach(
      [
        {},
        { file: { $ref: "#/components/schemas/Binary" } },
        { file: { items: { $ref: "#/components/schemas/Binary" }, type: "array" } },
        { file: { $ref: "#/components/schemas/Alias" } },
        { file: { allOf: [{ $ref: "#/components/schemas/Text" }, { format: "binary" }] } },
        {
          file: { allOf: [{ $ref: "#/components/schemas/Binary" }, { description: "File bytes" }] },
        },
      ],
      (properties) =>
        Effect.promise(async () => {
          const output = await Effect.runPromise(
            generate({
              components: {
                schemas: {
                  Alias: {
                    allOf: [{ $ref: "#/components/schemas/Binary" }, { description: "File bytes" }],
                  },
                  Binary: { format: "binary", type: "string" },
                  Container: { additionalProperties: false, properties, type: "object" },
                  Text: { type: "string" },
                },
              },
              info: { title: "Upload", version: "1.0.0" },
              openapi: "3.1.0",
              paths: {
                "/upload": {
                  post: {
                    requestBody: {
                      content: {
                        "multipart/form-data": {
                          schema: {
                            allOf: [
                              { $ref: "#/components/schemas/Container" },
                              { description: "Multipart object" },
                            ],
                          },
                        },
                      },
                      required: true,
                    },
                    responses: { "200": { description: "OK" } },
                  },
                },
              },
            }),
          );
          expect(source(output, "components/schemas")).toBe("");

          const multipart = source(output, "builtins/multipart");
          if (
            !("file" in properties && "type" in properties.file && properties.file.type === "array")
          ) {
            expect(multipart).not.toContain("export const files");
          }

          if (Object.keys(properties).length === 0) {
            expect(multipart).not.toContain("FileSystem");
            expect(source(output, "commands")).not.toContain("Flag");
          } else {
            expect(source(output, "components/multipart")).toContain('Flag.File("file"');
          }

          await checkPackage(output);
        }),
      { concurrency: 1 },
    ),
  );
}, 30_000);

test("explicit component categories preserve identity, overrides and inline definitions", async () => {
  const responses = { "200": { description: "OK" } };
  const schema = { minimum: 0, type: "integer" };
  const sharedParameter = {
    in: "query",
    name: "limit",
    schema: { $ref: "#/components/schemas/Shared" },
  };
  const body = {
    content: { "application/json": { schema: { $ref: "#/components/schemas/Shared" } } },
    required: true,
  };
  const input = {
    components: {
      parameters: {
        Alias: { $ref: "#/components/parameters/Shared", description: "Alias parameter" },
        Shared: sharedParameter,
        Twin: sharedParameter,
      },
      requestBodies: {
        Alias: { $ref: "#/components/requestBodies/Shared", description: "Alias payload" },
        Shared: { ...body, description: "Canonical payload" },
      },
      schemas: { Shared: schema, Twin: schema },
      securitySchemes: { Shared: { scheme: "bearer", type: "http" } },
    },
    info: { title: "Components", version: "1" },
    openapi: "3.1.0",
    paths: {
      "/first": {
        post: {
          parameters: [
            { $ref: "#/components/parameters/Alias" },
            { in: "header", name: "inline", schema },
          ],
          requestBody: { $ref: "#/components/requestBodies/Alias", description: "Local payload" },
          responses,
        },
      },
      "/second": {
        parameters: [{ $ref: "#/components/parameters/Twin" }],
        post: {
          parameters: [{ $ref: "#/components/parameters/Shared", description: "Local help" }],
          requestBody: { $ref: "#/components/requestBodies/Shared" },
          responses,
        },
      },
      "/third": {
        get: {
          parameters: [
            { $ref: "#/components/parameters/Twin" },
            { in: "header", name: "twin", schema: { $ref: "#/components/schemas/Twin" } },
          ],
          responses,
        },
      },
    },
    security: [{ Shared: [] }],
  };
  const output = await Effect.runPromise(generate(input));
  const commands = source(output, "commands");
  expect(commands.match(/Parameters.Shared/gu)).toHaveLength(1);
  expect(commands).toContain('Flag.withDescription("Local help")');
  expect(commands).toContain('Flag.Int("inline")');
  expect(commands).toContain("RequestBodies.Shared");
  expect(commands).toContain("RequestBodies.Alias");
  expect(commands).toContain('Flag.withDescription("Local payload")');
  expect(source(output, "components/request-bodies")).toContain("export const Alias = Shared");
  expect(source(output, "components/parameters")).toContain("export const Alias = Shared.pipe");
  expect(commands).toContain("SecuritySchemes.Shared");
  expect(source(output, "components/parameters")).toContain("export const Shared = Flag.Int");
  expect(source(output, "components/parameters")).toContain("export const Twin = Flag.Int");
  expect(source(output, "components/parameters")).toContain("Schemas.Shared");
  expect(source(output, "components/request-bodies")).toContain(
    "export const { Shared } = Schemas",
  );
  expect(source(output, "components/schemas")).toContain("export const Shared =");
  expect(source(output, "components/schemas")).toContain("export const Twin =");
  expect(
    output.files.some((file) => file.path === "src/models.ts" || file.path === "src/auth.ts"),
  ).toBe(false);
  expect(
    await Effect.runPromise(
      generate({ ...input, paths: Object.fromEntries(Array.reverse(Object.entries(input.paths))) }),
    ),
  ).toEqual(output);
  await checkPackage(output, async (directory) => {
    expect(Bun.spawnSync([path.resolve("node_modules/.bin/tsc"), "-p", directory]).exitCode).toBe(
      0,
    );

    const requests: { body: string; url: string; authorization: string | null }[] = [];
    const server = Bun.serve({
      fetch: async (request) => {
        requests.push({
          authorization: request.headers.get("authorization"),
          body: await request.text(),
          url: request.url,
        });

        return new Response("accepted");
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    const invoke = async (command: string, args: readonly string[]) => {
      const child = Bun.spawn(
        [
          "node",
          path.join(directory, "dist/main.js"),
          command,
          "post",
          "--base-url",
          server.url.origin,
          "--shared",
          "local-token",
          ...args,
        ],
        { stderr: "pipe", stdout: "pipe" },
      );
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      return { code, err, out };
    };
    try {
      const first = await invoke("first", ["--limit", "4", "--inline", "5", "--body", "12"]);
      expect(first.code, first.err).toBe(0);

      const second = await invoke("second", ["--limit", "0", "--body", "7"]);
      expect(second.code, second.err).toBe(0);
      expect(requests.map((request) => request.body)).toEqual(["12", "7"]);
      expect(requests.map((request) => new URL(request.url).searchParams.get("limit"))).toEqual([
        "4",
        "0",
      ]);
      expect(requests.map((request) => request.authorization)).toEqual([
        "Bearer local-token",
        "Bearer local-token",
      ]);

      const missing = await invoke("first", []);
      expect(missing.code).toBe(1);

      const invalid = await invoke("first", ["--limit", "-1", "--body", "12"]);
      expect(invalid.code).toBe(1);
      expect(requests).toHaveLength(2);
    } finally {
      await server.stop(true);
    }
  });
}, 30_000);

test("security reference help retains alias overrides with separate credential names", async () => {
  const output = await Effect.runPromise(
    generate({
      components: {
        securitySchemes: {
          Alias: { $ref: "#/components/securitySchemes/Base", description: "Alias token" },
          Base: { description: "Base token", scheme: "bearer", type: "http" },
          Empty: { $ref: "#/components/securitySchemes/Alias", description: "" },
          Outer: { $ref: "#/components/securitySchemes/Alias", description: "Outer token" },
        },
      },
      info: { title: "Security references", version: "1" },
      openapi: "3.1.0",
      paths: Object.fromEntries(
        ["Base", "Alias", "Outer", "Empty"].map((key) => [
          `/${key.toLowerCase()}`,
          { get: { responses: { "200": { description: "OK" } }, security: [{ [key]: [] }] } },
        ]),
      ),
    }),
  );
  const security = source(output, "components/security-schemes");
  expect(security).toContain('Flag.Redacted("alias")');
  expect(security).toContain('Flag.withDescription("Alias token")');
  expect(security).toContain('Flag.Redacted("outer")');
  expect(security).toContain('Flag.withDescription("Outer token")');
  expect(security).toContain('Flag.withDescription("")');
  await checkPackage(output);
});

test("fresh eight-operation Resend output compiles without changing the checked-in slice", async () => {
  const input = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(
    await readFile("examples/resend-generated/openapi.json", "utf-8"),
  );
  const output = await Effect.runPromise(generate(input, { name: "resend-generated" }));
  expect(source(output, "commands")).toContain("Parameters.PaginationLimit");
  await checkPackage(output);
});

test("multipart request-body aliases and JSON schema views retain explicit identities", async () => {
  const responses = { "200": { description: "OK" } };
  const uploadSchema = {
    additionalProperties: false,
    properties: { title: { minLength: 2, type: "string" } },
    required: ["title"],
    type: "object",
  };
  const output = await Effect.runPromise(
    generate({
      components: {
        requestBodies: {
          Alias: { $ref: "#/components/requestBodies/Upload" },
          Upload: { content: { "multipart/form-data": { schema: uploadSchema } }, required: true },
        },
        schemas: { Upload: uploadSchema },
      },
      info: { title: "Shared transport views", version: "1" },
      openapi: "3.1.0",
      paths: {
        "/alias": {
          post: { requestBody: { $ref: "#/components/requestBodies/Alias" }, responses },
        },
        "/inline": {
          post: {
            requestBody: { content: { "multipart/form-data": { schema: uploadSchema } } },
            responses,
          },
        },
        "/json": {
          post: {
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Upload" } } },
            },
            responses,
          },
        },
        "/multipart": {
          post: {
            requestBody: {
              content: {
                "multipart/form-data": { schema: { $ref: "#/components/schemas/Upload" } },
              },
            },
            responses,
          },
        },
      },
    }),
  );
  const bundles = source(output, "components/multipart");
  expect(bundles).toContain("export const Alias = Upload;");
  expect(bundles).toContain("export const Upload2 =");
  expect(source(output, "components/schemas")).toContain("export const Upload = Schema.Struct");
  expect(source(output, "commands")).toContain("MultipartComponents.Alias.title");
  expect(source(output, "commands")).toContain(
    "MultipartComponents.Upload2.title.pipe(Flag.optional)",
  );
  expect(source(output, "commands")).toContain('Flag.String("title").pipe(');
  await checkPackage(output);
});

test("source descriptions remain unchanged and defaults never alter requests", async () => {
  const responses = { "200": { description: "OK" } };
  const input = {
    components: {
      parameters: {
        Enabled: {
          description: "Shared flag",
          in: "query",
          name: "enabled",
          schema: { $ref: "#/components/schemas/FlagAlias" },
        },
        EnabledAlias: { $ref: "#/components/parameters/Enabled" },
      },
      requestBodies: {
        Body: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Payload" } } },
        },
        BodyAlias: { $ref: "#/components/requestBodies/Body" },
      },
      schemas: {
        Flag: { default: true, type: "boolean" },
        FlagAlias: { $ref: "#/components/schemas/Flag", default: false },
        Payload: {
          default: { a: false, z: 0 },
          properties: {
            blank: { default: "", type: "string" },
            choice: {
              oneOf: [
                { default: "a", enum: ["a"], type: "string" },
                { default: "b", enum: ["b"], type: "string" },
              ],
            },
            escaped: { default: `line\n\u0001\${literal}*/`, type: "string" },
            list: { default: [], items: { default: "item", type: "string" }, type: "array" },
            nested: {
              properties: { "a/b~c": { default: 0, type: "integer" } },
              required: ["a/b~c"],
              type: "object",
            },
            nothing: { default: null, type: "null" },
            prose: { description: "Defaults to inferred.", type: "string" },
          },
          type: "object",
        },
      },
    },
    info: { title: "Defaults", version: "1" },
    openapi: "3.1.0",
    paths: {
      "/required": {
        post: {
          operationId: "required",
          requestBody: {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Payload", default: {} } },
            },
            required: true,
          },
          responses,
        },
      },
      "/send/{id}": {
        post: {
          operationId: "send",
          parameters: [
            { $ref: "#/components/parameters/EnabledAlias", description: "Local flag description" },
            { in: "header", name: "X-Mode", schema: { default: "raw/slash", type: "string" } },
            { in: "query", name: "count", schema: { default: 0, type: "integer" } },
            { in: "query", name: "text", schema: { default: "", type: "string" } },
            {
              in: "path",
              name: "id",
              required: true,
              schema: { default: "identifier", type: "string" },
            },
          ],
          requestBody: {
            $ref: "#/components/requestBodies/BodyAlias",
            description: "Local body description",
          },
          responses,
        },
      },
    },
  };
  const output = await Effect.runPromise(generate(input));
  const reordered = {
    ...input,
    components: {
      ...input.components,
      schemas: {
        ...input.components.schemas,
        Payload: {
          ...input.components.schemas.Payload,
          default: Object.fromEntries(
            Array.reverse(Object.entries(input.components.schemas.Payload.default)),
          ),
        },
      },
    },
  };
  expect(await Effect.runPromise(generate(reordered))).toEqual(output);
  await checkPackage(output, async (directory) => {
    const build = Bun.spawnSync([path.resolve("node_modules/.bin/tsc"), "-p", directory]);
    expect(build.exitCode, build.stderr.toString()).toBe(0);

    const requests: { body: string; header: string | null; url: string }[] = [];
    const server = Bun.serve({
      async fetch(request) {
        requests.push({
          body: await request.text(),
          header: request.headers.get("x-mode"),
          url: request.url,
        });

        return new Response("accepted");
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    const invoke = async (args: readonly string[], command = "send") => {
      const process = Bun.spawn(["node", path.join(directory, "dist/main.js"), command, ...args], {
        stderr: "pipe",
        stdout: "pipe",
      });
      const [code, out, err] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);

      return { code, err, out };
    };
    try {
      const help = await invoke(["--help"]);
      expect(help.code, help.err).toBe(0);
      expect(help.out).toContain("Local flag description");
      expect(help.out).toContain("Local body description");
      for (const injected of [
        "Server default when omitted",
        "Declared default",
        "JSON body defaults",
        "See body defaults",
        "Defaults shown",
        "Pass a JSON array",
        "Deprecated.",
      ]) {
        expect(help.out).not.toContain(injected);
      }
      const requiredHelp = await invoke(["--help"], "required");
      expect(requiredHelp.out).not.toContain("body is required");

      const base = ["--id", "abc", "--base-url", server.url.origin];
      const omitted = await invoke(base);
      expect(omitted.code).toBe(0);

      const body = '{"blank":"","list":[],"nested":{"a/b~c":0},"nothing":null}';
      const explicit = await invoke([
        ...base,
        "--x-mode",
        "custom/slash",
        "--enabled",
        "false",
        "--count",
        "0",
        "--text",
        "",
        "--body",
        body,
      ]);
      expect(explicit.code).toBe(0);

      const filename = path.join(directory, "body.json");
      await writeFile(filename, body);
      const fromFile = await invoke([...base, "--body-file", filename]);
      expect(fromFile.code).toBe(0);
      expect(requests.map((request) => request.body)).toEqual(["", body, body]);
      expect(requests.map((request) => request.header)).toEqual([null, "custom/slash", null]);
      expect(new URL(requests[0]?.url ?? "").search).toBe("");
      expect(new URL(requests[1]?.url ?? "").searchParams.get("enabled")).toBe("false");
      expect(new URL(requests[1]?.url ?? "").searchParams.get("count")).toBe("0");
      expect(new URL(requests[1]?.url ?? "").searchParams.get("text")).toBe("");

      const missing = await invoke([...base, "--body", '{"nested":{}}']);
      expect(missing.code).toBe(1);

      const missingBody = await invoke(["--base-url", server.url.origin], "required");
      expect(missingBody.code).toBe(1);
      expect(requests).toHaveLength(3);
    } finally {
      await server.stop(true);
    }
  });
}, 30_000);

test("authored descriptions remain exact while empty overrides and fallbacks stay distinct", async () => {
  const authored = "  lower-case source\n\nDefaults to skip.  ";
  expect(
    description({ deprecated: true, description: authored, summary: "ignored", title: "ignored" }),
  ).toBe(authored);
  expect(description({ description: "", summary: "ignored", title: "ignored" })).toBe("");
  expect(description({ summary: " summary ", title: "ignored" })).toBe(" summary ");
  expect(description({ title: " title " })).toBe(" title ");

  const responses = { "200": { description: "OK" } };
  const output = await Effect.runPromise(
    generate({
      components: {
        parameters: {
          Q: {
            description: authored,
            in: "query",
            name: "q",
            schema: { default: [], items: { type: "string" }, type: "array" },
          },
        },
      },
      info: { title: "Source help", version: "1" },
      openapi: "3.1.0",
      paths: {
        "/authored": {
          get: {
            deprecated: true,
            description: authored,
            parameters: [{ $ref: "#/components/parameters/Q" }],
            responses,
            summary: "IGNORE_OPERATION_SUMMARY",
          },
        },
        "/empty": {
          get: {
            description: "",
            parameters: [{ $ref: "#/components/parameters/Q", description: "" }],
            responses,
            summary: "IGNORE_EMPTY_SUMMARY",
          },
        },
        "/summary": { get: { responses, summary: " Summary only " } },
      },
    }),
  );
  const commands = source(output, "commands");
  expect(commands).toContain(`Command.withDescription(${JSON.stringify(authored)})`);
  expect(commands).toContain('Parameters.Q.pipe(Flag.withDescription(""))');
  expect(commands).toContain('Command.withDescription(" Summary only ")');
  expect(commands).not.toContain("IGNORE_");
  expect(commands).not.toContain("Deprecated.");
  expect(commands).toContain("@deprecated");

  const parameters = source(output, "components/parameters");
  expect(parameters).toContain(`Flag.withDescription(${JSON.stringify(authored)})`);
  expect(parameters).toContain('Flag.withMetavar("JSON_ARRAY")');
  expect(parameters).not.toContain("Pass a JSON array");
  expect(parameters).not.toContain("Server default");
  await checkPackage(output);
});

test("native examples run literal shell values through the emitted CLI and preserve source help", async () => {
  const hostile = "-value ' $(printf injected) `printf injected`";
  const payload = {
    count: 0,
    enabled: false,
    message: `${hostile}\nnext`,
    nothing: null,
    values: ["", "a,b"],
  };
  const input = {
    components: { schemas: { Payload: { additionalProperties: true, type: "object" } } },
    info: { title: "Example App", version: "1" },
    openapi: "3.1.0",
    paths: {
      "/records": {
        post: {
          description: "Source-owned description.",
          operationId: "records/create",
          parameters: [
            {
              example: hostile,
              in: "query",
              name: "search",
              required: true,
              schema: { type: "string" },
            },
            {
              example: ["", "a,b"],
              in: "query",
              name: "labels",
              schema: { items: { type: "string" }, type: "array" },
            },
          ],
          requestBody: {
            content: {
              "application/json": {
                examples: { complete: { description: "Source-owned example.", value: payload } },
                schema: { $ref: "#/components/schemas/Payload" },
              },
            },
            required: true,
          },
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };
  const output = await Effect.runPromise(generate(input));
  expect(source(output, "commands")).toContain("Command.withExamples");
  await checkPackage(output, async (directory) => {
    const build = Bun.spawnSync([path.resolve("node_modules/.bin/tsc"), "-p", directory]);
    expect(build.exitCode).toBe(0);

    const main = path.join(directory, "dist/main.js");
    const rendered = Bun.spawnSync(["node", main, "records", "create", "--help"]);
    expect(rendered.exitCode).toBe(0);

    const text = rendered.stdout.toString();
    expect(text).toContain("Source-owned description.");
    expect(text).toContain("Source-owned example.");
    expect(text).toContain("EXAMPLES");

    const usage =
      text
        .split("\n")
        .find((line) => line.trimStart().startsWith("example-app records create --"))
        ?.trim() ?? "";
    expect(usage).not.toBe("");

    const requests: { body: unknown; search: string | null; labels: string[] }[] = [];
    const server = Bun.serve({
      async fetch(request) {
        const url = new URL(request.url);
        requests.push({
          body: await request.json(),
          labels: url.searchParams.getAll("labels"),
          search: url.searchParams.get("search"),
        });

        return new Response("ok");
      },
      port: 0,
    });
    try {
      const executable = `node '${main}'`;
      const command = usage.replace(/^example-app/u, executable);
      const run = Bun.spawn(["/bin/sh", "-c", command], {
        env: { ...process.env, API_BASE_URL: server.url.toString() },
        stderr: "pipe",
        stdout: "pipe",
      });
      const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(requests).toEqual([{ body: payload, labels: ["", "a,b"], search: hostile }]);
    } finally {
      await server.stop(true);
    }
  });
}, 30_000);
