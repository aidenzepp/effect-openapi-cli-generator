import { describe, expect, test } from "bun:test";
import nodePath from "node:path";
import { Array as Arr, Effect, Exit, Order, Schema } from "effect";
import { Diagnostic } from "../../src/model/diagnostic.ts";
import { JsonPointer } from "../../src/model/brands.ts";
import { Verdict, VerdictCoverage } from "../../src/model/verdict.ts";
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
  scope: "document" | "element" | "field" | "operation",
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

const fieldRefusal = make(
  "refusal",
  "field",
  "PRM-27/compound-nested",
  "/paths/~1x/post/requestBody/content/application~1x-www-form-urlencoded/encoding/metadata",
);

const noCoverage = { byNotice: [], checked: true, invented: [], missing: [] };

const input = (diagnostics: readonly Diagnostic[]): VerdictInput => ({
  commandNames: [],
  corpusVersion: 1,
  coverage: noCoverage,
  diagnostics,
  generator: { config: "corpus/config/x.json", configSha256: "a".repeat(64), version: "0.1.0" },
  informational: 2,
  nonStandard: [],
  operations: { generated: 5, total: 8 },
  spec: { id: "x", openapi: "3.0.0", sha256: "b".repeat(64) },
  twinEquality: { checked: true, equal: true },
});

const doc = "https://example.com/spec.json";

// Every walk kind and every claim kind once, as the corpus run hands them over (design 8.2).
const coverage = Schema.decodeUnknownSync(VerdictCoverage)({
  byNotice: [
    {
      document: doc,
      in: "header",
      kind: "parameter",
      name: "X-Trace",
      pointer: "/paths/~1x/get/parameters/1",
    },
  ],
  checked: true,
  invented: [
    { kind: "command", path: ["ghost"] },
    { kind: "requestMedia", mediaType: "text/csv", path: ["x", "get"] },
    { key: "418", kind: "response", path: ["x", "get"] },
    { kind: "securityAlternative", path: ["x", "get"], schemes: ["basic", "key"] },
    { kind: "server", path: ["x", "get"], url: "https://other.example" },
  ],
  missing: [
    { document: doc, kind: "operation", pointer: "/paths/~1y/post" },
    {
      document: doc,
      in: "query",
      kind: "parameter",
      name: "q",
      pointer: "/paths/~1x/get/parameters/0",
    },
    {
      document: doc,
      kind: "requestMedia",
      mediaType: "application/json",
      pointer: "/paths/~1y/post/requestBody/content/application~1json",
    },
    { document: doc, key: "200", kind: "response", pointer: "/paths/~1y/post/responses/200" },
    { document: doc, kind: "securityAlternative", pointer: "/security/0", schemes: [] },
    { document: doc, kind: "server", pointer: "/servers/0", url: "https://api.example.com" },
  ],
});

const nonStandard = [
  {
    choice: "deepObjectBrackets",
    pointer: Schema.decodeUnknownSync(JsonPointer)("/paths/~1x/get/parameters/2"),
    row: "PRM-27",
  },
] as const;

const commandNames = (
  ["config", "operationId", "route", "route", "x-fern", "x-forge", "x-forge"] as const
).map((command) => ({ command }));

const full = (diagnostics: readonly Diagnostic[]): VerdictInput => ({
  ...input(diagnostics),
  commandNames,
  coverage,
  nonStandard,
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

  test("a field refusal is partly-refused", () => {
    expect(classifyVerdict([fieldRefusal])).toBe("partly-refused");
    expect(classifyVerdict([notice, fieldRefusal])).toBe("partly-refused");
  });

  test("a document refusal is refused, whatever else is present", () => {
    expect(classifyVerdict([documentRefusal])).toBe("refused");
    expect(classifyVerdict([operationRefusal, documentRefusal, notice])).toBe("refused");
  });
});

describe("makeVerdict", () => {
  const list = [operationRefusal, notice, elementRefusal, fieldRefusal, documentRefusal];

  const verdict = makeVerdict(input(list));

  const encoded = Schema.encodeSync(Verdict)(verdict);

  test("counts come from the diagnostic list and the supplied operation totals", () => {
    expect(verdict.counts).toEqual({
      informational: 2,
      nonStandard: 0,
      notices: 1,
      operations: { generated: 5, refused: 3, total: 8 },
      refusals: { document: 1, element: 1, field: 1, operation: 1 },
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
      {
        code: "PRM-27/compound-nested",
        pointer: fieldRefusal.pointer,
        row: "PRM-27",
        scope: "field",
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

describe("revision 19 fields", () => {
  const verdict = makeVerdict(full([elementRefusal, notice]));

  const text = Effect.runSync(printVerdict(verdict));

  test("a verdict carrying every new field round-trips through the codec in the printer layout", () => {
    expect(Schema.decodeUnknownSync(Verdict)(JSON.parse(text))).toEqual(verdict);
    expect(verdict.coverage).toEqual(coverage);
    expect(verdict.nonStandard).toEqual(nonStandard);
    expect(verdict.counts.nonStandard).toBe(1);
    expect(verdict.commandSources).toEqual({ config: 1, fern: 1, fold: 3, forge: 2 });

    const result = Bun.spawnSync([vp, "fmt", "--stdin-filepath=tests/report/verdict.json"], {
      cwd: root,
      stdin: new TextEncoder().encode(text),
    });

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe(text);
  }, 30_000);

  test("missing lists walk elements only: no invented claim and no string", () => {
    const { missing } = Schema.encodeSync(Verdict)(verdict).coverage;

    expect(missing.map((element) => element.kind)).toEqual([
      "operation",
      "parameter",
      "requestMedia",
      "response",
      "securityAlternative",
      "server",
    ]);
    expect(JSON.stringify(missing)).not.toContain("invented");
    expect(verdict.coverage.invented).toHaveLength(5);
  });

  test("a non-standard entry never changes the verdict", () => {
    for (const list of [[], [notice], [elementRefusal], [documentRefusal]]) {
      expect(makeVerdict(full(list)).verdict).toBe(makeVerdict(input(list)).verdict);
    }
  });
});

describe("field scope (revision 30)", () => {
  const verdict = makeVerdict(input([fieldRefusal, notice]));

  const text = Effect.runSync(printVerdict(verdict));

  test("a report with one field refusal counts it and lists its scope", () => {
    expect(verdict.counts.refusals).toEqual({ document: 0, element: 0, field: 1, operation: 0 });
    expect(Schema.encodeSync(Verdict)(verdict).refusals).toEqual([
      {
        code: "PRM-27/compound-nested",
        pointer: fieldRefusal.pointer,
        row: "PRM-27",
        scope: "field",
      },
    ]);
    expect(verdict.verdict).toBe("partly-refused");
  });

  test("the refusal count keys print alphabetically and the file decodes back", () => {
    const keys = ['"document"', '"element"', '"field"', '"operation"'].map((key) =>
      text.indexOf(key, text.indexOf('"refusals"')),
    );

    expect(keys.every((index) => index > 0)).toBe(true);
    expect(keys).toEqual(Arr.sort(keys, Order.Number));
    expect(Schema.decodeUnknownSync(Verdict)(JSON.parse(text))).toEqual(verdict);
  });
});
