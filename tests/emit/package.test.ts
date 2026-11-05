import { describe, expect, test } from "bun:test";
import nodePath from "node:path";
import { Effect, Exit, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { emitPackageFiles } from "../../src/emit/package.ts";
import type { GeneratorSource } from "../../src/emit/package.ts";
import { AuthorConfig } from "../../src/model/author-config.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const vp = nodePath.resolve(root, "node_modules/.bin/vp");

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const JsonObject = Schema.Record(Schema.String, Schema.Json);

const StringMap = Schema.Record(Schema.String, Schema.String);

const EmittedPackage = Schema.Struct({
  bin: StringMap,
  dependencies: StringMap,
  devDependencies: StringMap,
  engines: StringMap,
  files: Schema.Array(Schema.String),
  name: Schema.String,
  scripts: StringMap,
  version: Schema.String,
});

const Tsconfig = Schema.Struct({
  compilerOptions: JsonObject,
  extends: Schema.optionalKey(Schema.String),
  include: Schema.Array(Schema.String),
});

const config = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "example-cli",
  package: { name: "example-cli", version: "1.2.3" },
});

const source: GeneratorSource = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const emit = (generator: GeneratorSource = source) =>
  Effect.runSync(emitPackageFiles(config, generator));

const contentOf = (path: string): string => {
  const file = emit().find((candidate) => candidate.path === path);
  expect(file).toBeDefined();

  return file?.content ?? "";
};

const parsePackage = () =>
  Schema.decodeUnknownSync(EmittedPackage)(JSON.parse(contentOf("package.json")));

const parseTsconfig = (path: string) =>
  Schema.decodeUnknownSync(Tsconfig)(JSON.parse(contentOf(path)));

// `vp fmt --stdin-filepath` runs the formatter `vp fmt --check` runs: output equal to input passes.
const formatted = (path: string, text: string) =>
  decoder.decode(
    Bun.spawnSync([vp, "fmt", `--stdin-filepath=${path}`], {
      cwd: root,
      stdin: encoder.encode(text),
    }).stdout,
  );

describe("emitPackageFiles", () => {
  test("emits the three files in path order", () => {
    expect(emit().map((file) => file.path)).toEqual([
      "package.json",
      "tsconfig.build.json",
      "tsconfig.json",
    ]);
  });

  test("pins equal the generator's package.json", () => {
    const emitted = parsePackage();
    expect(emitted.dependencies).toEqual({
      "@effect/platform-bun": generatorPackage.dependencies["@effect/platform-bun"],
      effect: generatorPackage.dependencies.effect,
    });
    expect(emitted.devDependencies).toEqual({
      "@types/bun": generatorPackage.devDependencies["@types/bun"],
      typescript: generatorPackage.devDependencies.typescript,
    });
    expect(emitted.engines).toEqual({ bun: generatorPackage.engines.bun });
  });

  test("name and version come from the config, bin from binName", () => {
    const emitted = parsePackage();
    expect(emitted.name).toBe("example-cli");
    expect(emitted.version).toBe("1.2.3");
    expect(emitted.bin).toEqual({ "example-cli": "dist/bin.js" });
    expect(emitted.files).toEqual(["dist", "README.md"]);
  });

  test("build names tsconfig.build.json and typecheck is tsc --noEmit", () => {
    expect(parsePackage().scripts).toEqual({
      build: "tsc -p tsconfig.build.json",
      typecheck: "tsc --noEmit",
    });
  });

  test("top-level keys follow the printer.md order", () => {
    const order = [
      "name",
      "version",
      "private",
      "description",
      "license",
      "bin",
      "files",
      "type",
      "exports",
      "scripts",
      "dependencies",
      "devDependencies",
      "engines",
      "packageManager",
    ];
    const keys = Object.keys(
      Schema.decodeUnknownSync(JsonObject)(JSON.parse(contentOf("package.json"))),
    );
    expect(keys).toEqual(order.filter((key) => keys.includes(key)));
    expect(keys).toContain("type");
  });

  test("tsconfig.json carries the generator's compiler options", () => {
    const { compilerOptions, include } = parseTsconfig("tsconfig.json");
    const generatorOptions = Schema.decodeUnknownSync(Tsconfig)(generatorTsconfig).compilerOptions;
    expect(include).toEqual(["src"]);
    for (const key of ["strict", "target", "module", "moduleResolution", "lib"]) {
      expect(compilerOptions[key]).toEqual(generatorOptions[key]);
    }
    expect(compilerOptions.types).toEqual(["bun"]);
  });

  test("tsconfig.build.json emits JavaScript and declarations into dist", () => {
    const build = parseTsconfig("tsconfig.build.json");
    expect(build.extends).toBe("./tsconfig.json");
    expect(build.compilerOptions).toMatchObject({
      declaration: true,
      noEmit: false,
      outDir: "dist",
      rootDir: "src",
    });
  });

  test("every emitted JSON file is a vp fmt fixed point", () => {
    for (const file of emit()) {
      expect(formatted(`tests/emit/emitted/${file.path}`, file.content)).toBe(file.content);
    }
  }, 30_000);

  test("output is deterministic", () => {
    expect(emit()).toEqual(emit());
  });

  test("a generator source without the pins fails with a typed error", () => {
    const exit = Effect.runSyncExit(
      emitPackageFiles(config, { ...source, packageJson: { name: "x" } }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("invalid-generator-source");
  });
});
