import { describe, expect, test } from "bun:test";
import nodePath from "node:path";
import { Effect, Exit, Schema } from "effect";
import { Diagnostic } from "../../src/model/diagnostic.ts";
import { Verdict } from "../../src/model/verdict.ts";
import { classifyVerdict, makeVerdict, printVerdict } from "../../src/report/verdict.ts";
import type { VerdictInput } from "../../src/report/verdict.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const vp = nodePath.resolve(root, "node_modules/.bin/vp");

const base = {
  document: "file:///spec.json",
  element: "Parameter style deepObject",
  message: "deepObject value has nested objects",
  openapi: "3.0.3",
  specSection: "https://spec.openapis.org/oas/v3.0.4.html#style-values",
};

const make = (
  severity: "notice" | "refusal",
  scope: "document" | "element" | "operation",
  code: string,
  pointer: string,
) =>
  Schema.decodeUnknownSync(Diagnostic)({
    ...base,
    code,
    pointer,
    row: code.split("/")[0],
    scope,
    severity,
  });

const documentRefusal = make("refusal", "document", "DOC-1/unsupported-version", "");

const operationRefusal = make("refusal", "operation", "PRM-27/compound-nested", "/paths/~1x/get");

const elementRefusal = make("refusal", "element", "PRM-9/ignored-style", "/paths/~1x/get/p/0");

const notice = make("notice", "element", "PRM-19/ignored-header", "/paths/~1x/get/p/1");

const input = (diagnostics: readonly Diagnostic[]): VerdictInput => ({
  corpusVersion: 1,
  coverage: { checked: true, missing: [] },
  diagnostics,
  generator: { config: "corpus/config/x.json", configSha256: "a".repeat(64), version: "0.1.0" },
  informational: 2,
  operations: { generated: 5, total: 8 },
  spec: { id: "x", openapi: "3.0.0", sha256: "b".repeat(64) },
  twinEquality: { checked: true, equal: true },
});

const print = (diagnostics: readonly Diagnostic[]) =>
  Effect.runSync(printVerdict(makeVerdict(input(diagnostics))));

describe("classifyVerdict", () => {
  test("no refusals is accepted, notices included", () => {
    expect(classifyVerdict([])).toBe("accepted");
    expect(classifyVerdict([notice])).toBe("accepted");
  });

  test("an operation or element refusal is partly-refused", () => {
    expect(classifyVerdict([operationRefusal])).toBe("partly-refused");
    expect(classifyVerdict([notice, elementRefusal])).toBe("partly-refused");
  });

  test("a document refusal is refused, whatever else is present", () => {
    expect(classifyVerdict([documentRefusal])).toBe("refused");
    expect(classifyVerdict([operationRefusal, documentRefusal, notice])).toBe("refused");
  });
});

describe("makeVerdict", () => {
  const list = [operationRefusal, notice, elementRefusal, documentRefusal];

  const verdict = makeVerdict(input(list));

  const encoded = Schema.encodeSync(Verdict)(verdict);

  test("counts come from the diagnostic list and the supplied operation totals", () => {
    expect(verdict.counts).toEqual({
      informational: 2,
      notices: 1,
      operations: { generated: 5, refused: 3, total: 8 },
      refusals: { document: 1, element: 1, operation: 1 },
    });
  });

  test("refusals and notices are listed in full, in diagnostic order", () => {
    expect(encoded.refusals).toEqual([
      {
        code: "PRM-27/compound-nested",
        pointer: "/paths/~1x/get",
        row: "PRM-27",
        scope: "operation",
      },
      {
        code: "PRM-9/ignored-style",
        pointer: "/paths/~1x/get/p/0",
        row: "PRM-9",
        scope: "element",
      },
      { code: "DOC-1/unsupported-version", pointer: "", row: "DOC-1", scope: "document" },
    ]);
    expect(encoded.notices).toEqual([
      { code: "PRM-19/ignored-header", pointer: "/paths/~1x/get/p/1", row: "PRM-19" },
    ]);
    expect(verdict.verdict).toBe("refused");
  });

  test("the value passes the Verdict schema", () => {
    expect(
      Exit.isSuccess(Schema.decodeUnknownExit(Verdict)(Schema.encodeSync(Verdict)(verdict))),
    ).toBe(true);
  });
});

describe("printVerdict", () => {
  test("the same input prints the same bytes", () => {
    const list = [operationRefusal, notice];

    expect(print(list)).toBe(print(list));
    expect(print(list).endsWith("}\n")).toBe(true);
  });

  test("keys are sorted and the file decodes back to the value", () => {
    const text = print([elementRefusal]);

    expect(text.indexOf('"corpusVersion"')).toBeLessThan(text.indexOf('"verdict"'));
    expect(Schema.decodeUnknownSync(Verdict)(JSON.parse(text))).toEqual(
      makeVerdict(input([elementRefusal])),
    );
  });

  test("a negative count fails with a schema error", () => {
    const bad = { ...makeVerdict(input([])), corpusVersion: -1 };

    expect(Exit.isFailure(Effect.runSyncExit(printVerdict(bad)))).toBe(true);
  });

  test("printed files are vp fmt fixed points", () => {
    for (const list of [
      [],
      [notice],
      [operationRefusal, elementRefusal, notice],
      [documentRefusal],
    ]) {
      const text = print(list);
      const result = Bun.spawnSync([vp, "fmt", "--stdin-filepath=tests/report/verdict.json"], {
        cwd: root,
        stdin: new TextEncoder().encode(text),
      });

      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).toBe(text);
    }
  }, 30_000);
});
