import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import type { GenerateResult } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Json } from "../../src/model/pointer.ts";

// The fixes of m2-dscfx through generate(), with no package build: a discriminator with no
// composition keyword, or whose explicit mapping leaves a oneOf/anyOf branch unlisted, is refused
// at element scope at the discriminator (DSC-05, D-OQ9); a multipart part typed as XML over an
// object schema is schema-driven XML, refused in normalize so the emitter never builds it as a
// JSON part (XML-01, D-SCH3). An opaque XML body and a JSON object part are unchanged.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// The generated files live under the worktree's git-ignored `work/`, never the system temp
// directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "dsc-fixes-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const config = {
  allowInsecure: true,
  binName: "dscfx",
  envPrefix: "DSCFX",
  package: { name: "dsc-fixes-cli", version: "0.1.0" },
};

const done: Json = { "204": { description: "done" } };

interface Members {
  readonly [key: string]: Json;
}

const kind: Json = { type: "string" };

const pet = (properties: Members): Members => ({
  properties,
  required: ["kind"],
  type: "object",
});

const post = (operationId: string, requestBody: Json): Json => ({
  post: { operationId, requestBody, responses: done },
});

const json = (schema: Json): Json => ({ content: { "application/json": { schema } } });

// A multipart body whose `doc` part is an object under the given contentType.
const multipart = (contentType: string, required: boolean): Json => ({
  content: {
    "multipart/form-data": {
      encoding: { doc: { contentType } },
      schema: {
        properties: {
          doc: {
            properties: { id: { type: "integer", xml: { attribute: true } } },
            type: "object",
          },
          name: { type: "string" },
        },
        type: "object",
      },
    },
  },
  required,
});

const spec: Json = {
  components: {
    schemas: {
      Base: {
        discriminator: { mapping: { cat: "Cat" }, propertyName: "kind" },
        ...pet({ kind }),
      },
      Cat: pet({ kind, meow: { type: "boolean" } }),
      Child: { allOf: [{ $ref: "#/components/schemas/Base" }, { type: "object" }] },
      Dog: pet({ bark: { type: "boolean" }, kind }),
      Lone: { discriminator: { propertyName: "kind" }, ...pet({ kind }) },
    },
  },
  info: { title: "dsc fixes", version: "1.0.0" },
  openapi: "3.1.2",
  paths: {
    "/inherited": post("inherited-create", json({ $ref: "#/components/schemas/Child" })),
    "/json-part": post("json-part-create", multipart("application/json", false)),
    "/lone": post("lone-create", json({ $ref: "#/components/schemas/Lone" })),
    "/partial": post(
      "partial-create",
      json({
        discriminator: { mapping: { cat: "Cat" }, propertyName: "kind" },
        oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
      }),
    ),
    "/xml-body": post("xml-body-create", {
      content: { "application/xml": { schema: { properties: { id: { type: "integer" } } } } },
      required: true,
    }),
    "/xml-optional": post("xml-optional-create", multipart("application/xml", false)),
    "/xml-required": post("xml-required-create", multipart("text/xml", true)),
  },
};

const document = Schema.decodeUnknownSync(DocumentUri)("file:///dscfx/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///dscfx/author-config.json");

const run = (): Promise<GenerateResult> => {
  const specPath = nodePath.join(work, "openapi.json");
  const configPath = nodePath.join(work, "author-config.json");
  nodeFs.writeFileSync(specPath, `${JSON.stringify(spec)}\n`);
  nodeFs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);

  return Effect.runPromise(
    generate(
      {
        document,
        generator,
        outDir: nodePath.join(work, "out"),
        source: { _tag: "File", path: specPath },
        strict: false,
      },
      { document: configDocument, path: configPath },
    ).pipe(Effect.provide(layer)),
  );
};

const generated = await run();

const diagnosticsOf = (code: string) =>
  generated.diagnostics.filter((diagnostic) => diagnostic.code === code);

const pointersOf = (code: string): readonly string[] =>
  diagnosticsOf(code).map((diagnostic) => String(diagnostic.pointer));

// The emitted command declaration of each operation that has one, read from the output directory.
const commandOf = (operation: string): readonly string[] =>
  generated.files
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) =>
      nodeFs.readFileSync(nodePath.join(work, "out", file), "utf-8").split("\nexport const "),
    )
    .filter((declaration) =>
      new RegExp(`Command\\.make\\(\\s*"${operation}"`, "u").test(declaration),
    );

const media = (path: string, type: string): string =>
  `/paths/~1${path}/post/requestBody/content/${type.replace("/", "~1")}`;

describe("DSC-05 refusals through generate()", () => {
  test("a discriminator with no composition keyword is refused at the discriminator", () => {
    expect(diagnosticsOf("DSC-05/no-composition").map((diagnostic) => diagnostic.scope)).toEqual([
      "element",
    ]);
    expect(pointersOf("DSC-05/no-composition")).toEqual(["/components/schemas/Lone/discriminator"]);
  });

  test("an explicit mapping that leaves a oneOf branch unlisted is refused at the discriminator", () => {
    expect(diagnosticsOf("DSC-05/unlisted-branch").map((diagnostic) => diagnostic.scope)).toEqual([
      "element",
    ]);
    expect(pointersOf("DSC-05/unlisted-branch")).toEqual([
      `${media("partial", "application/json")}/schema/discriminator`,
    ]);
  });

  test("the allOf base schema is not refused, and every DSC-05 operation still generates", () => {
    expect([
      ...pointersOf("DSC-05/no-composition"),
      ...pointersOf("DSC-05/unlisted-branch"),
    ]).not.toContain("/components/schemas/Base/discriminator");
    expect(
      ["inherited-create", "lone-create", "partial-create"].map(
        (operation) => commandOf(operation).length,
      ),
    ).toEqual([1, 1, 1]);
  });
});

// The XML-01 refusal of the multipart `doc` part of one path.
const xmlPart = (path: string, type: string) => ({
  pointer: media(path, type),
  related: [`${media(path, type)}/encoding/doc/contentType`],
  scope: "element" as const,
});

describe("XML-01 schema-driven XML parts through generate()", () => {
  test("an optional and a required XML part are refused at element scope, naming the part", () => {
    expect(
      diagnosticsOf("XML-01/schema-driven").map((diagnostic) => ({
        pointer: String(diagnostic.pointer),
        related: diagnostic.related?.map((key) => String(key.pointer)),
        scope: diagnostic.scope,
      })),
    ).toEqual([
      xmlPart("xml-optional", "multipart/form-data"),
      xmlPart("xml-required", "multipart/form-data"),
    ]);
  });

  test("a required XML part refuses its operation, which is not emitted", () => {
    expect(
      diagnosticsOf("OPR-09/required-body-refused").map((diagnostic) => diagnostic.scope),
    ).toEqual(["operation"]);
    expect(pointersOf("OPR-09/required-body-refused")).toEqual(["/paths/~1xml-required/post"]);
    expect(commandOf("xml-required-create")).toEqual([]);
  });

  test("the emitter never builds an XML part as a JSON part; a JSON object part is unchanged", () => {
    const [optional] = commandOf("xml-optional-create");
    const [jsonPart] = commandOf("json-part-create");

    expect(optional).toBeDefined();
    expect(optional).not.toContain("Serialize.jsonPart");
    expect(optional).not.toContain('Input.jsonFlag("doc")');
    expect(jsonPart).toContain("Serialize.jsonPart");
  });

  test("an opaque XML body still generates with no XML-01 diagnostic of its own", () => {
    expect(commandOf("xml-body-create")).toHaveLength(1);
    expect(pointersOf("XML-01/schema-driven")).not.toContain(media("xml-body", "application/xml"));
  });
});
