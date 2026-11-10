import nodePath from "node:path";
import { BunCrypto } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Path, Schema } from "effect";
import type { PlatformError, Scope } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import type { GenerateError } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";

const memguard = nodePath.resolve(import.meta.dir, "../../tools/memguard.sh");

const ceilingMib = process.env.MEMGUARD_MIB ?? "4096";

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const decodeDocument = Schema.decodeUnknownSync(DocumentUri);

const PackageBin = Schema.Struct({ bin: Schema.Record(Schema.String, Schema.String) });

/**
 * A file the API author owns, such as the command module an author config names, written into
 * the generated package after generation.
 */
export interface AuthorFile {
  readonly content: string;
  readonly path: string;
}

/**
 * One fixture to generate: the spec and author config files, and the author-owned files the
 * package needs to type-check.
 */
export interface Fixture {
  readonly authorFiles?: readonly AuthorFile[];
  readonly configPath: string;
  readonly specPath: string;
}

/**
 * A generated package inside its scoped temp directory: `root` is the temp directory, `dir` the
 * package directory inside it.
 */
export interface GeneratedPackage {
  readonly dir: string;
  readonly root: string;
}

/**
 * The bin's invocation: argv after the bin, the whole environment, stdin bytes and a timeout.
 */
export interface BinInvocation {
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly timeoutMs: number;
}

/**
 * What the bin did: its exit code (`null` when a signal ended it), whether the timeout ended it,
 * and its stdout and stderr bytes.
 */
export interface BinRun {
  readonly exitCode: number | null;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
  readonly timedOut: boolean;
}

/**
 * A heavy step (install, type-check, build) that exited non-zero, with its output.
 */
export class GeneratedCliStepFailed extends Data.TaggedError("GeneratedCliStepFailed")<{
  readonly exitCode: number | null;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
  readonly step: "build" | "install" | "typecheck";
}> {}

// Diagnostics name a fixed URI per file, never the host path (C8).
const documentFor = (file: string) => decodeDocument(`file:///fixture/${nodePath.basename(file)}`);

/**
 * Generates the fixture through `generate` into `<root>/out`, where `root` is a fresh temp
 * directory the enclosing scope removes, then writes the author-owned files into the package.
 */
export const generateFixture = (
  fixture: Fixture,
): Effect.Effect<
  GeneratedPackage,
  GenerateError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* generateGen() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "generated-cli-" });
    const dir = path.join(root, "out");
    yield* generate(
      {
        document: documentFor(fixture.specPath),
        generator,
        outDir: dir,
        source: { _tag: "File", path: fixture.specPath },
        strict: false,
      },
      { document: documentFor(fixture.configPath), path: fixture.configPath },
    ).pipe(Effect.provide(BunCrypto.layerDigest));
    yield* Effect.forEach(
      fixture.authorFiles ?? [],
      (file) => {
        const target = path.join(dir, ...file.path.split("/"));

        return fs
          .makeDirectory(path.dirname(target), { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(target, file.content)));
      },
      { discard: true },
    );

    return { dir, root };
  });

// Spawning synchronously blocks the process, so heavy steps never overlap, whoever calls them.
const heavy = (
  step: GeneratedCliStepFailed["step"],
  dir: string,
  command: readonly string[],
): Effect.Effect<void, GeneratedCliStepFailed> =>
  Effect.suspend(() => {
    const result = Bun.spawnSync([memguard, ceilingMib, "--", ...command], {
      cwd: dir,
      stderr: "pipe",
      stdout: "pipe",
    });

    return result.exitCode === 0
      ? Effect.void
      : Effect.fail(
          new GeneratedCliStepFailed({
            exitCode: result.exitCode,
            stderr: result.stderr,
            stdout: result.stdout,
            step,
          }),
        );
  });

/**
 * Installs the package's dependencies preferring Bun's cache (`--prefer-offline`: cached packages
 * resolve locally, only what is missing is fetched), then type-checks and builds it with the
 * package's own `typecheck` and `build` scripts. Each step runs under `tools/memguard.sh`, one at a
 * time.
 */
export const preparePackage = (
  generated: GeneratedPackage,
): Effect.Effect<void, GeneratedCliStepFailed> =>
  heavy("install", generated.dir, [
    process.execPath,
    "install",
    "--prefer-offline",
    "--no-save",
    "--ignore-scripts",
  ]).pipe(
    Effect.andThen(heavy("typecheck", generated.dir, [process.execPath, "run", "typecheck"])),
    Effect.andThen(heavy("build", generated.dir, [process.execPath, "run", "build"])),
  );

/**
 * Runs the package's one `bin` entry with Bun, without blocking the event loop. `env` is the bin's
 * whole environment (default empty), so nothing from the test process leaks into the run.
 */
export const runBin = (
  generated: GeneratedPackage,
  invocation: BinInvocation,
): Effect.Effect<BinRun, PlatformError.PlatformError | Schema.SchemaError, FileSystem.FileSystem> =>
  Effect.gen(function* run() {
    const fs = yield* FileSystem.FileSystem;
    const manifest = yield* fs.readFileString(nodePath.join(generated.dir, "package.json"));
    const { bin } = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageBin))(manifest);
    const [entry, ...others] = Object.values(bin);
    if (entry === undefined || others.length > 0) {
      return yield* Effect.die("the generated package must declare exactly one bin");
    }

    // Async, so an in-process server the bin talks to keeps serving while the bin runs.
    return yield* Effect.promise(async () => {
      const child = Bun.spawn(
        [process.execPath, nodePath.join(generated.dir, ...entry.split("/")), ...invocation.args],
        {
          cwd: generated.dir,
          env: { ...invocation.env },
          stderr: "pipe",
          stdin: invocation.stdin ?? new Uint8Array(),
          stdout: "pipe",
        },
      );
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, invocation.timeoutMs);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).bytes(),
        new Response(child.stderr).bytes(),
        child.exited,
      ]).finally(() => {
        clearTimeout(timer);
      });

      return { exitCode: child.signalCode === null ? exitCode : null, stderr, stdout, timedOut };
    });
  });
