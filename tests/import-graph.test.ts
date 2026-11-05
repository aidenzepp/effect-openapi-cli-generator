import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, FileSystem, Layer, Order, Path, Schema } from "effect";
import generatorPackage from "../package.json" with { type: "json" };
import generatorTsconfig from "../tsconfig.json" with { type: "json" };
import { generate } from "../src/generate.ts";
import { DocumentUri } from "../src/model/brands.ts";

const root = nodePath.resolve(import.meta.dir, "..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const transpiler = new Bun.Transpiler({ loader: "ts" });

// `scanImports` reports value, side-effect, re-export and dynamic imports but omits imports whose
// bindings are all type-only, and typescript@7.0.2 exposes no classic compiler API. This scan
// reads every `import ... from "x"` and `export ... from "x"` statement (type-only ones included)
// without executing a module.
const fromStatement = /\b(?:import|export)\b[^;"']*?\bfrom\s*["'](?<specifier>[^"']+)["']/gu;

/**
 * Every module specifier `source` imports: value, dynamic and type-only, sorted and distinct.
 */
export const importsOf = (text: string): readonly string[] => {
  // A leading shebang (the generated `bin.ts`) is not parseable by `scanImports`.
  const source = text.startsWith("#!") ? text.slice(text.indexOf("\n")) : text;
  const scanned = transpiler.scanImports(source).map((found) => found.path);
  const statements = Array.from(
    source.matchAll(fromStatement),
    (match) => match.groups?.specifier ?? "",
  );

  return Arr.dedupe(Arr.sort([...scanned, ...statements], Order.String));
};

const sourceFiles = (dir: string): readonly string[] =>
  Arr.sort(
    nodeFs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => nodePath.relative(dir, nodePath.join(entry.parentPath, entry.name))),
    Order.String,
  );

describe("importsOf", () => {
  test("reports value, dynamic and type-only imports", () => {
    const text = [
      'import { a } from "value";',
      'import type { B } from "type-only";',
      'import { type C } from "inline-type";',
      'export type { D } from "re-export-type";',
      'import "side-effect";',
      'const e = await import("dynamic");',
    ].join("\n");

    expect(importsOf(text)).toEqual([
      "dynamic",
      "inline-type",
      "re-export-type",
      "side-effect",
      "type-only",
      "value",
    ]);
  });
});

const generatorImports = (stage: string): ReadonlyMap<string, readonly string[]> => {
  const dir = nodePath.join(root, "src", stage);

  return new Map(
    sourceFiles(dir).map((file) => [
      `src/${stage}/${file}`,
      importsOf(nodeFs.readFileSync(nodePath.join(dir, file), "utf-8")),
    ]),
  );
};

/**
 * The `src/` stage directory a relative import of `file` lands in, or undefined for a package
 * import.
 */
const stageOf = (file: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const target = nodePath.relative(
    nodePath.join(root, "src"),
    nodePath.resolve(root, nodePath.dirname(file), specifier),
  );

  return target.split(nodePath.sep)[0];
};

describe("generator import graph (design 4.7)", () => {
  const downstream = ["names", "emit", "write", "report"] as const;
  const upstream = ["load", "validate", "resolve"] as const;

  // Two imports of the resolver's pure RFC 6901 helper (`formatPointer`, the `Json` type) predate
  // this rule. They are listed so the rule is enforced everywhere else, and a stale entry fails.
  // Follow-up: move `pointer.ts` out of `resolve/` and empty this list.
  const known = [
    "src/emit/domain.ts -> ../resolve/pointer.ts",
    "src/names/flatten.ts -> ../resolve/pointer.ts",
  ];

  const edges = (stage: string): readonly string[] =>
    [...generatorImports(stage)].flatMap(([file, specifiers]) =>
      specifiers
        .filter((specifier) => upstream.some((banned) => stageOf(file, specifier) === banned))
        .map((specifier) => `${file} -> ${specifier}`),
    );

  for (const stage of downstream) {
    test(`src/${stage}/ never imports ${upstream.join(", ")}`, () => {
      expect(generatorImports(stage).size).toBeGreaterThan(0);
      expect(edges(stage).filter((edge) => !known.includes(edge))).toEqual([]);
    });
  }

  test("the known exceptions are still present", () => {
    expect(Arr.sort(downstream.flatMap(edges), Order.String)).toEqual(known);
  });
});

const goldenSpec = nodeFs.readFileSync(nodePath.join(fixture, "openapi.json"), "utf-8");

const goldenConfig = nodeFs.readFileSync(nodePath.join(fixture, "author-config.json"), "utf-8");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

/**
 * Generates the golden spec into a scoped temp directory and returns, per emitted `.ts` file, the
 * module specifiers it imports. Nothing in the package is executed.
 */
const generatedImports = (): Promise<ReadonlyMap<string, readonly string[]>> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* emit() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ts7-" });
        const specPath = path.join(dir, "openapi.json");
        const configPath = path.join(dir, "author-config.json");
        const out = path.join(dir, "out");
        yield* fs.writeFileString(specPath, goldenSpec);
        yield* fs.writeFileString(configPath, goldenConfig);
        yield* generate(
          {
            document: Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json"),
            generator: {
              packageJson: decodeJson(generatorPackage),
              tsconfig: decodeJson(generatorTsconfig),
            },
            outDir: out,
            source: { _tag: "File", path: specPath },
            strict: false,
          },
          {
            document: Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json"),
            path: configPath,
          },
        );

        return new Map(
          sourceFiles(out).map((file) => [
            file,
            importsOf(nodeFs.readFileSync(path.join(out, file), "utf-8")),
          ]),
        );
      }),
    ).pipe(Effect.provide(layer)),
  );

/**
 * The package file a relative import of `file` lands on, extension and index aside.
 */
const targetOf = (file: string, specifier: string): string =>
  nodePath.posix.join(nodePath.posix.dirname(file), specifier);

type Files = ReadonlyMap<string, readonly string[]>;

const under = (layerName: string) => (file: string) => file.startsWith(`src/${layerName}/`);

const platform = (specifier: string): boolean => specifier.startsWith("@effect/platform-");

const bun = (specifier: string): boolean =>
  platform(specifier) || specifier === "bun" || specifier.startsWith("bun:");

const effectOnly = (specifier: string): boolean =>
  specifier === "effect" || specifier.startsWith("effect/");

const inRuntimeOrDomain = (file: string): boolean =>
  under("runtime")(file) || under("domain")(file);

const apiReachesOut = (file: string, specifier: string): boolean => {
  if (!specifier.startsWith(".")) {
    return false;
  }

  const target = targetOf(file, specifier);

  return (
    target.startsWith("src/cli/") ||
    target === "src/cli" ||
    target === "src/runtime/output.ts" ||
    target === "src/runtime/output"
  );
};

const edges = (
  files: Files,
  inside: (file: string) => boolean,
  banned: (file: string, specifier: string) => boolean,
): readonly string[] =>
  [...files].flatMap(([file, specifiers]) =>
    inside(file)
      ? specifiers
          .filter((specifier) => banned(file, specifier))
          .map((specifier) => `${file} -> ${specifier}`)
      : [],
  );

describe("generated package import graph (design 4.1)", () => {
  const emitted = generatedImports();

  test("emits the layers the rules name", async () => {
    const files = await emitted;
    const names = [...files.keys()];

    expect(names).toContain("src/bin.ts");
    for (const name of ["api", "cli", "domain", "runtime"]) {
      expect(names.some(under(name))).toBe(true);
    }
  });

  test("nothing under runtime/ or domain/ imports the platform or names Bun", async () => {
    expect(edges(await emitted, inRuntimeOrDomain, (_file, specifier) => bun(specifier))).toEqual(
      [],
    );
  });

  test("api/ never imports runtime/output.ts or cli/", async () => {
    expect(edges(await emitted, under("api"), apiReachesOut)).toEqual([]);
  });

  test("domain/ imports effect only", async () => {
    expect(
      edges(await emitted, under("domain"), (_file, specifier) => !effectOnly(specifier)),
    ).toEqual([]);
  });

  test("only bin.ts imports the platform", async () => {
    const files = await emitted;

    expect(
      edges(
        files,
        (file) => file !== "src/bin.ts",
        (_file, specifier) => platform(specifier),
      ),
    ).toEqual([]);
    expect(files.get("src/bin.ts")?.some(platform)).toBe(true);
  });
});

describe("the rules catch violations", () => {
  test("a planted type-only import is seen", () => {
    const planted = 'import type { Mode } from "../resolve/pointer.ts";\nexport type X = Mode;\n';

    expect(importsOf(planted)).toEqual(["../resolve/pointer.ts"]);
    expect(stageOf("src/emit/planted.ts", "../resolve/pointer.ts")).toBe("resolve");
  });

  test("a planted platform import is seen", () => {
    const planted = 'import type { BunServices } from "@effect/platform-bun";\n';

    expect(importsOf(planted).some((specifier) => specifier.startsWith("@effect/platform-"))).toBe(
      true,
    );
  });
});
