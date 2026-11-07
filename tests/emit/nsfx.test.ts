import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Array as Arr, Effect, Schema } from "effect";
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

// Groups whose names fold to one api namespace (the Cloudflare shape: `accounts`,
// `addressing.address-maps.accounts`, the tag `Accounts`) each get their own planned namespace, and
// a cli module that reads two of them imports both without a name clash.

const root = nodePath.resolve(import.meta.dir, "../..");

const tsc = nodePath.join(root, "node_modules/.bin/tsc");

// Scratch lives under the worktree's `work/`, never the system temp directory.
const scratch = nodePath.join(root, "work/nsfx");

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const document = Schema.decodeUnknownSync(DocumentUri)("file:///nsfx/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///nsfx/author-config.json");

const configJson = decodeJson({
  binName: "nsfx",
  envPrefix: "NSFX",
  package: { name: "nsfx-cli", version: "1.0.0" },
  servers: { accepted: ["https://api.example.com"] },
});

const ok = {
  "200": {
    content: { "application/json": { schema: { type: "object" } } },
    description: "ok",
  },
};

// `listAAccounts` is planned under `a.accounts` with an alias in `b.accounts`, so `cli/` for
// `b.accounts` reads its own api namespace and the one of `a.accounts`.
const paths = {
  "/a/accounts": {
    get: {
      operationId: "listAAccounts",
      responses: ok,
      "x-fern-sdk-group-name": "a.accounts",
      "x-fern-sdk-method-name": "list",
      "x-forge-aliases": [{ "x-forge-group-name": "b.accounts", "x-forge-method-name": "list-a" }],
    },
  },
  "/accounts": {
    get: { operationId: "listAccounts", responses: ok, tags: ["Accounts"] },
  },
  "/b/accounts": {
    get: {
      operationId: "listBAccounts",
      responses: ok,
      "x-fern-sdk-group-name": "b.accounts",
      "x-fern-sdk-method-name": "list",
    },
  },
};

const specOf = (value: Readonly<Record<string, Schema.Json>>): Schema.Json =>
  decodeJson({
    info: { title: "Namespaces", version: "1.0.0" },
    openapi: "3.1.0",
    paths: value,
    servers: [{ url: "https://api.example.com" }],
  });

const spec = specOf(paths);

const generator = {
  packageJson: decodeJson(generatorPackage),
  tsconfig: decodeJson(generatorTsconfig),
};

const planned = (value: Schema.Json) =>
  Effect.gen(function* plan() {
    const config = yield* decodeAuthorConfig(configJson, { document: configDocument });
    const resolution = yield* resolve({ document, line: "3.1", value });
    const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument });

    return { api, config, plan: yield* planNames(api, { config, configDocument, strict: false }) };
  });

const emitted = Effect.gen(function* emit() {
  const { api, config, plan } = yield* planned(spec);
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

// Every `import * as <name> from "<from>"` line of a module.
const namespaceImports = (content: string): readonly (readonly [string, string])[] =>
  [...content.matchAll(/^import \* as (?<name>\w+) from "(?<from>[^"]+)";$/gmu)].map(
    ({ groups }) => [groups?.name ?? "", groups?.from ?? ""] as const,
  );

// Each planned group's namespace, keyed by its file segment.
const namespacesOf = async (value: Schema.Json) => {
  const { plan } = await Effect.runPromise(planned(value));

  return Object.fromEntries(
    plan.groups.map((group) => [String(group.segment), String(group.namespace)]),
  );
};

describe("api namespaces of groups that fold to one name", () => {
  test("are planned unique: shallower groups first, then by group path", async () => {
    expect(await namespacesOf(spec)).toEqual({
      a: "A",
      "a-accounts": "Accounts2",
      accounts: "Accounts",
      b: "B",
      "b-accounts": "Accounts3",
    });
  });

  test("do not depend on operation order", async () => {
    const reversed = specOf(Object.fromEntries(Arr.reverse(Object.entries(paths))));

    expect(await namespacesOf(reversed)).toEqual(await namespacesOf(spec));
  });

  test("a cli module reading two of them imports each once, under its planned name", async () => {
    const { cli } = await run();
    const imports = namespaceImports(contentOf(cli.files, "src/cli/b-accounts.ts"));

    expect(imports.filter(([, from]) => from.startsWith("../api/"))).toEqual([
      ["Accounts2", "../api/a-accounts.ts"],
      ["Accounts3", "../api/b-accounts.ts"],
    ]);
    for (const file of cli.files) {
      const names = namespaceImports(file.content).map(([name]) => name);
      expect(new Set(names).size).toBe(names.length);
    }
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

    nodeFs.rmSync(scratch, { force: true, recursive: true });
    nodeFs.mkdirSync(scratch, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(scratch, "tsconfig.json"), tsconfig);
    nodeFs.symlinkSync(nodePath.join(root, "node_modules"), nodePath.join(scratch, "node_modules"));
    for (const file of files) {
      const target = nodePath.join(scratch, ...file.path.split("/"));
      nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true });
      nodeFs.writeFileSync(target, file.content);
    }

    const result = Bun.spawnSync([tsc, "--noEmit", "-p", nodePath.join(scratch, "tsconfig.json")], {
      cwd: scratch,
    });
    nodeFs.rmSync(scratch, { force: true, recursive: true });

    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
