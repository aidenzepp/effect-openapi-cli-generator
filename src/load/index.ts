import { Effect } from "effect";
import type { FileSystem, PlatformError, Stream } from "effect";
import type { DocumentUri } from "../model/brands.ts";
import type { Json } from "../resolve/pointer.ts";
import { defaultLimits, readFileBounded, readStreamBounded, refuse } from "./budget.ts";
import type { LoadLimits, LoadRefusal } from "./budget.ts";
import { parseStrictJson } from "./json.ts";

export { defaultLimits, LoadRefusal } from "./budget.ts";

export type { LoadLimits } from "./budget.ts";

type Document = typeof DocumentUri.Type;

export interface LoadOptions {
  readonly document: Document;
  readonly limits?: Partial<LoadLimits>;
}

export interface Loaded {
  readonly document: Document;
  readonly format: "json" | "yaml";
  readonly value: Json;
}

const limitsOf = (options: LoadOptions): LoadLimits => ({ ...defaultLimits, ...options.limits });

const hasBom = (bytes: Uint8Array): boolean =>
  bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Loads one document from bytes already read. The first non-whitespace character picks the
 * format, never the extension: `{` is JSON, anything else is YAML (design 3.1).
 */
export const loadBytes = (
  bytes: Uint8Array,
  options: LoadOptions,
): Effect.Effect<Loaded, LoadRefusal> => {
  const limits = limitsOf(options);
  const { document } = options;

  if (bytes.length > limits.maxBytes) {
    return refuse(document, "DOC-14/too-large");
  }

  return Effect.try({
    catch: () => "DOC-14/invalid-encoding" as const,
    try: () => decoder.decode(bytes),
  }).pipe(
    Effect.matchEffect({
      onFailure: (code) => refuse(document, code),
      onSuccess: (text) =>
        text.trimStart().startsWith("{")
          ? parseStrictJson(text, limits, document, hasBom(bytes) ? 3 : 0).pipe(
              Effect.map((value): Loaded => ({ document, format: "json", value })),
            )
          : refuse(document, "DOC-14/yaml-unsupported"),
    }),
  );
};

/**
 * Loads one document from a file, checking its size with `FileSystem.stat` before reading.
 */
export const loadFile = (
  path: string,
  options: LoadOptions,
): Effect.Effect<Loaded, LoadRefusal, FileSystem.FileSystem> =>
  readFileBounded(path, limitsOf(options), options.document).pipe(
    Effect.flatMap((bytes) => loadBytes(bytes, options)),
  );

/**
 * Loads one document from a byte stream (stdin) through `Stream.limitBytes`.
 */
export const loadStream = (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  options: LoadOptions,
): Effect.Effect<Loaded, LoadRefusal> =>
  readStreamBounded(stream, limitsOf(options), options.document).pipe(
    Effect.flatMap((bytes) => loadBytes(bytes, options)),
  );
