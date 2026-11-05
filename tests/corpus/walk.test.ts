import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { walk } from "../../corpus/tools/walk.ts";
import type { WalkElement } from "../../corpus/tools/walk.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const walked = (value: Json): readonly WalkElement[] =>
  Effect.runSync(
    resolve({ document: entry, line: "3.1", value }).pipe(
      Effect.orDie,
      Effect.flatMap((resolution) => walk(resolution)),
    ),
  );

// Each element as `kind pointer detail`, in the walker's order (sorted by pointer).
const lines = (value: Json): readonly string[] =>
  walked(value).map((element) => {
    if (element.kind === "operation") {
      return `operation ${element.pointer} ${element.method} ${element.path}`;
    }

    if (element.kind === "parameter") {
      return `parameter ${element.pointer} ${element.in}:${element.name}`;
    }

    if (element.kind === "requestMedia") {
      return `requestMedia ${element.pointer} ${element.mediaType}`;
    }

    if (element.kind === "response") {
      return `response ${element.pointer} ${element.key}`;
    }

    if (element.kind === "securityAlternative") {
      return `securityAlternative ${element.pointer} ${element.schemes.join(",")}`;
    }

    return `server ${element.pointer} ${element.url}`;
  });

const base = { info: { title: "t", version: "1" }, openapi: "3.1.1" };

const ok = { "200": { description: "ok" } };

describe("outline walk", () => {
  test("a small spec yields the exact element list", () => {
    const value: Json = {
      ...base,
      components: { securitySchemes: { key: { in: "header", name: "x-key", type: "apiKey" } } },
      paths: {
        "/users/{id}": {
          get: {
            parameters: [
              { in: "path", name: "id", required: true, schema: { type: "string" } },
              { in: "query", name: "q", schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" }, default: { description: "err" } },
          },
          post: {
            requestBody: {
              content: { "application/json": {}, "text/plain": {} },
            },
            responses: ok,
            security: [{ key: [] }, {}],
          },
          servers: [{ url: "https://path.example" }],
        },
      },
      security: [{ key: [] }],
      servers: [{ url: "https://api.example" }],
    };

    expect(lines(value)).toEqual([
      "operation /paths/~1users~1{id}/get get /users/{id}",
      "parameter /paths/~1users~1{id}/get/parameters/0 path:id",
      "parameter /paths/~1users~1{id}/get/parameters/1 query:q",
      "response /paths/~1users~1{id}/get/responses/200 200",
      "response /paths/~1users~1{id}/get/responses/default default",
      "operation /paths/~1users~1{id}/post post /users/{id}",
      "requestMedia /paths/~1users~1{id}/post/requestBody/content/application~1json application/json",
      "requestMedia /paths/~1users~1{id}/post/requestBody/content/text~1plain text/plain",
      "response /paths/~1users~1{id}/post/responses/200 200",
      "securityAlternative /paths/~1users~1{id}/post/security/0 key",
      "securityAlternative /paths/~1users~1{id}/post/security/1 ",
      "server /paths/~1users~1{id}/servers/0 https://path.example",
      "securityAlternative /security/0 key",
      "server /servers/0 https://api.example",
    ]);
  });

  test("a $ref'd parameter is listed at its use site, not at its target", () => {
    const value: Json = {
      ...base,
      components: { parameters: { Limit: { in: "query", name: "limit" } } },
      paths: {
        "/a": {
          get: {
            parameters: [{ $ref: "#/components/parameters/Limit" }],
            responses: ok,
          },
        },
      },
    };

    expect(lines(value)).toEqual([
      "operation /paths/~1a/get get /a",
      "parameter /paths/~1a/get/parameters/0 query:limit",
      "response /paths/~1a/get/responses/200 200",
    ]);
  });

  test("a $ref'd request body and response are listed at their use sites", () => {
    const value: Json = {
      ...base,
      components: {
        requestBodies: { Body: { content: { "application/json": {} } } },
        responses: { Fine: { description: "ok" } },
      },
      paths: {
        "/a": {
          put: {
            requestBody: { $ref: "#/components/requestBodies/Body" },
            responses: { "204": { $ref: "#/components/responses/Fine" } },
          },
        },
      },
    };

    expect(lines(value)).toEqual([
      "operation /paths/~1a/put put /a",
      "requestMedia /paths/~1a/put/requestBody/content/application~1json application/json",
      "response /paths/~1a/put/responses/204 204",
    ]);
  });

  test("a $ref'd path item lists its operations under the use-site path", () => {
    const value: Json = {
      ...base,
      components: {
        pathItems: {
          Shared: { get: { parameters: [{ in: "header", name: "x-id" }], responses: ok } },
        },
      },
      paths: { "/b": { $ref: "#/components/pathItems/Shared" } },
    };

    expect(lines(value)).toEqual([
      "operation /paths/~1b/get get /b",
      "parameter /paths/~1b/get/parameters/0 header:x-id",
      "response /paths/~1b/get/responses/200 200",
    ]);
  });

  test("path-level parameters are listed once at the path item, never per operation", () => {
    const value: Json = {
      ...base,
      paths: {
        "/c": {
          delete: { responses: ok },
          get: { responses: ok },
          parameters: [{ in: "query", name: "shared" }],
        },
      },
    };

    expect(lines(value)).toEqual([
      "operation /paths/~1c/delete delete /c",
      "response /paths/~1c/delete/responses/200 200",
      "operation /paths/~1c/get get /c",
      "response /paths/~1c/get/responses/200 200",
      "parameter /paths/~1c/parameters/0 query:shared",
    ]);
  });

  test("same name in different locations are distinct parameters", () => {
    const value: Json = {
      ...base,
      paths: {
        "/d": {
          get: {
            parameters: [
              { in: "query", name: "id" },
              { in: "header", name: "id" },
            ],
            responses: ok,
          },
        },
      },
    };

    expect(
      walked(value).flatMap((e) => (e.kind === "parameter" ? [`${e.in}:${e.name}`] : [])),
    ).toEqual(["query:id", "header:id"]);
  });

  test("a spec with no operations yields only its servers and security", () => {
    expect(lines({ ...base, paths: {}, servers: [{ url: "/" }] })).toEqual(["server /servers/0 /"]);
  });

  test("each operation records the path-item and root elements it inherits", () => {
    const value: Json = {
      ...base,
      components: { securitySchemes: { key: { in: "header", name: "x-key", type: "apiKey" } } },
      paths: {
        "/f": {
          delete: { responses: ok, security: [], servers: [{ url: "https://own.example" }] },
          get: { parameters: [{ in: "header", name: "x-id" }], responses: ok },
          parameters: [
            { in: "query", name: "q" },
            { in: "header", name: "X-Id" },
          ],
          post: { parameters: [{ in: "query", name: "Q" }], responses: ok },
        },
        "/g": { get: { responses: ok }, servers: [{ url: "https://path.example" }] },
      },
      security: [{ key: [] }, {}],
      servers: [{ url: "https://api.example" }],
    };

    expect(
      walked(value).flatMap((element) =>
        element.kind === "operation"
          ? [`${element.pointer} ${element.inherits.join(" ")} default:${element.defaultServer}`]
          : [],
      ),
    ).toEqual([
      "/paths/~1f/delete /paths/~1f/parameters/0 /paths/~1f/parameters/1 default:false",
      "/paths/~1f/get /paths/~1f/parameters/0 /security/0 /security/1 /servers/0 default:false",
      "/paths/~1f/post /paths/~1f/parameters/0 /paths/~1f/parameters/1 /security/0 /security/1 /servers/0 default:false",
      "/paths/~1g/get /paths/~1g/servers/0 /security/0 /security/1 default:false",
    ]);
  });

  test("an operation with no servers at any level takes the default server", () => {
    expect(
      walked({ ...base, paths: { "/h": { get: { responses: ok } } } }).flatMap((element) =>
        element.kind === "operation" ? [element.defaultServer] : [],
      ),
    ).toEqual([true]);
  });

  test("webhooks and callbacks are not request elements", () => {
    const value: Json = {
      ...base,
      paths: {
        "/e": {
          post: {
            callbacks: { cb: { "{$request.body#/url}": { post: { responses: ok } } } },
            responses: ok,
          },
        },
      },
      webhooks: { hook: { post: { responses: ok } } },
    };

    expect(lines(value)).toEqual([
      "operation /paths/~1e/post post /e",
      "response /paths/~1e/post/responses/200 200",
    ]);
  });
});
