import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Diagnostic } from "../../src/model/diagnostic.ts";
import { humanLine, sanitizeField } from "../../src/report/human.ts";

const base = {
  code: "PRM-27/compound-nested",
  document: "file:///spec.json",
  element: "Parameter style deepObject",
  message: "deepObject value has nested objects",
  openapi: "3.0.3",
  pointer: "/paths/~1v1~1charges/get/parameters/3",
  row: "PRM-27",
  scope: "operation",
  severity: "refusal",
  specSection: "https://spec.openapis.org/oas/v3.0.4.html#style-values",
};

const make = (fields: Partial<typeof base> & { readonly operation?: object }) =>
  Schema.decodeUnknownSync(Diagnostic)({ ...base, ...fields });

const operation = { method: "GET", operationId: "list-charges", path: "/v1/charges" };

describe("humanLine", () => {
  test("fields appear in the design 8.1 order", () => {
    expect(humanLine(make({ operation }))).toBe(
      "refused PRM-27/compound-nested at #/paths/~1v1~1charges/get/parameters/3 (GET /v1/charges, list-charges): deepObject value has nested objects; https://spec.openapis.org/oas/v3.0.4.html#style-values",
    );
  });

  test("a notice leads with its severity word", () => {
    expect(humanLine(make({ scope: "element", severity: "notice" })).startsWith("notice ")).toBe(
      true,
    );
  });

  test("without operation or operationId the parenthesis is omitted cleanly", () => {
    expect(humanLine(make({}))).toBe(
      "refused PRM-27/compound-nested at #/paths/~1v1~1charges/get/parameters/3: deepObject value has nested objects; https://spec.openapis.org/oas/v3.0.4.html#style-values",
    );
    expect(humanLine(make({ operation: { method: "GET", path: "/v1/charges" } }))).toContain(
      " (GET /v1/charges): ",
    );
  });

  test("a hostile pointer, message and path render as one inert line", () => {
    const line = humanLine(
      make({
        element: "x\u001B[2Jy",
        message: "a\r\nrefused FAKE-1/forged at #/x\u0007‮\u0085b",
        operation: { method: "GET", path: "/p\u001B]0;owned\u0007" },
        pointer: "/a\nb\u001B[31m",
      }),
    );
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(line.startsWith("refused PRM-27/compound-nested at #/a")).toBe(true);
  });
});

describe("sanitizeField", () => {
  test("leaves printable text unchanged", () => {
    expect(sanitizeField("plain /paths/~1x é 日本")).toBe("plain /paths/~1x é 日本");
  });

  test("replaces each control, format and separator character with a visible escape", () => {
    expect(sanitizeField(String.fromCodePoint(0x1b, 0xa, 0x9, 0x7f, 0x85, 0x20_0b, 0x20_28))).toBe(
      "\\u{1b}\\u{a}\\u{9}\\u{7f}\\u{85}\\u{200b}\\u{2028}",
    );
  });
});
