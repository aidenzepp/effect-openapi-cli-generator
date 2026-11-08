import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, Layer, Order, Schema } from "effect";
import { emitCli } from "../../src/emit/cli.ts";
import { emitEntryFiles } from "../../src/emit/entry.ts";
import type { EmittedFile } from "../../src/emit/package.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import { generateFixture } from "../support/generated-cli.ts";
import { setEnv } from "../support/env.ts";

// Design 4.1 Lazy root: `cli/root.ts` holds a header table of the top-level groups, each loaded by a
// literal `import()`, and `main.ts` builds the root from the `Stdio` arguments. In process, on the
// lazy-root fixture: two top-level tag groups, a 3.2 child group, an untagged operation and an
// author command.

const fixture = nodePath.resolve(import.meta.dir, "../fixtures/lazy-root");

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

const readJson = (name: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(JsonRecord))(
    nodeFs.readFileSync(nodePath.join(fixture, name), "utf-8"),
  );

const document = Schema.decodeUnknownSync(DocumentUri)("file:///fixture/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///fixture/author-config.json");

const emitted = Effect.gen(function* emit() {
  const config = yield* decodeAuthorConfig(readJson("author-config.json"), {
    document: configDocument,
  });
  const resolution = yield* resolve({ document, line: "3.2", value: readJson("openapi.json") });
  const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument });
  const plan = yield* planNames(api, { config, configDocument, strict: false });
  const cli = yield* emitCli({ api, config, plan, validationEdits: [] });
  const entry = yield* emitEntryFiles(config);

  return { files: [...cli.files, ...entry], plan };
});

const { files, plan } = await Effect.runPromise(emitted);

const contentOf = (path: string): string => {
  const file = files.find((candidate: EmittedFile) => candidate.path === path);
  expect(file).toBeDefined();

  return file?.content ?? "";
};

const rootModule = contentOf("src/cli/root.ts");

const topLevel = plan.groups.filter((group) => group.parent === undefined);

const children = plan.groups.filter((group) => group.parent !== undefined);

const specifiers = (text: string, pattern: RegExp): readonly string[] =>
  [...text.matchAll(pattern)].map((match) => match.groups?.from ?? "");

const staticImports = specifiers(rootModule, /^import .* from "(?<from>[^"]+)";$/gmu);

describe("lazy root: cli/root.ts", () => {
  test("the fixture has two top-level groups and one child group", () => {
    expect(topLevel.map((group) => String(group.segment))).toEqual(["pets", "stores"]);
    expect(children.map((group) => [String(group.segment), group.parent])).toEqual([
      ["toys", "pets"],
    ]);
  });

  test("holds one literal import() per top-level group, in plan order", () => {
    expect(specifiers(rootModule, /import\("(?<from>[^"]+)"\)/gu)).toEqual(
      topLevel.map((group) => `./${group.segment}.ts`),
    );
  });

  test("statically imports no cli group, no api group and no domain module", () => {
    expect(staticImports.filter((from) => from.startsWith("./"))).toEqual([]);

    const api = staticImports.filter((from) => from.startsWith("../api/"));
    expect(Arr.sort(api, Order.String)).toEqual([
      "../api/root.ts",
      "../api/security.ts",
      "../api/servers.ts",
    ]);
    expect(staticImports.filter((from) => from.includes("domain/"))).toEqual([]);
    expect(staticImports).toContain("../runtime/groups.ts");
  });

  test("has no top-level await and never reads process.argv", () => {
    for (const path of ["src/cli/root.ts", "src/main.ts", "src/bin.ts"]) {
      expect(contentOf(path)).not.toContain("await");
      expect(contentOf(path)).not.toContain("process.argv");
    }
  });

  test("each entry's header equals the fields its group module's Command.make sets", () => {
    for (const group of topLevel) {
      expect(contentOf(`src/cli/${group.segment}.ts`)).toContain(
        `export const group = Command.make(${JSON.stringify(group.name)}).pipe(`,
      );
      expect(rootModule).toContain(
        `{ load: () => import("./${group.segment}.ts"), name: ${JSON.stringify(group.name)} }`,
      );
    }
  });

  test("a child group is absent from the table and stays a static import of its parent", () => {
    for (const child of children) {
      expect(rootModule).not.toContain(`./${child.segment}.ts`);

      const parent = topLevel.find((group) => group.tag === child.parent);
      expect(contentOf(`src/cli/${parent?.segment ?? ""}.ts`)).toContain(
        `import * as ${child.namespace}Cli from "./${child.segment}.ts";`,
      );
    }
  });

  test("builds the root through Groups.root, untagged and author commands after the groups", () => {
    expect(rootModule).toContain("export const root = (args: readonly string[]) =>");
    expect(rootModule).toContain("Groups.root(");
    expect(rootModule).toContain("Command.withSubcommands(Arr.appendAll(groups, [health, login]))");
    expect(rootModule).toContain('import { login } from "../../custom/commands.ts";');
    expect(rootModule).toContain("export const services = Layer.mergeAll(");
  });
});

describe("lazy root: main.ts", () => {
  test("reads the Stdio arguments, builds the root, then runs and formats over that root", () => {
    const main = contentOf("src/main.ts");
    expect(main).toContain('import { root, services } from "./cli/root.ts";');
    expect(main).toContain("Stdio.Stdio.use((stdio) => stdio.args).pipe(");
    expect(main).toContain("Effect.flatMap(root),");
    expect(main).toContain("Command.run(command, {");
    expect(main).toContain("CliOutput.layer(Output.formatter(command))");
    expect(main).not.toContain("Groups.root");
  });
});

// Tags whose Pascal fold is a `cli/root.ts` binding (`Groups`, `Arr`) or a namespace every cli
// module imports (`Command`, `Effect`): the plan renames each api namespace, so generation never
// stops on a name clash, and the emitted root type-checks.
describe("lazy root: tags named like the root's bindings", () => {
  const repoRoot = nodePath.resolve(import.meta.dir, "../..");
  const scratch = nodePath.join(repoRoot, "work");
  nodeFs.mkdirSync(scratch, { recursive: true });

  const work = nodeFs.mkdtempSync(nodePath.join(scratch, "lazy-root-clash-"));
  afterAll(() => {
    nodeFs.rmSync(work, { force: true, recursive: true });
  });

  const tags = ["Groups", "Arr", "Command", "Effect"];
  const spec = {
    info: { title: "Clashing tags", version: "1.0.0" },
    openapi: "3.1.0",
    paths: Object.fromEntries(
      tags.map((tag) => [
        `/${tag.toLowerCase()}`,
        {
          get: {
            operationId: `${tag.toLowerCase()}-list`,
            responses: { "200": { description: "The list." } },
            tags: [tag],
          },
        },
      ]),
    ),
    servers: [{ url: "https://api.example.com" }],
    tags: tags.map((name) => ({ name })),
  };
  const config = {
    binName: "clash",
    package: { name: "clash-cli", version: "0.1.0" },
    servers: { accepted: ["https://api.example.com"] },
  };

  test("generates, renames each api namespace, and the root type-checks", async () => {
    const specPath = nodePath.join(work, "openapi.json");
    const configPath = nodePath.join(work, "author-config.json");
    nodeFs.writeFileSync(specPath, JSON.stringify(spec));
    nodeFs.writeFileSync(configPath, JSON.stringify(config));

    // Generate under the work directory, then read and type-check the package inside its scope.
    const restoreTmpdir = setEnv("TMPDIR", work);
    const checked = Effect.gen(function* check() {
      const { dir } = yield* generateFixture({ configPath, specPath });
      const read = (path: string) => nodeFs.readFileSync(nodePath.join(dir, path), "utf-8");

      nodeFs.symlinkSync(
        nodePath.join(repoRoot, "node_modules"),
        nodePath.join(dir, "node_modules"),
      );

      const tsc = Bun.spawnSync(
        [nodePath.join(repoRoot, "node_modules/.bin/tsc"), "--noEmit", "-p", "tsconfig.json"],
        { cwd: dir },
      );

      return {
        groups: tags.map((tag) => read(`src/cli/${tag.toLowerCase()}.ts`)),
        root: read("src/cli/root.ts"),
        tsc: { exitCode: tsc.exitCode, stdout: new TextDecoder().decode(tsc.stdout) },
      };
    });
    const { groups, root, tsc } = await Effect.runPromise(
      Effect.scoped(checked).pipe(
        Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
      ),
    ).finally(() => {
      restoreTmpdir();
    });

    expect(root).toContain('import * as Groups from "../runtime/groups.ts";');
    for (const [index, tag] of tags.entries()) {
      const segment = tag.toLowerCase();
      expect(root).toContain(`import("./${segment}.ts")`);
      expect(groups[index]).toContain(`from "../api/${segment}.ts";`);
      expect(groups[index]).not.toContain(`import * as ${tag} from "../api/${segment}.ts";`);
    }
    expect(tsc.stdout).toBe("");
    expect(tsc.exitCode).toBe(0);
  }, 300_000);
});
