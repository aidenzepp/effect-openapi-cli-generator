import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { Diagnostic } from "../../src/model/diagnostic.ts";
import {
  GenerationReport,
  generatorExitStatus,
  makeGenerationReport,
  printGenerationReport,
} from "../../src/report/index.ts";
import type { GenerationReportInput } from "../../src/report/index.ts";

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

const notice = make("notice", "element", "PRM-19/ignored-header", "/paths/~1x/get/p/1");

const inputs = Schema.decodeUnknownSync(GenerationReport.fields.inputs)([
  { document: "file:///spec.json", sha256: "a".repeat(64) },
  { document: "file:///other.json", sha256: "b".repeat(64) },
]);

const renames = Schema.decodeUnknownSync(GenerationReport.fields.renames)([
  { from: "list", pointer: "/paths/~1x/get", to: "list-2" },
]);

const input = (diagnostics: readonly Diagnostic[]): GenerationReportInput => ({
  acceptedServers: ["https://api.example.com"],
  diagnostics,
  inputs,
  renames,
  version: "0.1.0",
});

const print = (diagnostics: readonly Diagnostic[]) =>
  Effect.runSync(printGenerationReport(makeGenerationReport(input(diagnostics))));

describe("generation report bytes", () => {
  const text = print([operationRefusal, notice]);

  const parsed: unknown = JSON.parse(text);

  test("the same input prints the same bytes, ending in a newline", () => {
    expect(print([operationRefusal, notice])).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
  });

  test("keys are sorted at the top level", () => {
    const keys = Object.keys(Schema.decodeUnknownSync(GenerationReport)(parsed));

    expect(keys).toEqual([
      "acceptedServers",
      "generator",
      "inputs",
      "notices",
      "refusals",
      "renames",
    ]);
  });

  test("records servers, input digests in given order, version and renames", () => {
    const report = Schema.decodeUnknownSync(GenerationReport)(parsed);

    expect(report.acceptedServers).toEqual(["https://api.example.com"]);
    expect(report.generator).toEqual({ version: "0.1.0" });
    expect(report.inputs).toEqual(inputs);
    expect(report.inputs.map((entry) => entry.sha256)).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(report.renames).toEqual(renames);
  });

  test("lists refusals and notices in full, split by severity, in the order given", () => {
    const report = Schema.decodeUnknownSync(GenerationReport)(parsed);

    expect(report.refusals.map((entry) => entry.code)).toEqual(["PRM-27/compound-nested"]);
    expect(report.notices.map((entry) => entry.code)).toEqual(["PRM-19/ignored-header"]);
    expect(report.refusals[0]?.message).toBe(base.message);
  });

  test("carries no timestamp field anywhere", () => {
    expect(text).not.toMatch(/time|date|generatedAt/iu);
  });

  test("a bad digest fails with a schema error", () => {
    const bad = {
      ...makeGenerationReport(input([])),
      inputs: inputs.map((entry) => ({ ...entry, sha256: "xyz" })),
    };

    expect(Exit.isFailure(Effect.runSyncExit(printGenerationReport(bad)))).toBe(true);
  });
});

describe("generatorExitStatus", () => {
  test("output written with no refusals exits 0", () => {
    expect(generatorExitStatus({ _tag: "Written", diagnostics: [notice], strict: false })).toBe(0);
    expect(generatorExitStatus({ _tag: "Written", diagnostics: [notice], strict: true })).toBe(0);
  });

  test("a partly refused run exits 0 without --strict", () => {
    expect(
      generatorExitStatus({ _tag: "Written", diagnostics: [operationRefusal], strict: false }),
    ).toBe(0);
  });

  test("a document refusal exits 1", () => {
    expect(
      generatorExitStatus({
        _tag: "Written",
        diagnostics: [notice, documentRefusal],
        strict: false,
      }),
    ).toBe(1);
  });

  test("any refusal exits 1 under --strict", () => {
    expect(
      generatorExitStatus({ _tag: "Written", diagnostics: [operationRefusal], strict: true }),
    ).toBe(1);
  });

  test("a held lock exits 1", () => {
    expect(generatorExitStatus({ _tag: "LockHeld" })).toBe(1);
  });
});
