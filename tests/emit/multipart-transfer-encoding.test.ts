import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema, Stream } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { emitApi } from "../../src/emit/api.ts";
import { emitCli } from "../../src/emit/cli.ts";
import { emitDomainSchemas } from "../../src/emit/domain.ts";
import { emitPackageFiles } from "../../src/emit/package.ts";
import type { EmittedFile } from "../../src/emit/package.ts";
import { runtimeFiles } from "../../src/emit/runtime-files.generated.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Server } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { normalizeSchemas } from "../../src/normalize/schemas.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { resolve } from "../../src/resolve/index.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

// A multipart part's base64 transfer encoding is the model's `EncodingRule.contentEncoding`, set
// by normalize from 3.0 `format: byte` or 3.1+ `contentEncoding: base64` (design 6.3 Multipart
// transfer encoding). The `api/` builder passes it on the part entry, the runtime writer encodes
// the part and writes the one `Content-Transfer-Encoding` header, and the part flag takes a file.

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

type Line = "3.0" | "3.1";

const base64Part = (line: Line): Schema.Json =>
  line === "3.0"
    ? { format: "byte", type: "string" }
    : { contentEncoding: "base64", type: "string" };

// One `POST /uploads` operation with a required multipart body: `doc`, then `title`.
const specOf = (line: Line, doc: Schema.Json, encoding?: Schema.Json): Schema.Json => {
  const schema = {
    properties: { doc, title: { type: "string" } },
    required: ["doc"],
    type: "object",
  };
  const media = encoding === undefined ? { schema } : { encoding, schema };

  return {
    ...golden,
    openapi: line === "3.0" ? "3.0.4" : "3.1.0",
    paths: {
      "/uploads": {
        post: {
          operationId: "uploads-create",
          requestBody: { content: { "multipart/form-data": media }, required: true },
          responses: { "200": { description: "ok" } },
          tags: ["uploads"],
        },
      },
    },
  };
};

const generate = (line: Line, value: Schema.Json) =>
  Effect.gen(function* generated() {
    const resolution = yield* resolve({ document, line, value });
    const { api } = yield* normalize(resolution, { config, configDocument });
    const schemas = yield* normalizeSchemas(resolution);
    const plan = yield* planNames(api, { config, configDocument, strict: false });
    const context = { config, configDocument, document, openapi: api.openapi };
    const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;
    // The request body roots, as `generate` passes them, so the body schema is exported.
    const roots = api.operations.flatMap((operation) =>
      (operation.body?.alternatives ?? []).flatMap((alternative) =>
        alternative.schema === undefined ? [] : [alternative.schema.key],
      ),
    );
    const domain = yield* emitDomainSchemas(schemas.validation.definitions, roots, plan.domain);
    const apiFiles = yield* emitApi({ api, boundOrigins: bound, plan });
    const cli = yield* emitCli({ api, config, plan });

    return { apiFiles, cli, domain };
  });

const contentOf = (files: readonly EmittedFile[], path: string): string =>
  files.find((file) => file.path === path)?.content ?? "";

const uploads = async (line: Line, value: Schema.Json) => {
  const { apiFiles, cli, domain } = await Effect.runPromise(generate(line, value));

  return {
    api: contentOf(apiFiles, "src/api/uploads.ts"),
    apiFiles,
    cli: contentOf(cli.files, "src/cli/uploads.ts"),
    cliFiles: cli.files,
    domain,
    refusals: cli.refusals.map((refusal) => ({
      reason: refusal.reason,
      subject: refusal.subject,
    })),
  };
};

const decodeEntry = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Tuple([Schema.String, Schema.String]),
    Schema.Tuple([Schema.String, Schema.String, Schema.Literal("base64")]),
  ]),
);

// The `doc` part entry of the emitted `Serialize.formData` call, read back as data.
const docEntry = (api: string): Serialize.FormPartEntry => {
  const line = api.split("\n").find((text) => text.trimStart().startsWith('["doc",')) ?? "";

  return decodeEntry(JSON.parse(line.trim().replace(/,$/u, "")));
};

const fileFlag = 'Effect.map(Multipart.fileBody("doc", source), (bytes) => ({';

describe("emitApi and emitCli: a multipart part's base64 transfer encoding", () => {
  for (const line of ["3.0", "3.1"] as const) {
    test(`a ${line} base64 part emits contentEncoding base64 and takes a file`, async () => {
      const emitted = await uploads(line, specOf(line, base64Part(line)));

      expect(emitted.refusals).toEqual([]);
      expect(docEntry(emitted.api)).toEqual(["doc", "application/octet-stream", "base64"]);
      expect(emitted.api).toContain('["title", "text/plain"],');
      expect(emitted.cli).toContain(fileFlag);
      expect(emitted.cli).toContain("the base64 encoding is applied for you.");
    });
  }

  test("a part with no transfer encoding emits a two-element entry and a text flag", async () => {
    const emitted = await uploads("3.1", specOf("3.1", { type: "string" }));

    expect(emitted.refusals).toEqual([]);
    expect(docEntry(emitted.api)).toEqual(["doc", "text/plain"]);
    expect(emitted.cli).toContain("doc: Effect.succeed(Option.toArray(flags.doc)),");
    expect(emitted.cli).not.toContain("encoding is applied for you");
  });

  test("a declared Content-Transfer-Encoding header is sent once, by the runtime", async () => {
    const encoding = {
      doc: { headers: { "Content-Transfer-Encoding": { schema: { type: "string" } } } },
    };
    const emitted = await uploads("3.1", specOf("3.1", base64Part("3.1"), encoding));

    const entry = docEntry(emitted.api);

    expect(emitted.refusals).toEqual([]);
    expect(entry).toEqual(["doc", "application/octet-stream", "base64"]);
    for (const file of [...emitted.apiFiles, ...emitted.cliFiles]) {
      expect(file.content).not.toContain("Content-Transfer-Encoding");
    }

    const body = await Effect.runPromise(
      Serialize.formData(
        { doc: [{ filename: "doc.bin", stream: Stream.make(Uint8Array.from([1, 2, 3])) }] },
        { parts: [entry, ["title", "text/plain"]], required: true },
      ).expand,
    );
    if (body._tag !== "Stream") {
      throw new Error(`expected a stream body, got ${body._tag}`);
    }

    const chunks = await Effect.runPromise(Stream.runCollect(body.stream));
    const decoder = new TextDecoder();
    const lines = chunks
      .map((chunk) => decoder.decode(chunk, { stream: true }))
      .join("")
      .split("\r\n");

    expect(lines.filter((text) => /^content-transfer-encoding:/iu.test(text))).toEqual([
      "Content-Transfer-Encoding: base64",
    ]);
    expect(lines).toContain("AQID");
  });

  test("a base64url part stays refused: normalize drops the operation", async () => {
    const emitted = await uploads(
      "3.1",
      specOf("3.1", { contentEncoding: "base64url", type: "string" }),
    );

    expect(emitted.api).toBe("");
    expect(emitted.cli).toBe("");
  });
});

// The emitted domain, api and cli modules and the runtime, written under the worktree's
// git-ignored `work/` and type-checked together: the part entry matches the runtime part type.
const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "multipart-transfer-encoding-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

const generator = {
  packageJson: decodeJson(generatorPackage),
  tsconfig: decodeJson(generatorTsconfig),
};

describe("emitApi: the emitted base64 part entry against the runtime", () => {
  test("the emitted modules type-check", async () => {
    const emitted = await uploads("3.1", specOf("3.1", base64Part("3.1")));
    const scaffold = await Effect.runPromise(emitPackageFiles(config, generator));
    const files: readonly EmittedFile[] = [
      emitted.domain,
      ...emitted.apiFiles,
      ...emitted.cliFiles.filter((file) => file.path !== "src/cli/root.ts"),
      ...Object.entries(runtimeFiles).map(([key, content]) => ({ content, path: `src/${key}` })),
      { content: contentOf(scaffold, "tsconfig.json"), path: "tsconfig.json" },
    ];
    for (const file of files) {
      const target = nodePath.join(work, ...file.path.split("/"));
      nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true });
      nodeFs.writeFileSync(target, file.content);
    }

    nodeFs.symlinkSync(nodePath.join(root, "node_modules"), nodePath.join(work, "node_modules"));

    const tsc = nodePath.join(root, "node_modules/.bin/tsc");
    const result = Bun.spawnSync([tsc, "--noEmit", "-p", nodePath.join(work, "tsconfig.json")], {
      cwd: work,
    });

    expect(emitted.refusals).toEqual([]);
    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
