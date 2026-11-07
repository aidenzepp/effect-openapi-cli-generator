import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, FileSystem, Layer, Order, Path, Schema, pipe } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { emitScaffold } from "../../src/emit/index.ts";
import type { ScaffoldInput } from "../../src/emit/index.ts";
import type { EmittedFile } from "../../src/emit/package.ts";
import { runtimeFiles } from "../../src/emit/runtime-files.generated.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const tsc = nodePath.join(root, "node_modules/.bin/tsc");

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

const decodeRecord = Schema.decodeUnknownSync(JsonRecord);

const read = (relative: string) =>
  decodeRecord(JSON.parse(nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8")));

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const scaffoldInput = Effect.gen(function* prepare() {
  const config = yield* decodeAuthorConfig(read("author-config.json"), {
    document: configDocument,
  });
  const resolution = yield* resolve({ document, line: "3.1", value: read("openapi.json") });
  const { api, diagnostics } = yield* normalize(resolution, {
    checkFindings: [],
    config,
    configDocument,
  });
  const plan = yield* planNames(api, { config, configDocument, strict: false });
  const input: ScaffoldInput = {
    api,
    config,
    diagnostics: [...diagnostics, ...plan.diagnostics],
    generator: {
      packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
      tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
    },
    plan,
  };

  return input;
});

const scaffold = () => Effect.runPromise(scaffoldInput.pipe(Effect.flatMap(emitScaffold)));

const runtimeKeys = Arr.sort(Object.keys(runtimeFiles), Order.String);

const contentOf = (files: readonly EmittedFile[], path: string) =>
  files.find((file) => file.path === path)?.content;

describe("emitScaffold", () => {
  test("is the complete scaffold file list, sorted by path", async () => {
    const files = await scaffold();
    const paths = files.map((file) => file.path);

    expect(paths).toEqual(Arr.sort(paths, Order.String));
    expect(paths).toEqual(
      Arr.sort(
        [
          "README.md",
          "package.json",
          "src/bin.ts",
          "src/main.ts",
          "tsconfig.build.json",
          "tsconfig.json",
          ...runtimeKeys.map((key) => `src/${key}`),
        ],
        Order.String,
      ),
    );
  });

  test("ships domain/errors.ts and runtime/* from the embed, verbatim", async () => {
    const files = await scaffold();

    expect(runtimeKeys).toContain("domain/errors.ts");
    for (const key of runtimeKeys) {
      expect(key === "domain/errors.ts" || /^runtime\/[a-z-]+\.ts$/u.test(key)).toBe(true);
      expect(contentOf(files, `src/${key}`)).toBe(runtimeFiles[key]);
    }
  });

  test("the embed holds every file under src/runtime-src", async () => {
    const onDisk = await Effect.runPromise(
      Effect.gen(function* list() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = path.join(root, "src", "runtime-src");
        const entries = yield* fs.readDirectory(dir, { recursive: true });
        const files = yield* pipe(
          entries,
          Effect.filter((entry) =>
            fs.stat(path.join(dir, entry)).pipe(Effect.map((info) => info.type === "File")),
          ),
        );

        return Arr.sort(
          files.map((file) => file.split(path.sep).join("/")),
          Order.String,
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(runtimeKeys).toEqual(onDisk);
  });

  test("the embedded runtime type-checks under the emitted tsconfig.json", async () => {
    const files = await scaffold();
    const tsconfig = contentOf(files, "tsconfig.json") ?? "";
    expect(tsconfig).not.toBe("");

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* check() {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "em5c-" });
          yield* fs.writeFileString(path.join(dir, "tsconfig.json"), tsconfig);
          yield* fs.symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"));
          for (const key of runtimeKeys) {
            const target = path.join(dir, "src", ...key.split("/"));
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            yield* fs.writeFileString(target, contentOf(files, `src/${key}`) ?? "");
          }

          return Bun.spawnSync([tsc, "--noEmit", "-p", path.join(dir, "tsconfig.json")], {
            cwd: dir,
          });
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
