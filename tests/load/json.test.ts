import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, Schema, Stream } from "effect";
import path from "node:path";
import { DocumentUri } from "../../src/model/brands.ts";
import { loadBytes, loadFile, loadStream } from "../../src/load/index.ts";
import type { LoadOptions, LoadRefusal } from "../../src/load/index.ts";

const fixture = (name: string) => path.join(import.meta.dir, "..", "fixtures", "load", name);

const document = Schema.decodeUnknownSync(DocumentUri)("file:///spec.json");

const options = (limits?: LoadOptions["limits"]): LoadOptions =>
  limits === undefined ? { document } : { document, limits };

const encode = (text: string) => new TextEncoder().encode(text);

const file = (name: string, limits?: LoadOptions["limits"]) =>
  loadFile(fixture(name), options(limits)).pipe(Effect.provide(BunFileSystem.layer));

const refusal = <A>(effect: Effect.Effect<A, LoadRefusal>) =>
  Effect.runPromise(Effect.flip(effect));

const pointerOf = (error: LoadRefusal): string => error.diagnostic.pointer;

const nested = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;

describe("load: strict JSON", () => {
  test("plain JSON loads as json", async () => {
    const loaded = await Effect.runPromise(loadBytes(encode('{"a":[1,"x",null]}'), options()));
    expect(loaded.format).toBe("json");
    expect(loaded.value).toEqual({ a: [1, "x", null] });
  });

  test("a leading UTF-8 byte order mark is ignored", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('{"a":1}')]);
    const loaded = await Effect.runPromise(loadBytes(bytes, options()));
    expect(loaded.value).toEqual({ a: 1 });
  });

  test("a duplicate key is refused with its byte offset, line and column", async () => {
    const error = await refusal(file("duplicate-key.json"));
    expect(error._tag).toBe("LoadRefusal");
    expect(error.diagnostic.code).toBe("DOC-14/duplicate-key");
    expect(pointerOf(error)).toBe("/info/title");
    expect(error.offset).toBe(50);
    expect(error.diagnostic.line).toBe(3);
    expect(error.diagnostic.column).toBe(27);
  });

  test("duplicate keys compare after unescaping", async () => {
    const error = await refusal(loadBytes(encode('{"a":1,"\\u0061":2}'), options()));
    expect(error.diagnostic.code).toBe("DOC-14/duplicate-key");
    expect(pointerOf(error)).toBe("/a");
  });

  test("the same key in different objects is not a duplicate", async () => {
    const loaded = await Effect.runPromise(
      loadBytes(encode('{"a":{"x":1},"b":{"x":2}}'), options()),
    );
    expect(loaded.value).toEqual({ a: { x: 1 }, b: { x: 2 } });
  });

  test("depth 256 loads and depth 257 is refused", async () => {
    const ok = await Effect.runPromise(loadBytes(encode(`{"a":${nested(255)}}`), options()));
    expect(ok.format).toBe("json");

    const error = await refusal(loadBytes(encode(`{"a":${nested(256)}}`), options()));
    expect(error.diagnostic.code).toBe("DOC-14/depth-limit");

    const deep = await refusal(loadBytes(encode(`{${'"a":{'.repeat(20_000)}`), options()));
    expect(deep.diagnostic.code).toBe("DOC-14/depth-limit");
  });

  test("a document past the node budget is refused", async () => {
    const error = await refusal(loadBytes(encode('{"a":[1,2,3,4]}'), options({ maxNodes: 5 })));
    expect(error.diagnostic.code).toBe("DOC-14/node-budget");
  });

  test("a file over the limit is refused from its size before it is read", async () => {
    const error = await refusal(file("duplicate-key.json", { maxBytes: 16 }));
    expect(error.diagnostic.code).toBe("DOC-14/too-large");
  });

  test("a stream over the limit is refused", async () => {
    const chunks = Stream.make(encode('{"a":"'), encode("x".repeat(64)), encode('"}'));
    const error = await refusal(loadStream(chunks, options({ maxBytes: 32 })));
    expect(error.diagnostic.code).toBe("DOC-14/too-large");

    const within = await Effect.runPromise(loadStream(chunks, options()));
    expect(within.format).toBe("json");
  });

  test("an integer beyond 2^53 in a default is refused at the literal", async () => {
    const error = await refusal(file("unsafe-integer-default.json"));
    expect(error.diagnostic.code).toBe("DOC-14/unsafe-integer");
    expect(pointerOf(error)).toBe("/components/schemas/Id/default");
  });

  test("2^53 itself and integers outside default, enum and const load", async () => {
    const loaded = await Effect.runPromise(file("safe-integers.json"));
    expect(loaded.format).toBe("json");
  });

  test("unsafe integers are refused inside enum and const too", async () => {
    const inEnum = await refusal(loadBytes(encode('{"enum":[1,9007199254740993]}'), options()));
    expect(pointerOf(inEnum)).toBe("/enum/1");

    const inConst = await refusal(loadBytes(encode('{"const":-9007199254740993}'), options()));
    expect(inConst.diagnostic.code).toBe("DOC-14/unsafe-integer");
  });

  test("malformed JSON is refused", async () => {
    const error = await refusal(loadBytes(encode('{"a":'), options()));
    expect(error.diagnostic.code).toBe("DOC-14/invalid-json");
  });

  test("invalid UTF-8 is refused", async () => {
    const error = await refusal(loadBytes(new Uint8Array([0x7b, 0xff, 0x7d]), options()));
    expect(error.diagnostic.code).toBe("DOC-14/invalid-encoding");
  });

  test("anything not starting with a brace is routed to YAML, which is not yet supported", async () => {
    const error = await refusal(file("spec.yaml"));
    expect(error.diagnostic.code).toBe("DOC-14/yaml-unsupported");
  });

  test("a missing file is refused as unreadable", async () => {
    const error = await refusal(file("missing.json"));
    expect(error.diagnostic.code).toBe("DOC-14/unreadable");
  });
});
