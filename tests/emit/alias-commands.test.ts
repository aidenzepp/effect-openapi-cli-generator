import { describe, expect, test } from "bun:test";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { emitApi } from "../../src/emit/api.ts";
import { emitCli } from "../../src/emit/cli.ts";
import { emitPackageFiles } from "../../src/emit/package.ts";
import type { EmittedFile } from "../../src/emit/package.ts";
import { runtimeFiles } from "../../src/emit/runtime-files.generated.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Server } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { resolve } from "../../src/resolve/index.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const tsc = nodePath.join(root, "node_modules/.bin/tsc");

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const document = Schema.decodeUnknownSync(DocumentUri)("file:///alias/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///alias/author-config.json");

const configJson = decodeJson({
  binName: "alias",
  envPrefix: "ALIAS",
  package: { name: "alias-cli", version: "1.0.0" },
  servers: { accepted: ["https://api.example.com"] },
});

const ok = {
  "200": {
    content: { "application/json": { schema: { type: "object" } } },
    description: "ok",
  },
};

// `getWidget` is planned under `widgets`; its one alias, `items fetch`, lands in a group whose
// own operation is `listItems`.
const spec = decodeJson({
  info: { title: "Aliases", version: "1.0.0" },
  openapi: "3.1.0",
  paths: {
    "/items": {
      get: { operationId: "listItems", responses: ok, tags: ["items"] },
    },
    "/widgets/{id}": {
      get: {
        operationId: "getWidget",
        parameters: [
          { in: "path", name: "id", required: true, schema: { type: "string" } },
          { in: "query", name: "fields", schema: { type: "string" } },
        ],
        responses: ok,
        tags: ["widgets"],
        "x-forge-aliases": [{ "x-forge-group-name": "items", "x-forge-method-name": "fetch" }],
      },
    },
  },
  servers: [{ url: "https://api.example.com" }],
});

const generator = {
  packageJson: decodeJson(generatorPackage),
  tsconfig: decodeJson(generatorTsconfig),
};

const emitted = Effect.gen(function* emit() {
  const config = yield* decodeAuthorConfig(configJson, { document: configDocument });
  const resolution = yield* resolve({ document, line: "3.1", value: spec });
  const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument });
  const plan = yield* planNames(api, { config, configDocument, strict: false });
  const context = { config, configDocument, document, openapi: api.openapi };
  const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;
  const apiFiles = yield* emitApi({ api, boundOrigins: bound, plan });
  const cli = yield* emitCli({ api, config, plan, validationEdits: [] });
  const scaffold = yield* emitPackageFiles(config, generator);

  return { apiFiles, cli, plan, scaffold };
});

const run = () => Effect.runPromise(emitted);

const contentOf = (files: readonly EmittedFile[], path: string): string =>
  files.find((file) => file.path === path)?.content ?? "";

// The exported statements of a module, keyed by their name.
const statementsOf = (content: string): ReadonlyMap<string, string> =>
  new Map(
    content
      .split(/^export const /mu)
      .slice(1)
      .map((block) => [block.slice(0, block.indexOf(" ")), block] as const),
  );

// The object literal annotated as `annotation` in one command statement.
const annotation = (statement: string, name: string): string => {
  const start = statement.indexOf(`Command.annotate(${name},`);
  const end = statement.indexOf("Command.annotate(", start + 1);

  return start === -1 ? "" : statement.slice(start, end === -1 ? undefined : end);
};

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("alias commands", () => {
  test("the plan holds the primary under widgets and the alias under items", async () => {
    const { plan } = await run();
    const commands = plan.groups.flatMap((group) =>
      group.commands.map((command) => ({
        alias: command.alias,
        group: group.name,
        identifier: String(command.identifier),
        name: command.name,
      })),
    );

    expect(commands).toContainEqual({
      alias: undefined,
      group: "widgets",
      identifier: "getWidget",
      name: "get-widget",
    });
    expect(commands).toContainEqual({
      alias: 0,
      group: "items",
      identifier: "fetch",
      name: "fetch",
    });
  });

  test("the builder, Meta, Media, Security and Input are printed once, in the primary module", async () => {
    const { apiFiles } = await run();
    const all = apiFiles.map((file) => file.content).join("\n");
    const widgets = contentOf(apiFiles, "src/api/widgets.ts");
    const items = contentOf(apiFiles, "src/api/items.ts");

    expect(count(all, 'pathTemplate: "/widgets/{id}"')).toBe(1);
    expect(widgets).toContain("export const getWidget = ");
    expect(widgets).toContain("export const getWidgetMeta = ");
    expect(widgets).toContain("const getWidgetMedia");
    expect(widgets).toContain("const getWidgetSecurity");
    expect(widgets).toContain("export interface GetWidgetInput");
    expect(items).toContain("export const listItems = ");
    for (const name of ["fetch", "fetchMeta", "fetchMedia", "fetchSecurity", "FetchInput"]) {
      expect(all).not.toMatch(new RegExp(`(const|interface) ${name}\\b`, "u"));
    }
  });

  test("both commands call the one builder and carry equal bindings and help", async () => {
    const { cli } = await run();
    const primary = statementsOf(contentOf(cli.files, "src/cli/widgets.ts")).get("getWidget") ?? "";
    const alias = statementsOf(contentOf(cli.files, "src/cli/items.ts")).get("fetch") ?? "";

    expect(primary).toMatch(/Command\.make\(\s*"get-widget"/u);
    expect(alias).toMatch(/Command\.make\(\s*"fetch"/u);
    for (const statement of [primary, alias]) {
      expect(statement).toContain("Widgets.getWidget(");
      expect(statement).toContain("Output.send(Widgets.getWidgetMeta");
    }

    expect(annotation(alias, "Describe.Binding")).not.toBe("");
    expect(annotation(alias, "Describe.Binding")).toBe(annotation(primary, "Describe.Binding"));
    expect(annotation(alias, "Output.Help")).toBe(annotation(primary, "Output.Help"));
    expect(cli.refusals).toEqual([]);
  });

  test("the emitted api and cli modules type-check", async () => {
    const { apiFiles, cli, scaffold } = await run();
    const files: readonly EmittedFile[] = [
      ...apiFiles,
      ...cli.files,
      ...Object.entries(runtimeFiles).map(([key, content]) => ({ content, path: `src/${key}` })),
    ];
    const tsconfig = contentOf(scaffold, "tsconfig.json");
    expect(tsconfig).not.toBe("");

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* check() {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "nmx3-" });
          yield* fs.writeFileString(path.join(dir, "tsconfig.json"), tsconfig);
          yield* fs.symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"));
          for (const file of files) {
            const target = path.join(dir, ...file.path.split("/"));
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            yield* fs.writeFileString(target, file.content);
          }

          return Bun.spawnSync([tsc, "--noEmit", "-p", path.join(dir, "tsconfig.json")], {
            cwd: dir,
          });
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
    );

    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
