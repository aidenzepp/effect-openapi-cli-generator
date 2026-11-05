import { expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import generatorPackage from "../package.json" with { type: "json" };
import { generateFixture, preparePackage, runBin } from "./support/generated-cli.ts";
import type { GeneratedPackage } from "./support/generated-cli.ts";

// The generated package is a real package: its own scripts build it, its bin runs, and it packs
// and installs (offline, from Bun's cache) into a consumer whose symlinked bin runs.

const golden = nodePath.resolve(import.meta.dir, "fixtures/golden/users-update");

// The golden author config names `./custom/commands.ts`, which the author owns: one `login` command.
const authorCommands = `import { Command } from "effect/cli";\n\nexport const login = Command.make("login");\n`;

const ceilingMib = process.env.MEMGUARD_MIB ?? "4096";

const memguard = nodePath.resolve(import.meta.dir, "../tools/memguard.sh");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const Manifest = Schema.Struct({
  bin: Schema.Record(Schema.String, Schema.String),
  dependencies: Schema.Record(Schema.String, Schema.String),
  devDependencies: Schema.Record(Schema.String, Schema.String),
  engines: Schema.Record(Schema.String, Schema.String),
  files: Schema.Array(Schema.String),
  name: Schema.String,
  packageManager: Schema.String,
  scripts: Schema.Record(Schema.String, Schema.String),
  version: Schema.String,
});

const readManifest = (dir: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    nodeFs.readFileSync(nodePath.join(dir, "package.json"), "utf-8"),
  );

const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// Runs a heavy step under the memguard in `cwd`, failing with its output when it exits non-zero.
const guarded = (cwd: string, command: readonly string[], env?: Record<string, string>) => {
  const result = Bun.spawnSync([memguard, ceilingMib, ...command], {
    cwd,
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} exited ${result.exitCode}\n${utf8(result.stdout)}\n${utf8(result.stderr)}`,
    );
  }

  return utf8(result.stdout);
};

const pinsOf = (record: Readonly<Record<string, string>>, names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, record[name]]));

const exercise = (generated: GeneratedPackage) =>
  Effect.gen(function* exerciseGen() {
    const manifest = readManifest(generated.dir);
    const binName = Object.keys(manifest.bin)[0] ?? "";
    const direct = yield* runBin(generated, { args: ["--help"], timeoutMs: 30_000 });
    const directVersion = yield* runBin(generated, { args: ["--version"], timeoutMs: 30_000 });

    // Pack the built package and install the tarball into a consumer, offline.
    const packDir = nodePath.join(generated.root, "pack");
    nodeFs.mkdirSync(packDir);
    guarded(generated.dir, [process.execPath, "pm", "pack", "--destination", packDir]);

    const tarball = nodeFs.readdirSync(packDir).find((entry) => entry.endsWith(".tgz")) ?? "";
    const consumer = nodePath.join(generated.root, "consumer");
    nodeFs.mkdirSync(consumer);
    nodeFs.writeFileSync(
      nodePath.join(consumer, "package.json"),
      `${JSON.stringify({ name: "consumer", private: true, version: "0.0.0" })}\n`,
    );
    guarded(consumer, [
      process.execPath,
      "add",
      "--offline",
      "--ignore-scripts",
      nodePath.join(packDir, tarball),
    ]);

    const link = nodePath.join(consumer, "node_modules/.bin", binName);
    const installed = (args: readonly string[]) => {
      const result = Bun.spawnSync([link, ...args], {
        cwd: consumer,
        env: { PATH: `${nodePath.dirname(process.execPath)}:/usr/bin:/bin` },
        stderr: "pipe",
        stdout: "pipe",
      });

      return {
        exitCode: result.exitCode,
        stderr: utf8(result.stderr),
        stdout: utf8(result.stdout),
      };
    };

    return {
      binName,
      direct: { exitCode: direct.exitCode, stdout: utf8(direct.stdout) },
      directVersion: { exitCode: directVersion.exitCode, stdout: utf8(directVersion.stdout) },
      installedHelp: installed(["--help"]),
      installedVersion: installed(["--version"]),
      isSymlink: nodeFs.lstatSync(link).isSymbolicLink(),
      tsconfigBuild: nodeFs.existsSync(nodePath.join(generated.dir, "tsconfig.build.json")),
    };
  });

test("the golden package builds with its own script, runs, packs and installs offline", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* check() {
        const generated = yield* generateFixture({
          authorFiles: [{ content: authorCommands, path: "custom/commands.ts" }],
          configPath: nodePath.join(golden, "author-config.json"),
          specPath: nodePath.join(golden, "openapi.json"),
        });
        yield* preparePackage(generated);

        const manifest = readManifest(generated.dir);
        const result = yield* exercise(generated);

        return { manifest, result };
      }),
    ).pipe(Effect.provide(layer)),
  );
  const { manifest, result } = observed;
  const pins = Object.keys(manifest.dependencies);
  const devPins = Object.keys(manifest.devDependencies);

  expect(pins.length).toBeGreaterThan(0);
  expect(pinsOf(manifest.dependencies, pins)).toEqual(pinsOf(generatorPackage.dependencies, pins));
  expect(pinsOf(manifest.devDependencies, devPins)).toEqual(
    pinsOf(generatorPackage.devDependencies, devPins),
  );
  expect(manifest.bin).toEqual({ [result.binName]: "dist/src/bin.js" });
  expect(manifest.files).toContain("dist");
  expect(manifest.engines).toEqual(generatorPackage.engines);
  expect(manifest.packageManager).toBe(generatorPackage.packageManager);
  expect(manifest.scripts.build).toContain("tsconfig.build.json");
  expect(manifest.scripts.typecheck).toBeDefined();
  expect(result.tsconfigBuild).toBe(true);

  expect(result.direct.exitCode).toBe(0);
  expect(result.direct.stdout.length).toBeGreaterThan(0);
  expect(result.directVersion).toEqual({
    exitCode: 0,
    stdout: `${result.binName} v${manifest.version}\n`,
  });
  expect(result.isSymlink).toBe(true);
  expect(result.installedHelp.exitCode).toBe(0);
  expect(result.installedHelp.stdout).toBe(result.direct.stdout);
  expect(result.installedVersion.exitCode).toBe(0);
  expect(result.installedVersion.stdout).toBe(`${result.binName} v${manifest.version}\n`);
}, 600_000);
