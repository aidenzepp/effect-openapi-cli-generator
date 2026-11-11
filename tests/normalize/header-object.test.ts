import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import { headerMarks } from "../../src/normalize/header-object.ts";
import type { HeaderMarks } from "../../src/normalize/header-object.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const marksOf = (headers: Json, name: string): HeaderMarks =>
  Effect.runSync(
    resolve({
      document: entry,
      line: "3.1",
      value: {
        components: { headers },
        info: { title: "t", version: "1" },
        openapi: "3.1.1",
        paths: {},
      },
    }).pipe(
      Effect.flatMap((resolution) =>
        headerMarks(resolution, { document: entry, pointer: `/components/headers/${name}` }),
      ),
    ),
  );

describe("headerMarks", () => {
  test("a non-boolean mark reads as false and keeps its sibling", () => {
    const headers = {
      bare: {},
      numeric: { required: 1, schema: { type: "string" } },
      referenced: { $ref: "#/components/headers/stringy" },
      stringy: { deprecated: "yes", required: true, schema: { type: "string" } },
    };

    expect(marksOf(headers, "stringy")).toEqual({ deprecated: false, required: true });
    expect(marksOf(headers, "numeric")).toEqual({ deprecated: false, required: false });
    expect(marksOf(headers, "bare")).toEqual({ deprecated: false, required: false });
    expect(marksOf(headers, "referenced")).toEqual({ deprecated: false, required: true });
  });
});
