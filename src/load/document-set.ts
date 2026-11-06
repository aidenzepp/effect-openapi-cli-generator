import { Array as Arr, Effect, FileSystem, Option, Order, Path, Schema } from "effect";
import { pathToFileURL } from "node:url";
import { DocumentUri } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import { LoadRefusal } from "./budget.ts";
import { loadFile } from "./index.ts";
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

const messages = {
  "REF-16/document-limit": "The document set holds more documents than the limit allows.",
  "REF-16/duplicate-uri": "Two documents in the set share a retrieval URI.",
  "REF-16/outside-root": "A reference-root entry resolves outside the reference root.",
  "REF-16/relative-uri": "A document's retrieval URI is not an absolute URI.",
  "REF-16/unreadable-root": "The reference root or one of its entries cannot be read.",
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
): Effect.Effect<readonly [Document, SetMember], LoadRefusal, FileSystem.FileSystem> => {
  const uri = decodeUri(pair.uri);

  if (uri._tag === "None") {
    return refuse("REF-16/relative-uri", pair);
  }

  if (documents.has(uri.value)) {
    return refuse("REF-16/duplicate-uri", pair);
  }

  return loadFile(pair.path, { document: uri.value }).pipe(
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

const preloadFile = (documents: Map<Document, SetMember>, real: string) => {
  const pair: DocumentPair = { path: real, uri: pathToFileURL(real).href };

  return documents.size >= maxDocuments
    ? refuse("REF-16/document-limit", pair)
    : loadPair(documents, pair).pipe(
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

    const walk = (directory: string): Effect.Effect<void, LoadRefusal, FileSystem.FileSystem> =>
      Effect.gen(function* visit() {
        const names = yield* fs
          .readDirectory(directory)
          .pipe(Effect.catch(() => unreadable(directory)));

        for (const name of Arr.sort(names, Order.String)) {
          const real = yield* resolveUnderRoot(
            realRoot,
            path.relative(realRoot, path.join(directory, name)),
          );
          const info = yield* fs.stat(real).pipe(Effect.catch(() => unreadable(real)));

          if (info.type === "Directory" && !seenDirectories.has(real)) {
            seenDirectories.add(real);
            yield* walk(real);
          } else if (
            info.type === "File" &&
            refRootExtensions.has(path.extname(real).toLowerCase()) &&
            !seenFiles.has(real)
          ) {
            seenFiles.add(real);
            yield* preloadFile(documents, real);
          }
        }
      });

    yield* walk(realRoot);
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
