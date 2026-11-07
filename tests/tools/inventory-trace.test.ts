import { describe, expect, test } from "bun:test";

import { traceRows, titlesOf } from "../../tools/inventory-trace.ts";

const row = (id: string, coveredBy: readonly string[] = []) => ({
  coveredBy,
  disposition: "implemented" as const,
  id,
});

const trace = (source: string, rows: ReturnType<typeof row>[]) =>
  traceRows({ deferred: [], rows, splits: [], titles: titlesOf(source) });

describe("inventory trace: todo is never covered", () => {
  test("TRC-01: a row with only passing tests is covered", () => {
    const reports = trace(`test("TRC-01: works", () => {});`, [row("TRC-01")]);

    expect(reports).toEqual([{ id: "TRC-01", status: "covered" }]);
  });

  test("TRC-02: a row with passing and todo tests is partial, with both counts", () => {
    const reports = trace(
      `test("TRC-01: works", () => {});\ntest("TRC-01: more", () => {});\ntest.todo("TRC-01: gap");`,
      [row("TRC-01")],
    );

    expect(reports).toEqual([{ id: "TRC-01", passing: 2, status: "partial", todo: 1 }]);
  });

  test("TRC-03: a row with only todo tests is todo", () => {
    const reports = trace(`test.todo("TRC-01: gap");`, [row("TRC-01")]);

    expect(reports).toEqual([{ id: "TRC-01", status: "todo" }]);
  });

  test("TRC-04: a row with coveredBy and no tests of its own is unchanged", () => {
    const reports = trace(`test("TRC-02: works", () => {});`, [
      row("TRC-01", ["TRC-02"]),
      row("TRC-02"),
    ]);

    expect(reports).toEqual([
      { id: "TRC-01", status: "covered" },
      { id: "TRC-02", status: "covered" },
    ]);
  });
});
