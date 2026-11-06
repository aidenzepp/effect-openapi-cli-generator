import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate, GenerateRefused } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Json } from "../../src/model/pointer.ts";
import { normalizeBody } from "../../src/normalize/bodies.ts";
import { normalizeResponses } from "../../src/normalize/responses.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Line } from "../../src/validate/index.ts";

// Media type fixes found by the body witness: MED-26 (array form-data body refused), MED-10
// (response encoding noticed), MED-09 (3.2 Media Type description noticed), MED-24 (reported once).

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

const specLine: Record<Line, string> = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.1" };

const body = "/paths/~1a/post/requestBody";

const responsesPointer = "/paths/~1a/get/responses";

const bodyOf = (line: Line, requestBody: Json) => {
  const value: Json = {
    info: { title: "t", version: "1" },
    openapi: openapi[line],
    paths: { "/a": { post: { requestBody, responses: { "200": { description: "ok" } } } } },
  };
  const resolution = Effect.runSync(resolve({ document: entry, line, value }));

  return Effect.runSync(normalizeBody(resolution, { openapi: openapi[line], pointer: body }));
};

const responsesOf = (line: Line, responses: Json) => {
  const value: Json = {
    info: { title: "t", version: "1" },
    openapi: openapi[line],
    paths: { "/a": { get: { responses } } },
  };
  const resolution = Effect.runSync(resolve({ document: entry, line, value }));

  return Effect.runSync(normalizeResponses(resolution, responsesPointer));
};

const codes = (found: { readonly diagnostics: readonly Diagnostic[] }) =>
  found.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.severity,
    diagnostic.scope,
    String(diagnostic.pointer),
  ]);

const named: Json = { properties: { name: { type: "string" } }, type: "object" };

const nameValue: Json = {
  items: {
    properties: { name: { type: "string" }, value: { type: "string" } },
    type: "object",
  },
  type: "array",
};

describe("MED-26 a form-data array body is refused", () => {
  for (const line of ["3.0", "3.1", "3.2"] as const) {
    test(`an array schema on multipart/form-data refuses the body (${line})`, () => {
      const outcome = bodyOf(line, {
        content: { "multipart/form-data": { schema: nameValue } },
        required: true,
      });

      expect(outcome._tag === "Refused" && outcome.required).toBe(true);
      expect(codes(outcome)).toEqual([
        ["MED-26/array-form-data", "refusal", "element", `${body}/content/multipart~1form-data`],
      ]);
    });
  }

  test("an object schema on multipart/form-data still generates", () => {
    expect(bodyOf("3.1", { content: { "multipart/form-data": { schema: named } } })._tag).toBe(
      "Implemented",
    );
  });

  test("a sibling alternative keeps the body", () => {
    const outcome = bodyOf("3.2", {
      content: {
        "application/json": { schema: named },
        "multipart/form-data": { schema: nameValue },
      },
    });

    expect(outcome._tag).toBe("Implemented");
    expect(codes(outcome).map(([code]) => code)).toEqual(["MED-26/array-form-data"]);
  });
});

describe("MED-10 encoding on a response media type is noticed", () => {
  for (const line of ["3.0", "3.1"] as const) {
    test(`encoding is ignored with a notice (${line})`, () => {
      const found = responsesOf(line, {
        "200": {
          content: {
            "application/json": {
              encoding: { name: { contentType: "text/plain" } },
              schema: named,
            },
          },
          description: "ok",
        },
      });

      expect(codes(found)).toEqual([
        [
          "MED-10/encoding-ignored",
          "notice",
          "element",
          `${responsesPointer}/200/content/application~1json`,
        ],
      ]);
      expect(String(found.diagnostics[0]?.specSection)).toBe(
        `https://spec.openapis.org/oas/v${specLine[line]}.html#media-type-encoding`,
      );
    });
  }

  test("a response media type without encoding has no notice", () => {
    const found = responsesOf("3.1", {
      "200": { content: { "application/json": { schema: named } }, description: "ok" },
    });

    expect(codes(found)).toEqual([]);
  });
});

describe("MED-09 a 3.2 Media Type description is noticed", () => {
  test("a response media type description is ignored with a notice", () => {
    const found = responsesOf("3.2", {
      "200": {
        content: { "application/json": { description: "the payload", schema: named } },
        description: "ok",
      },
    });

    expect(codes(found)).toEqual([
      [
        "MED-09/description-ignored",
        "notice",
        "element",
        `${responsesPointer}/200/content/application~1json`,
      ],
    ]);
  });

  test("a request media type description is ignored with a notice", () => {
    const outcome = bodyOf("3.2", {
      content: { "application/json": { description: "the payload", schema: named } },
    });

    expect(outcome._tag).toBe("Implemented");
    expect(codes(outcome)).toEqual([
      ["MED-09/description-ignored", "notice", "element", `${body}/content/application~1json`],
    ]);
  });
});

describe("MED-24 an invalid media type key is reported once", () => {
  test("normalizeBody leaves the key to the grammar check and drops the alternative", () => {
    const outcome = bodyOf("3.1", { content: { "not a type": {}, "text/plain": {} } });

    expect(codes(outcome)).toEqual([]);
    expect(outcome._tag === "Implemented" && outcome.body.alternatives.length).toBe(1);
  });

  test("generate reports the refusal exactly once", async () => {
    const root = nodePath.resolve(import.meta.dir, "../..");
    const work = nodeFs.mkdtempSync(
      nodePath.join(nodeFs.realpathSync(root), "work", "media-fixes-"),
    );
    const spec = nodePath.join(work, "openapi.json");
    const config = nodePath.join(work, "author-config.json");
    nodeFs.writeFileSync(
      spec,
      JSON.stringify({
        info: { title: "t", version: "1" },
        openapi: "3.1.2",
        paths: {
          "/a": {
            post: {
              requestBody: {
                content: { "application/json": { schema: named }, "not a type": { schema: named } },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      }),
    );
    nodeFs.copyFileSync(
      nodePath.join(root, "corpus/fixtures/rows/body/author-config.json"),
      config,
    );

    const decode = Schema.decodeUnknownSync(DocumentUri);
    const exit = await Effect.runPromiseExit(
      generate(
        {
          document: decode("file:///fixture/openapi.json"),
          generator: {
            packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
            tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
          },
          outDir: nodePath.join(work, "out"),
          source: { _tag: "File", path: spec },
          strict: false,
        },
        { document: decode("file:///fixture/author-config.json"), path: config },
      ).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
    );
    const diagnostics = Exit.isSuccess(exit)
      ? exit.value.diagnostics
      : exit.cause.reasons.flatMap((reason) =>
          reason._tag === "Fail" && reason.error instanceof GenerateRefused
            ? reason.error.diagnostics
            : [],
        );
    nodeFs.rmSync(work, { force: true, recursive: true });

    expect(diagnostics.filter((d) => d.code === "MED-24/invalid-media-type").length).toBe(1);
  });
});
