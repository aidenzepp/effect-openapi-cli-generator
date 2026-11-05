import { expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
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
