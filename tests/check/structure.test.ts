import { describe, expect, test } from "bun:test";
import { Array as Arr, Effect, Order, Schema } from "effect";
import { checkStructure } from "../../src/check/structure.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/resolve/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.1" };

interface Members {
  readonly [key: string]: Json;
}

const responses: Json = { "200": { description: "ok" } };

const op = (members: Members = {}): Json => ({ responses, ...members });

const idParameter: Json = { in: "path", name: "id", required: true, schema: { type: "string" } };

const spec = (line: Line, members: Members): Json => ({
  info: { title: "t", version: "1" },
  openapi: openapi[line],
  paths: {},
  ...members,
});

const check = (line: Line, members: Members) =>
  Effect.runSync(
    resolve({ document: entry, line, value: spec(line, members) }).pipe(
      Effect.flatMap(checkStructure),
    ),
  );

const paths = (value: Members): Members => ({ paths: value });

const summary = (line: Line, members: Members) =>
  check(line, members).map((diagnostic) => [diagnostic.code, diagnostic.scope] as const);

const pointerOf = (diagnostic: Diagnostic | undefined): string => String(diagnostic?.pointer);

const relatedOf = (diagnostic: Diagnostic | undefined): readonly string[] =>
  (diagnostic?.related ?? []).map((related) => String(related.pointer));

const rows = (line: Line, members: Members) =>
  check(line, members).map((diagnostic) => diagnostic.row);

describe("clean documents", () => {
  test("a document with no structural defect has no diagnostics", () => {
    const members = {
      components: {
        parameters: { Id: idParameter },
        pathItems: { Shared: { get: op({ operationId: "shared" }) } },
        schemas: { "Pet.v1-x_y": { type: "string" } },
      },
      ...paths({
        "/": { get: op({ operationId: "root" }) },
        "/a/": { get: op({ operationId: "listA" }) },
        "/a/{id}": {
          get: op({ operationId: "getA", parameters: [{ $ref: "#/components/parameters/Id" }] }),
          parameters: [{ in: "header", name: "X-Id" }],
          post: op({
            operationId: "postA",
            parameters: [idParameter, { in: "header", name: "x-id" }],
          }),
        },
        "/b%ff/{id}.json": { get: op({ parameters: [idParameter] }) },
        "/shared": { $ref: "#/components/pathItems/Shared" },
      }),
    };

    expect(check("3.1", members)).toEqual([]);
    expect(check("3.2", members)).toEqual([]);
  });

  test("required: true on a path parameter is not checked here", () => {
    const members = paths({
      "/a/{id}": { get: op({ parameters: [{ in: "path", name: "id", required: false }] }) },
    });

    expect(check("3.1", members)).toEqual([]);
  });
});

describe("CMP-13 component keys", () => {
  test("a key outside the component-name pattern is refused at document scope", () => {
    const found = check("3.1", {
      components: { parameters: { a$b: idParameter }, schemas: { "bad key": {}, ok: {} } },
    });

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["CMP-13/invalid-key", "document"],
      ["CMP-13/invalid-key", "document"],
    ]);
    expect(
      Arr.sort(
        found.map((diagnostic) => pointerOf(diagnostic)),
        Order.String,
      ),
    ).toEqual(["/components/parameters/a$b", "/components/schemas/bad key"]);
  });

  test("the same rule holds in 3.0", () => {
    expect(
      summary("3.0", { components: { responses: { "no/slash": { description: "x" } } } }),
    ).toEqual([["CMP-13/invalid-key", "document"]]);
  });
});

describe("OPR-07 operationId uniqueness", () => {
  const twice = paths({
    "/a": { get: op({ operationId: "x" }) },
    "/b": { get: op({ operationId: "x" }), post: op({ operationId: "y" }) },
  });

  test("a repeated operationId is refused once, at document scope, naming the first use", () => {
    const found = check("3.1", twice);

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["OPR-07/duplicate-id", "document"],
    ]);
    expect(pointerOf(found[0])).toBe("/paths/~1b/get/operationId");
    expect(relatedOf(found[0])).toEqual(["/paths/~1a/get/operationId"]);
  });

  test("operationIds compare case-sensitively", () => {
    expect(
      check(
        "3.1",
        paths({ "/a": { get: op({ operationId: "x" }), put: op({ operationId: "X" }) } }),
      ),
    ).toEqual([]);
  });
});

describe("PTH-03 and PTH-08 template and path parameters", () => {
  test("PTH-03: an expression with no path parameter, at operation scope", () => {
    const found = check("3.1", paths({ "/a/{id}": { post: op({ operationId: "p" }) } }));

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["PTH-03/missing-parameter", "operation"],
    ]);
    expect(found[0]?.operation).toEqual({ method: "POST", operationId: "p", path: "/a/{id}" });
  });

  test("PTH-03 is one diagnostic per distinct expression", () => {
    expect(rows("3.1", paths({ "/a/{x}/{y}": { get: op() } }))).toEqual(["PTH-03", "PTH-03"]);
  });

  test("PTH-08: a path parameter with no expression", () => {
    expect(summary("3.1", paths({ "/a": { get: op({ parameters: [idParameter] }) } }))).toEqual([
      ["PTH-08/missing-expression", "operation"],
    ]);
  });

  test("a case mismatch yields both rows", () => {
    expect(rows("3.1", paths({ "/a/{Id}": { get: op({ parameters: [idParameter] }) } }))).toEqual([
      "PTH-03",
      "PTH-08",
    ]);
  });

  test("a path parameter on the path item satisfies each operation, an operation one overrides it", () => {
    const members = paths({
      "/a/{id}": {
        get: op({ parameters: [idParameter] }),
        parameters: [idParameter],
        put: op(),
      },
    });

    expect(check("3.1", members)).toEqual([]);
  });

  test("a path-item parameter with no expression is refused for each operation", () => {
    const members = paths({ "/a": { get: op(), parameters: [idParameter], put: op() } });

    expect(rows("3.1", members)).toEqual(["PTH-08", "PTH-08"]);
  });

  test("a path parameter reached through $ref counts", () => {
    const members = {
      components: { parameters: { Id: idParameter } },
      ...paths({
        "/a/{id}": { get: op({ parameters: [{ $ref: "#/components/parameters/Id" }] }) },
      }),
    };

    expect(check("3.1", members)).toEqual([]);
  });
});

describe("PTH-04 template-identical paths", () => {
  test("every operation of both paths is refused at operation scope", () => {
    const members = paths({
      "/a/{x}": { get: op({ parameters: [{ ...idParameter, name: "x" }] }) },
      "/a/{y}": {
        get: op({ parameters: [{ ...idParameter, name: "y" }] }),
        put: op({ parameters: [{ ...idParameter, name: "y" }] }),
      },
    });
    const found = check("3.1", members);

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["PTH-04/template-identical", "operation"],
      ["PTH-04/template-identical", "operation"],
      ["PTH-04/template-identical", "operation"],
    ]);
    expect(relatedOf(found[0])).toEqual(["/paths/~1a~1{y}"]);
  });

  test("distinct templates are not identical", () => {
    const members = paths({
      "/a/{x}": { get: op({ parameters: [{ ...idParameter, name: "x" }] }) },
      "/a/{x}/b": { get: op({ parameters: [{ ...idParameter, name: "x" }] }) },
    });

    expect(check("3.1", members)).toEqual([]);
  });
});

describe("PTH-07 path keys", () => {
  const bad = [
    "//a",
    "/a//b",
    "/a?x=1",
    "/a#f",
    "/a/../b",
    "/a/%2E./b",
    "/a/./b",
    "/a\\b",
    "/a/[x]",
    "/a b",
    "/café",
    "/a/%zz",
    "/a/{}",
    "/a/{b",
  ];

  for (const key of bad) {
    test(`refuses ${JSON.stringify(key)} at operation scope`, () => {
      expect(summary("3.1", paths({ [key]: { get: op() } }))).toContainEqual([
        "PTH-07/invalid-path-key",
        "operation",
      ]);
    });
  }

  test("an expression used twice in one key is refused", () => {
    const members = paths({ "/a/{id}/{id}": { get: op({ parameters: [idParameter] }) } });

    expect(summary("3.1", members)).toEqual([["PTH-07/repeated-expression", "operation"]]);
  });

  test("a key with no operation raises nothing", () => {
    expect(check("3.1", paths({ "/a?x": { summary: "s" } }))).toEqual([]);
  });
});

describe("PTH-28 duplicate parameters", () => {
  test("two parameters with one (name, in) in the operation list", () => {
    const members = paths({
      "/a": {
        get: op({
          parameters: [
            { in: "query", name: "q" },
            { in: "query", name: "q" },
          ],
        }),
      },
    });
    const found = check("3.1", members);

    expect(found.map((diagnostic) => [diagnostic.code, diagnostic.scope])).toEqual([
      ["PTH-28/duplicate-parameter", "operation"],
    ]);
    expect(pointerOf(found[0])).toBe("/paths/~1a/get/parameters/1");
    expect(relatedOf(found[0])).toEqual(["/paths/~1a/get/parameters/0"]);
  });

  test("a duplicate in the path-item list is refused for each operation", () => {
    const members = paths({
      "/a": {
        get: op(),
        parameters: [
          { in: "query", name: "q" },
          { in: "query", name: "q" },
        ],
        put: op(),
      },
    });

    expect(rows("3.1", members)).toEqual(["PTH-28", "PTH-28"]);
  });

  test("header names compare case-insensitively, other names case-sensitively", () => {
    expect(
      rows(
        "3.1",
        paths({
          "/a": {
            get: op({
              parameters: [
                { in: "header", name: "X-Id" },
                { in: "header", name: "x-id" },
              ],
            }),
          },
        }),
      ),
    ).toEqual(["PTH-28"]);
    expect(
      rows(
        "3.1",
        paths({
          "/a": {
            get: op({
              parameters: [
                { in: "query", name: "Q" },
                { in: "query", name: "q" },
              ],
            }),
          },
        }),
      ),
    ).toEqual([]);
  });

  test("the same name in a different location is not a duplicate", () => {
    const members = paths({
      "/a/{q}": {
        get: op({
          parameters: [
            { in: "query", name: "q" },
            { ...idParameter, name: "q" },
          ],
        }),
      },
    });

    expect(check("3.1", members)).toEqual([]);
  });

  test("an operation parameter overriding a path-item parameter is not a duplicate", () => {
    const members = paths({
      "/a": {
        get: op({ parameters: [{ in: "query", name: "q" }] }),
        parameters: [{ in: "query", name: "q" }],
      },
    });

    expect(check("3.1", members)).toEqual([]);
  });

  test("a duplicate through $ref is found", () => {
    const members = {
      components: { parameters: { Q: { in: "query", name: "q" } } },
      ...paths({
        "/a": {
          get: op({
            parameters: [{ $ref: "#/components/parameters/Q" }, { in: "query", name: "q" }],
          }),
        },
      }),
    };

    expect(rows("3.1", members)).toEqual(["PTH-28"]);
  });
});

const qs = (name: string): Json => ({
  content: { "application/x-www-form-urlencoded": {} },
  in: "querystring",
  name,
});

const extra = (key: string): Members =>
  paths({ "/a": { additionalOperations: { [key]: op({ operationId: "x" }) } } });

describe("STY-44 querystring", () => {
  test("two querystring parameters", () => {
    expect(
      summary("3.2", paths({ "/a": { get: op({ parameters: [qs("a"), qs("b")] }) } })),
    ).toEqual([["STY-44/querystring-conflict", "operation"]]);
  });

  test("a querystring beside a query parameter", () => {
    const members = paths({
      "/a": { get: op({ parameters: [qs("a"), { in: "query", name: "q" }] }) },
    });

    expect(summary("3.2", members)).toEqual([["STY-44/querystring-conflict", "operation"]]);
  });

  test("across the path item and the operation", () => {
    const members = paths({
      "/a": { get: op({ parameters: [qs("b")] }), parameters: [qs("a")] },
    });

    expect(rows("3.2", members)).toEqual(["STY-44"]);
  });

  test("through $ref", () => {
    const members = {
      components: { parameters: { Qs: qs("a") } },
      ...paths({
        "/a": {
          get: op({
            parameters: [{ $ref: "#/components/parameters/Qs" }, { in: "query", name: "q" }],
          }),
        },
      }),
    };

    expect(rows("3.2", members)).toEqual(["STY-44"]);
  });

  test("one querystring, or one overridden by name, is fine", () => {
    expect(check("3.2", paths({ "/a": { get: op({ parameters: [qs("a")] }) } }))).toEqual([]);
    expect(
      check("3.2", paths({ "/a": { get: op({ parameters: [qs("a")] }), parameters: [qs("a")] } })),
    ).toEqual([]);
  });
});

describe("additionalOperations keys", () => {
  for (const key of ["GET", "get", "Get", "QUERY", "query"]) {
    test(`PTH-24: ${key} equals a fixed method`, () => {
      expect(summary("3.2", extra(key))).toEqual([["PTH-24/fixed-method-key", "operation"]]);
    });
  }

  for (const key of ["FETCH", "propfind", "Propfind", "BREW COFFEE"]) {
    test(`PTH-23: ${key} is outside the allowlist`, () => {
      expect(summary("3.2", extra(key))).toEqual([["PTH-23/method-not-allowed", "operation"]]);
    });
  }

  test("an allowlisted token is clean and is reported with its own capitalization", () => {
    expect(check("3.2", extra("PROPFIND"))).toEqual([]);
    expect(check("3.2", extra("FETCH"))[0]?.operation?.method).toBe("FETCH");
  });

  test("additionalOperations is read in 3.2 only", () => {
    expect(check("3.1", extra("get"))).toEqual([]);
  });
});

describe("path items reached through $ref", () => {
  test("the use site is the pointer and the target is related", () => {
    const members = {
      components: { pathItems: { P: { get: op({ operationId: "p" }) } } },
      ...paths({ "/a/{id}": { $ref: "#/components/pathItems/P" } }),
    };
    const found = check("3.1", members);

    expect(found.map((diagnostic) => diagnostic.code)).toEqual(["PTH-03/missing-parameter"]);
    expect(pointerOf(found[0])).toBe("/paths/~1a~1{id}");
    expect(relatedOf(found[0])).toEqual(["/components/pathItems/P/get"]);
  });
});
