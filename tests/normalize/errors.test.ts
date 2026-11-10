import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Diagnostic } from "../../src/model/diagnostic.ts";
import { BodyNodeBudget, BodyNotReadable } from "../../src/normalize/bodies.ts";
import { ParameterNotReadable } from "../../src/normalize/parameters.ts";
import { SchemaBudgetExceeded, SchemaImportDefect } from "../../src/normalize/schemas.ts";

const diagnostic = Schema.decodeUnknownSync(Diagnostic)({
  code: "REF-18/node-budget",
  document: "file:///spec/openapi.json",
  element: "Schema Object",
  message: "the schema walk visited more nodes than the node budget allows",
  openapi: "3.1.1",
  pointer: "/components/schemas/A",
  row: "REF-18",
  scope: "document",
  severity: "refusal",
  specSection: "https://spec.openapis.org/oas/v3.1.2.html#schema-object",
});

describe("normalize error classes", () => {
  test("normalize errors are schema classes", () => {
    const defect = new SchemaImportDefect({ key: "#/components/schemas/A", message: "no import" });
    expect(defect._tag).toBe("SchemaImportDefect");
    expect(defect.key).toBe("#/components/schemas/A");
    expect(defect.message).toBe("no import");

    const budget = new SchemaBudgetExceeded({ limit: 50 });
    expect(budget._tag).toBe("SchemaBudgetExceeded");
    expect(budget.limit).toBe(50);

    const parameter = new ParameterNotReadable({ pointer: "/info", reason: "not-a-parameter" });
    expect(parameter._tag).toBe("ParameterNotReadable");
    expect(parameter.pointer).toBe("/info");
    expect(parameter.reason).toBe("not-a-parameter");

    const body = new BodyNotReadable({ pointer: "/info", reason: "not-a-request-body" });
    expect(body._tag).toBe("BodyNotReadable");
    expect(body.pointer).toBe("/info");
    expect(body.reason).toBe("not-a-request-body");

    const nodes = new BodyNodeBudget({ diagnostic });
    expect(nodes._tag).toBe("BodyNodeBudget");
    expect(nodes.diagnostic).toBe(diagnostic);

    const outside = [{ pointer: "/info", reason: "not-a-reason" }];
    expect(() => {
      Reflect.construct(ParameterNotReadable, outside);
    }).toThrow();
    expect(() => {
      Reflect.construct(BodyNotReadable, outside);
    }).toThrow();
  });
});
