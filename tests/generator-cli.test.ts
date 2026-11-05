import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { Array as Arr, Order, Schema } from "effect";
import generatorPackage from "../package.json" with { type: "json" };
import { GenerationReport } from "../src/report/index.ts";

const root = nodePath.resolve(import.meta.dir, "..");

const bin = nodePath.join(root, "src/bin.ts");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

const decodeRecord = Schema.decodeUnknownSync(JsonRecord);

const decodeReport = Schema.decodeUnknownSync(GenerationReport);

const readFixture = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const goldenText = readFixture("openapi.json");

const goldenSpec = decodeRecord(JSON.parse(goldenText));

// The golden spec plus one operation whose only request body is `text/plain` (EMT-1).
const withTextBody = JSON.stringify({
  ...goldenSpec,
  paths: {
    ...decodeRecord(goldenSpec.paths),
    "/notes": {
      post: {
        operationId: "notes-create",
        requestBody: { content: { "text/plain": { schema: { type: "string" } } }, required: true },
        responses: { "204": { description: "Stored." } },
        tags: ["notes"],
      },
    },
  },
});

const scratch = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "gn2-"));

afterAll(() => {
  nodeFs.rmSync(scratch, { force: true, recursive: true });
});

const decoder = new TextDecoder();

const encoder = new TextEncoder();

interface Ran {
  readonly dir: string;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

let runs = 0;

/**
 * Runs the generator CLI in a fresh directory that holds the golden author config as `c.json` and
 * `spec` (when given) as `openapi.json`, the golden file name. Relative arguments resolve against
 * that directory.
 */
const cli = (args: readonly string[], options: { spec?: string; stdin?: string } = {}): Ran => {
  runs += 1;
  const dir = nodePath.join(scratch, `run-${runs}`);
  nodeFs.mkdirSync(dir);
  nodeFs.writeFileSync(nodePath.join(dir, "c.json"), readFixture("author-config.json"));
  if (options.spec !== undefined) {
    nodeFs.writeFileSync(nodePath.join(dir, "openapi.json"), options.spec);
  }

  const result = Bun.spawnSync(["bun", bin, ...args], {
    cwd: dir,
    stdin: encoder.encode(options.stdin ?? ""),
  });

  return {
    dir,
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  };
};

const lines = (text: string): readonly string[] => text.split("\n").filter((line) => line !== "");

const entries = (dir: string): readonly string[] => Arr.sort(nodeFs.readdirSync(dir), Order.String);

const readOut = (ran: Ran, relative: string): string | undefined => {
  const target = nodePath.join(ran.dir, "out", relative);

  return nodeFs.existsSync(target) ? nodeFs.readFileSync(target, "utf-8") : undefined;
};

const reportOf = (ran: Ran) =>
  decodeReport(JSON.parse(readOut(ran, "generation-report.json") ?? ""));

const generateArgs = (spec: string, ...rest: readonly string[]) => [
  "generate",
  spec,
  "--config",
  "c.json",
  "--out",
  "out",
  ...rest,
];

describe("generator CLI", () => {
  test("--version prints the generator's package version", () => {
    const ran = cli(["--version"]);

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain(generatorPackage.version);
  });

  test("--help lists generate, validate and verdict", () => {
    const ran = cli(["--help"]);

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("generate");
    expect(ran.stdout).toContain("validate");
    expect(ran.stdout).toContain("verdict");
  });

  test("generate writes the golden package, exits 0 and prints one stderr line per diagnostic", () => {
    const ran = cli(generateArgs("openapi.json"), { spec: goldenText });
    const report = reportOf(ran);

    expect(ran.exitCode).toBe(0);
    expect(readOut(ran, "src/api/users.ts")).toBe(readFixture("expected/src/api/users.ts"));
    expect(readOut(ran, "src/cli/users.ts")).toBe(readFixture("expected/src/cli/users.ts"));
    expect(lines(ran.stderr)).toHaveLength(report.refusals.length + report.notices.length);
    expect(ran.stdout).toBe("");
  });

  test("generate reads the specification from stdin for -", () => {
    const ran = cli(generateArgs("-"), { stdin: goldenText });

    expect(ran.exitCode).toBe(0);
    expect(readOut(ran, "src/cli/users.ts")).toBe(readFixture("expected/src/cli/users.ts"));
  });

  test("generate --report json prints the written generation report on stdout", () => {
    const ran = cli(generateArgs("openapi.json", "--report", "json"), { spec: goldenText });

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toBe(readOut(ran, "generation-report.json") ?? "missing");
  });

  test("a document refusal exits 1 with one stderr line and writes nothing", () => {
    for (const text of ["{", "{}"]) {
      const ran = cli(generateArgs("-"), { stdin: text });

      expect(ran.exitCode).toBe(1);
      expect(lines(ran.stderr)).toHaveLength(1);
      expect(entries(ran.dir)).toEqual(["c.json"]);
    }
  });

  test("an operation refusal exits 0 and writes the rest; --strict exits 1 and writes nothing", () => {
    const partial = cli(generateArgs("openapi.json"), { spec: withTextBody });
    const refusals = reportOf(partial).refusals.map((diagnostic) => diagnostic.code);

    expect(partial.exitCode).toBe(0);
    expect(refusals).toContain("EMT-1/unsupported-body");
    expect(readOut(partial, "src/cli/notes.ts")).toBeUndefined();
    expect(readOut(partial, "src/cli/users.ts")).toBe(readFixture("expected/src/cli/users.ts"));

    const strict = cli(generateArgs("openapi.json", "--strict"), { spec: withTextBody });

    expect(strict.exitCode).toBe(1);
    expect(entries(strict.dir)).toEqual(["c.json", "openapi.json"]);
  });

  test("validate checks the golden spec, exits 0 and writes no file", () => {
    const ran = cli(["validate", "openapi.json"], { spec: goldenText });

    expect(ran.exitCode).toBe(0);
    expect(entries(ran.dir)).toEqual(["c.json", "openapi.json"]);
  });

  test("validate exits 1 on a document refusal from stdin and writes no file", () => {
    const ran = cli(["validate", "-"], { stdin: "{" });

    expect(ran.exitCode).toBe(1);
    expect(lines(ran.stderr)).toHaveLength(1);
    expect(entries(ran.dir)).toEqual(["c.json"]);
  });

  test("verdict prints the verdict class and writes no file", () => {
    const golden = cli(["verdict", "openapi.json", "--config", "c.json"], { spec: goldenText });
    const partial = cli(["verdict", "openapi.json", "--config", "c.json"], { spec: withTextBody });
    const refused = cli(["verdict", "-", "--config", "c.json"], { stdin: "{" });

    expect([golden.exitCode, partial.exitCode, refused.exitCode]).toEqual([0, 0, 0]);
    expect(golden.stdout).toBe("accepted\n");
    expect(partial.stdout).toBe("partly-refused\n");
    expect(refused.stdout).toBe("refused\n");
    expect(entries(golden.dir)).toEqual(["c.json", "openapi.json"]);
    expect(entries(refused.dir)).toEqual(["c.json"]);
  });
});
