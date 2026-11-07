import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { BinRun, GeneratedPackage } from "../support/generated-cli.ts";

// Design 4.1 Lazy root, through the built CLI (M1 TS-2) and the capture server (M1 TS-1): the lazy
// build prints what an eager build of the same package prints, `tsc` rewrites each
// `import("./<segment>.ts")` to `.js`, and the inferred table keeps every group's requirements
// checked at `Effect.provide` and `runMain`.
//
// The eager oracle is built live, inside the same package and by the same `tsc` build (m2.md 2
// outcome 5, "as the eager root did"; audit 15dfff22 S5). The generator has no eager form (design
// 4.1 One layout), so the test writes one beside the generated entry: `src/cli/eager-root.ts` is
// `src/cli/root.ts` with its `Groups` import pointed at `src/runtime/eager-groups.ts`, which hands
// the root header every top-level group's real module whatever argv selects, never a header-only
// stub; `src/eager-main.ts` and `src/eager-bin.ts` are `main.ts` and `bin.ts` over it. That is the
// pre-LZ-2 command tree (every group's own `Command.make`), so root help and the unknown-group
// error compare real group headers against the lazy stubs.
//
// Every file in `tests/fixtures/lazy-root/expected/` is the eager oracle's output: each record test
// below runs both builds and asserts lazy = eager = record, so a record that drifts from eager output
// fails here. help.stdout and unknown-group.stderr were last written from the lazy build (379e2e4);
// this test is what ties them to the eager oracle.

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

// The eager oracle's runtime half: every entry's module loaded, argv ignored (see the header).
const eagerGroups = `import { Effect } from "effect";
import type { Entry, Group } from "./groups.ts";

export const root = <E, R, C>(
  table: readonly Entry<E, R>[],
  header: (groups: readonly Group<E, R>[]) => C,
  _args: readonly string[],
): Effect.Effect<C> =>
  Effect.forEach(table, (entry) =>
    Effect.promise(() => entry.load()).pipe(Effect.map((module) => module.group)),
  ).pipe(Effect.map(header));
`;

// Copies a generated module to `to`, replacing exactly one occurrence of `from` with `into`.
const derive = (dir: string, source: string, to: string, from: string, into: string) => {
  const text = nodeFs.readFileSync(nodePath.join(dir, source), "utf-8");
  if (text.split(from).length !== 2) {
    throw new Error(`${source} must hold exactly one ${from}`);
  }

  nodeFs.writeFileSync(nodePath.join(dir, to), text.replace(from, into));
};

// Writes the eager entry beside the generated one, before the package's typecheck and build.
const writeEagerOracle = ({ dir }: GeneratedPackage) => {
  nodeFs.writeFileSync(nodePath.join(dir, "src/runtime/eager-groups.ts"), eagerGroups);
  derive(
    dir,
    "src/cli/root.ts",
    "src/cli/eager-root.ts",
    'import * as Groups from "../runtime/groups.ts";',
    'import * as Groups from "../runtime/eager-groups.ts";',
  );
  derive(dir, "src/main.ts", "src/eager-main.ts", '"./cli/root.ts"', '"./cli/eager-root.ts"');
  derive(dir, "src/bin.ts", "src/eager-bin.ts", '"./main.ts"', '"./eager-main.ts"');
};

// The recorded runs, by file stem: each record is the eager oracle's output (see the header).
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
    }).pipe(
      Effect.tap((fresh) =>
        Effect.sync(() => {
          writeEagerOracle(fresh);
        }),
      ),
      Effect.tap(preparePackage),
      Scope.provide(scope),
      Effect.provide(layer),
    ),
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

// The eager oracle's bin, spawned as `runBin` spawns the package's own bin: empty environment, no
// stdin, the same timeout.
const runEager = async (args: readonly string[]): Promise<BinRun> => {
  const child = Bun.spawn(
    [process.execPath, nodePath.join(built().dir, "dist/src/eager-bin.js"), ...args],
    { cwd: built().dir, env: {}, stderr: "pipe", stdin: new Uint8Array(), stdout: "pipe" },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 30_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).bytes(),
    child.exited,
  ]).finally(() => {
    clearTimeout(timer);
  });

  return { exitCode: child.signalCode === null ? exitCode : null, stderr, stdout, timedOut };
};

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const record = (stem: string, stream: "exit" | "stderr" | "stdout") =>
  nodeFs.readFileSync(nodePath.join(expected, `${stem}.${stream}`), "utf-8");

const exitText = (result: BinRun) => `${result.exitCode}\n`;

const streams = (result: BinRun) => ({
  exit: exitText(result),
  stderr: decode(result.stderr),
  stdout: decode(result.stdout),
});

describe("lazy root: the built CLI", () => {
  test("dist/src/cli/root.js imports each top-level group by import() with a .js specifier", () => {
    const rootJs = nodeFs.readFileSync(nodePath.join(built().dir, "dist/src/cli/root.js"), "utf-8");
    const loaded = [...rootJs.matchAll(/import\("(?<from>[^"]+)"\)/gu)];
    expect(loaded.map((match) => match.groups?.from)).toEqual(["./pets.js", "./stores.js"]);
    expect(rootJs).not.toMatch(/\.ts["']/u);
  });

  test("the eager oracle's built root imports every group module and never stubs one", () => {
    const groupsJs = nodeFs.readFileSync(
      nodePath.join(built().dir, "dist/src/runtime/eager-groups.js"),
      "utf-8",
    );
    const eagerRootJs = nodeFs.readFileSync(
      nodePath.join(built().dir, "dist/src/cli/eager-root.js"),
      "utf-8",
    );
    expect(groupsJs).not.toMatch(/stub|selected/u);
    expect(eagerRootJs).toContain('from "../runtime/eager-groups.js"');
    expect(
      [...eagerRootJs.matchAll(/import\("(?<from>[^"]+)"\)/gu)].map((match) => match.groups?.from),
    ).toEqual(["./pets.js", "./stores.js"]);
  });

  for (const [stem, args] of recorded) {
    test(`prints what the eager oracle prints, which is the record: ${stem}`, async () => {
      const lazy = await run(args);
      const eager = await runEager(args);
      expect(streams(lazy)).toEqual(streams(eager));
      expect(streams(eager)).toEqual({
        exit: record(stem, "exit"),
        stderr: record(stem, "stderr"),
        stdout: record(stem, "stdout"),
      });
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
