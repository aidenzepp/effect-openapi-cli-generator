import type { PlatformError } from "effect";
import { Data, Effect, FileSystem, Option, Path, Schema, Sink, Stdio, Stream } from "effect";
import { Flag, GlobalFlag } from "effect/cli";
import { OutputError, UsageError } from "../domain/errors.ts";

/**
 * `--output <path>` writes the response body to a file; `-` writes it to stdout.
 */
export const OutputPath = GlobalFlag.Setting("output")({
  flag: Flag.String("output").pipe(
    Flag.optional,
    Flag.withDescription("Write the response body to <path>, or to stdout when <path> is -"),
  ),
});

/**
 * `--force` lets `--output <path>` replace an existing file.
 */
export const Force = GlobalFlag.Setting("force")({
  flag: Flag.Boolean("force").pipe(
    Flag.withDescription("Replace an existing --output file"),
    Flag.withDefault(false),
  ),
});

/**
 * Default `--max-error-bytes` (design 7.4).
 */
export const defaultMaxErrorBytes = 4096;

/**
 * Ceiling for `--max-error-bytes` (design 7.4).
 */
export const maxErrorBytesCeiling = 65_536;

const inErrorBytesRange = (n: number): boolean => n >= 0 && n <= maxErrorBytesCeiling;

const errorBytesRangeMessage = (): string => `must be between 0 and ${maxErrorBytesCeiling}`;

/**
 * `--max-error-bytes` bounds the error-body excerpt; 0 omits it.
 */
export const MaxErrorBytes = GlobalFlag.Setting("max-error-bytes")({
  flag: Flag.Int("max-error-bytes").pipe(
    // Flag.filter takes (predicate, onFalse); it is not an array method with a thisArg.
    // oxlint-disable-next-line unicorn/no-array-method-this-argument
    Flag.filter(inErrorBytesRange, errorBytesRangeMessage),
    Flag.withDescription("Bytes of an error response body to print; 0 prints none"),
    Flag.withDefault(defaultMaxErrorBytes),
  ),
});

/**
 * A response body: its media type (absent when the response declared none) and its bytes, not
 * yet read.
 */
export interface ResponseBody<E, R = never> {
  readonly mediaType: string | undefined;
  readonly bytes: Stream.Stream<Uint8Array, E, R>;
}

const textMediaType =
  /^(?:text\/|application\/(?:json|xml|x-www-form-urlencoded)\b|[^;]*\+(?:json|xml)\b)/iu;

/**
 * Whether the media type is text-family. Absent or unrecognized media types count as binary.
 */
const isText = (mediaType: string | undefined): boolean =>
  mediaType !== undefined && textMediaType.test(mediaType.trim());

const BrokenPipe = Schema.Struct({ code: Schema.Literal("EPIPE") });

const isBrokenPipe = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "Unknown" && Schema.is(BrokenPipe)(error.reason.cause);

const stdoutPath = "-";

/**
 * The reader went away: stop streaming, report success (design 13.1 R5).
 */
class StdoutClosed extends Data.TaggedError("StdoutClosed") {}

const stdoutFailure = (failure: PlatformError.PlatformError): OutputError | StdoutClosed =>
  isBrokenPipe(failure)
    ? new StdoutClosed()
    : new OutputError({ path: stdoutPath, reason: "write" });

const toStdout = <E, R>(
  body: Stream.Stream<Uint8Array, E, R>,
): Effect.Effect<void, E | OutputError, R | Stdio.Stdio> =>
  Effect.gen(function* step1() {
    const stdio = yield* Stdio.Stdio;
    const sink = Sink.mapError(stdio.stdout(), stdoutFailure);

    yield* Stream.run(body, sink);
  }).pipe(Effect.catchTag("StdoutClosed", () => Effect.void));

const writeError = (path: string) => () => new OutputError({ path, reason: "write" });

const toFile = <E, R>(
  body: Stream.Stream<Uint8Array, E, R>,
  target: string,
  force: boolean,
): Effect.Effect<void, E | OutputError, R | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* step2() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const failWrite = writeError(target);

    if (!force && (yield* fs.exists(target).pipe(Effect.mapError(failWrite)))) {
      return yield* new OutputError({ path: target, reason: "exists" });
    }

    const temp = yield* fs
      .makeTempFile({ directory: path.dirname(target), prefix: ".output-", suffix: ".tmp" })
      .pipe(Effect.mapError(failWrite));

    return yield* Effect.gen(function* step3() {
      yield* Stream.run(body, fs.sink(temp).pipe(Sink.mapError(failWrite)));

      // Without --force, link fails on an existing path, so a racing creator is never overwritten.
      yield* force
        ? fs.rename(temp, target).pipe(Effect.mapError(failWrite))
        : fs
            .link(temp, target)
            .pipe(
              Effect.mapError((error) =>
                error.reason._tag === "AlreadyExists"
                  ? new OutputError({ path: target, reason: "exists" })
                  : failWrite(),
              ),
            );
    }).pipe(
      // makeTempFile puts the file in a fresh sibling directory; removing it removes both.
      Effect.ensuring(
        Effect.ignore(fs.remove(path.dirname(temp), { force: true, recursive: true })),
      ),
    );
  });

/**
 * Write a response body to its destination: stdout, or with `--output <path>` a temp sibling
 * renamed into place (an existing path is refused unless `--force`). `--output -` is stdout.
 * Binary media to a terminal is refused before the body is read unless `--output -` is given.
 * EPIPE on stdout stops the stream and succeeds.
 */
export const writeBody = <E, R>(
  response: ResponseBody<E, R>,
): Effect.Effect<
  void,
  E | OutputError | UsageError,
  | R
  | FileSystem.FileSystem
  | GlobalFlag.Setting.Identifier<"force">
  | GlobalFlag.Setting.Identifier<"output">
  | Path.Path
  | Stdio.Stdio
> =>
  Effect.gen(function* step4() {
    const output = yield* OutputPath;
    const force = yield* Force;
    const target = Option.getOrUndefined(output);

    if (target !== undefined && target !== stdoutPath) {
      return yield* toFile(response.bytes, target, force);
    }

    if (target === undefined && !isText(response.mediaType)) {
      const stdio = yield* Stdio.Stdio;

      if (yield* stdio.stdoutIsTerminal) {
        return yield* new UsageError({
          flag: "output",
          message:
            "refusing to write binary output to a terminal; use --output <path> or --output -",
        });
      }
    }

    return yield* toStdout(response.bytes);
  });
