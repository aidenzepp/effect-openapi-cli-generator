import { expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer } from "effect";
import { generateFixture, preparePackage, runBin } from "./generated-cli.ts";

const golden = nodePath.resolve(import.meta.dir, "../fixtures/golden/users-update");

// The golden author config names `./custom/commands.ts`, which the author owns: one `login` command.
const authorCommands = `import { Command } from "effect/cli";\n\nexport const login = Command.make("login");\n`;

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

test("the golden package generates, type-checks and builds, and its --version exits 0", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* check() {
        const generated = yield* generateFixture({
          authorFiles: [{ content: authorCommands, path: "custom/commands.ts" }],
          configPath: nodePath.join(golden, "author-config.json"),
          specPath: nodePath.join(golden, "openapi.json"),
        });
        yield* preparePackage(generated);

        const version = yield* runBin(generated, { args: ["--version"], timeoutMs: 30_000 });

        return { root: generated.root, version };
      }),
    ).pipe(Effect.provide(layer)),
  );

  expect(observed.version.timedOut).toBe(false);
  expect(observed.version.exitCode).toBe(0);
  expect(observed.version.stdout.length).toBeGreaterThan(0);
  expect(observed.root).not.toBe("");
  expect(nodeFs.existsSync(observed.root)).toBe(false);
}, 300_000);

const scratch = nodePath.resolve(import.meta.dir, "../../work");

const fetchBin = `const response = await fetch(process.argv[2] ?? "");\nprocess.stdout.write(await response.text());\n`;

const stuckBin = `await new Promise(() => {});\n`;

const writePackage = (bin: string) =>
  Effect.gen(function* write() {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(scratch, { recursive: true });

    const root = yield* fs.makeTempDirectoryScoped({ directory: scratch, prefix: "run-bin-" });

    yield* fs.writeFileString(
      nodePath.join(root, "package.json"),
      JSON.stringify({ bin: { probe: "bin.ts" } }),
    );
    yield* fs.writeFileString(nodePath.join(root, "bin.ts"), bin);

    return { dir: root, root };
  });

test("runBin does not block the event loop: the bin reaches an in-process server", async () => {
  const server = Bun.serve({ fetch: () => new Response("pong"), hostname: "127.0.0.1", port: 0 });
  try {
    const run = await Effect.runPromise(
      Effect.scoped(
        writePackage(fetchBin).pipe(
          Effect.flatMap((generated) =>
            runBin(generated, { args: [`http://127.0.0.1:${server.port}/`], timeoutMs: 5000 }),
          ),
        ),
      ).pipe(Effect.provide(layer)),
    );

    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(new TextDecoder().decode(run.stdout)).toBe("pong");
  } finally {
    await server.stop(true);
  }
}, 30_000);

test("runBin kills a bin that outlives its timeout and reports timedOut", async () => {
  const run = await Effect.runPromise(
    Effect.scoped(
      writePackage(stuckBin).pipe(
        Effect.flatMap((generated) => runBin(generated, { args: [], timeoutMs: 500 })),
      ),
    ).pipe(Effect.provide(layer)),
  );

  expect(run.timedOut).toBe(true);
  expect(run.exitCode).not.toBe(0);
}, 30_000);
