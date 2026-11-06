import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import path from "node:path";
import { DocumentUri } from "../../src/model/brands.ts";
import { makeDocumentSet, maxDocuments } from "../../src/load/document-set.ts";
import type { DocumentPair } from "../../src/load/document-set.ts";

const fixture = (name: string) =>
  path.join(import.meta.dir, "..", "fixtures", "document-set", "pairs", name);

const uri = Schema.decodeUnknownSync(DocumentUri);

const pet = fixture("pet.json");

const owner = fixture("owner.yaml");

const run = (pairs: readonly DocumentPair[]) =>
  makeDocumentSet(pairs).pipe(Effect.provide(BunFileSystem.layer));

const refusal = (pairs: readonly DocumentPair[]) => Effect.runPromise(Effect.flip(run(pairs)));

describe("document set: --document pairs", () => {
  test("two valid pairs load keyed by their retrieval URIs", async () => {
    const set = await Effect.runPromise(
      run([
        { path: pet, uri: "https://example.com/pet.json" },
        { path: owner, uri: "https://example.com/owner.yaml" },
      ]),
    );

    expect([...set.documents.keys()].map(String)).toEqual([
      "https://example.com/pet.json",
      "https://example.com/owner.yaml",
    ]);
    expect(set.documents.get(uri("https://example.com/pet.json"))?.path).toBe(pet);
  });

  test("a JSON member and a YAML member both load", async () => {
    const set = await Effect.runPromise(
      run([
        { path: pet, uri: "https://example.com/pet.json" },
        { path: owner, uri: "https://example.com/owner.yaml" },
      ]),
    );
    const formats = [...set.documents.values()].map((member) => member.format);

    expect(formats).toEqual(["json", "yaml"]);
    expect(set.documents.get(uri("https://example.com/owner.yaml"))?.value).toEqual({
      Owner: { type: "object" },
    });
  });

  test("a relative URI is refused with the pair's path", async () => {
    const error = await refusal([{ path: pet, uri: "schemas/pet.json" }]);

    expect(error.diagnostic.code).toBe("REF-16/relative-uri");
    expect(error.diagnostic.scope).toBe("document");
    expect(error.diagnostic.hint).toBe(pet);
  });

  test("an unreadable path is refused with the pair's path", async () => {
    const missing = fixture("missing.json");
    const error = await refusal([{ path: missing, uri: "https://example.com/missing.json" }]);

    expect(error.diagnostic.code).toBe("DOC-14/unreadable");
    expect(error.diagnostic.scope).toBe("document");
    expect(error.diagnostic.hint).toBe(missing);
  });

  test("a duplicate retrieval URI is refused naming the second path", async () => {
    const error = await refusal([
      { path: pet, uri: "https://example.com/doc" },
      { path: owner, uri: "https://example.com/doc" },
    ]);

    expect(error.diagnostic.code).toBe("REF-16/duplicate-uri");
    expect(error.diagnostic.scope).toBe("document");
    expect(error.diagnostic.hint).toBe(owner);
  });

  test("the 33rd document is refused and exactly 32 load", async () => {
    const pairs = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        path: pet,
        uri: `https://example.com/doc-${index}.json`,
      }));
    const set = await Effect.runPromise(run(pairs(maxDocuments)));
    const error = await refusal(pairs(maxDocuments + 1));

    expect(set.documents.size).toBe(32);
    expect(error.diagnostic.code).toBe("REF-16/document-limit");
    expect(error.diagnostic.scope).toBe("document");
    expect(error.diagnostic.hint).toBe(pet);
  });
});
