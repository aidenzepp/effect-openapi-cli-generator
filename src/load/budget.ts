import { Array as Arr, ByteSize, Data, Effect, FileSystem, Schema, Stream } from "effect";
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
 * Reads a regular file through `FileSystem.stream`, so `maxBytes` bounds the bytes actually read,
 * not the size `stat` reported. Anything that is not a regular file is refused unread.
 */
export const readFileBounded = (
  path: string,
  limits: LoadLimits,
  document: Document,
): Effect.Effect<Uint8Array, LoadRefusal, FileSystem.FileSystem> =>
  Effect.gen(function* readBounded() {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs
      .stat(path)
      .pipe(Effect.catchTag("PlatformError", () => refuse(document, "DOC-14/unreadable")));

    if (info.type !== "File") {
      return yield* refuse(document, "DOC-14/unreadable");
    }

    if (ByteSize.toBigInt(info.size) > BigInt(limits.maxBytes)) {
      return yield* refuse(document, "DOC-14/too-large");
    }

    return yield* readStreamBounded(fs.stream(path), limits, document);
  });
