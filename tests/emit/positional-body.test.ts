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

// M3-MP1 (design 6.3, HT:B15): a 3.2 positional multipart/mixed body is one repeatable, ordered
// --part flag, sent by Serialize.mixed under its position rules. --part is foreign to every other
// alternative, and --body and --body-file are foreign to it. Still refused at operation scope:
// other multipart subtypes and positional part headers.

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

// One 3.2 `POST /uploads` operation whose body has the alternatives in `content`.
const specWith = (content: Record<string, Schema.Json>, required = true): Schema.Json => ({
  ...golden,
  openapi: "3.2.0",
  paths: {
    "/uploads": {
      post: {
        operationId: "uploads-create",
        requestBody: { content, required },
        responses: { "200": { description: "ok" } },
        tags: ["uploads"],
      },
    },
  },
});

const contentOf = (files: readonly EmittedFile[], path: string): string =>
  files.find((file) => file.path === path)?.content ?? "";

const uploads = async (value: Schema.Json) => {
  const emitted = await Effect.runPromise(
    Effect.gen(function* generated() {
      const resolution = yield* resolve({ document, line: "3.2", value });
      const { api, diagnostics } = yield* normalize(resolution, {
        checkFindings: [],
        config,
        configDocument,
      });
      const plan = yield* planNames(api, { config, configDocument, strict: false });
      const context = { config, configDocument, document, openapi: api.openapi };
      const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;
      const apiFiles = yield* emitApi({ api, boundOrigins: bound, plan });
      const cli = yield* emitCli({ api, config, plan, validationEdits: [] });

      return { apiFiles, cli, diagnostics: [...diagnostics, ...plan.diagnostics] };
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
    refusals: emitted.cli.refusals.map(({ reason, subject }) => ({ reason, subject })),
  };
};

const positional: Schema.Json = {
  itemEncoding: { contentType: "image/png" },
  prefixEncoding: [{ contentType: "application/json" }],
  schema: {
    items: { contentMediaType: "image/png" },
    maxItems: 4,
    prefixItems: [{ type: "object" }],
    type: "array",
  },
};

describe("M3-MP1: a positional multipart/mixed body", () => {
  test("is one repeatable --part flag of paths, opened in order and sent by Serialize.mixed", async () => {
    const emitted = await uploads(specWith({ "multipart/mixed": positional }));

    expect(emitted.refusals).toEqual([]);
    expect(emitted.cli).toContain('part: Flag.String("part").pipe(');
    expect(emitted.cli).toContain("Flag.atLeast(0)");
    expect(emitted.cli).toContain(
      'Effect.forEach(flags.part, (source) => Multipart.fileBody("part", source))',
    );
    expect(emitted.cli).not.toContain("Input.bodyFileFlag");
    expect(emitted.api).toContain("Serialize.mixed(");
    expect(emitted.api).toContain("body: Serialize.MixedParts");
    expect(emitted.api).toContain('itemEncoding: { contentType: "image/png" }');
    expect(emitted.api).toContain('prefixEncoding: [{ contentType: "application/json" }]');
    expect(emitted.api).toContain("maxParts: 4");
  });

  test("help names each position's content type", async () => {
    const emitted = await uploads(specWith({ "multipart/mixed": positional }));

    expect(emitted.cli).toContain("part 1: application/json; parts 2+: image/png");
  });

  test("beside another alternative --part is foreign to it, and --body and --body-file to the positional key", async () => {
    const emitted = await uploads(
      specWith({
        "application/json": { schema: { properties: { name: { type: "string" } } } },
        "multipart/mixed": positional,
      }),
    );

    expect(emitted.refusals).toEqual([]);
    expect(emitted.cli).toContain(
      '"application/json": { part: Option.isSome(Option.fromIterable(flags.part)) }',
    );
    expect(emitted.cli.replaceAll(/\s+/gu, " ")).toContain(
      '"multipart/mixed": { body: Option.isSome(flags.body), "body-file": Option.isSome(flags.bodyFile), name: Option.isSome(flags.name), }',
    );
    expect(emitted.api).toContain('"multipart/mixed": (body: Serialize.MixedParts) =>');
  });

  test("a body field named part collides with --part and is refused, never shadowed", async () => {
    const emitted = await uploads(
      specWith({
        "application/json": { schema: { properties: { part: { type: "string" } } } },
        "multipart/mixed": positional,
      }),
    );

    expect(emitted.diagnostics).toContainEqual({
      code: "RQB-03/flag-collision",
      scope: "operation",
      severity: "refusal",
    });
  });

  test("positional part headers and another multipart subtype stay refused at operation scope", async () => {
    const headers = await uploads(
      specWith({
        "multipart/mixed": {
          prefixEncoding: [{ headers: { "X-Part": { schema: { type: "string" } } } }],
          schema: { prefixItems: [{ type: "string" }], type: "array" },
        },
      }),
    );
    const related = await uploads(
      specWith({
        "multipart/related": {
          prefixEncoding: [{ contentType: "text/plain" }],
          schema: { prefixItems: [{ type: "string" }], type: "array" },
        },
      }),
    );

    expect(
      [headers.refusals, related.refusals].map((list) => list.map(({ reason }) => reason)),
    ).toEqual([["unsupported-body"], ["unsupported-body"]]);
  });
});
