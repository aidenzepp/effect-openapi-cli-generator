import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import nodePath from "node:path";
import { Array as Arr, Effect, Schema } from "effect";
import { emitDomainSchemas } from "../../src/emit/domain.ts";
import { domainIdentifiers } from "../../src/names/domain.ts";
import { SafeIdentifier } from "../../src/names/fold.ts";
import type { Json } from "../../src/model/pointer.ts";

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

const tsc = nodePath.resolve(root, "node_modules/.bin/tsc");

// Type-checks the emitted module beside the real `effect` package, under the repository's flags.
const typeErrors = (content: string): string => {
  const scratch = nodePath.resolve(root, "work");
  fs.mkdirSync(scratch, { recursive: true });

  const directory = fs.mkdtempSync(nodePath.resolve(scratch, "domain-emit-"));
  try {
    const file = nodePath.resolve(directory, "schemas.ts");

    fs.writeFileSync(file, content);

    const result = Bun.spawnSync(
      [
        tsc,
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        "--types",
        "node",
        file,
      ],
      { cwd: root },
    );

    return decoder.decode(result.stdout) + decoder.decode(result.stderr);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
};

const ref = (key: string): Json => ({ $ref: `#/$defs/${key}` });

const store = (entries: readonly (readonly [string, Json])[]): ReadonlyMap<string, Json> =>
  new Map(entries);

const identifier = Schema.decodeSync(SafeIdentifier);

const identifiersOf = (entries: readonly (readonly [string, Json])[]) =>
  domainIdentifiers(entries.map(([key]) => key));

const emit = (entries: readonly (readonly [string, Json])[], roots: readonly string[]) =>
  Effect.runPromise(emitDomainSchemas(store(entries), roots, identifiersOf(entries))).then(
    (file) => file.content,
  );

const failure = (
  entries: readonly (readonly [string, Json])[],
  roots: readonly string[],
  identifiers = identifiersOf(entries),
) => Effect.runPromise(emitDomainSchemas(store(entries), roots, identifiers).pipe(Effect.flip));

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

// A seeded generator of definition sets (Park-Miller): short and long names, quoted keys, nested
// objects, nullable arrays and references, `additionalProperties` naming a definition, and
// recursive references inside records and arrays.
const random = (seed: number) => {
  let state = seed;

  return (): number => {
    state = (state * 48_271) % 2_147_483_647;

    return state / 2_147_483_647;
  };
};

const longStem =
  "Customer_balance_resource_cash_balance_transaction_resource_applied_to_payment_transaction_adjustment";

const fuzzDefinitions = (seed: number, count: number): readonly (readonly [string, Json])[] => {
  const draw = random(seed);
  const index = (length: number): number => Math.floor(draw() * length);
  const names = Array.from({ length: count }, (_, slot) =>
    draw() < 0.3 ? `${longStem.slice(0, 40 + index(60))}_${slot}` : `D${slot}`,
  );
  const keys = ["id", "name", "total_pretax_credit_amounts", "weird key", "x", longStem.slice(9)];
  const anyRef = (): Json => ref(names[index(names.length)] ?? "D0");
  const nullable = (schema: Json): Json =>
    draw() < 0.5 ? { anyOf: [schema, { type: "null" }] } : { anyOf: [{ type: "null" }, schema] };
  const leaves: readonly (() => Json)[] = [
    () => ({ type: "string" }),
    () => ({ maxLength: 8, minLength: 1, type: "string" }),
    () => ({ type: "integer" }),
    () => ({ type: "boolean" }),
    () => ({ enum: literals(draw() < 0.5 ? "s" : "a_much_longer_state_name", 2 + index(9)) }),
    anyRef,
  ];
  const leaf = (): Json => (leaves[index(leaves.length)] ?? anyRef)();
  const node = (depth: number, kind: "any" | "object"): Json => {
    if (kind === "object") {
      const chosen = keys.filter(() => draw() < 0.4);
      const object = {
        properties: Object.fromEntries(chosen.map((key) => [key, node(depth, "any")])),
        required: chosen.filter(() => draw() < 0.5),
        type: "object",
      };

      return draw() < 0.3 ? { additionalProperties: false, ...object } : object;
    }

    const forms: readonly (() => Json)[] = [
      leaf,
      leaf,
      () => ({ items: node(depth + 1, "any"), type: "array" }),
      () => nullable({ items: node(depth + 1, "any"), type: "array" }),
      () => ({ items: anyRef(), type: ["array", "null"] }),
      () => nullable(anyRef()),
      () => ({ additionalProperties: anyRef(), type: "object" }),
      () => ({ additionalProperties: { items: anyRef(), type: "array" }, type: "object" }),
      () => ({ anyOf: [anyRef(), anyRef()] }),
      () => node(depth + 1, "object"),
    ];

    return depth > 2 ? leaf() : (forms[index(forms.length)] ?? leaf)();
  };

  return names.map((name): readonly [string, Json] => [
    name,
    node(0, draw() < 0.7 ? "object" : "any"),
  ]);
};

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
  }, 30_000);

  test("a definition a Schema.Codec annotation names has its type, recursive or not", async () => {
    const content = await emit(
      [
        ["A", { properties: { b: ref("B") }, type: "object" }],
        ["B", { properties: { c: ref("C") }, type: "object" }],
        ["C", { properties: { a: ref("A"), b: ref("B") }, type: "object" }],
      ],
      ["A", "B", "C"],
    );

    expect(content).toContain("Schema.suspend((): Schema.Codec<A> => A)");
    expect(typeErrors(content)).toBe("");
    expectFixedPoint(content);
  }, 60_000);

  test("a type and its value of one name pass the repository lint", async () => {
    const content = await emit(
      [
        ["A", { properties: { a: ref("A") }, type: "object" }],
        ["B", { properties: { a: ref("A") }, type: "object" }],
      ],
      ["A", "B"],
    );
    const directory = fs.mkdtempSync(nodePath.resolve(root, "tests/emit/lint-scratch-"));
    try {
      fs.writeFileSync(nodePath.resolve(directory, "schemas.ts"), content);

      const lint = Bun.spawnSync([vp, "lint", directory], { cwd: root });

      expect(decoder.decode(lint.stdout) + decoder.decode(lint.stderr)).not.toContain(
        "no-redeclare",
      );
      expect(lint.exitCode).toBe(0);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  }, 60_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
    expect(content).toContain('"caf\\u00E9"');
    expect(content).toContain("class:");
    expectFixedPoint(content);
  }, 30_000);

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
  }, 30_000);

  test("a recursive reference inside Record breaks out its arguments", async () => {
    const content = await emit(
      [
        [
          "P",
          {
            properties: { m: { additionalProperties: ref("P"), type: "object" } },
            type: "object",
          },
        ],
      ],
      ["P"],
    );

    expect(content).toContain(`Schema.Record(
        Schema.String,
        Schema.suspend((): Schema.Codec<P> => P),
      ),`);
    expectFixedPoint(content);
  }, 30_000);

  test("a reference beside null stays on its member's line", async () => {
    const content = await emit(
      [
        [
          "Invoice",
          {
            properties: {
              next: ref("Invoice"),
              total_pretax_credit_amounts: {
                anyOf: [
                  { items: ref("Invoices_resource_pretax_credit_amount"), type: "array" },
                  { type: "null" },
                ],
              },
            },
            type: "object",
          },
        ],
        [
          "Invoices_resource_pretax_credit_amount",
          { properties: { amount: { type: "integer" } }, type: "object" },
        ],
      ],
      ["Invoice"],
    );

    expect(content).toContain(
      "  readonly total_pretax_credit_amounts?: ReadonlyArray<InvoicesResourcePretaxCreditAmount> | null;",
    );
    expectFixedPoint(content);
  }, 30_000);

  test("a type whose head does not fit opens under the =", async () => {
    const key = `${longStem}_reversal`;
    const name = identifiersOf([[key, {}]]).get(key);
    const content = await emit([[key, { properties: { self: ref(key) }, type: "object" }]], [key]);

    expect(content).toContain(`export type ${name} =\n  {`);
    expectFixedPoint(content);
  }, 30_000);

  test("generated definition sets pass vp fmt", async () => {
    const contents = await Promise.all(
      [1, 2, 3, 10, 18].map((seed) => {
        const entries = fuzzDefinitions(seed, 200);

        return emit(
          entries,
          entries.map(([name]) => name),
        );
      }),
    );

    for (const content of contents) {
      expectFixedPoint(content);
    }
  }, 30_000);

  test("no request-reachable definitions make an empty module", async () => {
    const content = await emit([["Unreached", { type: "string" }]], []);

    expect(content).toBe("export {};\n");
    expectFixedPoint(content);
  }, 30_000);

  test("a definition that is not a schema object is refused", async () => {
    const error = await failure([["Any", true]], ["Any"]);

    expect(error).toMatchObject({ _tag: "DomainEmitError", reason: "unsupported-definition" });
  });

  test("a schema the importer rejects is refused", async () => {
    const error = await failure([["Odd", { not: { type: "string" } }]], ["Odd"]);

    expect(error).toMatchObject({ _tag: "DomainEmitError", reason: "import-failed" });
  });

  test("exports, references and identifier annotations carry the folded name", async () => {
    const content = await emit(
      [
        ["user_update", { properties: { avatar: ref("my-schema") }, type: "object" }],
        ["my-schema", { type: "string" }],
        ["Schema", { type: "boolean" }],
        ["Command", { properties: { schema: ref("Schema") }, type: "object" }],
      ],
      ["user_update", "Command"],
    );

    expect(content).toContain(
      'export const MySchema = Schema.String.annotate({ identifier: "MySchema" });',
    );
    expect(content).toContain("avatar: Schema.optionalKey(MySchema)");
    expect(content).toContain(
      'export const Schema2 = Schema.Boolean.annotate({ identifier: "Schema2" });',
    );
    expect(content).toContain("export const Command2 =");
    expect(content).toContain("export const UserUpdate =");
    expect(content).not.toMatch(/user_update|my-schema|Schema1/u);
    expectFixedPoint(content);
  }, 30_000);

  test("a copy key the identifier map does not name is refused", async () => {
    const entries: readonly (readonly [string, Json])[] = [
      ["Root", { properties: { leaf: ref("Leaf") }, type: "object" }],
      ["Leaf", { type: "string" }],
    ];
    const error = await failure(entries, ["Root"], domainIdentifiers(["Root"]));

    expect(error).toMatchObject({ _tag: "DomainEmitError", reason: "identifier-mismatch" });
  });

  test("two copy keys with one name are refused", async () => {
    const entries: readonly (readonly [string, Json])[] = [
      ["A", { type: "string" }],
      ["B", { type: "integer" }],
    ];
    const error = await failure(
      entries,
      ["A", "B"],
      new Map([
        ["A", identifier("Shared")],
        ["B", identifier("Shared")],
      ]),
    );

    expect(error).toMatchObject({ _tag: "DomainEmitError", reason: "identifier-mismatch" });
  });

  test("a name Effect exports differently is refused", async () => {
    // Effect reserves `Schema` and would export `Schema1`.
    const error = await failure(
      [["Root", { type: "string" }]],
      ["Root"],
      new Map([["Root", identifier("Schema")]]),
    );

    expect(error).toMatchObject({ _tag: "DomainEmitError", reason: "identifier-mismatch" });
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
