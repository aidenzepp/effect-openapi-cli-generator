import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Exit, Runtime, Schema } from "effect";
import { coverageOf } from "../../corpus/tools/coverage.ts";
import { coverageFindings, settle } from "../../corpus/tools/run.ts";
import type { Findings } from "../../corpus/tools/run.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { resolve } from "../../src/resolve/index.ts";

// The runner is driven as a process (`--root`, `--only`, `--out`, `--list-ci`) over a stub corpus
// of local fixture specs. The pinned cache is pre-seeded, so nothing is fetched (C8); the stub
// tree and the generated packages live under the worktree's `work/`, never the system temp dir.
const repo = nodePath.resolve(import.meta.dir, "../..");

const stub = nodePath.join(repo, "work/corpus-run-test");

const cache = nodePath.join(stub, "cache");

const author = {
  binName: "stub",
  envPrefix: "STUB",
  package: { name: "stub-cli", version: "0.1.0" },
  servers: { accepted: ["https://api.example.com"] },
};

const accepted = {
  info: { title: "t", version: "1" },
  openapi: "3.1.1",
  paths: {
    "/things": { get: { operationId: "listThings", responses: { "200": { description: "ok" } } } },
  },
  servers: [{ url: "https://api.example.com" }],
};

// `info.version` is required: a document-scope refusal (VAL-03), so the verdict is `refused`.
const refusedSpec = { info: { title: "t" }, openapi: "3.1.1", paths: {} };

interface Stub {
  readonly config: object;
  readonly id: string;
  readonly spec: object;
}

// Listed in this order: `refused` runs before `broken` when both are selected.
const entries: readonly Stub[] = [
  { config: author, id: "clean", spec: accepted },
  { config: author, id: "refused", spec: refusedSpec },
  // The config names an author command module nobody wrote, so the generated package cannot build.
  {
    config: { ...author, commands: { module: "./custom/commands.ts", names: ["login"] } },
    id: "broken",
    spec: accepted,
  },
];

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const written = (path: string, content: string | Uint8Array): void => {
  nodeFs.mkdirSync(nodePath.dirname(path), { recursive: true });
  nodeFs.writeFileSync(path, content);
};

const manifest = (): string => {
  const specs = entries.map((entry) => {
    const bytes = new TextEncoder().encode(JSON.stringify(entry.spec));
    const sha256 = digest(bytes);
    written(nodePath.join(cache, sha256), bytes);
    written(nodePath.join(stub, "corpus/config", `${entry.id}.json`), JSON.stringify(entry.config));

    return {
      bytes: bytes.length,
      format: "json",
      id: entry.id,
      license: "MIT",
      pinnedRef: `stub/${entry.id}@${"0".repeat(40)}`,
      sha256,
      sourceUrl: `https://raw.githubusercontent.com/stub/${entry.id}/${"0".repeat(40)}/openapi.json`,
      tier: "ci",
    };
  });

  return JSON.stringify({ specs, version: 1 });
};

beforeAll(() => {
  nodeFs.rmSync(stub, { force: true, recursive: true });
  written(nodePath.join(stub, "corpus/corpus.json"), manifest());
});

afterAll(() => {
  nodeFs.rmSync(stub, { force: true, recursive: true });
});

interface Ran {
  readonly code: number | null;
  // The logger writes to stdout and stderr; `log` is both, for messages.
  readonly log: string;
  readonly stdout: string;
}

// Blocking, so no two builds overlap. The test process already runs under memguard.
const runner = (...args: readonly string[]): Ran => {
  const result = Bun.spawnSync(["bun", "--smol", "corpus/tools/run.ts", "--root", stub, ...args], {
    cwd: repo,
    env: { ...process.env, CORPUS_CACHE: cache },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 300_000,
  });

  return {
    code: result.exitCode,
    log: result.stdout.toString() + result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
};

const verdictFile = (id: string): string => {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new Error(`no stub entry ${id}`);
  }

  const sha = digest(new TextEncoder().encode(JSON.stringify(entry.spec)));

  return `${id}@${sha.slice(0, 12)}.json`;
};

describe("corpus run options", () => {
  test("--list-ci prints the ci ids, one per line, and exits 0", () => {
    const ran = runner("--list-ci");

    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe("clean\nrefused\nbroken\n");
  }, 60_000);

  test("--only runs one entry; --out writes there and leaves corpus/verdicts untouched", () => {
    const out = nodePath.join(stub, "out");
    const ran = runner("--only", "clean", "--out", out);

    expect(ran.log).not.toContain("refused");
    expect(ran.code).toBe(0);
    expect(nodeFs.readdirSync(out)).toEqual([verdictFile("clean")]);
    expect(nodeFs.existsSync(nodePath.join(stub, "corpus/verdicts"))).toBe(false);
    expect(
      JSON.parse(nodeFs.readFileSync(nodePath.join(out, verdictFile("clean")), "utf-8")),
    ).toMatchObject({
      coverage: { checked: true, missing: [] },
      verdict: "accepted",
    });
  }, 300_000);

  test("a refused verdict exits 1 and names the spec and the refusal", () => {
    const ran = runner("--only", "refused");

    expect(ran.code).toBe(1);
    expect(ran.log).toContain("refused: refused (document): VAL-03/schema-invalid");
  }, 60_000);

  test("a build that fails exits 1; --only repeats, so both selected entries are reached", () => {
    const ran = runner("--only", "refused", "--only", "broken");

    expect(ran.code).toBe(1);
    expect(ran.log).toContain("refused: refused (document)");
    expect(ran.log).toContain("broken: build failed");
  }, 300_000);

  test("an unknown --only id, an unknown argument and --check with --out exit 1", () => {
    // Three process spawns, one per case (the unknown id is run once, not twice). Each is a
    // failure before any build, measured at 0.3-0.6 s idle; 60 s leaves two orders of margin.
    const unknownId = runner("--only", "nope");
    expect(unknownId.code).toBe(1);
    expect(unknownId.log).toContain("--only nope: no ci entry with that id");
    expect(runner("--frobnicate").log).toContain("unknown argument: --frobnicate");
    expect(runner("--check", "--out", "x").code).toBe(1);
  }, 60_000);
});

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///fixture/openapi.json");

// The runner's coverage verdict: the real join over a spec, against a `--describe` with no commands.
const gaps = Effect.runSync(
  resolve({ document: entry, line: "3.1", value: accepted }).pipe(
    Effect.flatMap((resolution) =>
      coverageOf({
        describe: JSON.stringify({ commands: [], describeVersion: 1 }),
        report: JSON.stringify({ notices: [], refusals: [] }),
        resolution,
      }),
    ),
  ),
);

const exitCodeOf = (found: readonly Findings[]): number => {
  const exit = Effect.runSyncExit(settle(found));
  let code = -1;
  Runtime.defaultTeardown(exit, (value) => {
    code = value;
  });

  return code;
};

describe("corpus run exit status", () => {
  test("coverage found by the join is the only failure: exit 3, each cause named", () => {
    const causes = coverageFindings("stub", gaps);

    expect(causes).toContain("stub: missing operation /paths/~1things/get");
    expect(causes.every((cause) => cause.startsWith("stub: "))).toBe(true);
    expect(exitCodeOf([{ coverage: causes, other: [] }])).toBe(3);
  });

  test("a refusal or build failure alongside a coverage gap exits 1", () => {
    const causes = coverageFindings("stub", gaps);

    expect(exitCodeOf([{ coverage: causes, other: ["stub: verdict is refused"] }])).toBe(1);
  });

  test("no findings exits 0, and the settled failure is typed", () => {
    expect(exitCodeOf([{ coverage: [], other: [] }])).toBe(0);
    expect(Exit.isFailure(Effect.runSyncExit(settle([{ coverage: ["x"], other: [] }])))).toBe(true);
  });
});
