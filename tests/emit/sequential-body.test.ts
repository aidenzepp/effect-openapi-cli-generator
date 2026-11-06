import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { emitApi } from "../../src/emit/api.ts";
import { emitCli } from "../../src/emit/cli.ts";
import type { CliEmitOutput } from "../../src/emit/cli.ts";
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

// A sequential (NDJSON, JSON-seq) or text request body is the operator's bytes as given: `--body`
// text or a `--body-file` stream through `Input.sequentialBody`, never parsed or asserted (design
// 6.3 Sequential uploads). The api builder's `Serialize.body` sets the declared media type as
// `Content-Type`. An SSE body, and a sequential or text alternative beside other media, stay
// refused.

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

const ok = { "200": { description: "ok" } };

const item: Schema.Json = { properties: { id: { type: "string" } }, type: "object" };

// One `POST /events` operation whose request body offers `content`.
const specOf = (content: Readonly<Record<string, Schema.Json>>, required = true): Schema.Json => ({
  ...golden,
  paths: {
    "/events": {
      post: {
        operationId: "events-upload",
        requestBody: { content, required },
        responses: ok,
        tags: ["events"],
      },
    },
  },
});

// The spec planned and emitted through every layer the cli module imports.
const generate = (value: Schema.Json) =>
  Effect.gen(function* generated() {
    const resolution = yield* resolve({ document, line: "3.1", value });
    const { api } = yield* normalize(resolution, { config, configDocument });
    const schemas = yield* normalizeSchemas(resolution);
    const plan = yield* planNames(api, { config, configDocument, strict: false });
    const context = { config, configDocument, document, openapi: api.openapi };
    const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;
    const domain = yield* emitDomainSchemas(schemas.validation.definitions, [], plan.domain);
    const apiFiles = yield* emitApi({ api, boundOrigins: bound, plan });
    const cli = yield* emitCli({ api, config, plan });

    return { apiFiles, cli, domain };
  });

const run = (value: Schema.Json) => Effect.runPromise(generate(value));

const contentOf = (files: readonly EmittedFile[], path: string): string =>
  files.find((file) => file.path === path)?.content ?? "";

const refusalsOf = (cli: CliEmitOutput) =>
  cli.refusals.map((refusal) => ({ reason: refusal.reason, subject: refusal.subject }));

const events = async (content: Readonly<Record<string, Schema.Json>>, required?: boolean) => {
  const { cli } = await run(specOf(content, required));

  return { cli, text: contentOf(cli.files, "src/cli/events.ts") };
};

const sequentialCall = (required: boolean) =>
  `Input.sequentialBody({ body: flags.body, bodyFile: flags.bodyFile, required: ${required} })`;

describe("emitCli: sequential and text request bodies", () => {
  for (const mediaType of ["application/x-ndjson", "application/json-seq"]) {
    test(`a lone ${mediaType} body is sent through Input.sequentialBody`, async () => {
      const { cli, text } = await events({ [mediaType]: { schema: item } });

      expect(refusalsOf(cli)).toEqual([]);
      expect(text).toContain(sequentialCall(true));
      expect(text).toContain("Events.upload({ body: loaded })");
      expect(text).not.toContain("Input.mergeBody(");
      expect(text).not.toContain("Input.binaryBody(");
    });
  }

  test("an optional NDJSON body passes required: false", async () => {
    const { cli, text } = await events({ "application/x-ndjson": { schema: item } }, false);

    expect(refusalsOf(cli)).toEqual([]);
    expect(text).toContain(sequentialCall(false));
  });

  test("a lone text/plain body is sent through Input.sequentialBody", async () => {
    const { cli, text } = await events({ "text/plain": { schema: { type: "string" } } });

    expect(refusalsOf(cli)).toEqual([]);
    expect(text).toContain(sequentialCall(true));
  });

  test("an SSE request body is still refused", async () => {
    const { cli, text } = await events({ "text/event-stream": { schema: { type: "string" } } });

    expect(refusalsOf(cli)).toEqual([
      { reason: "unsupported-body", subject: "sse:text/event-stream" },
    ]);
    expect(text).toBe("");
  });

  test("an NDJSON alternative beside another media type is still refused", async () => {
    const { cli } = await events({
      "application/json": { schema: item },
      "application/x-ndjson": { schema: item },
    });

    expect(refusalsOf(cli)).toEqual([
      { reason: "unsupported-body", subject: "ndjson:application/x-ndjson" },
    ]);
  });

  test("a text alternative beside another media type is still refused", async () => {
    const { cli } = await events({
      "application/json": { schema: item },
      "text/plain": { schema: { type: "string" } },
    });

    expect(refusalsOf(cli)).toEqual([{ reason: "unsupported-body", subject: "text:text/plain" }]);
  });
});

// The emitted domain, api and cli modules and the runtime, written under the worktree's
// git-ignored `work/` and type-checked together: the cli hand-off matches the api `Input` types.
const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "sequential-body-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

const generator = {
  packageJson: decodeJson(generatorPackage),
  tsconfig: decodeJson(generatorTsconfig),
};

describe("emitCli: the emitted cli module against its api module and the runtime", () => {
  test("an NDJSON body: the hand-off type-checks", async () => {
    const { apiFiles, cli, domain } = await run(
      specOf({ "application/x-ndjson": { schema: item } }),
    );
    const scaffold = await Effect.runPromise(emitPackageFiles(config, generator));
    const files: readonly EmittedFile[] = [
      domain,
      ...apiFiles,
      ...cli.files.filter((file) => file.path !== "src/cli/root.ts"),
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

    expect(cli.refusals).toEqual([]);
    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
