import { describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import * as oxfmt from "oxfmt";
import { generate } from "../src/index.js";
import { formatApplication } from "../src/format.js";

const document = {
  openapi: "3.1.0",
  info: { title: "Sample API", version: "not-semver", description: "Original help" },
  paths: {
    "/items/{id}": {
      post: {
        operationId: "items-get",
        "x-fern-sdk-group-name": "account.items",
        summary: "Read */ dangerous\n@evil ` ${attack()} ",
        parameters: [
          {
            in: "path",
            name: "id",
            required: true,
            schema: { type: "string" },
            description: "Identifier",
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: JSON.parse(
                  '{"__proto__":{"type":"string","description":"Prototype field"}}',
                ),
              },
            },
          },
        },
        responses: { "200": { description: "OK" } },
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
    const pkg = JSON.parse(output.files[2]!.content);
    expect(pkg.name).toBe("sample-api");
    expect(pkg.version).toBe("0.0.0");
    expect(Object.keys(pkg.dependencies)).toEqual(["@effect/platform-node", "effect"]);
    for (const file of output.files) expect(file.content.endsWith("\n")).toBe(true);
  });
  test("emits native commands and literal-safe meaningful documentation", async () => {
    const output = await Effect.runPromise(generate(document, { name: "custom-api" }));
    const main = output.files[0]!.content;
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
      Effect.flip(formatApplication({ files: [{ path: "src/main.ts", content: "const = ;" }] })),
    );
    expect(result._tag).toBe("GenerationError");
    expect(result.code).toBe("format");
  });
});

test("hostile wire strings remain literals and both generated modules parse", async () => {
  const hostile = 'quote" slash\\ newline\n backtick` ${globalThis.injected = true} */\n@tag';
  const fixture = structuredClone(document);
  fixture.info.title = hostile;
  fixture.paths["/items/{id}"].post.requestBody.content["application/json"].schema.properties =
    JSON.parse(
      JSON.stringify({
        [hostile]: {
          type: "string",
          enum: [hostile],
          description: hostile,
          deprecated: true,
          externalDocs: { url: "https://example.test/", description: hostile },
        },
        constructor: { type: "string" },
        prototype: { type: "string" },
      }),
    );
  const output = await Effect.runPromise(generate(fixture, { name: "safe-api" }));
  const main = output.files[0]!.content;
  expect(main).toContain("@deprecated");
  expect(main).toContain("@see");
  expect(main).toContain("\\@tag");
  for (const file of output.files.filter((entry) => entry.path.endsWith(".ts"))) {
    const transformed = new Bun.Transpiler({ loader: "ts" }).transformSync(file.content);
    expect(transformed).not.toMatch(/^globalThis\.injected/m);
  }
  expect(main).toContain("Schema.Literals([");
});

test("formatter rejections become typed generation failures", async () => {
  const failure = spyOn(oxfmt, "format").mockRejectedValueOnce(new Error("formatter unavailable"));
  try {
    const result = await Effect.runPromise(
      Effect.flip(formatApplication({ files: [{ path: "file.ts", content: "const value = 1;" }] })),
    );
    expect(result.code).toBe("format");
    expect(result.message).toContain("formatter unavailable");
  } finally {
    failure.mockRestore();
  }
});
