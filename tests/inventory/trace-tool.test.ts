import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tool = path.join(import.meta.dir, "..", "..", "tools", "inventory-trace.ts");

interface RowInput {
  readonly id: string;
  readonly disposition?: "implemented" | "refused" | "informational";
  readonly coveredBy?: readonly string[];
}

interface Tree {
  readonly rows: readonly RowInput[];
  readonly deferred?: readonly { row: string; deferred: string; milestone2?: string }[];
  readonly split?: readonly { row: string; halves: readonly string[] }[];
  readonly tests?: Readonly<Record<string, string>>;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const makeRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "trace-"));

  roots.push(root);

  return root;
};

const run = (root: string, ...args: string[]) => {
  const result = Bun.spawnSync(["bun", tool, ...args], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    code: result.exitCode,
    lines: result.stdout.toString().split("\n").filter(Boolean),
  };
};

/**
 * Write a mini tree and run the tool over it through `--root`.
 */
const trace = (tree: Tree, ...args: string[]) => {
  const root = makeRoot();
  const inventory = path.join(root, "tests", "inventory");

  mkdirSync(inventory, { recursive: true });
  writeFileSync(
    path.join(inventory, "rows.json"),
    JSON.stringify(
      tree.rows.map((r) => ({
        coveredBy: [],
        disposition: "implemented",
        versions: ["3.0.4"],
        ...r,
      })),
    ),
  );
  writeFileSync(path.join(inventory, "deferred.json"), JSON.stringify(tree.deferred ?? []));
  writeFileSync(path.join(inventory, "split-rows.json"), JSON.stringify(tree.split ?? []));
  for (const [name, text] of Object.entries(tree.tests ?? {})) {
    mkdirSync(path.dirname(path.join(root, "tests", name)), { recursive: true });
    writeFileSync(path.join(root, "tests", name), text);
  }

  return run(import.meta.dir, "--root", root, ...args);
};

const titled = (...titles: string[]) =>
  titles.map((title) => `test(${JSON.stringify(title)}, () => {});`).join("\n");

const todo = (title: string) => `test.todo(${JSON.stringify(title)});`;

const split = [{ halves: ["request", "response"], row: "MED-03" }];

describe("inventory-trace statuses", () => {
  test("a row with a titled test is covered", () => {
    const { lines } = trace({
      rows: [{ id: "ZZZ-01" }],
      tests: { "a.test.ts": titled("ZZZ-01: x") },
    });

    expect(lines).toEqual(["ZZZ-01 covered"]);
  });

  test("a whole-deferred row that also has a test is deferred", () => {
    const { lines } = trace({
      deferred: [{ deferred: "whole", row: "OAF-01" }],
      rows: [{ id: "OAF-01" }],
      tests: { "a.test.ts": titled("OAF-01: x") },
    });

    expect(lines).toEqual(["OAF-01 deferred"]);
  });

  test("a test.todo title is todo, and a plain test beside it makes the row covered", () => {
    const only = trace({ rows: [{ id: "ZZZ-01" }], tests: { "a.test.ts": todo("ZZZ-01: x") } });
    const both = trace({
      rows: [{ id: "ZZZ-01" }],
      tests: { "a.test.ts": `${todo("ZZZ-01: x")}\n${titled("ZZZ-01: y")}` },
    });

    expect(only.lines).toEqual(["ZZZ-01 todo"]);
    expect(both.lines).toEqual(["ZZZ-01 covered"]);
  });

  test("a row id inside a comment is not a title", () => {
    const { lines } = trace({
      rows: [{ id: "ZZZ-01" }],
      tests: {
        "a.test.ts": `// test("ZZZ-01: x", () => {});\n/* test("ZZZ-01: y", () => {}); */\n${titled("ZZZ-02: z")}`,
      },
    });

    expect(lines).toEqual(["ZZZ-01 missing"]);
  });

  test("titles are found in nested test directories and in it() calls", () => {
    const { lines } = trace({
      rows: [{ id: "ZZZ-01" }],
      tests: { "deep/er/a.test.ts": `it("ZZZ-01: x", () => {});` },
    });

    expect(lines).toEqual(["ZZZ-01 covered"]);
  });

  test("an informational row with no test is informational and exits 0 under --check", () => {
    const { code, lines } = trace(
      { rows: [{ disposition: "informational", id: "INF-01" }] },
      "--check",
    );

    expect(lines).toEqual(["INF-01 informational"]);
    expect(code).toBe(0);
  });

  test("a row with a coveredBy clause and no test of its own is delegated", () => {
    const { lines } = trace({
      rows: [{ coveredBy: ["ZZZ-02"], id: "ZZZ-01" }, { id: "ZZZ-02" }],
      tests: { "a.test.ts": titled("ZZZ-02: x") },
    });

    expect(lines).toEqual(["ZZZ-01 delegated", "ZZZ-02 covered"]);
  });
});

describe("inventory-trace split rows", () => {
  const deferred = [{ deferred: "response", milestone2: "request", row: "MED-03" }];

  test("a test lacking its half tag does not cover the row", () => {
    const { lines } = trace({
      deferred,
      rows: [{ id: "MED-03" }],
      split,
      tests: { "a.test.ts": titled("MED-03: x") },
    });

    expect(lines).toEqual(["MED-03 (request) missing", "MED-03 (response) deferred"]);
  });

  test("the Milestone 2 half title covers the row while the other half is deferred", () => {
    const { lines } = trace({
      deferred,
      rows: [{ id: "MED-03" }],
      split,
      tests: { "a.test.ts": titled("MED-03 (request): x") },
    });

    expect(lines).toEqual(["MED-03 (request) covered", "MED-03 (response) deferred"]);
  });

  test("a todo for the required half makes the row todo", () => {
    const { lines } = trace({
      deferred,
      rows: [{ id: "MED-03" }],
      split,
      tests: { "a.test.ts": todo("MED-03 (request): x") },
    });

    expect(lines).toEqual(["MED-03 (request) todo", "MED-03 (response) deferred"]);
  });

  test("with the deferral gone both halves are required: one half title is missing", () => {
    const { lines } = trace({
      rows: [{ id: "MED-03" }],
      split,
      tests: { "a.test.ts": titled("MED-03 (request): x") },
    });

    expect(lines).toEqual(["MED-03 (request) covered", "MED-03 (response) missing"]);
  });

  test("with the deferral gone both half titles cover the row", () => {
    const { lines } = trace({
      rows: [{ id: "MED-03" }],
      split,
      tests: { "a.test.ts": titled("MED-03 (request): x", "MED-03 (response): y") },
    });

    expect(lines).toEqual(["MED-03 (request) covered", "MED-03 (response) covered"]);
  });

  test("with the deferral gone a bare title covers neither half", () => {
    const { lines } = trace({
      rows: [{ id: "MED-03" }],
      split,
      tests: { "a.test.ts": titled("MED-03: x") },
    });

    expect(lines).toEqual(["MED-03 (request) missing", "MED-03 (response) missing"]);
  });

  test("a title naming a half the row does not have covers nothing", () => {
    const { lines } = trace({
      rows: [{ id: "MED-03" }],
      split,
      tests: { "a.test.ts": titled("MED-03 (nope): x") },
    });

    expect(lines).toEqual(["MED-03 (request) missing", "MED-03 (response) missing"]);
  });
});

describe("inventory-trace exit statuses", () => {
  const tests = { "a.test.ts": `${titled("ZZZ-01: x")}\n${todo("ZZZ-02: y")}` };
  const missing = { rows: [{ id: "ZZZ-01" }, { id: "ZZZ-03" }], tests };
  const todos = { rows: [{ id: "ZZZ-01" }, { id: "ZZZ-02" }], tests };
  const delegated = { rows: [{ id: "ZZZ-01" }, { coveredBy: ["ZZZ-01"], id: "ZZZ-04" }], tests };

  test("report mode exits 0 on a missing row", () => {
    const { code, lines } = trace(missing);

    expect(lines).toEqual(["ZZZ-01 covered", "ZZZ-03 missing"]);
    expect(code).toBe(0);
  });

  test("--check exits 1 on a missing, a todo and a delegated row, and 0 when all are covered", () => {
    expect(trace(missing, "--check").code).toBe(1);
    expect(trace(todos, "--check").code).toBe(1);
    expect(trace(delegated, "--check").code).toBe(1);
    expect(trace({ rows: [{ id: "ZZZ-01" }], tests }, "--check").code).toBe(0);
  });

  test("--check --allow-todo exits 1 on a missing row and 0 on todo and delegated rows", () => {
    expect(trace(missing, "--check", "--allow-todo").code).toBe(1);
    expect(trace(todos, "--check", "--allow-todo").code).toBe(0);
    expect(trace(delegated, "--check", "--allow-todo").code).toBe(0);
  });

  test("a whole-deferred row with no test never fails --check", () => {
    const { code } = trace(
      { deferred: [{ deferred: "whole", row: "OAF-01" }], rows: [{ id: "OAF-01" }] },
      "--check",
    );

    expect(code).toBe(0);
  });

  test("--only judges and reports only matching rows", () => {
    const { code, lines } = trace(missing, "--check", "--only", "^ZZZ-01$");

    expect(lines).toEqual(["ZZZ-01 covered"]);
    expect(code).toBe(0);
  });

  test("a missing inventory exits 1 and an unknown or misplaced flag exits 2", () => {
    expect(run(makeRoot(), "--root", makeRoot()).code).toBe(1);
    expect(run(makeRoot(), "--bogus").code).toBe(2);
    expect(run(makeRoot(), "--allow-todo").code).toBe(2);
  });
});
