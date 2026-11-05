import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import { collectInformational } from "../../src/normalize/informational.ts";
import { resolve } from "../../src/resolve/index.ts";
import { evaluatePointer } from "../../src/model/pointer.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

interface Members {
  readonly [key: string]: Json;
}

const document = (line: Line, extra: Members = {}): Json => ({
  info: { title: "t", version: "1" },
  openapi: openapi[line],
  paths: {},
  ...extra,
});

const text = (value: string): string => value;

const collect = (value: Json, line: Line = "3.1") => {
  const resolution = Effect.runSync(resolve({ document: entry, line, value }));

  return Effect.runSync(collectInformational(resolution));
};

const pairs = (value: Json, line: Line = "3.1") =>
  collect(value, line).map((record) => [text(record.row), text(record.origin.pointer)]);

const ok: Members = { description: "ok" };

describe("document metadata", () => {
  test("info, contact, license, root external docs and each tag are one record each", () => {
    const value = document("3.1", {
      externalDocs: { url: "https://example.com/docs" },
      info: {
        contact: { name: "n" },
        license: { name: "MIT" },
        title: "t",
        version: "1",
      },
      tags: [{ externalDocs: { url: "https://example.com/t" }, name: "a" }, { name: "b" }],
    });

    expect(pairs(value)).toEqual([
      ["INF-01", "/info"],
      ["INF-09", "/info/contact"],
      ["INF-13", "/info/license"],
      ["EXD-01", "/externalDocs"],
      ["TAG-01", "/tags/0"],
      ["EXD-01", "/tags/0/externalDocs"],
      ["TAG-01", "/tags/1"],
    ]);
  });

  test("a record names the entry document as its origin", () => {
    const [first] = collect(document("3.1"));

    expect(text(first?.origin.document ?? "")).toBe(entry);
  });
});

describe("webhooks and callbacks", () => {
  test("37 webhooks yield 37 records, one per webhook", () => {
    const hooks = Object.fromEntries(
      Array.from({ length: 37 }, (_unused, index) => [`hook-${index}`, { post: {} }]),
    );
    const records = pairs(document("3.1", { webhooks: hooks })).filter(([row]) => row === "DOC-08");

    expect(records).toHaveLength(37);
    expect(records[0]).toEqual(["DOC-08", "/webhooks/hook-0"]);
    expect(records[36]).toEqual(["DOC-08", "/webhooks/hook-36"]);
  });

  test("a webhook is not walked further", () => {
    const value = document("3.1", {
      webhooks: { incoming: { post: { callbacks: { cb: {} }, externalDocs: {} }, "x-note": "a" } },
    });

    expect(pairs(value).filter(([row]) => row !== "INF-01")).toEqual([
      ["DOC-08", "/webhooks/incoming"],
    ]);
  });

  test("an empty webhooks map is one record at the map", () => {
    expect(pairs(document("3.1", { webhooks: {} })).slice(1)).toEqual([["DOC-08", "/webhooks"]]);
  });

  test("an operation callback is one record at its use site, and an empty map is one at the map", () => {
    const value = document("3.1", {
      paths: {
        "/a": {
          post: { callbacks: { onEvent: { "{$request.body#/url}": { post: {} } } } },
          put: { callbacks: {} },
        },
      },
    });

    expect(pairs(value).slice(1)).toEqual([
      ["CBK-01", "/paths/~1a/post/callbacks/onEvent"],
      ["CBK-01", "/paths/~1a/put/callbacks"],
    ]);
  });

  test("a component callback is recorded where it is written", () => {
    const value = document("3.1", { components: { callbacks: { c: {} } } });

    expect(pairs(value).slice(1)).toEqual([["CBK-01", "/components/callbacks/c"]]);
  });
});

describe("links and examples", () => {
  test("response links are one record each and an empty map is one record", () => {
    const value = document("3.1", {
      paths: {
        "/a": {
          get: {
            responses: {
              "200": { ...ok, links: { next: { operationId: "x" }, prev: { operationId: "y" } } },
              "404": { ...ok, links: {} },
            },
          },
        },
      },
    });

    expect(pairs(value).slice(1)).toEqual([
      ["LNK-01", "/paths/~1a/get/responses/200/links/next"],
      ["LNK-01", "/paths/~1a/get/responses/200/links/prev"],
      ["LNK-01", "/paths/~1a/get/responses/404/links"],
    ]);
  });

  test("a Reference Object link is recorded at its use site and not followed", () => {
    const value = document("3.1", {
      components: { links: { shared: { operationId: "x", "x-note": 1 } } },
      paths: {
        "/a": {
          get: {
            responses: { "200": { ...ok, links: { n: { $ref: "#/components/links/shared" } } } },
          },
        },
      },
    });

    expect(pairs(value).slice(1)).toEqual([
      ["LNK-01", "/paths/~1a/get/responses/200/links/n"],
      ["LNK-01", "/components/links/shared"],
    ]);
  });

  test("examples on a parameter, a media type, a header and the components are one record each", () => {
    const value = document("3.1", {
      components: { examples: { shared: { value: 1 } } },
      paths: {
        "/a": {
          get: {
            parameters: [{ examples: { one: { value: 1 } }, in: "query", name: "q" }],
            requestBody: { content: { "application/json": { examples: { e: { value: {} } } } } },
            responses: {
              "200": { ...ok, headers: { "X-Rate": { examples: { r: { value: 1 } } } } },
            },
          },
        },
      },
    });

    expect(pairs(value).slice(1)).toEqual([
      ["EXM-01", "/paths/~1a/get/parameters/0/examples/one"],
      ["EXM-01", "/paths/~1a/get/requestBody/content/application~1json/examples/e"],
      ["EXM-01", "/paths/~1a/get/responses/200/headers/X-Rate/examples/r"],
      ["EXM-01", "/components/examples/shared"],
    ]);
  });

  test("the schema example keyword and an example value are not Example Objects", () => {
    const value = document("3.1", {
      components: { schemas: { s: { example: { "x-a": 1 }, examples: [{ "x-b": 2 }] } } },
      paths: {
        "/a": {
          get: {
            requestBody: {
              content: {
                "application/json": { example: { "x-c": 3 }, schema: { type: "object" } },
              },
            },
          },
        },
      },
    });

    expect(pairs(value)).toEqual([["INF-01", "/info"]]);
  });
});

describe("vendor extensions", () => {
  test("an extension on the root, an operation and a server is one record each", () => {
    const value = document("3.1", {
      paths: {
        "/a": { get: { "x-fern-sdk-group-name": "things" } },
        "x-paths-note": true,
      },
      servers: [{ url: "https://example.com", "x-s": 1 }],
      "x-root": 1,
    });

    expect(pairs(value).slice(1)).toEqual([
      ["EXT-01", "/x-root"],
      ["EXT-01", "/servers/0/x-s"],
      ["EXT-01", "/paths/~1a/get/x-fern-sdk-group-name"],
      ["EXT-01", "/paths/x-paths-note"],
    ]);
  });

  test("the reserved x-oai- and x-oas- prefixes use their own row", () => {
    const value = document("3.2", { "x-oai-a": 1, "x-oas-b": 2, "x-other": 3 });

    expect(pairs(value, "3.2").slice(1)).toEqual([
      ["EXT-02", "/x-oai-a"],
      ["EXT-02", "/x-oas-b"],
      ["EXT-01", "/x-other"],
    ]);
  });

  test("a key that starts with x- in a map of names is not an extension", () => {
    const value = document("3.1", {
      components: { schemas: { "x-name": { properties: { "x-prop": {} } } } },
      paths: {
        "/a": {
          get: {
            requestBody: { content: { "application/json": {} } },
            responses: { "200": { ...ok, headers: { "x-header": {} } } },
          },
        },
      },
    });

    expect(pairs(value)).toEqual([["INF-01", "/info"]]);
  });
});

describe("accounting", () => {
  const mixed = document("3.1", {
    components: { callbacks: { c: {} }, examples: { e: {} }, links: { l: {} } },
    externalDocs: { url: "https://example.com" },
    paths: { "/a": { get: { callbacks: { cb: {} }, "x-a": 1 } } },
    tags: [{ name: "t" }],
    webhooks: { w: {} },
    "x-root": 1,
  });

  test("every record points at a node of the document", () => {
    const records = collect(mixed);

    expect(records.length).toBeGreaterThan(8);
    for (const record of records) {
      expect(() => Effect.runSync(evaluatePointer(mixed, record.origin.pointer))).not.toThrow();
    }
  });

  test("no two records share a row and a pointer", () => {
    const keys = pairs(mixed).map(([row, pointer]) => `${row} ${pointer}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  test("the same document yields the same records in the same order", () => {
    expect(pairs(mixed)).toEqual(pairs(mixed));
  });

  test("a document with nothing informational but info yields the info record alone", () => {
    expect(pairs(document("3.0"), "3.0")).toEqual([["INF-01", "/info"]]);
  });
});
