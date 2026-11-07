import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import {
  dispatchOrder,
  normalizeResponses,
  precedenceOrder,
} from "../../src/normalize/responses.ts";
import type { ResponseCase } from "../../src/model/entities.ts";
import { normalizeParameter } from "../../src/normalize/parameters.ts";
import type { NormalizedResponses } from "../../src/normalize/responses.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

interface Members {
  readonly [key: string]: Json;
}

const responsesPointer = "/paths/~1a/get/responses";

const normalize = (
  line: Line,
  responses: Members,
  components: Members = {},
): NormalizedResponses => {
  const value: Json = {
    components,
    info: { title: "t", version: "1" },
    openapi: openapi[line],
    paths: { "/a": { get: { responses } } },
  };
  const resolution = Effect.runSync(resolve({ document: entry, line, value }));

  return Effect.runSync(normalizeResponses(resolution, responsesPointer));
};

const keys = (result: NormalizedResponses) => result.responses.map((response) => response.key);

const text = (value: string | undefined): string | undefined => value;

const headerNames = (response: ResponseCase | undefined) =>
  response?.headers.map((header) => text(header.name));

const members = (...names: readonly string[]): Members =>
  Object.fromEntries(names.map((name) => [name, {}]));

const content = (media: Members): Members => ({ "200": { content: media, description: "ok" } });

const codes = (result: NormalizedResponses) =>
  result.diagnostics.map((diagnostic) => diagnostic.code);

const ok: Members = { description: "ok" };

const described = (...names: readonly string[]): Members =>
  Object.fromEntries(names.map((name) => [name, ok]));

describe("response keys", () => {
  test("an explicit code, a range and default become their key kinds in member order", () => {
    // JavaScript lists integer-like keys first and ascending, so 200 precedes 404 here.
    const result = normalize("3.1", described("404", "2XX", "default", "200"));

    expect(keys(result)).toEqual([{ code: 200 }, { code: 404 }, { range: 2 }, "default"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("each case keeps its use site as origin", () => {
    const [first] = normalize("3.1", { "200": ok }).responses;

    expect(text(first?.origin.document)).toBe(entry);
    expect(text(first?.origin.pointer)).toBe(`${responsesPointer}/200`);
  });

  test("a code outside 100 to 599 is refused at element scope and its case is not built", () => {
    const result = normalize("3.1", { "200": ok, "600": ok });

    expect(keys(result)).toEqual([{ code: 200 }]);
    expect(codes(result)).toEqual(["RSS-10/status-out-of-range"]);
    expect(result.diagnostics[0]?.scope).toBe("element");
    expect(result.diagnostics[0]?.severity).toBe("refusal");
    expect(text(result.diagnostics[0]?.pointer)).toBe(`${responsesPointer}/600`);
  });

  test("a lowercase range and a key outside the grammar are refused", () => {
    const result = normalize("3.1", { "2xx": ok, "6XX": ok, nope: ok });

    expect(keys(result)).toEqual([]);
    expect(codes(result)).toEqual([
      "RSS-06/invalid-key",
      "RSS-06/invalid-key",
      "RSS-06/invalid-key",
    ]);
  });

  test("a vendor extension key is not a response and raises no diagnostic", () => {
    const result = normalize("3.1", { "200": ok, "x-note": "text" });

    expect(keys(result)).toEqual([{ code: 200 }]);
    expect(result.diagnostics).toEqual([]);
  });

  test("an absent Responses Object has no cases", () => {
    const value: Json = {
      info: { title: "t", version: "1" },
      openapi: openapi["3.1"],
      paths: { "/a": { get: {} } },
    };
    const resolution = Effect.runSync(resolve({ document: entry, line: "3.1", value }));
    const result = Effect.runSync(normalizeResponses(resolution, responsesPointer));

    expect(result).toEqual({ diagnostics: [], responses: [] });
  });
});

describe("response headers", () => {
  const headers = {
    "Retry-After": { schema: { type: "integer" } },
    "X-Request-Id": { schema: { type: "string" } },
  };

  test("declared header names are recorded in order and nothing else", () => {
    const [first] = normalize("3.1", { "429": { description: "slow", headers } }).responses;

    expect(headerNames(first)).toEqual(["Retry-After", "X-Request-Id"]);
  });

  test("a response without headers records none", () => {
    const [first] = normalize("3.1", { "200": ok }).responses;

    expect(headerNames(first)).toEqual([]);
  });

  test("a Content-Type header is ignored with a notice, whatever its case", () => {
    const result = normalize("3.1", {
      "200": {
        description: "ok",
        headers: { "X-Rate": { schema: {} }, "content-type": { schema: { type: "string" } } },
      },
    });

    expect(headerNames(result.responses[0])).toEqual(["X-Rate"]);
    expect(codes(result)).toEqual(["RSP-09/ignored-content-type"]);
    expect(result.diagnostics[0]?.severity).toBe("notice");
    expect(text(result.diagnostics[0]?.pointer)).toBe(
      `${responsesPointer}/200/headers/content-type`,
    );
  });

  test("a header name that is not a token is refused and the case stays", () => {
    const result = normalize("3.1", {
      "200": {
        description: "ok",
        headers: { "X-Rate": { schema: {} }, "bad name": { schema: {} } },
      },
    });

    expect(headerNames(result.responses[0])).toEqual(["X-Rate"]);
    expect(codes(result)).toEqual(["RSP-09/invalid-header-name"]);
    expect(result.diagnostics[0]?.severity).toBe("refusal");
  });
});

describe("HDR-15 response header percent-encoding in 3.0", () => {
  const traced: Members = {
    "200": {
      description: "ok",
      headers: {
        "Content-Type": { schema: { type: "string" } },
        "X-Body": { content: { "text/plain": { schema: { type: "string" } } } },
        "X-Rate": { schema: { type: "integer" } },
        "X-Trace": { $ref: "#/components/headers/Trace" },
      },
    },
  };
  const components: Members = { headers: { Trace: { schema: { type: "string" } } } };

  test("each schema-serialized header gets one notice at its use site", () => {
    const result = normalize("3.0", traced, components);
    const notices = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "HDR-15/header-percent-encoding",
    );

    expect(notices.map((diagnostic) => text(diagnostic.pointer))).toEqual([
      `${responsesPointer}/200/headers/X-Rate`,
      `${responsesPointer}/200/headers/X-Trace`,
    ]);
    expect(notices.map((diagnostic) => [diagnostic.severity, diagnostic.scope])).toEqual([
      ["notice", "element"],
      ["notice", "element"],
    ]);
    expect(codes(result)).toEqual([
      "RSP-09/ignored-content-type",
      "HDR-15/header-percent-encoding",
      "HDR-15/header-percent-encoding",
    ]);
  });

  test("the notice says what the PRM-32 header parameter notice says", () => {
    const notice = normalize("3.0", traced, components).diagnostics.find(
      (diagnostic) => diagnostic.code === "HDR-15/header-percent-encoding",
    );

    const value: Json = {
      info: { title: "t", version: "1" },
      openapi: openapi["3.0"],
      paths: {
        "/a": {
          get: {
            parameters: [{ in: "header", name: "X-Rate", schema: {} }],
            responses: { "200": ok },
          },
        },
      },
    };
    const parameter = Effect.runSync(
      resolve({ document: entry, line: "3.0", value }).pipe(
        Effect.flatMap((resolution) =>
          normalizeParameter(resolution, {
            openapi: openapi["3.0"],
            pointer: "/paths/~1a/get/parameters/0",
          }),
        ),
      ),
    );
    const [prm32] = parameter.diagnostics;

    expect(prm32?.code).toBe("PRM-32/header-percent-encoding");
    expect(notice?.message).toBe(prm32?.message);
  });

  test("3.1 and 3.2 headers already agree with the correction", () => {
    expect(codes(normalize("3.1", traced, components))).toEqual(["RSP-09/ignored-content-type"]);
    expect(codes(normalize("3.2", traced, components))).toEqual(["RSP-09/ignored-content-type"]);
  });
});

describe("referenced responses and docs", () => {
  const components: Members = {
    responses: { Slow: { description: "Too slow.", headers: { "Retry-After": { schema: {} } } } },
  };

  test("a response reference is followed to its target", () => {
    const [first] = normalize(
      "3.1",
      { "429": { $ref: "#/components/responses/Slow" } },
      components,
    ).responses;

    expect(headerNames(first)).toEqual(["Retry-After"]);
    expect(text(first?.docs.description)).toBe("Too slow.");
    expect(text(first?.origin.pointer)).toBe(`${responsesPointer}/429`);
  });

  test("a 3.1 use-site description overrides the target", () => {
    const [first] = normalize(
      "3.1",
      { "429": { $ref: "#/components/responses/Slow", description: "Back off." } },
      components,
    ).responses;

    expect(text(first?.docs.description)).toBe("Back off.");
  });

  test("help text is made safe", () => {
    const [first] = normalize("3.1", { "200": { description: "a\u0007b" } }).responses;

    expect(text(first?.docs.description)).toBe("ab");
  });
});

describe("media alternatives", () => {
  test("a response without content has no alternatives", () => {
    const [first] = normalize("3.1", { "204": { description: "none" } }).responses;

    expect(first?.alternatives).toEqual([]);
  });

  test("alternatives keep document order with the codec derived from the media type", () => {
    const [first] = normalize(
      "3.1",
      content(
        members(
          "application/json",
          "application/problem+json",
          "text/plain",
          "application/xml",
          "application/octet-stream",
          "text/event-stream",
          "application/x-ndjson",
          "application/json-seq",
          "image/*",
        ),
      ),
    ).responses;

    expect(first?.alternatives.map((alt) => [text(alt.mediaType), alt.codec])).toEqual([
      ["application/json", "json"],
      ["application/problem+json", "json"],
      ["text/plain", "text"],
      ["application/xml", "xml"],
      ["application/octet-stream", "binary"],
      ["text/event-stream", "sse"],
      ["application/x-ndjson", "ndjson"],
      ["application/json-seq", "jsonseq"],
      ["image/*", "binary"],
    ]);
  });

  test("a schema reference uses its defs key and an inline schema its canonical pointer key", () => {
    const [named, inline] = normalize(
      "3.1",
      {
        "200": {
          content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
          description: "ok",
        },
        "201": {
          content: { "application/json": { schema: { type: "object" } } },
          description: "ok",
        },
      },
      { schemas: { User: { type: "object" } } },
    ).responses;

    expect(named?.alternatives[0]?.schema?.key).toBe("User");
    expect(inline?.alternatives[0]?.schema?.key).toBe(
      `${responsesPointer}/201/content/application~1json/schema`,
    );
  });

  test("a 3.2 itemSchema is kept apart from schema", () => {
    const [first] = normalize(
      "3.2",
      content({ "text/event-stream": { itemSchema: { type: "string" } } }),
    ).responses;
    const [alternative] = first?.alternatives ?? [];

    expect(alternative?.schema).toBeUndefined();
    expect(alternative?.itemSchema?.key).toBe(
      `${responsesPointer}/200/content/text~1event-stream/itemSchema`,
    );
  });

  test("a content key that is not a media type or range is refused", () => {
    const result = normalize("3.1", content(members("application/json", "not a type")));

    expect(result.responses[0]?.alternatives.map((alt) => text(alt.mediaType))).toEqual([
      "application/json",
    ]);
    expect(codes(result)).toEqual(["RSP-05/invalid-media-type"]);
  });
});

describe("order", () => {
  test("dispatch tries exact keys, then type ranges, then the full range, each in document order", () => {
    const [first] = normalize(
      "3.1",
      content(members("*/*", "text/*", "text/plain", "application/json; charset=utf-8", "image/*")),
    ).responses;

    expect(dispatchOrder(first?.alternatives ?? []).map((alt) => text(alt.mediaType))).toEqual([
      "text/plain",
      "application/json; charset=utf-8",
      "text/*",
      "image/*",
      "*/*",
    ]);
  });

  test("an explicit code beats a range and a range beats default", () => {
    const { responses } = normalize("3.1", described("default", "5XX", "404", "4XX", "200"));

    expect(precedenceOrder(responses).map((response) => response.key)).toEqual([
      { code: 200 },
      { code: 404 },
      { range: 4 },
      { range: 5 },
      "default",
    ]);
  });
});
