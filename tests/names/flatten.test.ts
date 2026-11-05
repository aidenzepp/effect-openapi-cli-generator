import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { flattenBody } from "../../src/names/flatten.ts";
import type { MediaAlternative } from "../../src/model/entities.ts";

type Defs = Readonly<Record<string, Schema.Json>>;

type Alternative = Pick<MediaAlternative, "codec" | "schema">;

const alternative = (codec: Alternative["codec"], key: string | undefined): Alternative =>
  key === undefined ? { codec } : { codec, schema: { key } };

const run = (defs: Defs, codec: Alternative["codec"] = "json", key: string | null = "Root") => {
  const result = flattenBody(defs, alternative(codec, key ?? undefined));
  if (Result.isFailure(result)) {
    throw new Error(`flattenBody failed with ${result.failure._tag}`);
  }

  return result.success;
};

const byName = (defs: Defs) =>
  new Map(
    run(defs).flags.map(
      ({ kind, name, pointer, repeated }) => [name, { kind, pointer, repeated }] as const,
    ),
  );

const object = (properties: Record<string, Schema.Json>): Schema.Json => ({
  properties,
  type: "object",
});

describe("flattenBody", () => {
  test("whole-body flags are always offered for a json body", () => {
    const flags = byName({ Root: object({}) });
    expect([...flags]).toEqual([
      ["body", { kind: "body", pointer: "", repeated: false }],
      ["body-file", { kind: "body-file", pointer: "", repeated: false }],
    ]);
  });

  test("depth 1 and 2 are typed flags, depth 3 is one json flag, wire paths are pointers", () => {
    const flags = byName({
      Root: object({
        address: object({
          city: { type: "string" },
          geo: object({ lat: { type: "number" } }),
        }),
        name: { type: "string" },
      }),
    });
    expect(flags.get("name")).toEqual({ kind: "string", pointer: "/name", repeated: false });
    expect(flags.get("address.city")).toEqual({
      kind: "string",
      pointer: "/address/city",
      repeated: false,
    });
    expect(flags.get("address.geo")).toEqual({
      kind: "json",
      pointer: "/address/geo",
      repeated: false,
    });
    expect(flags.get("address.geo.lat")).toBeUndefined();
    expect(flags.get("address")).toBeUndefined();
  });

  test("scalar kinds, repeatable scalar arrays and json for the non-flattened cases", () => {
    const flags = byName({
      Root: object({
        age: { type: "integer" },
        either: { oneOf: [{ type: "string" }, { type: "number" }] },
        items: { items: object({ id: { type: "string" } }), type: "array" },
        map: { additionalProperties: { type: "string" }, type: "object" },
        multi: { type: ["string", "null"] },
        price: { type: "number" },
        tags: { items: { type: "string" }, type: "array" },
      }),
    });
    expect(flags.get("age")?.kind).toBe("integer");
    expect(flags.get("price")?.kind).toBe("number");
    expect(flags.get("tags")).toEqual({ kind: "string", pointer: "/tags", repeated: true });
    expect(flags.get("items")?.kind).toBe("json");
    expect(flags.get("map")?.kind).toBe("json");
    expect(flags.get("multi")?.kind).toBe("json");
    expect(flags.get("either")?.kind).toBe("json");
  });

  test("a boolean is a boolean flag", () => {
    expect(byName({ Root: object({ active: { type: "boolean" } }) }).get("active")).toEqual({
      kind: "boolean",
      pointer: "/active",
      repeated: false,
    });
  });

  test("references and allOf of plain objects flatten; conflicting allOf is json", () => {
    const flags = byName({
      A: object({ a: { $ref: "#/$defs/Leaf" }, c: { $ref: "#/$defs/Conflict" } }),
      Conflict: {
        allOf: [object({ x: { type: "string" } }), object({ x: { type: "number" } })],
      },
      Leaf: { type: "string" },
      Root: {
        allOf: [{ $ref: "#/$defs/A" }, object({ b: { type: "string" } })],
      },
    });
    expect(flags.get("a")?.kind).toBe("string");
    expect(flags.get("b")?.kind).toBe("string");
    expect(flags.get("c")?.kind).toBe("json");
  });

  test("a property whose folded name equals a reserved flag is reported, not resolved", () => {
    const result = run({
      Root: object({
        active: { type: "boolean" },
        body: { type: "string" },
        force: { type: "boolean" },
      }),
    });
    expect(result.reserved.map(({ flag, pointer }) => [flag, pointer])).toEqual([
      ["body", "/body"],
      ["force", "/force"],
      ["no-force", "/force"],
    ]);
    expect(result.flags.map(({ name }) => name)).toContain("body");
  });

  test("names fold per segment and the output is sorted; an empty fold is skipped and reported", () => {
    const result = run({
      Root: object({
        "": { type: "string" },
        FirstName: { type: "string" },
        address: object({ "Zip Code": { type: "string" } }),
      }),
    });
    expect(result.flags.map(({ name }) => name)).toEqual([
      "address.zip-code",
      "body",
      "body-file",
      "first-name",
    ]);
    expect(result.skipped).toEqual([{ pointer: "/", reason: "EmptyFold" }]);
  });

  test("an unresolved reference is a typed failure", () => {
    const result = flattenBody(
      { Root: object({ x: { $ref: "#/$defs/Nope" } }) },
      alternative("json", "Root"),
    );
    expect(Result.isFailure(result) && result.failure._tag).toBe("UnresolvedBodyRef");
  });

  test("binary bodies accept only --body-file; text bodies get both and no field flags", () => {
    expect(
      run({ Root: object({ a: { type: "string" } }) }, "binary").flags.map(({ name }) => name),
    ).toEqual(["body-file"]);
    expect(
      run({ Root: object({ a: { type: "string" } }) }, "text").flags.map(({ name }) => name),
    ).toEqual(["body", "body-file"]);
  });

  test("a body with no schema offers only the whole-body flags; a non-object root has no field flags", () => {
    expect(run({}, "json", null).flags.map(({ name }) => name)).toEqual(["body", "body-file"]);
    expect(
      run({ Root: { items: { type: "string" }, type: "array" } }).flags.map(({ name }) => name),
    ).toEqual(["body", "body-file"]);
  });

  test("a self-referencing property is json at its depth, not an infinite walk", () => {
    const flags = byName({
      Node: object({ next: { $ref: "#/$defs/Node" } }),
      Root: { $ref: "#/$defs/Node" },
    });
    expect(flags.get("next.next")?.kind).toBe("json");
  });

  test("__proto__ is an ordinary property name; a pure reference cycle is a typed failure", () => {
    const hostile = {
      Root: Schema.decodeSync(Schema.fromJsonString(Schema.Json))(
        '{"properties":{"__proto__":{"type":"string"}}}',
      ),
    } satisfies Defs;
    expect(byName(hostile).get("proto")).toEqual({
      kind: "string",
      pointer: "/__proto__",
      repeated: false,
    });
    expect(Object.prototype).not.toHaveProperty("proto");

    const cycle = flattenBody(
      { A: { $ref: "#/$defs/A" }, Root: object({ x: { $ref: "#/$defs/A" } }) },
      alternative("json", "Root"),
    );
    expect(Result.isFailure(cycle) && cycle.failure._tag).toBe("UnresolvedBodyRef");
  });
});
