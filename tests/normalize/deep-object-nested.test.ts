import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Operation } from "../../src/model/entities.ts";
import { normalize } from "../../src/normalize/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Line } from "../../src/validate/index.ts";

// The subjects are entities with branded fields; `expect`'s own parameter would reject the plain
// literals they are compared with.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- test helper, the value is only compared
const see = (value: unknown) => expect(value);

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const configUri = Schema.decodeUnknownSync(DocumentUri)("file:///spec/author.json");

const base = { binName: "example", package: { name: "example-cli", version: "1.0.0" } };

const decodeConfig = Schema.decodeUnknownSync(AuthorConfig);

type Switch = "absent" | "false" | "true";

const configs: Record<Switch, AuthorConfig> = {
  absent: decodeConfig(base),
  false: decodeConfig({ ...base, nonStandard: { deepObjectBrackets: false } }),
  true: decodeConfig({ ...base, nonStandard: { deepObjectBrackets: true } }),
};

const openapi: Record<"3.0" | "3.1", string> = { "3.0": "3.0.3", "3.1": "3.1.1" };

const lines = ["3.0", "3.1"] as const;

const pointer = "/paths/~1a/get/parameters/0";

const components: Json = {
  schemas: {
    Filter: { properties: { range: { $ref: "#/components/schemas/Range" } }, type: "object" },
    Flat: { properties: { gte: { type: "integer" } }, type: "object" },
    Range: { properties: { gte: { type: "integer" } }, type: "object" },
  },
};

const run = (line: Line, parameter: Json, setting: Switch) =>
  Effect.runSync(
    resolve({
      document: entry,
      line,
      value: {
        components,
        info: { title: "t", version: "1" },
        openapi: line === "3.0" ? openapi["3.0"] : openapi["3.1"],
        paths: {
          "/a": { get: { parameters: [parameter], responses: { "200": { description: "ok" } } } },
        },
      },
    }).pipe(
      Effect.flatMap((resolution) =>
        normalize(resolution, {
          checkFindings: [],
          config: configs[setting],
          configDocument: configUri,
        }),
      ),
    ),
  );

const deep = (schema: Json, required = false): Json => ({
  explode: true,
  in: "query",
  name: "filter",
  required,
  schema,
  style: "deepObject",
});

const nested: readonly (readonly [string, Json])[] = [
  ["nested object", { properties: { a: { type: "object" } }, type: "object" }],
  ["top-level array", { items: { type: "string" }, type: "array" }],
  ["nested array", { properties: { a: { items: { type: "string" }, type: "array" } } }],
  ["additionalProperties object", { additionalProperties: { type: "object" }, type: "object" }],
  ["$ref-nested", { $ref: "#/components/schemas/Filter" }],
];

const scalar: readonly (readonly [string, Json])[] = [
  ["scalar members", { properties: { a: { type: "string" } }, type: "object" }],
  ["untyped member", { properties: { a: {} }, type: "object" }],
  ["$ref scalar members", { $ref: "#/components/schemas/Flat" }],
];

const operationOf = (line: Line, parameter: Json, setting: Switch): Operation | undefined =>
  run(line, parameter, setting).api.operations[0];

const facts = (diagnostics: readonly Diagnostic[]) =>
  diagnostics
    .filter((diagnostic) => diagnostic.row === "PRM-27" || diagnostic.row === "OPR-08")
    .map((diagnostic) => [
      diagnostic.code,
      diagnostic.severity,
      diagnostic.scope,
      diagnostic.pointer,
    ]);

describe("PRM-27 nested deepObject query parameters", () => {
  for (const line of lines) {
    for (const [label, schema] of nested) {
      for (const setting of ["absent", "false"] as const) {
        test(`PRM-27: ${line} ${label}, switch ${setting}: refused at element scope`, () => {
          const result = run(line, deep(schema), setting);

          see(facts(result.diagnostics)).toEqual([
            ["PRM-27/compound-nested", "refusal", "element", pointer],
          ]);
          see(result.api.operations[0]?.parameters).toEqual([]);
        });

        test(`PRM-27: ${line} ${label} required, switch ${setting}: raised to operation scope`, () => {
          const result = run(line, deep(schema, true), setting);

          see(facts(result.diagnostics)).toEqual([
            ["OPR-08/required-parameter-refused", "refusal", "operation", "/paths/~1a/get"],
            ["PRM-27/compound-nested", "refusal", "element", pointer],
          ]);
          see(result.api.operations).toEqual([]);
        });
      }

      test(`PRM-27: ${line} ${label}, switch true: marked with the author-choice notice`, () => {
        const result = run(line, deep(schema, true), "true");
        const [parameter] = result.api.operations[0]?.parameters ?? [];

        see(facts(result.diagnostics)).toEqual([
          ["PRM-27/bracket-author-choice", "notice", "element", pointer],
        ]);
        see(parameter?.serialization).toMatchObject({
          kind: "style",
          nonStandard: "deepObjectBrackets",
          style: "deepObject",
        });
      });
    }

    for (const [label, schema] of scalar) {
      for (const setting of ["absent", "false", "true"] as const) {
        test(`PRM-27: ${line} ${label}, switch ${setting}: unchanged, not marked`, () => {
          const result = run(line, deep(schema), setting);
          const serialization = result.api.operations[0]?.parameters[0]?.serialization;

          see(facts(result.diagnostics)).toEqual([]);
          see(serialization?.kind).toBe("style");
          see(serialization !== undefined && "nonStandard" in serialization).toBe(false);
        });
      }
    }

    test(`PRM-27: ${line} a nested form query parameter is not marked under the switch`, () => {
      const schema: Json = { properties: { a: { type: "object" } }, type: "object" };
      const form: Json = { in: "query", name: "filter", schema };
      const serialization = operationOf(line, form, "true")?.parameters[0]?.serialization;

      see(serialization?.kind).toBe("style");
      see(serialization !== undefined && "nonStandard" in serialization).toBe(false);
    });
  }

  test("PRM-27: 3.1 a member type list that includes object counts as nested", () => {
    const schema: Json = { properties: { a: { type: ["object", "null"] } }, type: "object" };

    see(facts(run("3.1", deep(schema), "absent").diagnostics).map(([code]) => code)).toEqual([
      "PRM-27/compound-nested",
    ]);
  });
});
