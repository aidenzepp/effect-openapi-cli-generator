import { BunFileSystem } from "@effect/platform-bun";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  makeDocumentSet,
  maxDocuments,
  maxWalkDepth,
  maxWalkEntries,
  resolveUnderRoot,
} from "../../src/load/document-set.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { DocumentPair, DocumentSetOptions } from "../../src/load/document-set.ts";

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

const run = (
  pairs: readonly DocumentPair[],
  refRoot: string,
  options: Omit<DocumentSetOptions, "refRoot"> = {},
) => makeDocumentSet(pairs, { ...options, refRoot }).pipe(Effect.provide(BunFileSystem.layer));

const refusal = (
  pairs: readonly DocumentPair[],
  refRoot: string,
  options: Omit<DocumentSetOptions, "refRoot"> = {},
) => Effect.runPromise(Effect.flip(run(pairs, refRoot, options)));

/**
 * `count` pairs over one file outside the root, each under its own retrieval URI.
 */
const numbered = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: path.join(fixtures, "outside.json"),
    uri: `https://example.com/doc-${index}.json`,
  }));

/**
 * The FileSystem with a hook that fires once, synchronously, the first time `target` is opened or
 * streamed: the point between the walk's check and the read where a concurrent writer can swap
 * the path. `after` fires once the open itself has returned.
 */
const swapAtOpen = (target: string, before: () => void, after?: () => void) =>
  Effect.gen(function* hooked() {
    const fs = yield* FileSystem.FileSystem;
    let fired = false;
    const fire = (file: string) => {
      const hit = !fired && file === target;

      if (hit) {
        fired = true;
        before();
      }

      return hit;
    };
    const wrapped: FileSystem.FileSystem = {
      ...fs,
      open: (file, options) =>
        Effect.suspend(() =>
          fire(file)
            ? fs.open(file, options).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    after?.();
                  }),
                ),
              )
            : fs.open(file, options),
        ),
      stream: (file, options) => {
        fire(file);

        return fs.stream(file, options);
      },
    };

    return wrapped;
  });

const runSwapped = (
  refRoot: string,
  hook: Effect.Effect<FileSystem.FileSystem, never, FileSystem.FileSystem>,
) =>
  Effect.runPromise(
    Effect.flip(
      hook.pipe(
        Effect.flatMap((fs) =>
          makeDocumentSet([], { refRoot }).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
        ),
      ),
    ).pipe(Effect.provide(BunFileSystem.layer)),
  );

/**
 * A directory outside the root holding `sub/b.yaml` with a secret, for swapping in place of
 * `root/sub`.
 */
const evilSub = (base: string) => {
  const evil = path.join(base, "evil", "sub");

  mkdirSync(evil, { recursive: true });
  writeFileSync(path.join(evil, "b.yaml"), "Secret: TOPSECRET\n");

  return evil;
};

const mkfifo = (file: string) => execFileSync("mkfifo", [file]);

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

  test("a spec-named symlink to a directory outside the root is refused", async () => {
    const { outside, root } = workspace();

    symlinkSync(outside, path.join(root, "linked.json"));

    const error = await refusal([], root);

    expect(error.diagnostic.code).toBe("REF-16/outside-root");
    expect(error.diagnostic.scope).toBe("document");
  });

  test("a node_modules-style directory link to outside the root is skipped and the set loads", async () => {
    const { outside, root } = workspace();

    symlinkSync(outside, path.join(root, "node_modules"));

    const set = await Effect.runPromise(run([], root));

    expect(uris(set)).toEqual([
      pathToFileURL(path.join(root, "a.json")).href,
      pathToFileURL(path.join(root, "sub", "b.yaml")).href,
    ]);
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

  test("the budget counts both sources and the entry outside the root", async () => {
    const { root } = workspace();
    const fits = await Effect.runPromise(run(numbered(maxDocuments - 3), root));
    const error = await refusal(numbered(maxDocuments - 2), root);

    expect(fits.documents.size).toBe(maxDocuments - 1);
    expect(error.diagnostic.code).toBe("REF-16/document-limit");
    expect(error.diagnostic.scope).toBe("document");
  });

  test("an entry inside the root is one of the 32 documents, not a second slot", async () => {
    const { root } = workspace();
    const entry = Schema.decodeUnknownSync(DocumentUri)(
      pathToFileURL(path.join(root, "a.json")).href,
    );
    const fits = await Effect.runPromise(run(numbered(maxDocuments - 2), root, { entry }));
    const error = await refusal(numbered(maxDocuments - 1), root, { entry });

    expect(fits.documents.size).toBe(maxDocuments);
    expect(error.diagnostic.code).toBe("REF-16/document-limit");
  });

  test("a --document URI spelling a preloaded file's URI differently is refused", async () => {
    const { root } = workspace();
    const spelled = pathToFileURL(path.join(root, "a.json")).href.replace(/^file:/u, "FILE:");
    const error = await refusal(
      [{ path: path.join(fixtures, "outside.json"), uri: spelled }],
      root,
    );

    expect(error.diagnostic.code).toBe("REF-16/duplicate-uri");
    expect(error.diagnostic.hint).toBe(realpathSync(path.join(root, "a.json")));
  });

  test("a --document URI equal to a preloaded file's URI is refused", async () => {
    const { root } = workspace();
    const uri = pathToFileURL(path.join(root, "a.json")).href;
    const error = await refusal([{ path: path.join(fixtures, "outside.json"), uri }], root);

    expect(error.diagnostic.code).toBe("REF-16/duplicate-uri");
    expect(error.diagnostic.scope).toBe("document");
  });

  test("a file swapped for an outside symlink after the walk's check is refused unread", async () => {
    const { outside, root } = workspace();
    const target = path.join(root, "a.json");
    const error = await runSwapped(
      root,
      swapAtOpen(target, () => {
        unlinkSync(target);
        symlinkSync(path.join(outside, "secret.json"), target);
      }),
    );

    expect(error.diagnostic.code).toBe("DOC-14/unreadable");
    expect(error.diagnostic.scope).toBe("document");
  });

  test("a parent directory swapped for an outside symlink after the walk's check is refused", async () => {
    const { base, root } = workspace();
    const evil = evilSub(base);
    const error = await runSwapped(
      root,
      swapAtOpen(path.join(root, "sub", "b.yaml"), () => {
        renameSync(path.join(root, "sub"), path.join(base, "held"));
        symlinkSync(evil, path.join(root, "sub"));
      }),
    );

    expect(error.diagnostic.code).toBe("REF-16/outside-root");
    expect(error.diagnostic.scope).toBe("document");
  });

  test("an outside file opened and then swapped back is refused by the handle's identity", async () => {
    const { base, root } = workspace();
    const evil = evilSub(base);
    const sub = path.join(root, "sub");
    const held = path.join(base, "held");
    const error = await runSwapped(
      root,
      swapAtOpen(
        path.join(sub, "b.yaml"),
        () => {
          renameSync(sub, held);
          symlinkSync(evil, sub);
        },
        () => {
          unlinkSync(sub);
          renameSync(held, sub);
        },
      ),
    );

    expect(error.diagnostic.code).toBe("REF-16/outside-root");
    expect(error.diagnostic.scope).toBe("document");
  });

  test("a FIFO named like a spec file is refused before it is opened", async () => {
    const { root } = workspace();

    mkfifo(path.join(root, "pipe.json"));

    const error = await refusal([], root);

    expect(error.diagnostic.code).toBe("REF-16/unreadable-root");
    expect(error.diagnostic.scope).toBe("document");
    expect(error.diagnostic.hint).toBe(path.join(root, "pipe.json"));
  });

  test("entries not named like spec files are skipped: dangling, escaping and special", async () => {
    const { outside, root } = workspace();

    symlinkSync(path.join(root, "missing"), path.join(root, "dangling"));
    symlinkSync(path.join(outside, "secret.json"), path.join(root, "escape.txt"));
    mkfifo(path.join(root, "pipe"));

    const set = await Effect.runPromise(run([], root));

    expect(uris(set)).toEqual([
      pathToFileURL(path.join(root, "a.json")).href,
      pathToFileURL(path.join(root, "sub", "b.yaml")).href,
    ]);
  });

  test(`the walk enters ${maxWalkDepth} levels below the root and refuses one more`, async () => {
    const { root } = workspace();
    const levels = (count: number) =>
      path.join(root, ...Array.from({ length: count }, (_, index) => `d${index}`));

    mkdirSync(levels(maxWalkDepth), { recursive: true });
    writeFileSync(path.join(levels(maxWalkDepth), "deep.json"), "{}");

    const set = await Effect.runPromise(run([], root));

    expect(uris(set)).toContain(pathToFileURL(path.join(levels(maxWalkDepth), "deep.json")).href);

    mkdirSync(levels(maxWalkDepth + 1));

    const error = await refusal([], root);

    expect(error.diagnostic.code).toBe("REF-16/walk-limit");
    expect(error.diagnostic.scope).toBe("document");
    expect(error.diagnostic.hint).toBe(levels(maxWalkDepth + 1));
  });

  test(`the walk refuses past ${maxWalkEntries} entries`, async () => {
    const { root } = workspace();
    const many = path.join(root, "many");

    mkdirSync(many);

    for (let index = 0; index < maxWalkEntries; index += 1) {
      writeFileSync(path.join(many, `n${index}`), "");
    }

    const error = await refusal([], root);

    expect(error.diagnostic.code).toBe("REF-16/walk-limit");
    expect(error.diagnostic.scope).toBe("document");
    expect(error.diagnostic.hint).toBe(many);
  });
});
