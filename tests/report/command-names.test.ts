import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Json } from "../../src/model/pointer.ts";
import { CommandName, GenerationReport } from "../../src/report/index.ts";

const document = Schema.decodeUnknownSync(DocumentUri)("file:///names/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///names/author-config.json");

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(GenerationReport));

const ok = { responses: { "200": { description: "ok" } } };

const baseConfig = {
  binName: "example",
  package: { name: "example-cli", version: "1.0.0" },
};

const spec = (paths: { readonly [path: string]: Json }): Json => ({
  info: { title: "names", version: "1" },
  openapi: "3.1.1",
  paths,
});

// One operation per naming source, plus one with two aliases and one emitCli refuses.
const curated = spec({
  "/fern": {
    get: {
      ...ok,
      operationId: "fernOp",
      "x-fern-sdk-group-name": "billing",
      "x-fern-sdk-method-name": "getInvoice",
    },
  },
  "/forge": {
    get: {
      ...ok,
      operationId: "forgeOp",
      "x-fern-sdk-method-name": "ignored",
      "x-forge-group-name": "accounts.members",
      "x-forge-method-name": "list",
    },
  },
  "/notes": {
    post: {
      ...ok,
      operationId: "notesCreate",
      requestBody: {
        content: { "text/event-stream": { schema: { type: "string" } } },
        required: true,
      },
      tags: ["notes"],
      "x-forge-aliases": [{ "x-forge-group-name": "memo", "x-forge-method-name": "add" }],
    },
  },
  "/routes/{id}": {
    get: {
      ...ok,
      parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
    },
  },
  "/tagged": { get: { ...ok, operationId: "listTagged", tags: ["things"] } },
  "/widgets": { get: { ...ok, operationId: "listWidgets", tags: ["widgets"] } },
  "/zones": {
    patch: {
      ...ok,
      operationId: "editZone",
      "x-forge-aliases": [
        { "x-forge-group-name": "dns", "x-forge-method-name": "edit-zone" },
        { "x-fern-sdk-group-name": "legacy", "x-fern-sdk-method-name": "updateZone" },
      ],
      "x-forge-group-name": "zones",
      "x-forge-method-name": "edit",
    },
  },
});

const curatedConfig = {
  ...baseConfig,
  naming: { operations: { listWidgets: { command: "show-all", group: "inventory" } } },
};

// Tags, operationIds and routes only.
const plain = spec({
  "/health": { get: ok },
  "/pets": { get: { ...ok, operationId: "listPets", tags: ["pets"] } },
  "/pets/{id}": {
    get: {
      ...ok,
      parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
      tags: ["pets"],
    },
  },
  "/version": { get: { ...ok, operationId: "getVersion" } },
});

const added = {
  ...baseConfig,
  security: {
    add: {
      requirement: [{ token: [] }],
      schemes: { token: { scheme: "bearer", type: "http" } },
    },
  },
};

// Runs `generate` in a scoped temp directory and returns the report file's bytes.
const reportText = (value: Json, config: Json): Promise<string> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* prepare() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "nmx4-" });
        const specPath = path.join(dir, "openapi.json");
        const configPath = path.join(dir, "author-config.json");
        const out = path.join(dir, "out");
        yield* fs.writeFileString(specPath, JSON.stringify(value));
        yield* fs.writeFileString(configPath, JSON.stringify(config));
        yield* generate(
          {
            document,
            generator,
            outDir: out,
            source: { _tag: "File", path: specPath },
            strict: false,
          },
          { document: configDocument, path: configPath },
        );

        return yield* fs.readFileString(path.join(out, "generation-report.json"));
      }),
    ).pipe(Effect.provide(layer)),
  );

const pointerOf = (path: string, method: string): string =>
  `/paths/${path.replaceAll("~", "~0").replaceAll("/", "~1")}/${method}`;

const entry = (
  path: readonly string[],
  group: string,
  command: string,
  at: readonly [string, string],
  alias?: number,
) => {
  const fields = { command, document, group, path, pointer: pointerOf(...at) };

  return Schema.decodeUnknownSync(CommandName)(alias === undefined ? fields : { alias, ...fields });
};

describe("generation report commandNames", () => {
  test("lists every emitted command with the source of its group and command name", async () => {
    const report = decodeReport(await reportText(curated, curatedConfig));

    expect(report.commandNames).toEqual([
      entry(["billing", "get-invoice"], "x-fern", "x-fern", ["/fern", "get"]),
      entry(["accounts", "members", "list"], "x-forge", "x-forge", ["/forge", "get"]),
      entry(["things", "list-tagged"], "tag", "operationId", ["/tagged", "get"]),
      entry(["inventory", "show-all"], "config", "config", ["/widgets", "get"]),
      entry(["zones", "edit"], "x-forge", "x-forge", ["/zones", "patch"]),
      entry(["dns", "edit-zone"], "x-forge", "x-forge", ["/zones", "patch"], 0),
      entry(["legacy", "update-zone"], "x-fern", "x-fern", ["/zones", "patch"], 1),
      entry(["get-routes-by-id"], "none", "route", ["/routes/{id}", "get"]),
    ]);
  });

  test("an operation emitCli refuses is reported once and none of its names is listed", async () => {
    const report = decodeReport(await reportText(curated, curatedConfig));
    const refused = report.refusals.filter((diagnostic) => diagnostic.row === "EMT-1");

    expect(refused.map(({ code, pointer }) => `${code} ${pointer}`)).toEqual([
      `EMT-1/unsupported-body ${pointerOf("/notes", "post")}`,
    ]);
    expect(
      report.commandNames.filter((name) => name.pointer === pointerOf("/notes", "post")),
    ).toEqual([]);
  });

  test("a spec without naming extensions lists tag, none, operationId and route sources only", async () => {
    const report = decodeReport(await reportText(plain, baseConfig));
    const sources = new Set(report.commandNames.flatMap((name) => [name.group, name.command]));

    expect(
      [...sources].every((source) => ["none", "operationId", "route", "tag"].includes(source)),
    ).toBe(true);
    expect(report.commandNames.map(({ command, group }) => ({ command, group }))).toEqual([
      { command: "operationId", group: "tag" },
      { command: "route", group: "tag" },
      { command: "route", group: "none" },
      { command: "operationId", group: "none" },
    ]);
    expect(report.commandNames.some((name) => "alias" in name)).toBe(false);
  });

  test("two runs print equal bytes", async () => {
    expect(await reportText(curated, curatedConfig)).toBe(await reportText(curated, curatedConfig));
  });

  test("an author-supplied scheme reaches the written report", async () => {
    const report = decodeReport(await reportText(plain, added));

    expect(report.authorSuppliedSchemes).toEqual([
      { key: "security.add.schemes.token", name: "token" },
    ]);
  });
});
