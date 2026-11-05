import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DocumentUri } from "../../src/model/brands.ts";
import { loadBytes, loadFile } from "../../src/load/index.ts";
import type { LoadOptions, LoadRefusal } from "../../src/load/index.ts";

const fixture = (name: string) => path.join(import.meta.dir, "..", "fixtures", "yaml", name);

const document = Schema.decodeUnknownSync(DocumentUri)("file:///spec.yaml");

const options = (limits?: LoadOptions["limits"]): LoadOptions =>
  limits === undefined ? { document } : { document, limits };

const encode = (text: string) => new TextEncoder().encode(text);

const file = (name: string, limits?: LoadOptions["limits"]) =>
  loadFile(fixture(name), options(limits)).pipe(Effect.provide(BunFileSystem.layer));

const text = (source: string, limits?: LoadOptions["limits"]) =>
  loadBytes(encode(source), options(limits));

const refusal = <A>(effect: Effect.Effect<A, LoadRefusal>) =>
  Effect.runPromise(Effect.flip(effect));

const pointerOf = (error: LoadRefusal): string => error.diagnostic.pointer;

const value = async (name: string) => {
  const loaded = await Effect.runPromise(file(name));

  return loaded.value;
};

describe("load: strict YAML hazards", () => {
  const hazards = [
    ["duplicate-key.yaml", "DOC-14/duplicate-key"],
    ["multi-document.yaml", "DOC-14/yaml-multi-document"],
    ["alias-bomb.yaml", "DOC-14/node-budget"],
    ["cyclic-anchor.yaml", "DOC-14/yaml-alias-cycle"],
    ["non-scalar-key-seq.yaml", "DOC-14/yaml-non-string-key"],
    ["non-scalar-key-map.yaml", "DOC-14/yaml-non-string-key"],
    ["timestamp-tag.yaml", "DOC-14/yaml-non-json-tag"],
    ["binary-tag.yaml", "DOC-14/yaml-non-json-tag"],
    ["custom-tag.yaml", "DOC-14/yaml-non-json-tag"],
    ["inf.yaml", "DOC-14/yaml-non-finite"],
    ["nan.yaml", "DOC-14/yaml-non-finite"],
  ] as const;

  test.each(hazards)("%s is refused as %s", async (name, code) => {
    const error = await refusal(file(name));
    expect(error._tag).toBe("LoadRefusal");
    expect(error.diagnostic.code).toBe(code);
    expect(error.diagnostic.row).toBe("DOC-14");
  });

  test("the merge key stays an ordinary key", async () => {
    expect(await value("merge-key.yaml")).toEqual({
      base: { x: 1 },
      m: { "<<": { x: 1 }, y: 2 },
    });
  });

  test("yes, = and an integer key stay strings", async () => {
    expect(await value("yes.yaml")).toEqual({ v: "yes" });
    expect(await value("equals.yaml")).toEqual({ v: "=" });
    expect(await value("integer-key.yaml")).toEqual({ "200": "ok" });
  });

  test("Failsafe key text and plain dates are kept as written", async () => {
    const loaded = await Effect.runPromise(text("0x1F: a\nnull: b\ntrue: c\nd: 2001-12-14\n"));
    expect(loaded.format).toBe("yaml");
    expect(loaded.value).toEqual({ "0x1F": "a", d: "2001-12-14", null: "b", true: "c" });
  });
});

describe("load: strict YAML positions", () => {
  test("a duplicate key reports its line, column and byte offset", async () => {
    const error = await refusal(file("duplicate-key.yaml"));
    expect(error.diagnostic.line).toBe(2);
    expect(error.diagnostic.column).toBe(1);
    expect(error.offset).toBe(5);
  });

  test("a non-finite number reports its pointer and position", async () => {
    const error = await refusal(file("inf.yaml"));
    expect(pointerOf(error)).toBe("/n");
    expect(error.diagnostic.line).toBe(1);
    expect(error.diagnostic.column).toBe(4);
    expect(error.offset).toBe(3);
  });

  test("a tag refusal points at the tagged value", async () => {
    const error = await refusal(file("timestamp-tag.yaml"));
    expect(pointerOf(error)).toBe("/t");
    expect(error.diagnostic.line).toBe(1);
  });

  test("offsets count bytes and include a byte order mark", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode("é: 1\né: 2\n")]);
    const error = await refusal(loadBytes(bytes, options()));
    expect(error.diagnostic.code).toBe("DOC-14/duplicate-key");
    expect(error.diagnostic.line).toBe(2);
    expect(error.offset).toBe(3 + 6);
  });
});

describe("load: strict YAML values", () => {
  test("a YAML file equals its JSON twin", async () => {
    const twin = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
      readFileSync(fixture("twin.json"), "utf-8"),
    );
    const loaded = await value("twin.yaml");
    expect(loaded).toEqual(twin);
  });

  test("__proto__ is an own key and changes no prototype", async () => {
    const loaded = await Effect.runPromise(text("a:\n  __proto__:\n    polluted: 1\n"));
    expect(JSON.stringify(loaded.value)).toBe('{"a":{"__proto__":{"polluted":1}}}');
    expect(Reflect.has({}, "polluted")).toBe(false);
  });

  test("an alias inside the node budget loads as the anchored value", async () => {
    const loaded = await Effect.runPromise(text("a: &a [1, 2]\nb: *a\nc: *a\n"));
    expect(loaded.value).toEqual({ a: [1, 2], b: [1, 2], c: [1, 2] });
  });

  test("a document past the node budget is refused", async () => {
    const error = await refusal(text("a: [1, 2, 3, 4]\n", { maxNodes: 4 }));
    expect(error.diagnostic.code).toBe("DOC-14/node-budget");
  });

  test("alias expansion counts against the node budget", async () => {
    const error = await refusal(text("a: &a [1, 2, 3]\nb: *a\nc: *a\n", { maxNodes: 10 }));
    expect(error.diagnostic.code).toBe("DOC-14/node-budget");
  });

  test("nesting past the depth limit is refused", async () => {
    const error = await refusal(text(`a: ${"[".repeat(300)}${"]".repeat(300)}\n`));
    expect(error.diagnostic.code).toBe("DOC-14/depth-limit");
  });

  test("very deep nesting is refused, not crashed", async () => {
    const error = await refusal(text(`a: ${"[".repeat(20_000)}`));
    expect(error._tag).toBe("LoadRefusal");
  });

  test("malformed YAML is refused as invalid", async () => {
    const error = await refusal(text("a: [1, 2\nb: {\n"));
    expect(error.diagnostic.code).toBe("DOC-14/invalid-yaml");
  });

  test("an empty stream is refused as invalid", async () => {
    const error = await refusal(text(""));
    expect(error.diagnostic.code).toBe("DOC-14/invalid-yaml");
  });
});
