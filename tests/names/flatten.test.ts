import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { flattenBody } from "../../src/names/flatten.ts";
import { EncodingRule } from "../../src/model/entities.ts";
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

const next = (level: number): Schema.Json => ({ $ref: `#/$defs/D${level}` });

const fanOut = (depth: number) => {
  const levels = Array.from({ length: depth }, (_, level): [string, Schema.Json] => [
    `D${level}`,
    { allOf: [next(level + 1), next(level + 1)] },
  ]);

  return {
    ...Object.fromEntries(levels),
    [`D${depth}`]: object({ leaf: { type: "string" } }),
    Root: next(0),
  } satisfies Defs;
};

// A string schema with a 5000-member enum: about 5000 nodes to compare.
const bigEnum = (): Schema.Json => ({
  enum: Array.from({ length: 5000 }, (_, index) => `v${index}`),
  type: "string",
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

  test("a diamond fan-out of shared defs resolves each def once (depth 20)", () => {
    expect(run(fanOut(20)).flags.map(({ name }) => name)).toEqual(["body", "body-file", "leaf"]);
  }, 5000);

  test("a diamond fan-out resolves at depth 30 and is a cheap typed failure past the 64-hop cap", () => {
    expect(Result.isSuccess(flattenBody(fanOut(30), alternative("json", "Root")))).toBe(true);

    const deep = flattenBody(fanOut(64), alternative("json", "Root"));
    expect(Result.isFailure(deep) && deep.failure._tag).toBe("UnresolvedBodyRef");
  }, 5000);

  test("each field flag names the source pointer of the property that declares it", () => {
    const inline = "/paths/~1x/post/requestBody/content/application~1json/schema";
    const other = "file:///spec/other.json#/defs/Remote";
    const defs = {
      Base: object({ address: object({ city: { type: "string" } }) }),
      Root: {
        allOf: [
          { $ref: "#/$defs/Base" },
          object({
            remote: { $ref: `#/$defs/${other.replaceAll("~", "~0").replaceAll("/", "~1")}` },
          }),
        ],
        properties: { own: { type: "string" } },
      },
      [inline]: object({ tags: { items: { type: "string" }, type: "array" } }),
      [other]: object({ id: { type: "integer" } }),
    } satisfies Defs;
    const pointers = (key: string) =>
      Object.fromEntries(
        run(defs, "json", key).flags.map(({ name, schemaPointer }) => [name, schemaPointer]),
      );

    expect(pointers("Root")).toEqual({
      "address.city": "/components/schemas/Base/properties/address/properties/city",
      body: "",
      "body-file": "",
      own: "/components/schemas/Root/properties/own",
      "remote.id": "/defs/Remote/properties/id",
    });
    expect(pointers(inline)).toEqual({
      body: "",
      "body-file": "",
      tags: `${inline}/properties/tags`,
    });
  });

  test("a property declared equal in two allOf members keeps the first declaration", () => {
    const { flags } = run({
      A: object({ x: { type: "string" } }),
      B: object({ x: { type: "string" } }),
      Root: { allOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }] },
    });

    expect(flags.find(({ name }) => name === "x")?.schemaPointer).toBe(
      "/components/schemas/A/properties/x",
    );
  });

  test("duplicate allOf keys over large equal subtrees charge their equality to the budget", () => {
    const members = Array.from({ length: 4 }, (_, index): [string, Schema.Json] => [
      `M${index}`,
      object({ big: bigEnum() }),
    ]);
    const result = flattenBody(
      {
        ...Object.fromEntries(members),
        Root: { allOf: members.map(([key]) => ({ $ref: `#/$defs/${key}` })) },
      },
      alternative("json", "Root"),
    );
    expect(Result.isFailure(result) && result.failure._tag).toBe("BodyBudgetExceeded");

    const small = flattenBody(
      {
        M0: object({ big: bigEnum() }),
        M1: object({ big: bigEnum() }),
        Root: { allOf: [{ $ref: "#/$defs/M0" }, { $ref: "#/$defs/M1" }] },
      },
      alternative("json", "Root"),
    );
    expect(Result.isSuccess(small)).toBe(true);
  }, 5000);

  test("a body that exceeds the shared visit budget is a typed BodyBudgetExceeded", () => {
    const members = Array.from({ length: 20_000 }, () => ({ type: "string" }));
    const result = flattenBody({ Root: { allOf: members } }, alternative("json", "Root"));
    expect(Result.isFailure(result) && result.failure._tag).toBe("BodyBudgetExceeded");
  }, 5000);

  test("many empty-folding keys under a shared def hit the budget instead of growing memory", () => {
    const empties = Object.fromEntries(
      Array.from({ length: 300 }, (_, index): [string, Schema.Json] => [
        `\u4E00${String.fromCodePoint(20_000 + index)}`,
        { type: "string" },
      ]),
    );
    const uses = Object.fromEntries(
      Array.from({ length: 300 }, (_, index): [string, Schema.Json] => [
        `use${index}`,
        { $ref: "#/$defs/Shared" },
      ]),
    );
    const result = flattenBody(
      { Root: object(uses), Shared: object(empties) },
      alternative("json", "Root"),
    );
    expect(Result.isFailure(result) && result.failure._tag).toBe("BodyBudgetExceeded");
  }, 5000);
});

// A part's Encoding rule as normalize builds it, with a base64 transfer encoding.
const base64Rule = (name: string) =>
  Schema.decodeUnknownSync(EncodingRule)({
    contentEncoding: "base64",
    contentType: ["application/octet-stream"],
    headers: [],
    origin: { document: "file:///spec.json", pointer: `/properties/${name}` },
    rows: [],
    target: { kind: "property", name },
  });

describe("flattenBody: multipart and xml", () => {
  const parts = {
    Root: object({
      avatar: { format: "binary", type: "string" },
      count: { type: "integer" },
      meta: object({ a: { type: "string" } }),
      name: { type: "string" },
      photos: { items: { format: "binary", type: "string" }, type: "array" },
      tags: { items: { type: "string" }, type: "array" },
    }),
  } satisfies Defs;

  test("a multipart body gets one flag per part and no whole-body flag", () => {
    const flattened = run(parts, "multipart");
    expect(
      flattened.flags.map(({ kind, name, pointer, repeated }) => [name, kind, pointer, repeated]),
    ).toEqual([
      ["avatar", "file", "/avatar", false],
      ["count", "integer", "/count", false],
      ["name", "string", "/name", false],
      ["photos", "file", "/photos", true],
      ["tags", "string", "/tags", true],
    ]);
    expect(flattened.skipped).toEqual([{ pointer: "/meta", reason: "UnsupportedPart" }]);
  });

  test("3.1 binary: contentMediaType and a schemaless part are files", () => {
    const flattened = run(
      {
        Root: object({
          any: {},
          png: { contentMediaType: "image/png", type: "string" },
        }),
      },
      "multipart",
    );
    expect(flattened.flags.map(({ kind, name }) => [name, kind])).toEqual([
      ["any", "file"],
      ["png", "file"],
    ]);
  });

  test("a part whose Encoding rule is base64 is a file part; the rule decides, not the schema", () => {
    const defs = {
      Root: object({
        b64: { contentEncoding: "base64", type: "string" },
        bytes: { format: "byte", type: "string" },
        many: { items: { format: "byte", type: "string" }, type: "array" },
        text: { contentEncoding: "base64", type: "string" },
      }),
    } satisfies Defs;
    const result = flattenBody(defs, {
      codec: "multipart",
      encoding: ["b64", "bytes", "many"].map(base64Rule),
      schema: { key: "Root" },
    });
    if (Result.isFailure(result)) {
      throw new Error(`flattenBody failed with ${result.failure._tag}`);
    }

    expect(result.success.flags.map(({ kind, name, repeated }) => [name, kind, repeated])).toEqual([
      ["b64", "file", false],
      ["bytes", "file", false],
      ["many", "file", true],
      ["text", "string", false],
    ]);
  });

  test("oneOf, array-of-object and map parts are skipped with a reason", () => {
    const flattened = run(
      {
        Root: object({
          choice: { oneOf: [{ type: "string" }, { type: "integer" }] },
          list: { items: object({ a: { type: "string" } }), type: "array" },
          map: { additionalProperties: { type: "string" }, type: "object" },
        }),
      },
      "multipart",
    );
    expect(flattened.flags).toEqual([]);
    expect(flattened.skipped.map(({ pointer }) => pointer)).toEqual(["/choice", "/list", "/map"]);
  });

  test("a binary property stays a string flag in json and form bodies", () => {
    expect(run(parts, "json").flags.find(({ name }) => name === "avatar")?.kind).toBe("string");
    expect(run(parts, "form").flags.find(({ name }) => name === "avatar")?.kind).toBe("string");
  });

  test("a multipart part named like a reserved flag is reported as a clash", () => {
    const flattened = run({ Root: object({ output: { type: "string" } }) }, "multipart");
    expect(flattened.reserved.map(({ flag }) => flag)).toEqual(["output"]);
  });

  test("an xml body is offered --body-file only", () => {
    expect(run({ Root: object({ a: { type: "string" } }) }, "xml").flags).toEqual([
      expect.objectContaining({ kind: "body-file", name: "body-file" }),
    ]);
  });
});
