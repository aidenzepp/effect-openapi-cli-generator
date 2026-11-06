import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

const tool = path.join(import.meta.dir, "..", "..", "tools", "inventory-export.ts");

const fixtures = path.join(import.meta.dir, "fixtures", "export");

const Rows = Schema.Array(
  Schema.Struct({ coveredBy: Schema.Array(Schema.String), id: Schema.String }),
);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const makeRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "export-"));

  roots.push(root);

  return root;
};

const run = (...args: string[]) => {
  const result = Bun.spawnSync(["bun", tool, ...args], { stderr: "pipe", stdout: "pipe" });

  return { code: result.exitCode, stderr: result.stderr.toString() };
};

/**
 * Export a fixture inventory into a fresh directory; the rows file is read back when it exists.
 */
const exportFixture = (name: string) => {
  const out = path.join(makeRoot(), "rows.json");
  const result = run(path.join(fixtures, `${name}.md`), out);

  return { ...result, out, text: result.code === 0 ? readFileSync(out, "utf-8") : "" };
};

describe("inventory-export", () => {
  test("a six-cell row of each disposition is exported with its fields, in inventory order", () => {
    const { code, text } = exportFixture("valid");

    expect(code).toBe(0);
    expect(JSON.parse(text)).toEqual([
      {
        coveredBy: [],
        disposition: "implemented",
        id: "BIN-01",
        versions: ["3.0.4", "3.1.2"],
      },
      {
        coveredBy: [],
        disposition: "refused",
        id: "BIN-02",
        versions: ["3.0.4", "3.1.2", "3.2.1"],
      },
      { coveredBy: [], disposition: "informational", id: "BIN-03", versions: ["3.2.1"] },
      {
        coveredBy: ["BIN-01", "BIN-02"],
        disposition: "implemented",
        id: "BIN-04",
        versions: ["3.0.4"],
      },
      { coveredBy: ["BIN-02"], disposition: "implemented", id: "BIN-05", versions: ["3.0.4"] },
    ]);
  });

  test("the output uses the printer layout: sorted keys, short arrays flat, final newline", () => {
    const { text } = exportFixture("valid");

    expect(text.endsWith("]\n")).toBe(true);
    expect(text).toContain('    "coveredBy": ["BIN-01", "BIN-02"],\n');
    expect(text).toContain('    "versions": ["3.0.4", "3.1.2", "3.2.1"]\n');
  });

  test("a derived-sources four-cell line is ignored", () => {
    const { text } = exportFixture("valid");

    expect(text).not.toContain("DRV-01");
  });

  test("a covered by clause becomes the explicit id list", () => {
    const rows = Schema.decodeUnknownSync(Schema.fromJsonString(Rows))(exportFixture("valid").text);

    expect(rows.find((row) => row.id === "BIN-05")?.coveredBy).toEqual(["BIN-02"]);
  });

  test.each([
    ["see-glob", "BIN-09"],
    ["see-range", "BIN-09"],
    ["see-prose", "BIN-09"],
    ["covered-informational", "BIN-09"],
    ["covered-prose", "BIN-09"],
    ["covered-unknown", "BIN-09"],
  ])("%s is rejected with exit 1 naming the row", (name, row) => {
    const { code, stderr } = exportFixture(name);

    expect(code).toBe(1);
    expect(stderr).toContain(row);
  });

  test("--check exits 0 on an equal file and 1 after one byte changes", () => {
    const { out } = exportFixture("valid");
    const input = path.join(fixtures, "valid.md");

    expect(run("--check", input, out).code).toBe(0);
    writeFileSync(out, readFileSync(out, "utf-8").replace("BIN-05", "BIN-06"));
    expect(run("--check", input, out).code).toBe(1);
  });

  test("--check exits 1 on a missing file and a bad command line exits 2", () => {
    const missing = path.join(makeRoot(), "absent.json");

    expect(run("--check", path.join(fixtures, "valid.md"), missing).code).toBe(1);
    expect(run(path.join(fixtures, "valid.md")).code).toBe(2);
  });
});
