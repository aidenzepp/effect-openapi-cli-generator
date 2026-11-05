import { Data, Effect, Schema } from "effect";
import { JsonLiteral } from "../model/brands.ts";
import type { AuthorConfig } from "../model/author-config.ts";
import { printJson, printPackageJson } from "./printer.ts";

/**
 * The generator's own `package.json` and `tsconfig.json`, parsed JSON, read by the caller at build
 * time. They are the single source of the emitted pins and compiler options (design 4.2, X12).
 */
export interface GeneratorSource {
  readonly packageJson: Schema.Json;
  readonly tsconfig: Schema.Json;
}

export interface EmittedFile {
  readonly content: string;
  readonly path: string;
}

/**
 * The generator's own manifest or compiler options lack a value the package needs, or the package
 * holds a value the printer refuses.
 */
export class PackageEmitError extends Data.TaggedError("PackageEmitError")<{
  readonly reason: "invalid-generator-source" | "unprintable-package";
}> {}

const GeneratorPackage = Schema.Struct({
  dependencies: Schema.Struct({ "@effect/platform-bun": Schema.String, effect: Schema.String }),
  devDependencies: Schema.Struct({ "@types/bun": Schema.String, typescript: Schema.String }),
  engines: Schema.Struct({ bun: Schema.String }),
});

const GeneratorTsconfig = Schema.Struct({
  compilerOptions: Schema.Record(Schema.String, Schema.Json),
});

const decodeGeneratorPackage = Schema.decodeUnknownEffect(GeneratorPackage);

const decodeGeneratorTsconfig = Schema.decodeUnknownEffect(GeneratorTsconfig);

const decodeJson = Schema.decodeUnknownEffect(JsonLiteral);

const invalidSource = () => new PackageEmitError({ reason: "invalid-generator-source" });

const buildOptions = {
  allowImportingTsExtensions: false,
  declaration: true,
  noEmit: false,
  outDir: "dist",
  rewriteRelativeImportExtensions: true,
  rootDir: ".",
};

const unprintable = () => new PackageEmitError({ reason: "unprintable-package" });

/**
 * Emits `package.json`, `tsconfig.json` and `tsconfig.build.json` (design 4.2, 4.3; X12), sorted by
 * path. The generated package types against Bun only, so `types` is `["bun"]` whatever the
 * generator lists.
 */
export const emitPackageFiles = (
  config: AuthorConfig,
  generator: GeneratorSource,
): Effect.Effect<readonly EmittedFile[], PackageEmitError> =>
  Effect.gen(function* emit() {
    const pins = yield* decodeGeneratorPackage(generator.packageJson).pipe(
      Effect.mapError(invalidSource),
    );
    const { compilerOptions } = yield* decodeGeneratorTsconfig(generator.tsconfig).pipe(
      Effect.mapError(invalidSource),
    );
    const manifest = yield* decodeJson({
      bin: { [config.binName]: "dist/src/bin.js" },
      dependencies: pins.dependencies,
      devDependencies: pins.devDependencies,
      engines: pins.engines,
      files: ["dist", "README.md"],
      name: config.package.name,
      scripts: { build: "tsc -p tsconfig.build.json", typecheck: "tsc --noEmit" },
      type: "module",
      version: config.package.version,
    }).pipe(Effect.mapError(unprintable));
    const tsconfig = yield* decodeJson({
      compilerOptions: { ...compilerOptions, noEmit: true, types: ["bun"] },
      exclude: ["node_modules", "dist"],
      include: ["src"],
    }).pipe(Effect.mapError(unprintable));
    const tsconfigBuild = yield* decodeJson({
      compilerOptions: buildOptions,
      exclude: ["node_modules", "dist"],
      extends: "./tsconfig.json",
      include: ["src/**/*.ts"],
    }).pipe(Effect.mapError(unprintable));
    const packageJson = yield* printPackageJson(manifest).pipe(Effect.mapError(unprintable));

    return [
      { content: packageJson, path: "package.json" },
      { content: printJson(tsconfigBuild), path: "tsconfig.build.json" },
      { content: printJson(tsconfig), path: "tsconfig.json" },
    ];
  });
