import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Schema } from "effect";
import { GenerationReport } from "../src/report/index.ts";

const root = nodePath.resolve(import.meta.dir, "..");

const bin = nodePath.join(root, "src/bin.ts");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

const decodeRecord = Schema.decodeUnknownSync(JsonRecord);

const decodeReport = Schema.decodeUnknownSync(GenerationReport);

const readFixture = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const golden = decodeRecord(JSON.parse(readFixture("openapi.json")));

const goldenPaths = decodeRecord(golden.paths);

const goldenSchemas = decodeRecord(decodeRecord(golden.components).schemas);

const schemasUri = "https://schemas.example.com/users.json";

// A query string is part of the URI; the pair splits at the first `=`, so it holds none.
const avatarUri = "https://schemas.example.com/avatar.json?v1";

// The golden spec with every schema it names moved to the two documents above.
const crossDocument = JSON.stringify(golden)
  .replaceAll('"#/components/schemas/UserUpdate"', `"${schemasUri}#/UserUpdate"`)
  .replaceAll('"#/components/schemas/Error"', `"${schemasUri}#/Error"`)
  .replaceAll('"#/components/schemas/Avatar"', `"${avatarUri}#/Avatar"`);

const schemasDocument = JSON.stringify({
  Error: goldenSchemas.Error,
  UserUpdate: goldenSchemas.UserUpdate,
});

const avatarDocument = JSON.stringify({ Avatar: goldenSchemas.Avatar });

const pathsUri = "https://paths.example.com/users.json";

// The golden spec whose first Path Item is a reference into another document of the set.
const memberPathItem = JSON.stringify({
  ...golden,
  paths: { ...goldenPaths, "/users/{id}": { $ref: `${pathsUri}#/item` } },
});

const pathsDocument = JSON.stringify({
  item: {
    get: {
      operationId: "users-get",
      parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
      responses: { "204": { description: "The user exists." } },
      tags: ["users"],
    },
  },
});

const scratch = nodePath.join(root, "work", "generator-cli-documents");

nodeFs.rmSync(scratch, { force: true, recursive: true });

nodeFs.mkdirSync(scratch, { recursive: true });

afterAll(() => {
  nodeFs.rmSync(scratch, { force: true, recursive: true });
});

const decoder = new TextDecoder();

interface Ran {
  readonly dir: string;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

// Runs the generator CLI in `dir` with nothing on stdin.
const run = (dir: string, args: readonly string[]): Ran => {
  const result = Bun.spawnSync(["bun", bin, ...args], { cwd: dir, stdin: "ignore" });

  return {
    dir,
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  };
};

let runs = 0;

/**
 * Runs the generator CLI in a fresh directory holding the golden author config as `c.json` and
 * each of `files` under its relative name. Relative arguments resolve against that directory.
 */
const cli = (args: readonly string[], files: Readonly<Record<string, string>> = {}): Ran => {
  runs += 1;
  const dir = nodePath.join(scratch, `run-${runs}`);
  nodeFs.mkdirSync(dir);
  nodeFs.writeFileSync(nodePath.join(dir, "c.json"), readFixture("author-config.json"));
  for (const [name, text] of Object.entries(files)) {
    nodeFs.mkdirSync(nodePath.dirname(nodePath.join(dir, name)), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, name), text);
  }

  return run(dir, args);
};

// The diagnostic codes of the human stderr lines (`<severity> <code> at ...`).
const codes = (ran: Ran): readonly string[] =>
  ran.stderr
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" ")[1] ?? "");

const reportOf = (ran: Ran) =>
  decodeReport(
    JSON.parse(
      nodeFs.readFileSync(nodePath.join(ran.dir, "out", "generation-report.json"), "utf-8"),
    ),
  );

const generateArgs = (...rest: readonly string[]) => [
  "generate",
  "openapi.json",
  "--config",
  "c.json",
  "--out",
  "out",
  ...rest,
];

const crossDocumentFiles = {
  "avatar.json": avatarDocument,
  "openapi.json": crossDocument,
  "users.json": schemasDocument,
};

describe("generator CLI document set", () => {
  test("generate and validate --help list --document and --ref-root", () => {
    for (const command of ["generate", "validate"]) {
      const ran = cli([command, "--help"]);

      expect(ran.exitCode).toBe(0);
      expect(ran.stdout).toContain("--document");
      expect(ran.stdout).toContain("--ref-root");
    }
  });

  test("generate with two --document pairs resolves cross-document references and writes the package", () => {
    const ran = cli(
      generateArgs(
        "--document",
        `${schemasUri}=users.json`,
        "--document",
        `${avatarUri}=avatar.json`,
      ),
      crossDocumentFiles,
    );
    const report = reportOf(ran);

    expect(ran.exitCode).toBe(0);
    expect(report.refusals).toEqual([]);
    expect(report.inputs.map((input) => String(input.document))).toContain(
      `file://${nodePath.join(nodeFs.realpathSync(ran.dir), "openapi.json")}`,
    );
    expect(nodeFs.existsSync(nodePath.join(ran.dir, "out", "src", "cli", "users.ts"))).toBe(true);
  });

  test("the report lists each --document member with its hash, in set order, and is reproducible", () => {
    const args = generateArgs(
      "--document",
      `${schemasUri}=users.json`,
      "--document",
      `${avatarUri}=avatar.json`,
    );
    const ran = cli(args, crossDocumentFiles);
    const report = reportOf(ran);
    const hash = (name: string) =>
      createHash("sha256")
        .update(nodeFs.readFileSync(nodePath.join(ran.dir, name)))
        .digest("hex");

    expect(report.inputs.map((input) => String(input.document))).toEqual([
      `file://${nodePath.join(nodeFs.realpathSync(ran.dir), "openapi.json")}`,
      schemasUri,
      avatarUri,
      expect.stringMatching(/c\.json$/u),
    ]);
    expect(report.inputs.map((input) => input.sha256).slice(1, 3)).toEqual([
      hash("users.json"),
      hash("avatar.json"),
    ]);
    expect(reportOf(cli(args, crossDocumentFiles)).inputs.slice(1, 3)).toEqual(
      report.inputs.slice(1, 3),
    );
  });

  test("without the pairs the same references are outside the set and nothing is written", () => {
    const ran = cli(generateArgs(), crossDocumentFiles);

    expect(ran.exitCode).toBe(1);
    expect(codes(ran)).toContain("REF-16/outside-set");
    expect(nodeFs.existsSync(nodePath.join(ran.dir, "out"))).toBe(false);
  });

  test("validate resolves the same references through the pairs", () => {
    const ran = cli(
      [
        "validate",
        "openapi.json",
        "--document",
        `${schemasUri}=users.json`,
        "--document",
        `${avatarUri}=avatar.json`,
      ],
      crossDocumentFiles,
    );

    expect(ran.exitCode).toBe(0);
    expect(codes(ran).filter((code) => code.startsWith("REF-"))).toEqual([]);
  });

  test("validate --ref-root refuses a symlink escape at document scope and exits 1", () => {
    const outside = nodePath.join(scratch, "outside");
    nodeFs.mkdirSync(outside, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(outside, "secret.json"), "{}");

    const ran = cli(["validate", "openapi.json", "--ref-root", "refs"], {
      "openapi.json": readFixture("openapi.json"),
      "refs/kept.json": "{}",
    });

    nodeFs.symlinkSync(
      nodePath.join(outside, "secret.json"),
      nodePath.join(ran.dir, "refs", "escape.json"),
    );

    const escaped = run(ran.dir, ["validate", "openapi.json", "--ref-root", "refs"]);

    expect(ran.exitCode).toBe(0);
    expect(escaped.exitCode).toBe(1);
    expect(codes(escaped)).toEqual(["REF-16/outside-root"]);
  });

  test("an entry inside --ref-root is one document with its preloaded copy", () => {
    const ran = cli(["validate", "specs/openapi.json", "--ref-root", "specs"], {
      "specs/openapi.json": readFixture("openapi.json"),
    });

    expect(ran.exitCode).toBe(0);
    expect(codes(ran).filter((code) => code.startsWith("REF-"))).toEqual([]);
  });

  test("a --document pair under the entry's own URI for another file is refused as a duplicate", () => {
    const files = { "openapi.json": readFixture("openapi.json"), "other.json": "{}" };
    const first = cli(["validate", "openapi.json"], files);
    const entryUri = `file://${nodePath.join(nodeFs.realpathSync(first.dir), "openapi.json")}`;
    const same = run(first.dir, [
      "validate",
      "openapi.json",
      "--document",
      `${entryUri}=openapi.json`,
    ]);
    const other = run(first.dir, [
      "validate",
      "openapi.json",
      "--document",
      `${entryUri}=other.json`,
    ]);

    expect(same.exitCode).toBe(0);
    expect(other.exitCode).toBe(1);
    expect(codes(other)).toEqual(["REF-16/duplicate-uri"]);
  });

  test("PTH-10: a Path Item reference into another document is refused, not dropped silently", () => {
    const files = { "openapi.json": memberPathItem, "paths.json": pathsDocument };
    const pair = `${pathsUri}=paths.json`;
    const generated = cli(generateArgs("--document", pair), files);
    const validated = cli(["validate", "openapi.json", "--document", pair], files);
    const strict = cli(generateArgs("--document", pair, "--strict"), files);

    expect(generated.exitCode).toBe(0);
    expect(reportOf(generated).refusals.map((diagnostic) => diagnostic.code)).toEqual([
      "PTH-10/other-document",
    ]);
    expect(String(reportOf(generated).refusals[0]?.pointer)).toBe("/paths/~1users~1{id}");
    expect(codes(validated)).toContain("PTH-10/other-document");
    expect(validated.exitCode).toBe(0);
    expect(strict.exitCode).toBe(1);
  });
});
