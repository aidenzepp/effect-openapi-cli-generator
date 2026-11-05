import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const seedsDirectory = join(import.meta.dir, "seeds");
const operationIdsFile = "resend-operation-ids.json";
const caseFields = ["id", "source", "input", "expected", "designSection"] as const;

const seedFiles = readdirSync(seedsDirectory)
  .filter((name) => name.endsWith(".json"))
  .toSorted();

const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(seedsDirectory, name), "utf8"));
const caseFileNames = seedFiles.filter((name) => name !== operationIdsFile);
const caseFiles = caseFileNames.map((name) => ({
  name,
  value: read(name) as { cases?: unknown[] },
}));

describe("seed files", () => {
  test("the Resend operationId list and at least one case file exist", () => {
    expect(seedFiles).toContain(operationIdsFile);
    expect(caseFileNames).toContain("hostile.json");
  });

  for (const { name, value } of caseFiles) {
    test(`${name} has non-empty cases with the five fields`, () => {
      expect(Array.isArray(value.cases)).toBe(true);
      expect(value.cases?.length).toBeGreaterThan(0);
      for (const entry of value.cases ?? []) {
        const seedCase = entry as Record<string, unknown>;
        for (const field of caseFields) {
          expect(Object.hasOwn(seedCase, field)).toBe(true);
        }
        expect(String(seedCase["designSection"]).startsWith("§")).toBe(true);
      }
    });
  }

  test("case ids are unique across all files", () => {
    const ids = caseFiles.flatMap(({ value }) =>
      (value.cases ?? []).map((entry) => (entry as { id: string }).id),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("resend-operation-ids.json pins the spec and lists sorted unique ids", () => {
    const file = read(operationIdsFile) as {
      source: string;
      specSha256: string;
      operationIds: string[];
    };
    expect(file.source).toBe("resend/resend-openapi@0b2a456ec468f07eb2e6fac73f0a76fb5463823c");
    expect(file.specSha256).toBe(
      "aa33334c3686b64a1dc11e556da0407473bb0b9a5a4f873d69cd9aa06b606915",
    );
    expect(file.operationIds.length).toBeGreaterThan(0);
    expect(new Set(file.operationIds).size).toBe(file.operationIds.length);
    expect(file.operationIds).toEqual(file.operationIds.toSorted());
  });
});
