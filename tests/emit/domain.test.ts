import { describe, expect, test } from "bun:test";
import nodePath from "node:path";
import { Array as Arr, Effect } from "effect";
import { emitDomainSchemas } from "../../src/emit/domain.ts";
import type { Json } from "../../src/resolve/pointer.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const vp = nodePath.resolve(root, "node_modules/.bin/vp");

const encoder = new TextEncoder();

const decoder = new TextDecoder();

// `vp fmt --stdin-filepath` runs the same formatter and config as `vp fmt --check`: output equal to
// input is a passing check.
const format = (text: string) => {
  const result = Bun.spawnSync([vp, "fmt", "--stdin-filepath=tests/emit/domain-printed.ts"], {
    cwd: root,
    stdin: encoder.encode(text),
  });

  return { exitCode: result.exitCode, stdout: decoder.decode(result.stdout) };
};

const ref = (key: string): Json => ({ $ref: `#/$defs/${key}` });

const store = (entries: readonly (readonly [string, Json])[]): ReadonlyMap<string, Json> =>
  new Map(entries);

const emit = (entries: readonly (readonly [string, Json])[], roots: readonly string[]) =>
  Effect.runPromise(emitDomainSchemas(store(entries), roots)).then((file) => file.content);

const failure = (entries: readonly (readonly [string, Json])[], roots: readonly string[]) =>
  Effect.runPromise(emitDomainSchemas(store(entries), roots).pipe(Effect.flip));

const expectFixedPoint = (content: string) => {
  const formatted = format(content);

  expect(formatted.exitCode).toBe(0);
  expect(formatted.stdout).toBe(content);
};

const position = (content: string, needle: string): number => {
  const index = content.indexOf(needle);

  expect(index).toBeGreaterThanOrEqual(0);

  return index;
};

const literals = (prefix: string, count: number): readonly string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}_${index}_value`);

describe("emitDomainSchemas", () => {
  test("a recursive schema goes through Schema.suspend and passes vp fmt", async () => {
    const content = await emit(
      [
        [
          "Node",
          {
            properties: {
              children: { items: ref("Node"), type: "array" },
              name: { type: "string" },
            },
            required: ["name"],
            type: "object",
          },
        ],
      ],
      ["Node"],
    );

    expect(content).toContain("Schema.suspend(");
    expect(content).toContain("export type Node =");
    expect(content).toContain("export const Node =");
    expectFixedPoint(content);
  });

  test("default, example and examples never reach the output", async () => {
    const content = await emit(
      [
        [
          "Pet",
          {
            default: { name: "secret-default" },
            example: { name: "secret-example" },
            examples: [{ name: "secret-examples" }],
            properties: {
              name: { default: "secret-name-default", examples: ["secret-name"], type: "string" },
            },
            type: "object",
          },
        ],
      ],
      ["Pet"],
    );

    expect(content).toContain("export const Pet =");
    expect(content).not.toContain("secret");
    expect(content).not.toContain("examples");
    expectFixedPoint(content);
  });

  test("properties come out sorted whatever their source order", async () => {
    const content = await emit(
      [
        [
          "Pet",
          {
            properties: Object.fromEntries([
              ["zed", { type: "string" }],
              ["alpha", { type: "string" }],
              ["mid", { type: "string" }],
            ]),
            type: "object",
          },
        ],
      ],
      ["Pet"],
    );

    expect(position(content, "alpha")).toBeLessThan(position(content, "mid"));
    expect(position(content, "mid")).toBeLessThan(position(content, "zed"));
    expectFixedPoint(content);
  });

  test("only request-reachable definitions are emitted, each after the names it reads", async () => {
    const content = await emit(
      [
        ["Reached", { type: "string" }],
        ["Root", { properties: { reached: ref("Reached") }, type: "object" }],
        ["Unreached", { type: "integer" }],
      ],
      ["Root"],
    );

    expect(content).toContain("export const Reached =");
    expect(content).toContain("export const Root =");
    expect(content).not.toContain("Unreached");
    expect(position(content, "export const Reached")).toBeLessThan(
      position(content, "export const Root"),
    );
    expectFixedPoint(content);
  });

  test("a recursive definition is declared before a definition that reads it", async () => {
    const content = await emit(
      [
        ["A", { properties: { next: ref("A") }, type: "object" }],
        ["Z", { properties: { head: ref("A") }, type: "object" }],
      ],
      ["Z"],
    );

    expect(position(content, "export const A =")).toBeLessThan(
      position(content, "export const Z ="),
    );
    expectFixedPoint(content);
  });

  test("mutually recursive definitions emit without a reference cycle", async () => {
    const content = await emit(
      [
        ["Left", { properties: { right: ref("Right") }, type: "object" }],
        ["Right", { properties: { left: ref("Left") }, type: "object" }],
      ],
      ["Left"],
    );

    expect(content.match(/Schema\.suspend\(/gu)?.length).toBe(2);
    expect(content).toContain("export type Left =");
    expect(content).toContain("export type Right =");
    expectFixedPoint(content);
  });

  test("the output is the same for the same definitions in any order", async () => {
    const entries: readonly (readonly [string, Json])[] = [
      ["B", { type: "integer" }],
      ["A", { properties: { b: ref("B") }, type: "object" }],
    ];
    const forward = await emit(entries, ["A"]);
    const backward = await emit(Arr.reverse(entries), ["A"]);

    expect(backward).toBe(forward);
  });

  test("chains, long literal unions and number lists keep the formatter's layout", async () => {
    const content = await emit(
      [
        [
          "Tags",
          {
            items: { maxLength: 8, minLength: 1, type: "string" },
            maxItems: 5,
            minItems: 1,
            type: "array",
          },
        ],
        ["Status", { enum: literals("state", 8) }],
        ["Codes", { enum: Array.from({ length: 40 }, (_, index) => index * 1000) }],
        ["Small", { maximum: 5, minimum: 1, multipleOf: 2, type: "integer" }],
      ],
      ["Tags", "Status", "Codes", "Small"],
    );

    expectFixedPoint(content);
  });

  test("recursive types with long unions, nullable objects and optional tuple elements", async () => {
    const content = await emit(
      [
        [
          "Tree",
          {
            properties: {
              children: { items: ref("Tree"), type: "array" },
              kind: { enum: literals("kind", 6) },
              link: {
                anyOf: [
                  { properties: { target: { type: "string" } }, type: "object" },
                  { type: "null" },
                ],
              },
              pair: {
                items: false,
                prefixItems: [{ type: "string" }, { enum: literals("slot", 8) }],
                type: "array",
              },
            },
            type: "object",
          },
        ],
      ],
      ["Tree"],
    );

    expect(content).toContain("export type Tree = {");
    expectFixedPoint(content);
  });

  test("keys that need quotes stay quoted and escaped", async () => {
    const content = await emit(
      [
        [
          "Odd",
          {
            additionalProperties: false,
            properties: Object.fromEntries(
              ["weird key", "200", "__proto__", "café", "中文", "class"].map((key) => [
                key,
                { type: "string" },
              ]),
            ),
            type: "object",
          },
        ],
      ],
      ["Odd"],
    );

    expect(content).toContain('"weird key"');
    expect(content).toContain('["__proto__"]');
    expect(content).toContain('"caf\\u00e9"');
    expect(content).toContain("class:");
    expectFixedPoint(content);
  });

  test("wide characters count two columns where the line breaks", async () => {
    const entries = ["中", "😀"].flatMap((char) =>
      Array.from({ length: 40 }, (_, index): readonly [string, Json] => [
        `Wide${char.codePointAt(0)}x${index + 10}`,
        { description: char.repeat(index + 10), type: "string" },
      ]),
    );
    const content = await emit(
      entries,
      entries.map(([name]) => name),
    );

    expectFixedPoint(content);
  });

  test("no request-reachable definitions make an empty module", async () => {
    const content = await emit([["Unreached", { type: "string" }]], []);

    expect(content).toBe("export {};\n");
    expectFixedPoint(content);
  });

  test("a definition that is not a schema object is refused", async () => {
    const error = await failure([["Any", true]], ["Any"]);

    expect(error).toMatchObject({ _tag: "DomainEmitError", reason: "unsupported-definition" });
  });

  test("a schema the importer rejects is refused", async () => {
    const error = await failure([["Odd", { not: { type: "string" } }]], ["Odd"]);

    expect(error).toMatchObject({ _tag: "DomainEmitError", reason: "import-failed" });
  });

  test("exact bytes of a small module", async () => {
    const content = await emit(
      [
        ["Tag", { enum: ["a", "b"] }],
        [
          "Pair",
          {
            properties: { count: { type: "integer" }, tag: ref("Tag") },
            required: ["tag"],
            type: "object",
          },
        ],
      ],
      ["Pair"],
    );

    expect(content).toBe(`import { Schema } from "effect";

export const Tag = Schema.Literals(["a", "b"]).annotate({ identifier: "Tag" });

export const Pair = Schema.StructWithRest(
  Schema.Struct({ count: Schema.optionalKey(Schema.Int), tag: Tag }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "Pair" });
`);
  });
});
