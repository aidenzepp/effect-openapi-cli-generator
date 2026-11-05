import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, FileSystem, Layer, Order, Path, Schema, pipe } from "effect";
import generatorPackage from "../package.json" with { type: "json" };
import generatorTsconfig from "../tsconfig.json" with { type: "json" };
import { generate } from "../src/generate.ts";
import { DocumentUri } from "../src/model/brands.ts";

const fixture = nodePath.resolve(import.meta.dir, "fixtures/golden/users-update");

const readFixture = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const goldenSpec = readFixture("openapi.json");

const goldenConfig = readFixture("author-config.json");

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

/**
 * Generates the golden spec into `<dir>/out` of a fresh temp directory, then returns every file
 * under it as a sorted list of relative path and bytes (hex, so the comparison is byte for byte).
 */
const generateTree = Effect.gen(function* generateTreeGen() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ts4-" });
  const specPath = path.join(dir, "openapi.json");
  const configPath = path.join(dir, "author-config.json");
  const out = path.join(dir, "out");

  yield* fs.writeFileString(specPath, goldenSpec);
  yield* fs.writeFileString(configPath, goldenConfig);
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

  const relatives = yield* fs.readDirectory(out, { recursive: true });
  const files = yield* pipe(
    relatives,
    Effect.filter((relative) =>
      fs.stat(path.join(out, relative)).pipe(Effect.map((info) => info.type === "File")),
    ),
  );
  const sorted = Arr.sort(files, Order.String);

  return yield* pipe(
    sorted,
    Effect.forEach((relative) =>
      fs.readFile(path.join(out, relative)).pipe(
        Effect.map((bytes) => ({
          bytes: Buffer.from(bytes).toString("hex"),
          relative: relative.split(path.sep).join("/"),
        })),
      ),
    ),
  );
});

const generateTwice = Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* twice() {
      const first = yield* generateTree;
      const second = yield* generateTree;

      return { first, second };
    }),
  ).pipe(Effect.provide(layer)),
);

describe("determinism (I8)", () => {
  test("generates the golden spec twice into fresh directories with identical trees", async () => {
    const { first, second } = await generateTwice;
    const paths = first.map((file) => file.relative);

    expect(paths).toContain("generation-report.json");
    expect(paths.some((relative) => relative.includes("manifest"))).toBe(true);
    expect(second.map((file) => file.relative)).toEqual(paths);
    expect(second).toEqual(first);
  });
});
