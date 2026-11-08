import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { operationHelp } from "../../src/emit/help.ts";
import type { HelpInput } from "../../src/emit/help.ts";
import { Operation, SecurityScheme } from "../../src/model/entities.ts";
import {
  GenerationReport,
  makeGenerationReport,
  printGenerationReport,
} from "../../src/report/index.ts";
import type { GenerationReportInput } from "../../src/report/index.ts";

const origin = { document: "file:///spec.json", pointer: "/paths/~1x/get" };

const rows = ["SEC-08"];

const scheme = (name: string, source: "author-supplied" | "spec") =>
  Schema.decodeUnknownSync(SecurityScheme)({
    credentialSources: ["flag", "env"],
    deprecated: false,
    kind: { scheme: "bearer", type: "http" },
    name,
    origin,
    rows,
    source,
  });

const operation = (names: readonly string[]) =>
  Schema.decodeUnknownSync(Operation)({
    deprecated: false,
    docs: {},
    key: { method: "GET", path: "/x" },
    origin,
    parameters: [],
    responses: [],
    rows: ["OPR-01"],
    security: {
      alternatives: [{ uses: names.map((name) => ({ scheme: name, scopes: [] })) }],
      declared: true,
      origin,
      rows,
    },
    servers: [],
    tags: [],
  });

const helpInput = (names: readonly string[], schemes: readonly SecurityScheme[]): HelpInput => ({
  credentials: [],
  diagnostics: [],
  flags: [],
  operation: operation(names),
  schemes,
});

const auth = (names: readonly string[], schemes: readonly SecurityScheme[]) =>
  operationHelp(helpInput(names, schemes)).sections.find(([title]) => title === "AUTH")?.[1] ?? "";

const base: GenerationReportInput = {
  acceptedServers: [],
  diagnostics: [],
  inputs: [],
  renames: [],
  version: "0.1.0",
};

const print = (input: GenerationReportInput) =>
  Effect.runSync(printGenerationReport(makeGenerationReport(input)));

describe("author-supplied schemes in help", () => {
  test("AS-2: an added scheme carries the marker in AUTH", () => {
    expect(auth(["added"], [scheme("added", "author-supplied")])).toContain("author-supplied");
  });

  test("AS-2: a spec scheme has no marker", () => {
    expect(auth(["declared"], [scheme("declared", "spec")])).not.toContain("author-supplied");
  });

  test("AS-2: only the added scheme of a mixed alternative is marked", () => {
    const line = auth(
      ["declared", "added"],
      [scheme("declared", "spec"), scheme("added", "author-supplied")],
    );

    expect(line.match(/author-supplied/gu)?.length).toBe(1);
    expect(line.indexOf("author-supplied")).toBeGreaterThan(line.indexOf("added"));
  });
});

describe("author-supplied schemes in the report", () => {
  test("AS-2: the report lists an added scheme with its config key", () => {
    const text = print({
      ...base,
      schemes: [scheme("declared", "spec"), scheme("added", "author-supplied")],
    });

    expect(
      Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({ authorSuppliedSchemes: GenerationReport.fields.authorSuppliedSchemes }),
        ),
      )(text).authorSuppliedSchemes,
    ).toEqual([{ key: "security.add.schemes.added", name: "added" }]);
  });

  test("AS-2: without an added scheme the report bytes are the M1 bytes", () => {
    const withSpec = print({ ...base, schemes: [scheme("declared", "spec")] });

    expect(withSpec).toBe(print(base));
    expect(withSpec).not.toContain("authorSuppliedSchemes");
  });
});
