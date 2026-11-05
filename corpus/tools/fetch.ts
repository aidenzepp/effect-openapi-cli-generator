import { createHash } from "node:crypto";
import { Data, Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)));

const Twin = Schema.Struct({ sha256: Sha256, sourceUrl: Schema.NonEmptyString });

/**
 * One pinned specification (design 8.2). `pinnedRef` is `owner/repo@<commit>`, or `unpinned` for a
 * source that cannot be pinned (such sources stay in the `extended` tier).
 */
export const CorpusEntry = Schema.Struct({
  bytes: Schema.Int,
  format: Schema.Literals(["json", "yaml"]),
  id: Schema.NonEmptyString,
  infoLicense: Schema.optionalKey(Schema.NonEmptyString),
  license: Schema.NonEmptyString,
  licenseSha256: Schema.optionalKey(Sha256),
  pinnedRef: Schema.NonEmptyString,
  sha256: Sha256,
  sourceUrl: Schema.NonEmptyString,
  tier: Schema.Literals(["ci", "extended"]),
  twin: Schema.optionalKey(Twin),
});

/**
 * The corpus manifest: a version and one entry per pinned spec.
 */
export const Corpus = Schema.Struct({
  specs: Schema.Array(CorpusEntry),
  version: Schema.Literal(1),
});

export class CorpusHashMismatch extends Data.TaggedError("CorpusHashMismatch")<{
  readonly actual: string;
  readonly expected: string;
  readonly sourceUrl: string;
}> {}

export class CorpusSourceRefused extends Data.TaggedError("CorpusSourceRefused")<{
  readonly sourceUrl: string;
}> {}

export class CorpusFetchFailed extends Data.TaggedError("CorpusFetchFailed")<{
  readonly cause: unknown;
  readonly sourceUrl: string;
}> {}

export class CorpusCacheFailed extends Data.TaggedError("CorpusCacheFailed")<{
  readonly cause: unknown;
  readonly path: string;
}> {}

export interface Pin {
  readonly sha256: string;
  readonly sourceUrl: string;
}

export type SourceError = CorpusFetchFailed | CorpusSourceRefused;

export type Source<R> = (sourceUrl: string) => Effect.Effect<Uint8Array, SourceError, R>;

const allowedHost = "raw.githubusercontent.com";

const isAllowed = (sourceUrl: string): boolean => {
  if (!URL.canParse(sourceUrl)) {
    return false;
  }

  const url = new URL(sourceUrl);

  return (
    url.protocol === "https:" &&
    url.hostname === allowedHost &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
};

/**
 * Reads a commit-pinned file from unauthenticated `raw.githubusercontent.com`; any other scheme,
 * host, port or credential is refused before a request is made.
 */
export const githubSource: Source<HttpClient.HttpClient> = (sourceUrl) =>
  isAllowed(sourceUrl)
    ? HttpClient.get(sourceUrl).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.mapError((cause) => new CorpusFetchFailed({ cause, sourceUrl })),
      )
    : Effect.fail(new CorpusSourceRefused({ sourceUrl }));

const sha256Of = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/**
 * Returns the cache path `<cacheDir>/<sha256>` for the pinned bytes. A cached file is used only
 * when it still hashes to the pin; otherwise the bytes come from `source`, are verified before
 * anything is written, and land through a temporary file and a rename.
 */
export const fetchPinned = <R>(
  pin: Pin,
  cacheDir: string,
  source: Source<R>,
): Effect.Effect<
  string,
  CorpusCacheFailed | CorpusHashMismatch | SourceError,
  FileSystem.FileSystem | Path.Path | R
> =>
  Effect.gen(function* fetch() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(cacheDir, pin.sha256);
    const cacheFailed = (cause: unknown) => new CorpusCacheFailed({ cause, path: target });
    const present = yield* fs.exists(target).pipe(Effect.mapError(cacheFailed));

    if (present) {
      const cached = yield* fs.readFile(target).pipe(Effect.mapError(cacheFailed));

      if (sha256Of(cached) === pin.sha256) {
        return target;
      }
    }

    const bytes = yield* source(pin.sourceUrl);
    const actual = sha256Of(bytes);

    if (actual !== pin.sha256) {
      return yield* new CorpusHashMismatch({
        actual,
        expected: pin.sha256,
        sourceUrl: pin.sourceUrl,
      });
    }

    yield* fs.makeDirectory(cacheDir, { recursive: true }).pipe(Effect.mapError(cacheFailed));

    const partial = yield* fs
      .makeTempFile({ directory: cacheDir, prefix: ".fetch-", suffix: ".partial" })
      .pipe(Effect.mapError(cacheFailed));

    yield* fs.writeFile(partial, bytes).pipe(
      Effect.andThen(fs.rename(partial, target)),
      Effect.tapError(() => Effect.ignore(fs.remove(partial, { force: true }))),
      Effect.mapError(cacheFailed),
    );

    return target;
  });
