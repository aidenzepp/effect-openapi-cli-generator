import { describe, expect, test } from "bun:test";
import { Array as Arr, Exit, Schema } from "effect";
import { Diagnostic, sortDiagnostics } from "../../src/model/diagnostic.ts";
import { Verdict } from "../../src/model/verdict.ts";

const base: typeof Diagnostic.Encoded = {
  code: "PRM-27/compound-nested",
  column: 3,
  document: "file:///spec.json",
  element: "Parameter style deepObject",
  line: 12,
  message: "deepObject value has nested objects",
  openapi: "3.0.3",
  pointer: "/paths/~1x/get/parameters/0",
  row: "PRM-27",
  scope: "element",
  severity: "refusal",
  specSection: "https://spec.openapis.org/oas/v3.0.4.html#style-values",
};

const keys = (list: readonly Diagnostic[]) =>
  list.map((d) => `${d.document}${d.pointer}|${d.code}`);

const decode = Schema.decodeUnknownExit(Diagnostic);

const make = (document: string, pointer: string, code: string) =>
  Schema.decodeUnknownSync(Diagnostic)({ ...base, code, document, pointer, row: "PRM-1" });

describe("Diagnostic", () => {
  test("a well-formed diagnostic decodes and round-trips through its encoding", () => {
    const diagnostic = Schema.decodeUnknownSync(Diagnostic)(base);
    expect(Schema.encodeSync(Diagnostic)(diagnostic)).toEqual(base);
  });

  test("a malformed code is rejected", () => {
    const rejected = [
      "PRM-27",
      "prm-27/compound-nested",
      "PRM-27/Compound",
      "PRM-27/",
      "PRM27/compound-nested",
      "PRM-27/compound nested",
    ].map((code) => Exit.isFailure(decode({ ...base, code })));
    expect(rejected.every(Boolean)).toBe(true);
  });

  test("a code that names a different row than the row field is rejected", () => {
    expect(Exit.isFailure(decode({ ...base, row: "PRM-28" }))).toBe(true);
  });

  test("a pointer that is not RFC 6901 text is rejected", () => {
    expect(Exit.isFailure(decode({ ...base, pointer: "#/paths" }))).toBe(true);
  });
});

describe("sortDiagnostics", () => {
  const documents = ["file:///a.json", "file:///b.json"];

  test("orders by document index, then pointer, then code, whatever the input order", () => {
    const ordered = [
      make("file:///a.json", "/paths/~1x", "PRM-1/a"),
      make("file:///a.json", "/paths/~1x", "PRM-1/b"),
      make("file:///a.json", "/paths/~1x/get/parameters/2", "PRM-1/a"),
      make("file:///a.json", "/paths/~1x/get/parameters/10", "PRM-1/a"),
      make("file:///b.json", "/info", "PRM-1/a"),
    ];
    const shuffled = Arr.getSomes([3, 4, 1, 2, 0].map((index) => Arr.get(ordered, index)));
    expect(keys(sortDiagnostics(documents, shuffled))).toEqual(keys(ordered));
  });

  test("a document outside the set sorts after every listed document", () => {
    const stray = make("file:///z.json", "/a", "PRM-1/a");
    const listed = make("file:///b.json", "/z", "PRM-1/a");
    expect(sortDiagnostics(documents, [stray, listed])).toEqual([listed, stray]);
  });
});

describe("Verdict", () => {
  const verdict: typeof Verdict.Encoded = {
    corpusVersion: 1,
    counts: {
      informational: 0,
      notices: 1,
      operations: { generated: 2, refused: 1, total: 3 },
      refusals: { document: 0, element: 1, operation: 0 },
    },
    coverage: { checked: true, missing: [] },
    generator: {
      config: "corpus/config/stripe.json",
      configSha256: "ab".repeat(32),
      version: "0.1.0",
    },
    notices: [{ code: "PRM-19/ignored-header", pointer: "/paths/~1x", row: "PRM-19" }],
    refusals: [
      { code: "PRM-27/compound-nested", pointer: "/paths/~1x", row: "PRM-27", scope: "element" },
    ],
    spec: { id: "stripe", openapi: "3.0.0", sha256: "cd".repeat(32) },
    twinEquality: { checked: true, equal: true },
    verdict: "partly-refused",
  };

  test("a verdict round-trips", () => {
    const decoded = Schema.decodeUnknownSync(Verdict)(verdict);
    expect(Schema.encodeSync(Verdict)(decoded)).toEqual(verdict);
  });

  test("an unknown verdict value is rejected", () => {
    expect(Exit.isFailure(Schema.decodeUnknownExit(Verdict)({ ...verdict, verdict: "ok" }))).toBe(
      true,
    );
  });
});
