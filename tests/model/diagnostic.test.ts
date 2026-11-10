import { describe, expect, test } from "bun:test";
import { Array as Arr, Cause, Effect, Exit, Schema } from "effect";
import {
  Diagnostic,
  diagnosticOf,
  isDocumentRefusal,
  isRefusal,
  makeDiagnostic,
  Site,
  sortDiagnostics,
} from "../../src/model/diagnostic.ts";
import { Origin } from "../../src/model/entities.ts";
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

const at = (severity: "refusal" | "notice", scope: "document" | "element") =>
  Schema.decodeUnknownSync(Diagnostic)({ ...base, scope, severity });

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

  test("the optional wire name decodes and round-trips, alongside an S30 row", () => {
    const encoded = {
      ...base,
      code: "S30-22/array-without-items",
      openapi: "3.0.3",
      row: "S30-22",
      wire: "session",
    };
    const diagnostic = Schema.decodeUnknownSync(Diagnostic)(encoded);
    expect(diagnostic.wire).toBe("session");
    expect(Schema.encodeSync(Diagnostic)(diagnostic)).toEqual(encoded);
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

  test("a row id with a digit in its prefix, like S30, decodes with its code", () => {
    expect(
      Exit.isSuccess(decode({ ...base, code: "S30-22/array-without-items", row: "S30-22" })),
    ).toBe(true);
  });

  test("a row id that starts with a digit, is lowercase, or lacks digits is rejected", () => {
    const rows = ["30S-1", "s30-1", "S30-"];
    const rejected = rows.map((row) =>
      Exit.isFailure(decode({ ...base, code: `${row}/array-without-items`, row })),
    );
    expect(rejected.every(Boolean)).toBe(true);
  });

  test("a field-scope refusal decodes and round-trips; an unknown scope is rejected", () => {
    const encoded: typeof Diagnostic.Encoded = {
      ...base,
      element: "metadata",
      pointer:
        "/paths/~1x/post/requestBody/content/application~1x-www-form-urlencoded/encoding/metadata",
      scope: "field",
    };
    const diagnostic = Schema.decodeUnknownSync(Diagnostic)(encoded);
    expect(diagnostic.scope).toBe("field");
    expect(Schema.encodeSync(Diagnostic)(diagnostic)).toEqual(encoded);
    expect(Exit.isFailure(decode({ ...base, scope: "property" }))).toBe(true);
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
  // Every list carries a real entry so the round trip exercises each element and claim shape,
  // not only empty arrays; the counts agree with the lists.
  const verdict: typeof Verdict.Encoded = {
    commandSources: { config: 1, fern: 0, fold: 1, forge: 0 },
    corpusVersion: 1,
    counts: {
      informational: 0,
      nonStandard: 1,
      notices: 1,
      operations: { generated: 2, refused: 1, total: 3 },
      refusals: { document: 0, element: 1, field: 1, operation: 0 },
    },
    coverage: {
      byNotice: [
        {
          document: "file:///stripe.json",
          in: "header",
          kind: "parameter",
          name: "X-Trace",
          pointer: "/paths/~1x/get/parameters/0",
        },
      ],
      checked: true,
      invented: [{ kind: "server", path: ["charges", "list"], url: "https://example.test" }],
      missing: [{ document: "file:///stripe.json", kind: "operation", pointer: "/paths/~1y/get" }],
    },
    generator: {
      config: "corpus/config/stripe.json",
      configSha256: "ab".repeat(32),
      version: "0.1.0",
    },
    nonStandard: [
      { choice: "deepObjectBrackets", pointer: "/paths/~1x/get/parameters/1", row: "PRM-27" },
    ],
    notices: [{ code: "PRM-19/ignored-header", pointer: "/paths/~1x", row: "PRM-19" }],
    refusals: [
      { code: "PRM-27/compound-nested", pointer: "/paths/~1x", row: "PRM-27", scope: "element" },
      {
        code: "PRM-27/compound-nested",
        pointer:
          "/paths/~1z/post/requestBody/content/application~1x-www-form-urlencoded/encoding/a",
        row: "PRM-27",
        scope: "field",
      },
    ],
    spec: { id: "stripe", openapi: "3.0.0", sha256: "cd".repeat(32) },
    twinEquality: { checked: true, equal: true },
    verdict: "partly-refused",
  };

  test("a verdict round-trips", () => {
    const decoded = Schema.decodeUnknownSync(Verdict)(verdict);
    expect(Schema.encodeSync(Verdict)(decoded)).toEqual(verdict);
  });

  test("a refusal count without the field key is rejected", () => {
    const counts = { ...verdict.counts, refusals: { document: 0, element: 1, operation: 0 } };
    expect(Exit.isFailure(Schema.decodeUnknownExit(Verdict)({ ...verdict, counts }))).toBe(true);
  });

  test("an unknown verdict value is rejected", () => {
    expect(Exit.isFailure(Schema.decodeUnknownExit(Verdict)({ ...verdict, verdict: "ok" }))).toBe(
      true,
    );
  });
});

describe("diagnosticOf and makeDiagnostic", () => {
  const { row: _row, ...input } = base;

  test("an undefined key is absent from the result", async () => {
    const diagnostic = await Effect.runPromise(makeDiagnostic({ ...input, hint: undefined }));

    expect(Object.keys(diagnostic)).not.toContain("hint");
  });

  test("row equals the code prefix", async () => {
    const diagnostic = await Effect.runPromise(makeDiagnostic(input));

    expect(diagnostic.row).toBe("PRM-27");
  });

  test("an invalid code dies through makeDiagnostic and fails with SchemaError through diagnosticOf", async () => {
    const bad = { ...input, code: "nonsense" };

    expect(Exit.isFailure(await Effect.runPromiseExit(makeDiagnostic(bad)))).toBe(true);

    const failed = await Effect.runPromise(Effect.flip(diagnosticOf(bad)));

    expect(Schema.isSchemaError(failed)).toBe(true);

    const exit = await Effect.runPromiseExit(makeDiagnostic(bad));

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  });

  test("the encoded key order equals that of a directly decoded Diagnostic", async () => {
    const built = await Effect.runPromise(makeDiagnostic({ ...input, hint: "h" }));
    const direct = Schema.decodeUnknownSync(Diagnostic)({ ...base, hint: "h" });

    expect(Object.keys(Schema.encodeSync(Diagnostic)(built))).toEqual(
      Object.keys(Schema.encodeSync(Diagnostic)(direct)),
    );
    expect(built).toEqual(direct);
  });

  test("refusal predicates read severity and scope", () => {
    expect(isRefusal(at("refusal", "element"))).toBe(true);
    expect(isRefusal(at("notice", "document"))).toBe(false);
    expect(isDocumentRefusal(at("refusal", "document"))).toBe(true);
    expect(isDocumentRefusal(at("refusal", "element"))).toBe(false);
    expect(isDocumentRefusal(at("notice", "document"))).toBe(false);
  });
});

describe("Site", () => {
  test("Site is the entity Origin: one value decodes the same and encodes document then pointer", () => {
    const value = { document: "file:///spec.json", pointer: "/paths/~1x/get" };
    const site = Schema.decodeUnknownSync(Site)(value);
    const origin = Schema.decodeUnknownSync(Origin)(value);

    expect(site).toEqual(origin);
    expect(Object.keys(Schema.encodeSync(Site)(site))).toEqual(["document", "pointer"]);
    expect(Object.keys(Schema.encodeSync(Origin)(origin))).toEqual(["document", "pointer"]);
  });
});
