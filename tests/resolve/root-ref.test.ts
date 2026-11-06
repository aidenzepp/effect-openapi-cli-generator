import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import { normalizeSchemas } from "../../src/normalize/schemas.ts";
import type { Json } from "../../src/model/pointer.ts";
import { nodeAt, resolve } from "../../src/resolve/index.ts";
import { GenerationReport } from "../../src/report/index.ts";
import type { Line } from "../../src/validate/index.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const bin = nodePath.join(root, "src/bin.ts");

const config = nodePath.join(root, "tests/fixtures/golden/users-update/author-config.json");

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const decodeReport = Schema.decodeUnknownSync(GenerationReport);

const scratch = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "root-ref-"));

afterAll(() => {
  nodeFs.rmSync(scratch, { force: true, recursive: true });
});

const cases: readonly { readonly line: Line; readonly openapi: string; readonly code: string }[] = [
  { code: "REF-02/non-schema-target", line: "3.0", openapi: "3.0.3" },
  { code: "SCH-03/non-schema-target", line: "3.1", openapi: "3.1.1" },
];

// One GET /a whose query parameter `q` carries the schema `{"$ref": "#"}`.
const spec = (openapi: string, required: boolean): Json => ({
  info: { title: "t", version: "1" },
  openapi,
  paths: {
    "/a": {
      get: {
        operationId: "a-get",
        parameters: [{ in: "query", name: "q", required, schema: { $ref: "#" } }],
        responses: { "204": { description: "ok" } },
        tags: ["a"],
      },
    },
  },
});

const schemaPointer = "/paths/~1a/get/parameters/0/schema";

// The resolver's diagnostics and the schema normalizer's, as the pipeline reports them together.
const diagnosed = (line: Line, value: Json) =>
  Effect.runSync(
    resolve({ document: entry, line, value }).pipe(
      Effect.flatMap((resolution) =>
        normalizeSchemas(resolution).pipe(
          Effect.map((normalization) => [...resolution.diagnostics, ...normalization.diagnostics]),
        ),
      ),
    ),
  );

let runs = 0;

const generate = (value: Json) => {
  runs += 1;
  const dir = nodePath.join(scratch, `run-${runs}`);
  nodeFs.mkdirSync(dir);
  nodeFs.writeFileSync(nodePath.join(dir, "openapi.json"), JSON.stringify(value));

  const ran = Bun.spawnSync(
    [
      "bun",
      bin,
      "generate",
      "openapi.json",
      "--config",
      config,
      "--out",
      "out",
      "--report",
      "json",
    ],
    { cwd: dir },
  );

  return {
    exitCode: ran.exitCode,
    stderr: new TextDecoder().decode(ran.stderr),
    stdout: new TextDecoder().decode(ran.stdout),
  };
};

describe("a schema $ref to the document root", () => {
  for (const { code, line, openapi } of cases) {
    test(`${line}: the schema is refused as ${code} at element scope, not left to the importer`, () => {
      const refusals = diagnosed(line, spec(openapi, false)).filter(
        (diagnostic) => diagnostic.severity === "refusal",
      );

      expect(refusals.map((diagnostic) => `${diagnostic.code} ${diagnostic.pointer}`)).toEqual([
        `${code} ${schemaPointer}`,
      ]);
      expect(refusals.map((diagnostic) => diagnostic.scope)).toEqual(["element"]);
    });

    test(`${line}: generate --report json exits 0 and its stdout parses as the report`, () => {
      for (const required of [false, true]) {
        const ran = generate(spec(openapi, required));
        const report = decodeReport(JSON.parse(ran.stdout));

        expect(ran.exitCode).toBe(0);
        expect(
          report.refusals.map((diagnostic) => `${diagnostic.code} ${diagnostic.scope}`),
        ).toContain(`${code} element`);
      }
    });

    test(`${line}: a parameter reference to the root is refused as ${code}, not DOC-23`, () => {
      const value: Json = {
        info: { title: "t", version: "1" },
        openapi,
        paths: {
          "/a": {
            get: { parameters: [{ $ref: "#" }], responses: { "204": { description: "ok" } } },
          },
        },
      };
      const refusal = Effect.runSync(
        Effect.flip(resolve({ document: entry, line, value })),
      ).diagnostic;

      expect(refusal.code).toBe(code);
      expect(String(refusal.pointer)).toBe("/paths/~1a/get/parameters/0");
    });
  }

  test("nodeAt on a pointer that does not parse returns undefined, not the root", () => {
    expect(nodeAt({ a: 1 }, "no-slash")).toBeUndefined();
    expect(nodeAt({ a: 1 }, "/a")).toBe(1);
  });
});
