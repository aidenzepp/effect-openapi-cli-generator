import { describe, expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { emitCli } from "../../src/emit/cli.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { planNames } from "../../src/names/index.ts";
import { flattenBody } from "../../src/names/flatten.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { FieldEncoding } from "../../src/runtime-src/runtime/input.ts";

const document = Schema.decodeUnknownSync(DocumentUri)("file:///b64/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///b64/author-config.json");

const config: Schema.Json = {
  binName: "b64",
  envPrefix: "B64",
  package: { name: "b64-cli", version: "1.0.0" },
  servers: { accepted: ["https://api.example.com"] },
};

interface Case {
  readonly encoding: FieldEncoding;
  readonly name: string;
  readonly schema: Schema.Json;
}

// One base64 property per spec line: 3.0 `format: byte`, 3.1 `contentEncoding: base64`, and 3.2
// `contentEncoding: base64url` with a `contentMediaType` kept as help text.
const cases: readonly Case[] = [
  { encoding: "base64", name: "3.0 format byte", schema: { format: "byte", type: "string" } },
  {
    encoding: "base64",
    name: "3.1 contentEncoding base64",
    schema: { contentEncoding: "base64", type: "string" },
  },
  {
    encoding: "base64url",
    name: "3.2 contentEncoding base64url",
    schema: { contentEncoding: "base64url", contentMediaType: "image/png", type: "string" },
  },
];

// The formatter may break lines; the structure is what the test pins.
const squeezed = (text: string | undefined): string => (text ?? "").replaceAll(/\s+/gu, " ");

const flatten = (properties: Readonly<Record<string, Schema.Json>>) => {
  const result = flattenBody(
    { Root: { properties, type: "object" } },
    { codec: "json", schema: { key: "Root" } },
  );
  if (Result.isFailure(result)) {
    throw new Error(`flattenBody failed with ${result.failure._tag}`);
  }

  return new Map(result.success.flags.map((flag) => [flag.name, flag] as const));
};

const spec = (properties: Readonly<Record<string, Schema.Json>>): Schema.Json => ({
  info: { title: "B64", version: "1.0.0" },
  openapi: "3.1.1",
  paths: {
    "/avatars": {
      post: {
        operationId: "avatars-create",
        requestBody: {
          content: { "application/json": { schema: { properties, type: "object" } } },
          required: true,
        },
        responses: { "204": { description: "Created." } },
        tags: ["avatars"],
      },
    },
  },
});

const emitted = (properties: Readonly<Record<string, Schema.Json>>) =>
  Effect.runPromise(
    Effect.gen(function* generate() {
      const author = yield* decodeAuthorConfig(config, { document: configDocument });
      const resolution = yield* resolve({ document, line: "3.1", value: spec(properties) });
      const { api } = yield* normalize(resolution, { config: author, configDocument });
      const plan = yield* planNames(api, { config: author, configDocument, strict: false });
      const output = yield* emitCli({ api, config: author, plan });
      const flags = plan.groups
        .flatMap((group) => group.commands)
        .flatMap((command) => command.flags);

      return {
        content: output.files.find((file) => file.path === "src/cli/avatars.ts")?.content,
        flags,
        refusals: output.refusals,
      };
    }),
  );

describe("a base64 body property is a file field flag", () => {
  for (const { encoding, name, schema } of cases) {
    test(`${name} plans a file flag`, () => {
      const flags = flatten({ photo: schema, title: { type: "string" } });
      expect(flags.get("photo")?.kind).toBe("file");
      expect(flags.get("photo")?.repeated).toBe(false);
      expect(flags.get("title")?.kind).toBe("string");
      expect(encoding).toBeDefined();
    });

    test(`${name} emits a FileField with encoding ${encoding}`, async () => {
      const { content, flags, refusals } = await emitted({
        photo: schema,
        title: { type: "string" },
      });
      expect(refusals).toEqual([]);
      expect(flags.find((flag) => flag.name === "photo")?.source).toMatchObject({ kind: "file" });
      expect(squeezed(content)).toContain(
        `Option.map( flags.photo, (path) => new Input.FileField({ encoding: "${encoding}", flag: "photo", path: path }), )`,
      );
      expect(content).toContain('Flag.String("photo")');
      expect(content).toContain("File path, or - for stdin");
      expect(content).not.toContain("flags.title, (path)");
    });
  }

  test("the content type is kept as help text", async () => {
    const { content } = await emitted({ photo: cases[2]?.schema ?? {} });
    expect(content).toContain("Content type: image/png.");
  });

  test("an ordinary string property stays a string flag and emits no FileField", async () => {
    const flags = flatten({ title: { type: "string" } });
    expect(flags.get("title")?.kind).toBe("string");

    const { content } = await emitted({ title: { type: "string" } });
    expect(content).not.toContain("FileField");
  });

  test("another contentEncoding, and an array of base64 strings, stay string flags", () => {
    const flags = flatten({
      many: { items: { format: "byte", type: "string" }, type: "array" },
      other: { contentEncoding: "base32", type: "string" },
    });
    expect(flags.get("other")?.kind).toBe("string");
    expect(flags.get("many")).toMatchObject({ kind: "string", repeated: true });
  });
});
