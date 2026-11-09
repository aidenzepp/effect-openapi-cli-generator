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

  test("a field refusal names the field and its media type after the operation", () => {
    const pointer =
      "/paths/~1v1~1accounts~1{account}/post/requestBody/content/application~1x-www-form-urlencoded/encoding/a~1b~0c";
    const head = `refused PRM-27/compound-nested at #${pointer} (POST /v1/accounts/{account}, update-account)`;
    const tail = ": deepObject value has nested objects; ";
    const line = humanLine(
      make({
        element: "a/b~c",
        operation: {
          method: "POST",
          operationId: "update-account",
          path: "/v1/accounts/{account}",
        },
        pointer,
        scope: "field",
      }),
    );

    const between = line.slice(head.length, line.indexOf(tail));

    expect(line.startsWith(head)).toBe(true);
    expect(line.indexOf(tail)).toBeGreaterThan(head.length);
    expect(between).toContain("a/b~c");
    expect(between).toContain("application/x-www-form-urlencoded");
  });

  test("a field refusal off an Encoding entry falls back to its element, with no media type", () => {
    const pointer = "/paths/~1x/post/requestBody/content/application~1json/schema";
    const line = humanLine(make({ element: "Request body field", pointer, scope: "field" }));

    expect(
      line.startsWith(`refused PRM-27/compound-nested at #${pointer} field "Request body field": `),
    ).toBe(true);
  });

  test("a hostile field name and media type render inert", () => {
    const line = humanLine(
      make({
        element: "x",
        pointer: "/paths/~1x/post/requestBody/content/a~1b\u001B[31m/encoding/x\u0007\ny",
        scope: "field",
      }),
    );

    expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
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
