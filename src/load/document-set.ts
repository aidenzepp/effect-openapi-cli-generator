import { Array as Arr, ByteSize, Effect, FileSystem, Option, Order, Path, Schema } from "effect";
import { pathToFileURL } from "node:url";
import { DocumentUri } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import { defaultLimits, LoadRefusal, readFileBounded } from "./budget.ts";
import type { VerifyOpened } from "./budget.ts";
import { loadBytes } from "./index.ts";
import type { Loaded } from "./index.ts";

type Document = typeof DocumentUri.Type;

/**
 * One `--document <uri>=<path>` pair: the retrieval URI the operator gives and the file that holds
 * the document.
 */
export interface DocumentPair {
  readonly path: string;
  readonly uri: string;
}

export interface SetMember extends Loaded {
  readonly path: string;
}

/**
 * The documents `$ref` may resolve over, keyed by retrieval URI (design 3.3).
 */
export interface DocumentSet {
  readonly documents: ReadonlyMap<Document, SetMember>;
}

/**
 * Most documents one set holds (design 3.3 budgets).
 */
export const maxDocuments = 32;

/**
 * Most directory entries one `--ref-root` walk visits, counting every name it reads.
 */
export const maxWalkEntries = 10_000;

/**
 * Deepest directory below the reference root that the walk enters; the root is depth 0.
 */
export const maxWalkDepth = 32;

const messages = {
  "REF-16/document-limit": "The document set holds more documents than the limit allows.",
  "REF-16/duplicate-uri": "Two documents in the set share a retrieval URI.",
  "REF-16/outside-root": "A reference-root entry resolves outside the reference root.",
  "REF-16/relative-uri": "A document's retrieval URI is not an absolute URI.",
  "REF-16/unreadable-root": "The reference root or one of its entries cannot be read.",
  "REF-16/walk-limit":
    "The reference root has more entries or deeper directories than the walk allows.",
} as const;

const decodeUri = Schema.decodeUnknownOption(DocumentUri);

/**
 * Splits `<uri>=<path>` at the first `=`. A value with no `=` yields a pair with an empty path,
 * which the loader then refuses as unreadable.
 */
export const parseDocumentPair = (value: string): DocumentPair => {
  const split = value.indexOf("=");

  return split === -1
    ? { path: "", uri: value }
    : { path: value.slice(split + 1), uri: value.slice(0, split) };
};

const refuse = (code: keyof typeof messages, pair: DocumentPair) =>
  Schema.decodeUnknownEffect(Diagnostic)({
    code,
    document: decodeUri(pair.uri)._tag === "Some" ? pair.uri : pathToFileURL(pair.path).href,
    element: "document",
    hint: pair.path,
    message: messages[code],
    openapi: "unknown",
    pointer: "",
    row: "REF-16",
    scope: "document",
    severity: "refusal",
    specSection: "https://spec.openapis.org/oas/v3.2.1.html#establishing-the-base-uri",
  }).pipe(
    Effect.orDie,
    Effect.flatMap((diagnostic) => Effect.fail(new LoadRefusal({ diagnostic }))),
  );

const withPath = (refusal: LoadRefusal, path: string): LoadRefusal => {
  const diagnostic = Schema.decodeUnknownSync(Diagnostic)({
    ...Schema.encodeSync(Diagnostic)(refusal.diagnostic),
    hint: path,
  });

  return new LoadRefusal(
    refusal.offset === undefined ? { diagnostic } : { diagnostic, offset: refusal.offset },
  );
};

const loadPair = (
  documents: ReadonlyMap<Document, SetMember>,
  pair: DocumentPair,
  verify?: VerifyOpened,
): Effect.Effect<readonly [Document, SetMember], LoadRefusal, FileSystem.FileSystem> => {
  const uri = decodeUri(pair.uri);

  if (uri._tag === "None") {
    return refuse("REF-16/relative-uri", pair);
  }

  if (documents.has(uri.value)) {
    return refuse("REF-16/duplicate-uri", pair);
  }

  return readFileBounded(pair.path, defaultLimits, uri.value, verify).pipe(
    Effect.flatMap((bytes) => loadBytes(bytes, { document: uri.value })),
    Effect.map((loaded): readonly [Document, SetMember] => [
      uri.value,
      { ...loaded, path: pair.path },
    ]),
    Effect.mapError((refusal) => withPath(refusal, pair.path)),
  );
};

export interface DocumentSetOptions {
  /**
   * A directory whose JSON and YAML files are preloaded (`--ref-root`, design 3.3, P10).
   */
  readonly refRoot?: string;
}

const refRootExtensions: ReadonlySet<string> = new Set([".json", ".yaml", ".yml"]);

const unreadable = (path: string) => refuse("REF-16/unreadable-root", { path, uri: "" });

const outsideRoot = (path: string) => refuse("REF-16/outside-root", { path, uri: "" });

const walkLimit = (path: string) => refuse("REF-16/walk-limit", { path, uri: "" });

/**
 * Resolves `relative` beneath `root` and returns the real path of the result. The lexical
 * `Path.resolveWithin` check refuses `..` escapes and absolute inputs; the `realPath` re-check
 * refuses a symlink whose target lies outside the real root.
 */
export const resolveUnderRoot = (
  root: string,
  relative: string,
): Effect.Effect<string, LoadRefusal, FileSystem.FileSystem> =>
  Effect.gen(function* resolve() {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const lexical = path.resolve(root, relative);
    const within = path.resolveWithin(root, relative);

    if (Option.isNone(within)) {
      return yield* outsideRoot(lexical);
    }

    const real = yield* fs.realPath(within.value).pipe(Effect.catch(() => unreadable(lexical)));
    const realRoot = yield* fs.realPath(root).pipe(Effect.catch(() => unreadable(root)));

    return Option.isSome(path.resolveWithin(realRoot, path.relative(realRoot, real)))
      ? real
      : yield* outsideRoot(lexical);
  }).pipe(Effect.provide(Path.layer));

/**
 * The opened handle must be the file at `real`, still inside the real root: the real path is
 * re-resolved and checked after the open, and its `(dev, ino)` must equal the handle's. Where the
 * platform reports no inode, `dev` and `size` stand in with the real-path check.
 */
const sameCheckedFile =
  (realRoot: string, real: string): VerifyOpened =>
  (opened) =>
    Effect.gen(function* verify() {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const checked = yield* resolveUnderRoot(realRoot, path.relative(realRoot, real));
      const info = yield* fs.stat(checked).pipe(Effect.catch(() => unreadable(real)));
      const sameInode =
        Option.isSome(opened.ino) && Option.isSome(info.ino)
          ? opened.ino.value === info.ino.value
          : ByteSize.toBigInt(opened.size) === ByteSize.toBigInt(info.size);
      const same = checked === real && info.type === "File" && info.dev === opened.dev && sameInode;

      return yield* same ? Effect.void : outsideRoot(real);
    }).pipe(Effect.provide(Path.layer));

const preloadFile = (documents: Map<Document, SetMember>, realRoot: string, real: string) => {
  const pair: DocumentPair = { path: real, uri: pathToFileURL(real).href };

  return documents.size >= maxDocuments
    ? refuse("REF-16/document-limit", pair)
    : loadPair(documents, pair, sameCheckedFile(realRoot, real)).pipe(
        Effect.flatMap(([uri, member]) =>
          Effect.sync(() => {
            documents.set(uri, member);
          }),
        ),
      );
};

const preloadRoot = (
  documents: Map<Document, SetMember>,
  root: string,
): Effect.Effect<void, LoadRefusal, FileSystem.FileSystem> =>
  Effect.gen(function* preload() {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const realRoot = yield* resolveUnderRoot(root, ".");
    const seenDirectories = new Set<string>([realRoot]);
    const seenFiles = new Set<string>();
    let visited = 0;

    const isSpecName = (name: string) => refRootExtensions.has(path.extname(name).toLowerCase());

    type Step = Effect.Effect<void, LoadRefusal, FileSystem.FileSystem>;

    const walk = (directory: string, depth: number): Step => {
      const enter = (real: string): Step => {
        if (seenDirectories.has(real)) {
          return Effect.void;
        }

        if (depth + 1 > maxWalkDepth) {
          return walkLimit(real);
        }

        seenDirectories.add(real);

        return walk(real, depth + 1);
      };

      const settle = (real: string, info: FileSystem.File.Info, specNamed: boolean): Step => {
        if (info.type === "Directory") {
          return enter(real);
        }

        if (!specNamed || !isSpecName(real) || seenFiles.has(real)) {
          return Effect.void;
        }

        if (info.type !== "File") {
          return unreadable(real);
        }

        seenFiles.add(real);

        return preloadFile(documents, realRoot, real);
      };

      /**
       * A name not like a spec file is considered only if it is a directory, found by a `stat`
       * that never resolves or opens it; anything else under that name is skipped.
       */
      const visitEntry = (name: string): Step => {
        const entry = path.join(directory, name);
        const specNamed = isSpecName(name);
        const considered = specNamed
          ? Effect.succeed(true)
          : fs.stat(entry).pipe(
              Effect.map((info) => info.type === "Directory"),
              Effect.orElseSucceed(() => false),
            );

        return considered.pipe(
          Effect.flatMap((consider) =>
            consider
              ? resolveUnderRoot(realRoot, path.relative(realRoot, entry)).pipe(
                  Effect.flatMap((real) =>
                    fs.stat(real).pipe(
                      Effect.catchTag("PlatformError", () => unreadable(real)),
                      Effect.flatMap((info) => settle(real, info, specNamed)),
                    ),
                  ),
                )
              : Effect.void,
          ),
        );
      };

      return fs.readDirectory(directory).pipe(
        Effect.catchTag("PlatformError", () => unreadable(directory)),
        Effect.flatMap((names) =>
          Effect.forEach(
            Arr.sort(names, Order.String),
            (name) =>
              Effect.suspend(() => {
                visited += 1;

                return visited > maxWalkEntries ? walkLimit(directory) : visitEntry(name);
              }),
            { discard: true },
          ),
        ),
      );
    };

    yield* walk(realRoot, 0);
  }).pipe(Effect.provide(Path.layer));

/**
 * Loads every pair through the bounded loader, in order, then the files under `options.refRoot`
 * (sorted, each keyed by the `file:` URL of its real path), into a set keyed by retrieval URI. All
 * documents count toward one budget and share one duplicate check. The
 * first refusal ends the load; every refusal is a document-scope diagnostic whose `hint` is the
 * offending pair's path, never the file's content.
 */
export const makeDocumentSet = (
  pairs: readonly DocumentPair[],
  options: DocumentSetOptions = {},
): Effect.Effect<DocumentSet, LoadRefusal, FileSystem.FileSystem> =>
  Effect.gen(function* load() {
    const overflow = pairs[maxDocuments];

    if (overflow !== undefined) {
      return yield* refuse("REF-16/document-limit", overflow);
    }

    const documents = new Map<Document, SetMember>();

    for (const pair of pairs) {
      const [uri, member] = yield* loadPair(documents, pair);

      documents.set(uri, member);
    }

    if (options.refRoot !== undefined) {
      yield* preloadRoot(documents, options.refRoot);
    }

    return { documents };
  });
