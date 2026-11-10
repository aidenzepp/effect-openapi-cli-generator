import { BunCrypto, BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DocumentUri } from "../../src/model/brands.ts";
import { makeDocumentSet, maxDocuments } from "../../src/load/document-set.ts";
import type { DocumentPair, DocumentSetOptions } from "../../src/load/document-set.ts";

const fixture = (name: string) =>
  path.join(import.meta.dir, "..", "fixtures", "document-set", "pairs", name);

const uri = Schema.decodeUnknownSync(DocumentUri);

const pet = fixture("pet.json");

const owner = fixture("owner.yaml");

const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layerDigest);

const run = (pairs: readonly DocumentPair[], options: DocumentSetOptions = {}) =>
  makeDocumentSet(pairs, options).pipe(Effect.provide(layer));

const refusal = (pairs: readonly DocumentPair[], options: DocumentSetOptions = {}) =>
  Effect.runPromise(Effect.flip(run(pairs, options)));

/**
 * `count` pairs over one file, each under its own retrieval URI.
 */
const numbered = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: pet,
    uri: `https://example.com/doc-${index}.json`,
  }));

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

  test("each member records the sha256 of the exact bytes it parsed", async () => {
    const set = await Effect.runPromise(
      run([
        { path: pet, uri: "https://example.com/pet.json" },
        { path: owner, uri: "https://example.com/owner.yaml" },
      ]),
    );
    expect(set.documents.get(uri("https://example.com/pet.json"))?.sha256).toBe(hash(pet));
    expect(set.documents.get(uri("https://example.com/owner.yaml"))?.sha256).toBe(hash(owner));
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

  test.each([
    ["https://example.com/doc.json", "HTTPS://Example.COM/doc.json"],
    ["https://example.com/a/doc.json", "https://example.com/a/./doc.json"],
    ["https://example.com/doc.json", "https://example.com/doc.json#part"],
  ])("%s then %s is refused as a duplicate naming the second path", async (first, second) => {
    const error = await refusal([
      { path: pet, uri: first },
      { path: owner, uri: second },
    ]);

    expect(error.diagnostic.code).toBe("REF-16/duplicate-uri");
    expect(error.diagnostic.scope).toBe("document");
    expect(error.diagnostic.hint).toBe(owner);
  });

  test("a pair spelling the entry's retrieval URI differently is refused naming its path", async () => {
    const error = await refusal([{ path: pet, uri: "HTTPS://Example.com/entry.json" }], {
      entry: uri("https://example.com/entry.json"),
    });

    expect(error.diagnostic.code).toBe("REF-16/duplicate-uri");
    expect(error.diagnostic.hint).toBe(pet);
  });

  test.each([
    ["no entry named", {}],
    ["an entry outside the pairs", { entry: uri("https://example.com/entry.json") }],
  ])("with %s, 31 pairs load and the 32nd is refused", async (_, options) => {
    const set = await Effect.runPromise(run(numbered(maxDocuments - 1), options));
    const error = await refusal(numbered(maxDocuments), options);

    expect(set.documents.size).toBe(31);
    expect(error.diagnostic.code).toBe("REF-16/document-limit");
    expect(error.diagnostic.scope).toBe("document");
    expect(error.diagnostic.hint).toBe(pet);
  });

  test("a pair under the entry's own retrieval URI spends no second slot", async () => {
    const entry = uri("https://example.com/doc-0.json");
    const set = await Effect.runPromise(run(numbered(maxDocuments), { entry }));
    const error = await refusal(numbered(maxDocuments + 1), { entry });

    expect(set.documents.size).toBe(32);
    expect(error.diagnostic.code).toBe("REF-16/document-limit");
  });

  test("a relative URI is refused under the file URL of a path with a space, % and #", async () => {
    const odd = path.join(import.meta.dir, "no such dir 100% #1 é", "pet.json");
    const error = await refusal([{ path: odd, uri: "schemas/pet.json" }]);

    expect(error.diagnostic.code).toBe("REF-16/relative-uri");
    expect(String(error.diagnostic.document)).toBe(pathToFileURL(odd).href);
    expect(error.diagnostic.hint).toBe(odd);
  });

  test("the first refusal follows pair order, before the reference root", async () => {
    const scratch = path.join(import.meta.dir, "..", "..", "work");

    mkdirSync(scratch, { recursive: true });

    const base = mkdtempSync(path.join(scratch, "document-set-"));
    const refRoot = path.join(base, "root");

    mkdirSync(refRoot);
    symlinkSync(pet, path.join(refRoot, "escape.json"));

    const error = await refusal(
      [
        { path: owner, uri: "schemas/owner.yaml" },
        { path: fixture("missing.json"), uri: "https://example.com/missing.json" },
      ],
      { refRoot },
    ).finally(() => {
      rmSync(base, { force: true, recursive: true });
    });

    expect(error.diagnostic.code).toBe("REF-16/relative-uri");
    expect(error.diagnostic.hint).toBe(owner);
  });

  test("a pair whose path is a symlink loads, keeping the pair's URI and path", async () => {
    const scratch = path.join(import.meta.dir, "..", "..", "work");

    mkdirSync(scratch, { recursive: true });

    const base = mkdtempSync(path.join(scratch, "document-set-"));
    const link = path.join(base, "pet.json");

    symlinkSync(pet, link);

    const set = await Effect.runPromise(
      run([{ path: link, uri: "https://example.com/pet.json" }]),
    ).finally(() => {
      rmSync(base, { force: true, recursive: true });
    });
    const member = set.documents.get(uri("https://example.com/pet.json"));

    expect(member?.path).toBe(link);
    expect(member?.document).toBe(uri("https://example.com/pet.json"));
    expect(member?.format).toBe("json");
  });
});
