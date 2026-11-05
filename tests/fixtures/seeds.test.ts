import { describe, expect, test } from "bun:test";
import { Array as Arr, Order, Schema } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const seedsDirectory = path.join(import.meta.dir, "seeds");

const operationIdsFile = "resend-operation-ids.json";

const caseFields = ["id", "source", "input", "expected", "designSection"] as const;

const SeedCase = Schema.Struct({
  designSection: Schema.optional(Schema.Unknown),
  expected: Schema.optional(Schema.Unknown),
  id: Schema.optional(Schema.Unknown),
  input: Schema.optional(Schema.Unknown),
  source: Schema.optional(Schema.Unknown),
});

const CaseFile = Schema.Struct({ cases: Schema.optional(Schema.Array(SeedCase)) });

const OperationIdsFile = Schema.Struct({
  operationIds: Schema.Array(Schema.String),
  source: Schema.String,
  specSha256: Schema.String,
});

const readSeed = <A, I>(name: string, schema: Schema.Codec<A, I>): A =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(
    readFileSync(path.join(seedsDirectory, name), "utf-8"),
  );

const seedFiles = Arr.sort(
  readdirSync(seedsDirectory).filter((name) => name.endsWith(".json")),
  Order.String,
);

const caseFileNames = seedFiles.filter((name) => name !== operationIdsFile);

const caseFiles = caseFileNames.map((name) => ({ name, value: readSeed(name, CaseFile) }));

describe("seed files", () => {
  test("the Resend operationId list and at least one case file exist", () => {
    expect(seedFiles).toContain(operationIdsFile);
    expect(caseFileNames).toContain("hostile.json");
  });

  for (const { name, value } of caseFiles) {
    test(`${name} has non-empty cases with the five fields`, () => {
      expect(Array.isArray(value.cases)).toBe(true);
      expect(value.cases?.length).toBeGreaterThan(0);
      for (const seedCase of value.cases ?? []) {
        for (const field of caseFields) {
          expect(Object.hasOwn(seedCase, field)).toBe(true);
        }

        expect(String(seedCase.designSection).startsWith("§")).toBe(true);
      }
    });
  }

  test("case ids are unique across all files", () => {
    const ids = caseFiles.flatMap(({ value }) =>
      (value.cases ?? []).map((entry) => String(entry.id)),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("resend-operation-ids.json pins the spec and lists sorted unique ids", () => {
    const file = readSeed(operationIdsFile, OperationIdsFile);
    expect(file.source).toBe("resend/resend-openapi@0b2a456ec468f07eb2e6fac73f0a76fb5463823c");
    expect(file.specSha256).toBe(
      "aa33334c3686b64a1dc11e556da0407473bb0b9a5a4f873d69cd9aa06b606915",
    );
    expect(file.operationIds.length).toBeGreaterThan(0);
    expect(new Set(file.operationIds).size).toBe(file.operationIds.length);
    expect(file.operationIds).toEqual(Arr.sort(file.operationIds, Order.String));
  });
});
