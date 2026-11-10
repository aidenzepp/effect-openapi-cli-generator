import { Array as Arr, Effect, FileSystem, Option, Order, Path, Schema } from "effect";
import type { Digest } from "effect/crypto";
import { DocumentUri } from "../model/brands.ts";
import { Diagnostic, makeDiagnostic } from "../model/diagnostic.ts";
import { retrievalBase } from "../resolve/base-uri.ts";
import {
  defaultLimits,
  LoadRefusal,
  readFileBounded,
  readMemberBounded,
  sameFile,
} from "./budget.ts";
import type { VerifyOpened } from "./budget.ts";
import { sha256Hex } from "../write/manifest.ts";
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
  /**
   * The sha256 of the exact bytes parsed, computed once at load.
   */
  readonly sha256: string;
}

/**
 * The documents `$ref` may resolve over, keyed by retrieval URI (design 3.3).
 */
export interface DocumentSet {
  readonly documents: ReadonlyMap<Document, SetMember>;
}

/**
 * Most documents one set holds, the entry included (design 3.3 budgets).
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

const isDocumentUri = Schema.is(DocumentUri);

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

/**
 * Refuses `pair` with `code`. The diagnostic's document is the pair's URI when it is absolute, and
 * otherwise the `file:` URL of its path; a path `toFileUrl` rejects is a defect, as before.
 */
const refusePair = Effect.fnUntraced(function* refusePair(
  code: keyof typeof messages,
  pair: DocumentPair,
): Effect.fn.Return<never, LoadRefusal, Path.Path> {
  const path = yield* Path.Path;
  const document = isDocumentUri(pair.uri)
    ? pair.uri
    : (yield* path.toFileUrl(pair.path).pipe(Effect.orDie)).href;
  const diagnostic = yield* makeDiagnostic({
    code,
    document,
    element: "document",
    hint: pair.path,
    message: messages[code],
    openapi: "unknown",
    pointer: "",
    scope: "document",
    severity: "refusal",
    specSection: "https://spec.openapis.org/oas/v3.2.1.html#establishing-the-base-uri",
  });

  return yield* new LoadRefusal({ diagnostic });
});

/**
 * The `REF-16/duplicate-uri` refusal for `pair`, whose `uri` is the retrieval URI already in use.
 */
export const duplicateUri = (pair: DocumentPair) => refusePair("REF-16/duplicate-uri", pair);

const withPath = (refusal: LoadRefusal, path: string): Effect.Effect<never, LoadRefusal> =>
  makeDiagnostic({ ...Schema.encodeSync(Diagnostic)(refusal.diagnostic), hint: path }).pipe(
    Effect.flatMap((diagnostic) =>
      Effect.fail(
        new LoadRefusal(
          refusal.offset === undefined ? { diagnostic } : { diagnostic, offset: refusal.offset },
        ),
      ),
    ),
  );

const withPathOf = (path: string) => (refusal: LoadRefusal) => withPath(refusal, path);

/**
 * The members loaded so far and the entry's retrieval URI, when the caller names it.
 */
interface Loading {
  readonly documents: Map<Document, SetMember>;
  readonly entry: Document | undefined;
}

/**
 * Whether `uri` names the resource `known` names, in the resolver's normal form, so that two
 * spellings (scheme or host case, `./`, a fragment) of one retrieval URI are one document.
 */
const sameResource = (uri: string, known: string): boolean =>
  retrievalBase(uri) === retrievalBase(known);

/**
 * `uri` collides with a member, or spells the entry's URI differently. A member under the entry's
 * exact URI is left to `setMembers`, which accepts it only when it is the entry's own file.
 */
const isDuplicate = ({ documents, entry }: Loading, uri: Document): boolean =>
  (entry !== undefined && uri !== entry && sameResource(uri, entry)) ||
  [...documents.keys()].some((known) => sameResource(uri, known));

/**
 * Whether one more document under `uri` overflows the budget. The entry always holds a slot: its
 * own when it is already a member, a reserved one otherwise. With no entry named, the slot is
 * reserved anyway, so the set never exceeds the budget.
 */
const overflows = ({ documents, entry }: Loading, uri: string): boolean => {
  const entrySlot = entry !== undefined && documents.has(entry) ? 0 : 1;

  return uri !== entry && documents.size + entrySlot >= maxDocuments;
};

/**
 * Reads, parses and hashes the file of `pair` under `document`; a refusal names the pair's path.
 */
const readMember = Effect.fnUntraced(
  function* readMember(
    pair: DocumentPair,
    document: Document,
    verify?: VerifyOpened,
  ): Effect.fn.Return<SetMember, LoadRefusal, FileSystem.FileSystem | Digest.Digest> {
    const bytes = yield* verify === undefined
      ? readFileBounded(pair.path, defaultLimits, document)
      : readMemberBounded(pair.path, defaultLimits, document, verify);
    const loaded = yield* loadBytes(bytes, { document });
    const sha256 = yield* sha256Hex(bytes);

    return { ...loaded, path: pair.path, sha256 };
  },
  (effect, pair) => effect.pipe(Effect.catchTag("LoadRefusal", withPathOf(pair.path))),
);

/**
 * Adds `pair` to `loading`. The duplicate and budget checks read `loading` when the Effect runs,
 * and the caller runs pairs in order, so each check sees every member loaded before it; no `Ref`
 * or `Effect.reduce` is needed.
 */
const loadPair = Effect.fnUntraced(function* loadPair(
  loading: Loading,
  pair: DocumentPair,
  verify?: VerifyOpened,
): Effect.fn.Return<void, LoadRefusal, FileSystem.FileSystem | Path.Path | Digest.Digest> {
  const uri = decodeUri(pair.uri);

  if (Option.isNone(uri)) {
    return yield* refusePair("REF-16/relative-uri", pair);
  }

  if (isDuplicate(loading, uri.value)) {
    return yield* duplicateUri(pair);
  }

  if (overflows(loading, uri.value)) {
    return yield* refusePair("REF-16/document-limit", pair);
  }

  const member = yield* readMember(pair, uri.value, verify);

  loading.documents.set(uri.value, member);

  return undefined;
});

export interface DocumentSetOptions {
  /**
   * The entry document's retrieval URI. It holds one slot of the budget, which a member under the
   * same URI shares, and a member spelling it differently is a duplicate. Without it a slot is
   * still reserved for the entry, so a `--ref-root` holding the entry admits one document fewer.
   */
  readonly entry?: Document;
  /**
   * A directory whose JSON and YAML files are preloaded (`--ref-root`, design 3.3, P10).
   */
  readonly refRoot?: string;
}

const refRootExtensions: ReadonlySet<string> = new Set([".json", ".yaml", ".yml"]);

const unreadable = (path: string) => refusePair("REF-16/unreadable-root", { path, uri: "" });

const outsideRoot = (path: string) => refusePair("REF-16/outside-root", { path, uri: "" });

const walkLimit = (path: string) => refusePair("REF-16/walk-limit", { path, uri: "" });

/**
 * Resolves `relative` beneath `root` and returns the real path of the result. The lexical
 * `Path.resolveWithin` check refuses `..` escapes and absolute inputs; the `realPath` re-check
 * refuses a symlink whose target lies outside the real root.
 */
export const resolveUnderRoot = Effect.fnUntraced(function* resolveUnderRoot(
  root: string,
  relative: string,
): Effect.fn.Return<string, LoadRefusal, FileSystem.FileSystem | Path.Path> {
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
});

/**
 * The opened handle must be the file at `real`, still inside the real root: after the open the
 * real path is re-resolved and `stat`ed by path, and that stat must match the handle (`sameFile`).
 * Together with the pre-open `stat` and `noFollow` (which refuses a symlink at the final
 * component) this closes the swap window between the pre-open `stat` and the open. The
 * post-open check is path-based, so a parent directory swapped between `realPath` and `stat`
 * remains possible (accepted risk, see design).
 */
const verify = Effect.fnUntraced(function* verify(
  realRoot: string,
  real: string,
  opened: FileSystem.File.Info,
): Effect.fn.Return<void, LoadRefusal, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const checked = yield* resolveUnderRoot(realRoot, path.relative(realRoot, real));
  const info = yield* fs.stat(checked).pipe(Effect.catch(() => unreadable(real)));
  const same = checked === real && info.type === "File" && sameFile(info, opened);

  return yield* same ? Effect.void : outsideRoot(real);
});

/**
 * `verify` as the loader's `VerifyOpened`, which admits only a `FileSystem` requirement, so the
 * caller's `path` service is provided to it here.
 */
const sameCheckedFile =
  (path: Path.Path, realRoot: string, real: string): VerifyOpened =>
  (opened) =>
    verify(realRoot, real, opened).pipe(Effect.provideService(Path.Path, path));

const preloadFile = Effect.fnUntraced(function* preloadFile(
  loading: Loading,
  realRoot: string,
  real: string,
): Effect.fn.Return<void, LoadRefusal, FileSystem.FileSystem | Path.Path | Digest.Digest> {
  const path = yield* Path.Path;
  const uri = (yield* path.toFileUrl(real).pipe(Effect.orDie)).href;

  yield* loadPair(loading, { path: real, uri }, sameCheckedFile(path, realRoot, real));
});

const preloadRoot = Effect.fnUntraced(function* preloadRoot(
  loading: Loading,
  root: string,
): Effect.fn.Return<void, LoadRefusal, FileSystem.FileSystem | Path.Path | Digest.Digest> {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const realRoot = yield* resolveUnderRoot(root, ".");
  const seenDirectories = new Set<string>([realRoot]);
  const seenFiles = new Set<string>();
  let visited = 0;

  const isSpecName = (name: string) => refRootExtensions.has(path.extname(name).toLowerCase());

  type Step = Effect.Effect<void, LoadRefusal, FileSystem.FileSystem | Path.Path | Digest.Digest>;

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

      return preloadFile(loading, realRoot, real);
    };

    /**
     * A name not like a spec file is considered only if it is a directory, found by a `stat`
     * that never resolves or opens it; anything else under that name is skipped, including a
     * directory link that leaves the real root (a `node_modules`-style link). A spec-named
     * escape is still refused.
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
                Effect.map(Option.some),
                Effect.catchIf(
                  (refusal) => !specNamed && refusal.diagnostic.code === "REF-16/outside-root",
                  () => Effect.succeedNone,
                ),
                Effect.flatMap((resolved: Option.Option<string>) =>
                  Option.match(resolved, {
                    onNone: () => Effect.void,
                    onSome: (real) =>
                      fs.stat(real).pipe(
                        Effect.catchTag("PlatformError", () => unreadable(real)),
                        Effect.flatMap((info) => settle(real, info, specNamed)),
                      ),
                  }),
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
});

/**
 * Loads every pair through the bounded loader, in order, then the files under `options.refRoot`
 * (sorted, each keyed by the `file:` URL of its real path), into a set keyed by retrieval URI. All
 * documents, the entry included, count toward one budget of `maxDocuments` and share one duplicate
 * check that compares retrieval URIs in normal form. The first refusal ends the load; every
 * refusal is a document-scope diagnostic whose `hint` is the offending pair's path, never the
 * file's content.
 */
export const makeDocumentSet = Effect.fnUntraced(function* makeDocumentSet(
  pairs: readonly DocumentPair[],
  options: DocumentSetOptions = {},
): Effect.fn.Return<DocumentSet, LoadRefusal, FileSystem.FileSystem | Path.Path | Digest.Digest> {
  const loading: Loading = { documents: new Map(), entry: options.entry };

  for (const pair of pairs) {
    yield* loadPair(loading, pair);
  }

  if (options.refRoot !== undefined) {
    yield* preloadRoot(loading, options.refRoot);
  }

  return { documents: loading.documents };
});
