import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Result } from "effect";

import * as InventoryTrace from "../../tools/inventory-trace.ts";

const { traceRows } = InventoryTrace;

const titlesOf = (source: string) => Result.getOrThrow(InventoryTrace.titlesOf(source));

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

const ids = (source: string) => titlesOf(source).map((title) => title.id);

describe("inventory trace: only real test calls are titles (audit S8)", () => {
  test("TRC-09: a test call inside a string or a template literal is not a title", () => {
    expect(ids(`const a = 'test("ZZZ-01: x", () => {})';`)).toEqual([]);
    expect(ids('const a = "test(\\"ZZZ-01: x\\", () => {})";')).toEqual([]);
    expect(ids('const a = `test("ZZZ-01: x", () => {})`;')).toEqual([]);
    expect(ids(`const a = \`\${b}test("ZZZ-01: x")\${c}\`;`)).toEqual([]);
  });

  test("TRC-10: a test call after a trailing // comment or inside a block comment is not a title", () => {
    expect(ids(`go(); // test("ZZZ-01: x", () => {});`)).toEqual([]);
    expect(ids(`go(); /* test("ZZZ-01: x", () => {}); */`)).toEqual([]);
  });

  test("TRC-11: a test under a skipped, todo or conditional describe is not a title", () => {
    for (const opener of [
      "describe.skip(",
      "describe.todo(",
      "describe.if(ok)(",
      "describe.skipIf(no)(",
    ]) {
      expect(ids(`${opener}"off", () => { test("ZZZ-01: x", () => {}); });`)).toEqual([]);
    }
  });

  test("TRC-12: a skipped describe ends at its closing parenthesis", () => {
    expect(
      ids(
        'describe.skip("off", () => { test("ZZZ-01: x", () => {}); });\ntest("ZZZ-02: y", () => {});',
      ),
    ).toEqual(["ZZZ-02"]);
  });

  test("TRC-13: describe and describe.each keep their tests; test.skip and test.each do not count", () => {
    expect(
      ids(
        'describe("on", () => { test("ZZZ-01: x", () => {}); });\ndescribe.each([1])("%s", () => { it("ZZZ-02: y", () => {}); });',
      ),
    ).toEqual(["ZZZ-01", "ZZZ-02"]);
    expect(
      ids('test.skip("ZZZ-01: x", () => {});\ntest.each([1])("ZZZ-02: %s", () => {});'),
    ).toEqual([]);
  });

  test("TRC-14: a template title with a substitution is read from its head", () => {
    expect(titlesOf(`test(\`ZZZ-01: \${name}\`, () => {});`)).toEqual([
      { half: undefined, id: "ZZZ-01", todo: false },
    ]);
  });

  test("TRC-15: a regular expression literal holding a quote or a slash does not hide later tests", () => {
    expect(
      ids('const r = /"[/]\\//u;\nconst q = a / b / c;\ntest("ZZZ-01: x", () => {});'),
    ).toEqual(["ZZZ-01"]);
  });

  test("TRC-16: a source the trace cannot tokenize is refused with the line", () => {
    for (const [source, reason] of [
      ['test("ZZZ-01: x");\nconst s = "open;', "unterminated string literal at line 2"],
      ["const s = `open", "unterminated template literal at line 1"],
      ["/* open", "unterminated block comment at line 1"],
      ["const r = /open\n", "unterminated regular expression at line 1"],
      ["go((", "unbalanced parentheses at line 1"],
    ] as const) {
      expect(InventoryTrace.titlesOf(source)).toEqual(Result.fail(reason));
    }
  });
});
