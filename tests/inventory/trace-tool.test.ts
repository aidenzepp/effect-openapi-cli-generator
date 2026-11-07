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

  const output = result.stdout.toString().split("\n").filter(Boolean);

  return {
    code: result.exitCode,
    lines: output.filter((line) => !line.startsWith("total ")),
    totals: output.filter((line) => line.startsWith("total ")),
  };
};

/**
 * The seven totals lines, in the tool's fixed order, from per-status counts.
 */
const totals = (counts: Readonly<Record<string, number>>) =>
  ["covered", "partial", "todo", "missing", "informational", "deferred", "delegated"].map(
    (status) => `total ${status} ${counts[status] ?? 0}`,
  );

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

  test("a test.todo title is todo, and a plain test beside it makes the row partial", () => {
    const only = trace({ rows: [{ id: "ZZZ-01" }], tests: { "a.test.ts": todo("ZZZ-01: x") } });
    const both = trace({
      rows: [{ id: "ZZZ-01" }],
      tests: { "a.test.ts": `${todo("ZZZ-01: x")}\n${titled("ZZZ-01: y")}` },
    });

    expect(only.lines).toEqual(["ZZZ-01 todo"]);
    expect(both.lines).toEqual(["ZZZ-01 partial (1 passing, 1 todo)"]);
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
      tests: { "a.test.ts": todo("ZZZ-02: x") },
    });

    expect(lines).toEqual(["ZZZ-01 delegated", "ZZZ-02 todo"]);
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
  const delegated = { rows: [{ id: "ZZZ-02" }, { coveredBy: ["ZZZ-02"], id: "ZZZ-04" }], tests };

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

describe("inventory-trace delegated rows", () => {
  const chain = [{ coveredBy: ["ZZZ-02"], id: "ZZZ-01" }, { id: "ZZZ-02" }];
  const wholeDeferred = [{ deferred: "whole", row: "OAF-01" }];

  test("a delegation chain with one uncovered target stays delegated, gated by --check only", () => {
    const tree = { rows: chain, tests: { "a.test.ts": todo("ZZZ-02: x") } };

    expect(trace(tree).lines).toEqual(["ZZZ-01 delegated", "ZZZ-02 todo"]);
    expect(trace(tree, "--check").code).toBe(1);
    expect(trace(tree, "--check", "--allow-todo").code).toBe(0);
  });

  test("the same chain once the target has a test is covered", () => {
    const { code, lines } = trace(
      { rows: chain, tests: { "a.test.ts": titled("ZZZ-02: x") } },
      "--check",
    );

    expect(lines).toEqual(["ZZZ-01 covered", "ZZZ-02 covered"]);
    expect(code).toBe(0);
  });

  test("a chain of two delegations resolves through the last target", () => {
    const rows = [
      { coveredBy: ["ZZZ-02"], id: "ZZZ-01" },
      { coveredBy: ["ZZZ-03"], id: "ZZZ-02" },
      { id: "ZZZ-03" },
    ];

    expect(trace({ rows }).lines).toEqual([
      "ZZZ-01 delegated",
      "ZZZ-02 delegated",
      "ZZZ-03 missing",
    ]);
    expect(trace({ rows, tests: { "a.test.ts": titled("ZZZ-03: x") } }).lines).toEqual([
      "ZZZ-01 covered",
      "ZZZ-02 covered",
      "ZZZ-03 covered",
    ]);
  });

  test("a delegation cycle is missing", () => {
    const tree = {
      rows: [
        { coveredBy: ["ZZZ-02"], id: "ZZZ-01" },
        { coveredBy: ["ZZZ-01"], id: "ZZZ-02" },
      ],
    };

    expect(trace(tree).lines).toEqual(["ZZZ-01 missing", "ZZZ-02 missing"]);
    expect(trace(tree, "--check", "--allow-todo").code).toBe(1);
  });

  test("a whole-deferred target passes through and the row is covered, naming it", () => {
    const { code, lines } = trace(
      {
        deferred: wholeDeferred,
        rows: [
          { coveredBy: ["OAF-01", "ZZZ-02"], id: "ZZZ-01" },
          { id: "OAF-01" },
          { id: "ZZZ-02" },
        ],
        tests: { "a.test.ts": titled("ZZZ-02: x") },
      },
      "--check",
    );

    expect(lines).toEqual([
      "ZZZ-01 covered (deferred: OAF-01)",
      "OAF-01 deferred",
      "ZZZ-02 covered",
    ]);
    expect(code).toBe(0);
  });

  test("with the deferral removed the target is required again and the row is delegated", () => {
    const rows = [
      { coveredBy: ["OAF-01", "ZZZ-02"], id: "ZZZ-01" },
      { id: "OAF-01" },
      { id: "ZZZ-02" },
    ];
    const tests = { "a.test.ts": titled("ZZZ-02: x") };

    expect(trace({ rows, tests }).lines).toEqual([
      "ZZZ-01 delegated",
      "OAF-01 missing",
      "ZZZ-02 covered",
    ]);
    expect(trace({ rows, tests: { "a.test.ts": titled("ZZZ-02: x", "OAF-01: y") } }).lines).toEqual(
      ["ZZZ-01 covered", "OAF-01 covered", "ZZZ-02 covered"],
    );
  });

  test("a row whose every target is whole-deferred is deferred when listed and missing when not", () => {
    const rows = [{ coveredBy: ["OAF-01"], id: "ZZZ-01" }, { id: "OAF-01" }];
    const entry = { deferred: "whole", row: "ZZZ-01" };

    expect(trace({ deferred: [...wholeDeferred, entry], rows }, "--check").lines).toEqual([
      "ZZZ-01 deferred",
      "OAF-01 deferred",
    ]);
    expect(trace({ deferred: wholeDeferred, rows }, "--check").code).toBe(1);
    expect(trace({ deferred: wholeDeferred, rows }).lines).toEqual([
      "ZZZ-01 missing",
      "OAF-01 deferred",
    ]);
  });

  test("--only on a delegated row still resolves a target outside the filter", () => {
    const { lines } = trace(
      { rows: chain, tests: { "a.test.ts": titled("ZZZ-02: x") } },
      "--only",
      "^ZZZ-01$",
    );

    expect(lines).toEqual(["ZZZ-01 covered"]);
  });
});

describe("inventory-trace totals", () => {
  const tree = {
    deferred: [
      { deferred: "response", milestone2: "request", row: "MED-03" },
      { deferred: "whole", row: "OAF-01" },
    ],
    rows: [
      { id: "ZZZ-01" },
      { id: "ZZZ-02" },
      { id: "ZZZ-03" },
      { coveredBy: ["ZZZ-02"], id: "ZZZ-04" },
      { id: "ZZZ-05" },
      { disposition: "informational" as const, id: "INF-01" },
      { id: "OAF-01" },
      { id: "MED-03" },
      { id: "RSP-04" },
    ],
    split: [...split, { halves: ["request", "response"], row: "RSP-04" }],
    tests: {
      "a.test.ts": [
        titled("ZZZ-01: x", "ZZZ-05: y", "MED-03 (request): z", "RSP-04 (request): w"),
        todo("ZZZ-02: x"),
        todo("ZZZ-05: z"),
      ].join("\n"),
    },
  };

  test("totals follow the row lines, one per status, counting a split row once by its worst half", () => {
    const { lines, totals: printed } = trace(tree);

    expect(lines).toEqual([
      "ZZZ-01 covered",
      "ZZZ-02 todo",
      "ZZZ-03 missing",
      "ZZZ-04 delegated",
      "ZZZ-05 partial (1 passing, 1 todo)",
      "INF-01 informational",
      "OAF-01 deferred",
      "MED-03 (request) covered",
      "MED-03 (response) deferred",
      "RSP-04 (request) covered",
      "RSP-04 (response) missing",
    ]);
    expect(printed).toEqual(
      totals({
        covered: 1,
        deferred: 2,
        delegated: 1,
        informational: 1,
        missing: 2,
        partial: 1,
        todo: 1,
      }),
    );
  });

  test("--check prints the same totals and keeps its exit status", () => {
    const strict = trace(tree, "--check");
    const lenient = trace(
      { ...tree, rows: tree.rows.filter((r) => r.id !== "ZZZ-03" && r.id !== "RSP-04") },
      "--check",
      "--allow-todo",
    );

    expect(strict.totals).toEqual(trace(tree).totals);
    expect(strict.code).toBe(1);
    expect(lenient.totals).toEqual(
      totals({ covered: 1, deferred: 2, delegated: 1, informational: 1, partial: 1, todo: 1 }),
    );
    expect(lenient.code).toBe(0);
  });

  test("--only totals count only the matching rows", () => {
    expect(trace(tree, "--only", "^(ZZZ-0[12]|MED-03)$").totals).toEqual(
      totals({ covered: 1, deferred: 1, todo: 1 }),
    );
  });

  test("an empty selection prints every total as zero", () => {
    expect(trace(tree, "--only", "^NONE-01$").totals).toEqual(totals({}));
  });
});
