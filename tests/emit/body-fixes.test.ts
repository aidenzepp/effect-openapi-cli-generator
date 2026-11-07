import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import { emitApi } from "../../src/emit/api.ts";
import { emitCli } from "../../src/emit/cli.ts";
import type { EmittedFile } from "../../src/emit/package.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Server } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { resolve } from "../../src/resolve/index.ts";

// Request body fixes from the body and encoding witnesses (m2-bdfx): a base64 form property takes
// a file (ENC-31, BIN-02, BIN-04), a 3.2 top-level array part takes its item's default type
// (ENC-24), a style-based multipart part is sent as name and raw value or refused alone (ENC-40),
// and a binary body's maxLength bounds the upload (MED-21).

const root = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const read = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

const golden = decodeRecord(JSON.parse(read("openapi.json")));

const configJson = decodeJson(JSON.parse(read("author-config.json")));

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const config = await Effect.runPromise(
  decodeAuthorConfig(configJson, { document: configDocument }),
);

type Line = "3.0" | "3.1" | "3.2";

const versions: Record<Line, string> = { "3.0": "3.0.4", "3.1": "3.1.0", "3.2": "3.2.0" };

// One `POST /uploads` operation whose required body is `media` under `mediaType`.
const specOf = (line: Line, mediaType: string, media: Schema.Json): Schema.Json => ({
  ...golden,
  openapi: versions[line],
  paths: {
    "/uploads": {
      post: {
        operationId: "uploads-create",
        requestBody: { content: { [mediaType]: media }, required: true },
        responses: { "200": { description: "ok" } },
        tags: ["uploads"],
      },
    },
  },
});

const contentOf = (files: readonly EmittedFile[], path: string): string =>
  files.find((file) => file.path === path)?.content ?? "";

const uploads = async (line: Line, value: Schema.Json) => {
  const emitted = await Effect.runPromise(
    Effect.gen(function* generated() {
      const resolution = yield* resolve({ document, line, value });
      const { api, diagnostics } = yield* normalize(resolution, { config, configDocument });
      const plan = yield* planNames(api, { config, configDocument, strict: false });
      const context = { config, configDocument, document, openapi: api.openapi };
      const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;
      const apiFiles = yield* emitApi({ api, boundOrigins: bound, plan });
      const cli = yield* emitCli({ api, config, plan });

      return { apiFiles, cli, diagnostics };
    }),
  );

  return {
    api: contentOf(emitted.apiFiles, "src/api/uploads.ts"),
    cli: contentOf(emitted.cli.files, "src/cli/uploads.ts"),
    diagnostics: emitted.diagnostics.map(({ code, scope, severity }) => ({
      code,
      scope,
      severity,
    })),
    refusals: emitted.cli.refusals.map((refusal) => refusal.reason),
  };
};

const object = (properties: Schema.Json): Schema.Json => ({ properties, type: "object" });

const base64Of = (line: Line): Schema.Json =>
  line === "3.0"
    ? { format: "byte", type: "string" }
    : { contentEncoding: "base64", type: "string" };

describe("ENC-31, BIN-02, BIN-04: a base64 form property takes a file the runtime encodes", () => {
  for (const line of ["3.0", "3.1", "3.2"] as const) {
    test(`a ${line} base64 form property is a file flag read into Input.FileField`, async () => {
      const emitted = await uploads(
        line,
        specOf(line, "application/x-www-form-urlencoded", {
          schema: object({ data: base64Of(line), name: { type: "string" } }),
        }),
      );

      expect(emitted.refusals).toEqual([]);
      expect(emitted.cli).toContain("Input.structuredBody");
      expect(emitted.cli).toContain("new Input.FileField({");
      expect(emitted.cli).toContain('encoding: "base64",');
      expect(emitted.cli).toContain('flag: "data",');
      expect(emitted.cli).toContain("the base64 encoding is applied for you.");
    });
  }
});

describe("ENC-24: a 3.2 top-level array part takes its item type's default contentType", () => {
  test("a 3.2 array of strings is sent per item as text/plain", async () => {
    const emitted = await uploads(
      "3.2",
      specOf("3.2", "multipart/form-data", {
        schema: object({ tags: { items: { type: "string" }, type: "array" } }),
      }),
    );

    expect(emitted.refusals).toEqual([]);
    expect(emitted.api).toContain('parts: [["tags", "text/plain"]],');
  });
});

// The ENC-40 body: `name`, then a `tags` array whose Encoding rule is `encoding`.
const styled = (line: Line, encoding: Schema.Json) =>
  specOf(line, "multipart/form-data", {
    encoding: { tags: encoding },
    schema: object({
      name: { type: "string" },
      tags: { items: { type: "string" }, type: "array" },
    }),
  });

describe("ENC-40: a style-based multipart part", () => {
  for (const line of ["3.1", "3.2"] as const) {
    test(`a ${line} form style with explode sends names and raw values as text/plain parts`, async () => {
      const emitted = await uploads(line, styled(line, { explode: true, style: "form" }));

      expect(emitted.refusals).toEqual([]);
      expect(emitted.api).toContain('["tags", "text/plain"],');
      expect(emitted.cli).toContain('Flag.String("tags")');
      expect(emitted.diagnostics.filter(({ code }) => code.startsWith("ENC-40"))).toEqual([]);
    });

    test(`a ${line} style the writer cannot send refuses the part only`, async () => {
      const emitted = await uploads(line, styled(line, { explode: false, style: "form" }));

      expect(emitted.refusals).toEqual([]);
      expect(emitted.api).toContain('parts: [["name", "text/plain"]],');
      expect(emitted.cli).not.toContain('Flag.String("tags")');
      expect(emitted.diagnostics.filter(({ code }) => code.startsWith("ENC-40"))).toEqual([
        { code: "ENC-40/unsupported-part-style", scope: "element", severity: "refusal" },
      ]);
    });
  }
});

// A 3.1 binary body under `application/octet-stream` with `schema`.
const binary = (schema: Schema.Json) => specOf("3.1", "application/octet-stream", { schema });

describe("MED-21: a binary body's maxLength bounds the upload", () => {
  test("the declared maxLength is the binary body's byte limit", async () => {
    const emitted = await uploads(
      "3.1",
      binary({ contentMediaType: "application/octet-stream", maxLength: 4, type: "string" }),
    );

    expect(emitted.refusals).toEqual([]);
    expect(emitted.cli).toContain("Input.binaryBody");
    expect(emitted.cli).toContain("maxBytes: 4,");
  });

  test("a body without maxLength keeps the runtime's default limit", async () => {
    const emitted = await uploads(
      "3.1",
      binary({ contentMediaType: "application/octet-stream", type: "string" }),
    );

    expect(emitted.cli).toContain("Input.binaryBody");
    expect(emitted.cli).not.toContain("maxBytes");
  });
});
