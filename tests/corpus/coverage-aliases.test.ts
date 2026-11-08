import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { coverageOf } from "../../corpus/tools/coverage.ts";
import type { Coverage } from "../../corpus/tools/coverage.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Json } from "../../src/model/pointer.ts";
import { resolve } from "../../src/resolve/index.ts";
import { Description } from "../../src/runtime-src/runtime/describe.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///fixture/openapi.json");

type Command = (typeof Description.Type)["commands"][number];

const operation = "/paths/~1a/get";

const parameter = `${operation}/parameters/0`;

const spec: Json = {
  info: { title: "t", version: "1" },
  openapi: "3.1.1",
  paths: {
    "/a": {
      get: {
        parameters: [{ in: "query", name: "limit", schema: { type: "integer" } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

const carrying = (path: readonly string[], fields: Partial<Command> = {}): Command => ({
  document: "openapi.json",
  flags: [{ location: "query", name: "limit", pointer: parameter, wireName: "limit" }],
  method: "GET",
  path,
  pathTemplate: "/a",
  pointer: operation,
  requestMedia: [],
  responses: ["200"],
  security: [],
  servers: [],
  ...fields,
});

const join = (commands: readonly Command[]): Coverage =>
  Effect.runSync(
    resolve({ document: entry, line: "3.1", value: spec }).pipe(
      Effect.flatMap((resolution) =>
        coverageOf({
          describe: JSON.stringify(
            Schema.encodeSync(Description)({ commands, describeVersion: 1 }),
          ),
          report: JSON.stringify({ notices: [], refusals: [] }),
          resolution,
        }),
      ),
      Effect.orDie,
    ),
  );

describe("coverage of an operation with alias commands", () => {
  test("two commands carrying the same elements leave nothing missing or invented", () => {
    const result = join([carrying(["a", "list"]), carrying(["b", "ls"])]);

    expect(result.missing).toEqual([]);
    expect(result.invented).toEqual([]);
  });

  test("a second command dropping a flag leaves that parameter missing", () => {
    const result = join([carrying(["a", "list"]), carrying(["b", "ls"], { flags: [] })]);

    expect(result.invented).toEqual([]);
    expect(result.missing.map((element) => element.pointer)).toEqual([parameter]);
  });

  test("a command whose pointer is no operation is still invented", () => {
    const result = join([
      carrying(["a", "list"]),
      carrying(["b", "ls"], { pointer: "/paths/~1gone/get" }),
    ]);

    expect(result.invented.map((entryInvented) => entryInvented.kind)).toEqual(["command"]);
    expect(result.missing).toEqual([]);
  });
});
