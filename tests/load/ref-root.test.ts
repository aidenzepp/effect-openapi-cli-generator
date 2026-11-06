import { BunFileSystem } from "@effect/platform-bun";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeDocumentSet, maxDocuments, resolveUnderRoot } from "../../src/load/document-set.ts";
import type { DocumentPair } from "../../src/load/document-set.ts";

const fixtures = path.join(import.meta.dir, "..", "fixtures", "document-set", "ref-root");

const scratch = path.join(import.meta.dir, "..", "..", "work");

const made: string[] = [];

/**
 * A fresh copy of the fixture tree, plus a sibling directory outside it, under `work/`.
 */
const workspace = () => {
  mkdirSync(scratch, { recursive: true });

  const base = realpathSync(mkdtempSync(path.join(scratch, "ref-root-")));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");

  made.push(base);
  cpSync(path.join(fixtures, "tree"), root, { recursive: true });
  mkdirSync(outside);
  cpSync(path.join(fixtures, "outside.json"), path.join(outside, "secret.json"));

  return { base, outside, root };
};

afterEach(() => {
  for (const base of made.splice(0)) {
    rmSync(base, { force: true, recursive: true });
  }
});

const run = (pairs: readonly DocumentPair[], refRoot: string) =>
  makeDocumentSet(pairs, { refRoot }).pipe(Effect.provide(BunFileSystem.layer));

const refusal = (pairs: readonly DocumentPair[], refRoot: string) =>
  Effect.runPromise(Effect.flip(run(pairs, refRoot)));

const uris = (set: { readonly documents: ReadonlyMap<string, unknown> }) =>
  [...set.documents.keys()].map(String);

describe("document set: --ref-root", () => {
  test("JSON and YAML files under the root load with file: URIs", async () => {
    const { root } = workspace();
    const set = await Effect.runPromise(run([], root));

    expect(uris(set)).toEqual([
      pathToFileURL(path.join(root, "a.json")).href,
      pathToFileURL(path.join(root, "sub", "b.yaml")).href,
    ]);
  });

  test("a symlink to a file outside the root is refused at document scope", async () => {
    const { outside, root } = workspace();

    symlinkSync(path.join(outside, "secret.json"), path.join(root, "escape.json"));

    const error = await refusal([], root);

    expect(error.diagnostic.code).toBe("REF-16/outside-root");
    expect(error.diagnostic.scope).toBe("document");
    expect(error.diagnostic.hint).toBe(path.join(root, "escape.json"));
  });

  test("a symlink to a directory outside the root is refused", async () => {
    const { outside, root } = workspace();

    symlinkSync(outside, path.join(root, "linked"));

    const error = await refusal([], root);

    expect(error.diagnostic.code).toBe("REF-16/outside-root");
    expect(error.diagnostic.scope).toBe("document");
  });

  test("a ../ path is refused at document scope", async () => {
    const { root } = workspace();
    const error = await Effect.runPromise(
      Effect.flip(resolveUnderRoot(root, "../outside.json")).pipe(
        Effect.provide(BunFileSystem.layer),
      ),
    );

    expect(error.diagnostic.code).toBe("REF-16/outside-root");
    expect(error.diagnostic.scope).toBe("document");
  });

  test("a symlink inside the root resolves to one URI however it is reached", async () => {
    const { root } = workspace();

    symlinkSync(path.join(root, "a.json"), path.join(root, "alias.json"));
    symlinkSync(path.join(root, "sub"), path.join(root, "subs"));

    const set = await Effect.runPromise(run([], root));

    expect(uris(set)).toEqual([
      pathToFileURL(path.join(root, "a.json")).href,
      pathToFileURL(path.join(root, "sub", "b.yaml")).href,
    ]);
  });

  test("the budget counts both sources", async () => {
    const { root } = workspace();
    const pet = path.join(fixtures, "outside.json");
    const pairs = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        path: pet,
        uri: `https://example.com/doc-${index}.json`,
      }));
    const fits = await Effect.runPromise(run(pairs(maxDocuments - 2), root));
    const error = await refusal(pairs(maxDocuments - 1), root);

    expect(fits.documents.size).toBe(maxDocuments);
    expect(error.diagnostic.code).toBe("REF-16/document-limit");
    expect(error.diagnostic.scope).toBe("document");
  });

  test("a --document URI equal to a preloaded file's URI is refused", async () => {
    const { root } = workspace();
    const uri = pathToFileURL(path.join(root, "a.json")).href;
    const error = await refusal([{ path: path.join(fixtures, "outside.json"), uri }], root);

    expect(error.diagnostic.code).toBe("REF-16/duplicate-uri");
    expect(error.diagnostic.scope).toBe("document");
  });
});
