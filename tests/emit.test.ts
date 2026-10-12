import { describe, expect, spyOn, test } from "bun:test";
import { Effect, Schema } from "effect";
import * as oxfmt from "oxfmt";
import { generate } from "../src/index.js";
import { formatApplication } from "../src/format.js";

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
describe("standalone application generation", () => {
  test("returns five deterministic, independently formatted files without platform services", async () => {
    const output = await Effect.runPromise(generate(document));
    expect(output.files.map((file) => file.path)).toEqual([
      "src/main.ts",
      "src/runtime.ts",
      "package.json",
      "tsconfig.json",
      ".gitignore",
    ]);
    expect(await Effect.runPromise(generate(document))).toEqual(output);
    expect(await Effect.runPromise(formatApplication(output))).toEqual(output);
    const pkg = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          dependencies: Schema.Record(Schema.String, Schema.String),
          name: Schema.String,
          version: Schema.String,
        }),
      ),
    )(output.files.find((file) => file.path === "package.json")?.content ?? "");
    expect(pkg.name).toBe("sample-api");
    expect(pkg.version).toBe("0.0.0");
    expect(Object.keys(pkg.dependencies)).toEqual(["@effect/platform-node", "effect"]);
    for (const file of output.files) {
      expect(file.content.endsWith("\n")).toBe(true);
    }
  });
  test("emits native commands and literal-safe meaningful documentation", async () => {
    const output = await Effect.runPromise(generate(document, { name: "custom-api" }));
    const main = output.files.find((file) => file.path === "src/main.ts")?.content ?? "";
    expect(main).toContain('Command.make("custom-api")');
    expect(main).toContain('Command.make("account")');
    expect(main).toContain('Argument.String("id")');
    expect(main).toContain("@evil");
    expect(main).toContain("Prototype field");
    expect(main).toContain('["__proto__"]');
    expect(main).toContain("Config.succeed");
    expect(main).not.toContain("effect-openapi-cli-generator");
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(main)).not.toThrow();
  });
  test("reports formatter syntax failures through the typed boundary", async () => {
    const result = await Effect.runPromise(
      Effect.flip(formatApplication({ files: [{ content: "const = ;", path: "src/main.ts" }] })),
    );
    expect(result._tag).toBe("GenerationError");
    expect(result.code).toBe("format");
  });
});

test("hostile wire strings remain literals and both generated modules parse", async () => {
  const hostile = `quote" slash\\ newline\n backtick\` \${globalThis.injected = true} */\n@tag`;
  const fixture = structuredClone(document);
  fixture.info.title = hostile;
  fixture.paths["/items/{id}"].post.requestBody.content["application/json"].schema.properties =
    structuredClone({
      [hostile]: {
        deprecated: true,
        description: hostile,
        enum: [hostile],
        externalDocs: {
          description: hostile,
          url: "https://example.test/",
        },
        type: "string",
      },
      constructor: { type: "string" },
      prototype: { type: "string" },
    });
  const output = await Effect.runPromise(generate(fixture, { name: "safe-api" }));
  const main = output.files.find((file) => file.path === "src/main.ts")?.content ?? "";
  expect(main).toContain("@deprecated");
  expect(main).toContain("@see");
  expect(main).toContain("\\@tag");
  for (const file of output.files.filter((entry) => entry.path.endsWith(".ts"))) {
    const transformed = new Bun.Transpiler({ loader: "ts" }).transformSync(file.content);
    expect(transformed).not.toMatch(/^globalThis\.injected/mu);
  }
  expect(main).toContain("Schema.Literals([");
});

test("formatter rejections become typed generation failures", async () => {
  const failure = spyOn(oxfmt, "format").mockRejectedValueOnce(new Error("formatter unavailable"));
  try {
    const result = await Effect.runPromise(
      Effect.flip(formatApplication({ files: [{ content: "const value = 1;", path: "file.ts" }] })),
    );
    expect(result.code).toBe("format");
    expect(result.message).toContain("formatter unavailable");
  } finally {
    failure.mockRestore();
  }
});

// Regression contract: generated enum validators accept exactly the declared
// scalar values, including null, under each supported OpenAPI version. Exercise
// the emitted schema with real Effect; full program compilation belongs to U6.
for (const openapi of ["3.0.3", "3.1.0"]) {
  for (const values of [["yes", null], [null], ["yes"]]) {
    test(`${openapi} emits an exact nullable enum ${JSON.stringify(values)}`, async () => {
      const fixture = structuredClone(document);
      fixture.openapi = openapi;
      Object.assign(fixture.paths["/items/{id}"].post.requestBody.content["application/json"], {
        schema: {
          ...(openapi.startsWith("3.0")
            ? { nullable: true, type: "string" }
            : { type: ["string", "null"] }),
          enum: values,
        },
      });
      const output = await Effect.runPromise(generate(fixture));
      const main = output.files.find((file) => file.path === "src/main.ts")?.content ?? "";
      const expression = /const schema0 = (?<schema>[\s\S]*?);/u.exec(main)?.groups?.schema;
      expect(expression).toBeDefined();
      expect(expression).not.toMatch(/Schema\.Literals\([^)]*null/u);
      if (values.length === 1 && values.includes(null)) {
        expect(expression).toBe("Schema.Null");
      } else {
        expect(expression).toContain('Schema.Literals(["yes"])');
        expect(expression?.includes("Schema.NullOr")).toBe(values.includes(null));
      }
    });
  }
}

test("base URL native flag adapts domain errors to InvalidValue", async () => {
  const output = await Effect.runPromise(generate(document));
  const main = output.files.find((file) => file.path === "src/main.ts")?.content ?? "";
  expect(main).toContain("new CliError.InvalidValue(");
  expect(main).toContain('option: "base-url"');
  expect(main).toContain('kind: "flag"');
  expect(main).toContain("value: cause.value");
});

test("emitted runtime decodes JSON and preserves the validated original", async () => {
  const output = await Effect.runPromise(generate(document));
  const runtime = output.files.find((file) => file.path === "src/runtime.ts")?.content ?? "";
  expect(runtime).toContain("Schema.fromJsonString(Schema.Json)");
  expect(runtime).toContain("return Option.some(value)");
  expect(runtime).not.toContain("JSON.parse");
  const main = output.files.find((file) => file.path === "src/main.ts")?.content ?? "";
  expect(main).toContain("Schema.Record(Schema.String, Schema.Json)");
  expect(main).toContain('body: Flag.String("body")');
});

test("string query values stay direct and optional branches parse", async () => {
  const fixture = structuredClone(document);
  fixture.paths["/items/{id}"].post.parameters.push({
    description: "Query",
    in: "query",
    name: "search",
    required: false,
    schema: { type: "string" },
  });
  const output = await Effect.runPromise(generate(fixture));
  const main = output.files.find((file) => file.path === "src/main.ts")?.content ?? "";
  expect(main).toContain('query.append("search", input.value1.value)');
  expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(main)).not.toThrow();
});
