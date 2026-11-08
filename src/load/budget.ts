import { Array as Arr, ByteSize, Data, Effect, FileSystem, Option, Schema, Stream } from "effect";
import type { PlatformError } from "effect";
import type { DocumentUri } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";

type Document = typeof DocumentUri.Type;

/**
 * Limits on what the loader reads into memory (design 3.1, 9 I5). Every number is a proposal to
 * calibrate on the corpus.
 */
export interface LoadLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export const defaultLimits: LoadLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 256,
  maxNodes: 10_000_000,
};

const messages = {
  "DOC-14/depth-limit": "The document nests deeper than the depth limit.",
  "DOC-14/duplicate-key": "An object repeats a key.",
  "DOC-14/invalid-encoding": "The document is not valid UTF-8.",
  "DOC-14/invalid-json": "The document is not valid JSON.",
  "DOC-14/invalid-yaml": "The document is not valid YAML 1.2.",
  "DOC-14/node-budget": "The document has more values than the node budget allows.",
  "DOC-14/too-large": "The document is larger than the size limit.",
  "DOC-14/unreadable": "The document could not be read.",
  "DOC-14/unsafe-integer": "An integer in default, enum or const is beyond 2^53.",
  "DOC-14/yaml-alias-cycle": "A YAML alias refers to a node that contains it.",
  "DOC-14/yaml-multi-document": "The YAML stream holds more than one document.",
  "DOC-14/yaml-non-finite": "A YAML number is not finite (.inf or .nan).",
  "DOC-14/yaml-non-json-tag": "A YAML tag has no JSON value.",
  "DOC-14/yaml-non-string-key": "A YAML mapping key is not a scalar.",
} as const;

export type LoadCode = keyof typeof messages;

/**
 * The loader refused its input. `offset` is a byte offset into the input when one is known.
 */
export class LoadRefusal extends Data.TaggedError("LoadRefusal")<{
  readonly diagnostic: Diagnostic;
  readonly offset?: number;
}> {}

/**
 * Where in the input a refusal points: 1-based line and column, 0-based byte offset.
 */
export interface Position {
  readonly column: number;
  readonly line: number;
  readonly offset: number;
}

export interface RefusalDetail {
  readonly pointer?: string;
  readonly position?: Position;
}

const diagnosticFields = (document: Document, code: LoadCode, pointer: string) => ({
  code,
  document,
  element: "document",
  message: messages[code],
  openapi: "unknown",
  pointer,
  row: "DOC-14",
  scope: "document",
  severity: "refusal",
  specSection: "https://spec.openapis.org/oas/v3.1.2.html#format",
});

/**
 * Fails with a `LoadRefusal` whose diagnostic is a `DOC-14` document-scope refusal.
 */
export const refuse = (
  document: Document,
  code: LoadCode,
  detail: RefusalDetail = {},
): Effect.Effect<never, LoadRefusal> => {
  const fields = diagnosticFields(document, code, detail.pointer ?? "");
  const { position } = detail;
  const input =
    position === undefined ? fields : { ...fields, column: position.column, line: position.line };

  return Schema.decodeUnknownEffect(Diagnostic)(input).pipe(
    Effect.orDie,
    Effect.flatMap((diagnostic) =>
      Effect.fail(
        new LoadRefusal(
          position === undefined ? { diagnostic } : { diagnostic, offset: position.offset },
        ),
      ),
    ),
  );
};

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = Arr.reduce(chunks, 0, (sum, chunk) => sum + chunk.length);
  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
};

/**
 * Collects a byte stream through `Stream.limitBytes`; the chunk that crosses the limit refuses.
 */
export const readStreamBounded = (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  limits: LoadLimits,
  document: Document,
): Effect.Effect<Uint8Array, LoadRefusal> =>
  stream.pipe(
    Stream.limitBytes<PlatformError.PlatformError | LoadRefusal, never>(
      ByteSize.bytes(limits.maxBytes),
      () => Stream.fromEffect(refuse(document, "DOC-14/too-large")),
    ),
    Stream.runCollect,
    Effect.map(concat),
    Effect.catchTag("PlatformError", () => refuse(document, "DOC-14/unreadable")),
  );

/**
 * A check a trust boundary runs on the opened handle's metadata before any byte is read. A
 * refusal here leaves the file unread.
 */
export type VerifyOpened = (
  opened: FileSystem.File.Info,
) => Effect.Effect<void, LoadRefusal, FileSystem.FileSystem>;

const chunkSize = 64 * 1024;

/**
 * The handle's bytes, chunk by chunk, until end of file.
 */
const handleStream = (
  file: FileSystem.File,
): Stream.Stream<Uint8Array, PlatformError.PlatformError> =>
  Stream.paginate(file, (handle) =>
    handle.readAlloc(chunkSize).pipe(
      Effect.map(
        Option.match({
          onNone: () => [[], Option.none()] as const,
          onSome: (chunk) => [[chunk], Option.some(handle)] as const,
        }),
      ),
    ),
  );

const checkRegular = (
  info: FileSystem.File.Info,
  limits: LoadLimits,
  document: Document,
): Effect.Effect<void, LoadRefusal> => {
  if (info.type !== "File") {
    return refuse(document, "DOC-14/unreadable");
  }

  return ByteSize.toBigInt(info.size) > BigInt(limits.maxBytes)
    ? refuse(document, "DOC-14/too-large")
    : Effect.void;
};

/**
 * Whether two `stat` results name the same file: equal `dev` and `ino`. Where the platform reports
 * no inode, equal `size` stands in for it.
 */
export const sameFile = (a: FileSystem.File.Info, b: FileSystem.File.Info): boolean =>
  a.dev === b.dev &&
  (Option.isSome(a.ino) && Option.isSome(b.ino)
    ? a.ino.value === b.ino.value
    : ByteSize.toBigInt(a.size) === ByteSize.toBigInt(b.size));

type VerifyAgainst = (
  before: FileSystem.File.Info,
  opened: FileSystem.File.Info,
) => Effect.Effect<void, LoadRefusal, FileSystem.FileSystem>;

/**
 * Opens `path` without following a symlink at its final component, checks the open handle (a
 * regular file within `maxBytes`, then `verify` against the `stat` taken before the open), and
 * reads that same handle through `Stream.limitBytes`, so the bytes read are the bytes checked and
 * `maxBytes` bounds what is actually read. The `stat` before the open refuses a special file
 * already in place without opening it; one swapped in after that `stat` is refused by the handle
 * check, but the open itself can block, since the FileSystem service cannot open non-blocking
 * (accepted risk). `noFollow` refuses a symlink at the final component only; a parent directory
 * swapped before the open is not detected here, so what `verify` can prove is limited to the
 * window between the pre-open `stat` and the open.
 */
const readOpened = (
  path: string,
  limits: LoadLimits,
  document: Document,
  verify: VerifyAgainst,
): Effect.Effect<Uint8Array, LoadRefusal, FileSystem.FileSystem> =>
  Effect.gen(function* readBounded() {
    const fs = yield* FileSystem.FileSystem;
    const unreadable = () => refuse(document, "DOC-14/unreadable");

    const before = yield* fs.stat(path).pipe(Effect.catchTag("PlatformError", unreadable));

    yield* checkRegular(before, limits, document);

    const file = yield* fs
      .open(path, { flag: "r", noFollow: true })
      .pipe(Effect.catchTag("PlatformError", unreadable));
    const opened = yield* file.stat.pipe(Effect.catchTag("PlatformError", unreadable));

    yield* checkRegular(opened, limits, document);
    yield* verify(before, opened);

    return yield* readStreamBounded(handleStream(file), limits, document);
  }).pipe(Effect.scoped);

/**
 * Reads a path the operator named (the entry document, a `--document` pair). A symlinked name is
 * the operator's choice, so its real path is resolved first; that real path is then opened
 * without following a symlink, and the handle must be the file a `stat` of the real path saw
 * (`sameFile`). The dev/ino comparison covers only the window between that `stat` and the open:
 * a file or final-component link swapped in there is refused, not read. A swap between
 * `realPath` and the `stat` is not detected.
 */
export const readFileBounded = (
  path: string,
  limits: LoadLimits,
  document: Document,
): Effect.Effect<Uint8Array, LoadRefusal, FileSystem.FileSystem> =>
  Effect.gen(function* readOperatorPath() {
    const fs = yield* FileSystem.FileSystem;
    const real = yield* fs
      .realPath(path)
      .pipe(Effect.catchTag("PlatformError", () => refuse(document, "DOC-14/unreadable")));

    return yield* readOpened(real, limits, document, (before, opened) =>
      sameFile(before, opened) ? Effect.void : refuse(document, "DOC-14/unreadable"),
    );
  });

/**
 * Reads a file found inside a trust boundary (a `--ref-root` member). `path` is opened as given,
 * never through a symlink at its final component, and `verify` decides whether the open handle
 * is still the file the boundary admitted. What `verify` can prove is bounded by what it checks:
 * the `--ref-root` check is path-based after the open (see `sameCheckedFile`).
 */
export const readMemberBounded = (
  path: string,
  limits: LoadLimits,
  document: Document,
  verify: VerifyOpened,
): Effect.Effect<Uint8Array, LoadRefusal, FileSystem.FileSystem> =>
  readOpened(path, limits, document, (_before, opened) => verify(opened));
