import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Scope } from "effect";
import generatorPackage from "../package.json" with { type: "json" };
import { generateFixture, preparePackage, runBin } from "./support/generated-cli.ts";
import type { AuthorFile, GeneratedPackage } from "./support/generated-cli.ts";
import { setEnv } from "./support/env.ts";

// Design 3.6 (format, lint, typecheck) and 9 I1, steelman E42: the emitted package is proved
// against the generator's own toolchain, on the golden users-update spec and on a hostile-names
// spec built from the hostile seed. One serial batch per fixture set: `vp fmt --check`,
// `vp lint --type-aware`, `tsc --noEmit`, then `vp fmt` twice with byte equality after the first
// pass. A generated file that fails any step is a finding, never a weakened expectation.

const repoRoot = nodePath.resolve(import.meta.dir, "..");

const golden = nodePath.join(repoRoot, "tests/fixtures/golden/users-update");

const hostileSpec = nodePath.join(repoRoot, "tests/fixtures/specs/hostile.json");

const memguard = nodePath.join(repoRoot, "tools/memguard.sh");

const ceilingMib = process.env.MEMGUARD_MIB ?? "4096";

const vp = nodePath.join(repoRoot, "node_modules/.bin/vp");

// The golden author config names `./custom/commands.ts`, which the author owns: one `login` command.
const authorCommands = `import { Command } from "effect/cli";\n\nexport const login = Command.make("login");\n`;

const hostileConfig = {
  binName: "hostile",
  envPrefix: "HOSTILE",
  package: { name: "hostile-cli", version: "0.1.0" },
  servers: { accepted: ["https://hostile.example.com"] },
};

interface FixtureSet {
  readonly authorFiles: readonly AuthorFile[];
  readonly configPath: string;
  readonly name: string;
  readonly specPath: string;
}

interface Step {
  readonly exitCode: number | null;
  readonly output: string;
}

interface Outcome {
  readonly files: ReadonlyMap<string, string>;
  readonly formatCheck: Step;
  readonly formatSecond: ReadonlyMap<string, string>;
  readonly lint: Step;
  readonly typecheck: Step;
  readonly typescriptVersion: Step;
}

interface Built {
  readonly help: string;
  readonly outcome: Outcome;
}

// Everything lives under the worktree's git-ignored `work/`, never the system temp directory.
const scratch = nodePath.join(repoRoot, "work");

mkdirSync(scratch, { recursive: true });

const work = mkdtempSync(nodePath.join(scratch, "emitted-proof-"));

const restoreTmpdir = setEnv("TMPDIR", work);

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// Spawning synchronously keeps the heavy steps serial; memguard bounds the process tree.
const run = (cwd: string, command: readonly string[]): Step => {
  const result = Bun.spawnSync([memguard, ceilingMib, "--", ...command], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    exitCode: result.exitCode,
    output: `${decode(result.stdout)}${decode(result.stderr)}`,
  };
};

// Every file of the package except installed and built output, keyed by relative path.
const snapshot = (dir: string): ReadonlyMap<string, string> => {
  const files = new Map<string, string>();
  const walk = (relative: string) => {
    for (const entry of readdirSync(nodePath.join(dir, relative), { withFileTypes: true })) {
      const next = nodePath.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (![".git", "dist", "node_modules"].includes(entry.name)) {
          walk(next);
        }
      } else {
        files.set(next, readFileSync(nodePath.join(dir, next), "latin1"));
      }
    }
  };
  walk("");

  return files;
};

// The vp tools resolve ignore rules from the package directory, and the git-ignored scratch
// directory above it would hide every file, so the package is its own repository root.
const isolate = (generated: GeneratedPackage) => {
  run(generated.dir, ["git", "init", "--quiet"]);
  writeFileSync(nodePath.join(generated.dir, ".gitignore"), "dist/\nnode_modules/\n");
};

// The failing step with its output, for assertion messages.
const describeStep = (label: string, step: Step) =>
  `${label} exited ${step.exitCode}:\n${step.output}`;

const prove = (generated: GeneratedPackage): Outcome => {
  const { dir } = generated;
  const tsc = nodePath.join(dir, "node_modules/.bin/tsc");
  const formatCheck = run(dir, [vp, "fmt", "--check"]);
  const lint = run(dir, [vp, "lint", "--type-aware"]);
  const typecheck = run(dir, [tsc, "--noEmit"]);
  const typescriptVersion = run(dir, [tsc, "--version"]);
  const first = run(dir, [vp, "fmt"]);
  const files = snapshot(dir);
  const second = run(dir, [vp, "fmt"]);
  if (first.exitCode !== 0 || second.exitCode !== 0) {
    throw new Error(describeStep("vp fmt", first.exitCode === 0 ? second : first));
  }

  return { files, formatCheck, formatSecond: snapshot(dir), lint, typecheck, typescriptVersion };
};

const fixtureSets: readonly FixtureSet[] = [
  {
    authorFiles: [{ content: authorCommands, path: "custom/commands.ts" }],
    configPath: nodePath.join(golden, "author-config.json"),
    name: "golden users-update",
    specPath: nodePath.join(golden, "openapi.json"),
  },
  {
    authorFiles: [],
    configPath: nodePath.join(work, "hostile-config.json"),
    name: "hostile names",
    specPath: hostileSpec,
  },
];

writeFileSync(
  nodePath.join(work, "hostile-config.json"),
  `${JSON.stringify(hostileConfig, null, 2)}\n`,
);

const scope = Effect.runSync(Scope.make());

const built = new Map<string, Promise<Built>>();

beforeAll(() => {
  // Serial by construction: each fixture set finishes before the next one starts.
  let previous: Promise<unknown> = Promise.resolve();
  for (const set of fixtureSets) {
    const next = previous.then(async () => {
      const generated = await Effect.runPromise(
        generateFixture(set).pipe(Scope.provide(scope), Effect.provide(layer)),
      );
      isolate(generated);
      await Effect.runPromise(preparePackage(generated));
      const help = await Effect.runPromise(
        runBin(generated, { args: ["users", "update", "--help"], timeoutMs: 60_000 }).pipe(
          Effect.provide(layer),
        ),
      );

      return { help: decode(help.stdout), outcome: prove(generated) };
    });
    built.set(set.name, next);
    previous = next.catch(() => null);
  }
}, 1_800_000);

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(work, { force: true, recursive: true });
  restoreTmpdir();
});

const outcomeOf = async (name: string) => {
  const result = await built.get(name);
  if (result === undefined) {
    throw new Error(`no run recorded for ${name}`);
  }

  return result;
};

describe.each(fixtureSets.map((set) => set.name))("emitted package: %s", (name) => {
  test("vp fmt --check accepts every emitted file", async () => {
    const { outcome } = await outcomeOf(name);

    expect(outcome.formatCheck.exitCode, describeStep("vp fmt --check", outcome.formatCheck)).toBe(
      0,
    );
  }, 1_800_000);

  test("vp lint --type-aware reports nothing", async () => {
    const { outcome } = await outcomeOf(name);

    expect(outcome.lint.exitCode, describeStep("vp lint --type-aware", outcome.lint)).toBe(0);
  }, 1_800_000);

  test("tsc --noEmit passes with the pinned TypeScript", async () => {
    const { outcome } = await outcomeOf(name);

    expect(outcome.typescriptVersion.output.trim()).toContain(
      generatorPackage.devDependencies.typescript,
    );
    expect(outcome.typecheck.exitCode, describeStep("tsc --noEmit", outcome.typecheck)).toBe(0);
  }, 1_800_000);

  test("a second vp fmt leaves every byte as the first pass left it", async () => {
    const { outcome } = await outcomeOf(name);

    expect([...outcome.formatSecond.keys()]).toEqual([...outcome.files.keys()]);
    for (const [file, content] of outcome.files) {
      expect(outcome.formatSecond.get(file) === content, file).toBe(true);
    }
  }, 1_800_000);
});

test("the built golden CLI's users update --help equals expected/help.txt byte for byte", async () => {
  const { help } = await outcomeOf("golden users-update");
  const expected = readFileSync(nodePath.join(golden, "expected/help.txt"), "utf-8");

  expect(help).toBe(expected);
}, 1_800_000);
