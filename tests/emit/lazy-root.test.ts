import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Array as Arr, Effect, Order, Schema } from "effect";
import { emitCli } from "../../src/emit/cli.ts";
import { emitEntryFiles } from "../../src/emit/entry.ts";
import type { EmittedFile } from "../../src/emit/package.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";

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
  const { api } = yield* normalize(resolution, { config, configDocument });
  const plan = yield* planNames(api, { config, configDocument, strict: false });
  const cli = yield* emitCli({ api, config, plan });
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
