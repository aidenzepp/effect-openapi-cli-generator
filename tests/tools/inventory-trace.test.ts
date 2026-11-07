import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import * as InventoryTrace from "../../tools/inventory-trace.ts";

const { traceRows, titlesOf } = InventoryTrace;

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

describe("inventory trace: row id forms", () => {
  test("TRC-05: an id whose prefix holds a digit is counted", () => {
    expect(titlesOf(`test("S30-12: works", () => {});`)).toEqual([
      { half: undefined, id: "S30-12", todo: false },
    ]);
  });

  test("TRC-06: a letters-only prefix is still counted", () => {
    expect(titlesOf(`test("SCO-03: works", () => {});`)).toEqual([
      { half: undefined, id: "SCO-03", todo: false },
    ]);
  });

  test("TRC-07: a title that is not a row id is ignored", () => {
    expect(
      titlesOf(`test("works without an id", () => {});\ntest("3S-01: bad", () => {});`),
    ).toEqual([]);
  });

  test("TRC-08: every id in rows.json matches the id pattern", () => {
    const text = readFileSync(new URL("../inventory/rows.json", import.meta.url), "utf-8");
    const ids = [...text.matchAll(/"id":\s*"(?<id>[^"]+)"/gu)].map((match) => match.groups?.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => id === undefined || !InventoryTrace.rowIdPattern.test(id))).toEqual(
      [],
    );
  });
});
