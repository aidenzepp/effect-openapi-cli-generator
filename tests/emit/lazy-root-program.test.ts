import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { BinRun, GeneratedPackage } from "../support/generated-cli.ts";

// Design 4.1 Lazy root, through the built CLI (M1 TS-2) and the capture server (M1 TS-1): the lazy
// build reproduces the eager record in `tests/fixtures/lazy-root/expected/` byte for byte, `tsc`
// rewrites each `import("./<segment>.ts")` to `.js`, and the inferred table keeps every group's
// requirements checked at `Effect.provide` and `runMain`.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(repoRoot, "tests/fixtures/lazy-root");

const expected = nodePath.join(fixture, "expected");

const memguard = nodePath.join(repoRoot, "tools/memguard.sh");

const ceilingMib = process.env.MEMGUARD_MIB ?? "4096";

// Generated packages live under the worktree's git-ignored `work/`, never the system temp directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "lazy-root-"));

const priorTmpdir = process.env.TMPDIR;

process.env.TMPDIR = work;

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const scope = Effect.runSync(Scope.make());

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

const apiKey = "lazy-root-key";

let generated: GeneratedPackage | undefined;

// The eager record (slice step 1): the runs whose output must not change, by file stem.
const recorded: readonly (readonly [string, readonly string[]])[] = [
  ["help", ["--help"]],
  ["pets-help", ["pets", "--help"]],
  ["stores-help", ["stores", "--help"]],
  ["describe", ["--describe"]],
  ["completions-bash", ["--completions", "bash"]],
  ["unknown-group", ["nosuch"]],
];

beforeAll(async () => {
  generated = await Effect.runPromise(
    generateFixture({
      authorFiles: [
        {
          content: nodeFs.readFileSync(nodePath.join(fixture, "custom/commands.ts"), "utf-8"),
          path: "custom/commands.ts",
        },
      ],
      configPath: nodePath.join(fixture, "author-config.json"),
      specPath: nodePath.join(fixture, "openapi.json"),
    }).pipe(Effect.tap(preparePackage), Scope.provide(scope), Effect.provide(layer)),
  );
}, 900_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  nodeFs.rmSync(work, { force: true, recursive: true });
  process.env.TMPDIR = priorTmpdir;
});

const built = (): GeneratedPackage => {
  if (generated === undefined) {
    throw new Error("the lazy-root package was not built");
  }

  return generated;
};

const run = (args: readonly string[], env: Readonly<Record<string, string>> = {}) =>
  Effect.runPromise(runBin(built(), { args, env, timeoutMs: 30_000 }).pipe(Effect.provide(layer)));

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const record = (stem: string, stream: "exit" | "stderr" | "stdout") =>
  nodeFs.readFileSync(nodePath.join(expected, `${stem}.${stream}`), "utf-8");

const exitText = (result: BinRun) => `${result.exitCode}\n`;

describe("lazy root: the built CLI", () => {
  test("dist/src/cli/root.js imports each top-level group by import() with a .js specifier", () => {
    const rootJs = nodeFs.readFileSync(nodePath.join(built().dir, "dist/src/cli/root.js"), "utf-8");
    const loaded = [...rootJs.matchAll(/import\("(?<from>[^"]+)"\)/gu)];
    expect(loaded.map((match) => match.groups?.from)).toEqual(["./pets.js", "./stores.js"]);
    expect(rootJs).not.toMatch(/\.ts["']/u);
  });

  for (const [stem, args] of recorded) {
    test(`reproduces the eager record byte for byte: ${stem}`, async () => {
      const result = await run(args);
      expect(decode(result.stdout)).toBe(record(stem, "stdout"));
      expect(decode(result.stderr)).toBe(record(stem, "stderr"));
      expect(exitText(result)).toBe(record(stem, "exit"));
    }, 60_000);
  }

  test("a global flag before the group name sends the same request as the group-first spelling", async () => {
    const env = { LAZY_API_KEY: apiKey };
    const exchange = async (args: readonly string[]) => {
      const before = capture.requests().length;
      const result = await run(args, env);
      expect(result.exitCode).toBe(0);

      return capture
        .requests()
        .slice(before)
        .map(({ body, headers, method, target }) => ({
          body: [...body],
          headers,
          method,
          target,
        }));
    };
    const globals = ["--base-url", origin, "--allow-credentials-for-base-url"];
    const flagFirst = await exchange([...globals, "pets", "list", "--limit", "3"]);
    const groupFirst = await exchange(["pets", "list", "--limit", "3", ...globals]);
    expect(flagFirst).toHaveLength(1);
    expect(flagFirst[0]?.target).toBe("/pets?limit=3");
    expect(flagFirst).toEqual(groupFirst);
  }, 60_000);

  test("<group> <command> --describe equals the root --describe", async () => {
    const result = await run(["pets", "list", "--describe"]);
    expect(decode(result.stdout)).toBe(record("describe", "stdout"));
    expect(exitText(result)).toBe(record("describe", "exit"));
  }, 60_000);

  test("--completions bash names every command path --describe lists", async () => {
    const DescribePaths = Schema.Struct({
      commands: Schema.Array(Schema.Struct({ path: Schema.Array(Schema.String) })),
    });
    const describeRun = await run(["--describe"]);
    const completionsRun = await run(["--completions", "bash"]);
    const described = Schema.decodeUnknownSync(Schema.fromJsonString(DescribePaths))(
      decode(describeRun.stdout),
    );
    const completions = decode(completionsRun.stdout);
    expect(described.commands.length).toBeGreaterThan(0);
    for (const { path } of described.commands) {
      expect(completions).toContain(`_lazy_${path.join("_")}()`);
    }
  }, 60_000);

  test("a group requirement the services layer drops fails the package typecheck", () => {
    const rootTs = nodePath.join(built().dir, "src/cli/root.ts");
    const original = nodeFs.readFileSync(rootTs, "utf-8");
    const provided = 'BaseUrl.layer(servers, "LAZY"),';
    expect(original).toContain(provided);

    nodeFs.writeFileSync(rootTs, original.replace(provided, ""));

    const typecheck = Bun.spawnSync(
      [memguard, ceilingMib, "--", process.execPath, "run", "typecheck"],
      { cwd: built().dir, stderr: "pipe", stdout: "pipe" },
    );
    nodeFs.writeFileSync(rootTs, original);

    expect(typecheck.exitCode).not.toBe(0);
    expect(decode(typecheck.stdout)).toContain("src/bin.ts");
  }, 300_000);
});
