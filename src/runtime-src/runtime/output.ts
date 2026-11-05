import type { PlatformError } from "effect";
import {
  Array as Arr,
  Cause,
  Data,
  Effect,
  FileSystem,
  Option,
  Order,
  Path,
  Redacted,
  Runtime,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { CliError, CliOutput, Flag, GlobalFlag } from "effect/cli";
import {
  ApiResponseError,
  CredentialMissing,
  OutputError,
  RedirectRefused,
  ResponseStreamError,
  TransportError,
  UsageError,
} from "../domain/errors.ts";
import type { Credential } from "./auth.ts";

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

/**
 * C0 except LF and TAB, DEL, C1, format characters (bidi controls among them), U+2028, U+2029 and
 * lone surrogates: the set the help text removes at generation (design 7.4).
 */
const unsafeText = /(?![\n\t])[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;

/**
 * Remove the characters that can drive a terminal or hide text. LF and TAB stay.
 */
export const sanitize = (text: string): string => text.replaceAll(unsafeText, "");

const byLongestValue = Order.mapInput(Order.flip(Order.Number), (credential: Credential) => {
  const value: string = Redacted.value(credential.value);

  return value.length;
});

/**
 * Replace every configured credential value with `<redacted:<scheme>>` (design 7.5, C5). The
 * longest value goes first so a value that contains another is not left half visible. Empty
 * values are skipped.
 */
export const scrub = (text: string, credentials: readonly Credential[]): string => {
  let scrubbed = text;

  for (const credential of Arr.sort(credentials, byLongestValue)) {
    const value: string = Redacted.value(credential.value);

    if (value !== "") {
      scrubbed = scrubbed.replaceAll(value, `<redacted:${credential.scheme}>`);
    }
  }

  return scrubbed;
};

// The first code point each UTF-8 length cannot encode: 0x80, 0x800 and 0x10000.
const oneByteLimit = 128;

const twoByteLimit = 2048;

const threeByteLimit = 65_536;

const utf8Width = (character: string): number => {
  const point = character.codePointAt(0) ?? 0;

  if (point < oneByteLimit) {
    return 1;
  }

  if (point < twoByteLimit) {
    return 2;
  }

  return point < threeByteLimit ? 3 : 4;
};

/**
 * The longest prefix of `text` that fits `maxBytes` of UTF-8, never splitting a character.
 */
const truncateUtf8 = (text: string, maxBytes: number): string => {
  let used = 0;
  let end = 0;

  for (const character of text) {
    used += utf8Width(character);

    if (used > maxBytes) {
      break;
    }

    end += character.length;
  }

  return text.slice(0, end);
};

/**
 * The excerpt of an error body: credential values scrubbed, then sanitized, then bounded to
 * `maxBytes` of UTF-8. The bound comes last because scrubbing can lengthen text and
 * `ApiResponseError` refuses an excerpt over 64 KiB (audit F6).
 */
export const boundedExcerpt = (
  text: string,
  maxBytes: number,
  credentials: readonly Credential[],
): string => truncateUtf8(sanitize(scrub(text, credentials)), maxBytes);

const encoder = new TextEncoder();

const longestCredentialBytes = (credentials: readonly Credential[]): number => {
  let longest = 0;

  for (const credential of credentials) {
    const value: string = Redacted.value(credential.value);

    longest = Math.max(longest, encoder.encode(value).length);
  }

  return longest;
};

// Stream.limitBytes drops the chunk that crosses the limit, which would lose a whole first chunk
// larger than the limit, so each chunk is cut at the remaining budget instead.
const takeBytes = <E, R>(
  body: Stream.Stream<Uint8Array, E, R>,
  budget: number,
): Stream.Stream<Uint8Array, E, R> =>
  body.pipe(
    Stream.mapAccum(
      () => budget,
      (remaining, chunk: Uint8Array) =>
        [remaining - Math.min(remaining, chunk.length), [chunk.subarray(0, remaining)]] as const,
    ),
    Stream.takeWhile((chunk) => chunk.length > 0),
  );

const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;

  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }

  return joined;
};

/**
 * Read the excerpt of an error response body for `ApiResponseError.bodyExcerpt`, bounded by
 * `--max-error-bytes` (0 reads nothing). It reads that many bytes plus the longest credential, so
 * a credential cut by the limit is still found and scrubbed, then bounds the scrubbed text.
 */
export const readExcerpt = <E, R>(
  body: Stream.Stream<Uint8Array, E, R>,
  credentials: readonly Credential[],
): Effect.Effect<string, E, R | GlobalFlag.Setting.Identifier<"max-error-bytes">> =>
  Effect.gen(function* step5() {
    const maxBytes = yield* MaxErrorBytes;

    if (maxBytes === 0) {
      return "";
    }

    const chunks = yield* Stream.runCollect(
      takeBytes(body, maxBytes + longestCredentialBytes(credentials)),
    );

    return boundedExcerpt(new TextDecoder().decode(concatBytes(chunks)), maxBytes, credentials);
  });

/**
 * The errors the runtime raises by design (design 7.1), each rendered through `renderError`.
 */
export type KnownError =
  | ApiResponseError
  | CredentialMissing
  | OutputError
  | RedirectRefused
  | ResponseStreamError
  | TransportError
  | UsageError;

const isKnownError = (error: unknown): error is KnownError =>
  error instanceof ApiResponseError ||
  error instanceof CredentialMissing ||
  error instanceof OutputError ||
  error instanceof RedirectRefused ||
  error instanceof ResponseStreamError ||
  error instanceof TransportError ||
  error instanceof UsageError;

const oneLine = (text: string): string => text.replaceAll(/[\n\t]+/gu, " ");

const singleLine = (text: string, credentials: readonly Credential[]): string =>
  oneLine(sanitize(scrub(text, credentials)));

/**
 * The text printed on stderr for a known error (design 7.4): `Error: <message>`, for an
 * `ApiResponseError` then `Request ID: <id>` when set, then the excerpt (omitted when empty).
 * Every part is scrubbed and sanitized again here, because the error may come from anywhere.
 */
export const renderError = (error: KnownError, credentials: readonly Credential[]): string => {
  const lines = [`Error: ${singleLine(error[CliError.userMessage], credentials)}`];

  if (error instanceof ApiResponseError) {
    if (error.requestId !== undefined) {
      lines.push(`Request ID: ${singleLine(error.requestId, credentials)}`);
    }

    const excerpt = boundedExcerpt(error.bodyExcerpt, maxErrorBytesCeiling, credentials);

    if (excerpt !== "") {
      lines.push(excerpt);
    }
  }

  return lines.join("\n");
};

const base = CliOutput.defaultFormatter({ colors: false });

const valueFreeMessage = (error: CliError.CliError): string => {
  if (error._tag !== "InvalidValue") {
    return base.formatCliError(error);
  }

  const subject = error.kind === "flag" ? `flag --${error.option}` : `argument <${error.option}>`;

  return `Invalid value for ${subject}. Run with --help for usage.`;
};

/**
 * Renders a `CliError.InvalidValue` by `kind` and `option` only: its `value` is the raw flag text
 * and its `expected` can quote it (design 7.5, SM-3). Everything else renders as the default
 * formatter does, without colors.
 */
export const valueFreeFormatter: CliOutput.Formatter = {
  formatCliError: valueFreeMessage,
  formatError: (error) => `\nERROR\n  ${valueFreeMessage(error)}`,
  formatErrors: (errors) =>
    errors.length === 0
      ? ""
      : `\nERROR${errors.length === 1 ? "" : "S"}\n${errors
          .map((error) => `  ${valueFreeMessage(error)}`)
          .join("\n")}`,
  formatHelpDoc: base.formatHelpDoc,
  formatVersion: base.formatVersion,
};

/**
 * Exit 70: a failure no error class names, a defect in the program. It is already printed.
 */
export class InternalError extends Data.TaggedError("InternalError") {
  readonly [Runtime.errorExitCode] = 70;

  readonly [Runtime.errorReported] = false;
}

/**
 * Longest message a defect line may carry. A runtime choice: the design says only "one line".
 */
const maxDefectLineLength = 512;

const Described = Schema.Union([Schema.String, Schema.Struct({ message: Schema.String })]);

const isString = Schema.is(Schema.String);

const isDescribed = Schema.is(Described);

const defectMessage = (defect: typeof Described.Type): string =>
  isString(defect) ? defect : defect.message;

const printStderr = (text: string): Effect.Effect<void, never, Stdio.Stdio> =>
  Effect.gen(function* step6() {
    const stdio = yield* Stdio.Stdio;

    yield* Stream.run(Stream.make(`${text}\n`), stdio.stderr());
  }).pipe(Effect.ignore);

/**
 * The final catch around `Command.run` (design 7.4): a known error is rendered once and fails
 * again as itself, so its exit code stands; interruption and `CliError`s (rendered by the CLI
 * presenter) pass through; anything else prints one scrubbed line and "internal error, please
 * report" and fails with `InternalError`, exit 70. `credentials` are the values to scrub; the
 * caller holds them.
 */
export const finalCatch =
  (credentials: readonly Credential[]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | InternalError, R | Stdio.Stdio> =>
    Effect.catchCause(effect, (cause): Effect.Effect<never, E | InternalError, Stdio.Stdio> => {
      const failure = Cause.findErrorOption(cause);

      if (
        Cause.hasInterruptsOnly(cause) ||
        (Option.isSome(failure) && CliError.isCliError(failure.value))
      ) {
        return Effect.failCause(cause);
      }

      if (Option.isSome(failure) && isKnownError(failure.value)) {
        const error = failure.value;

        return printStderr(renderError(error, credentials)).pipe(
          Effect.andThen(Effect.fail(Object.assign(error, { [Runtime.errorReported]: false }))),
        );
      }

      const squashed = Cause.squash(cause);
      const line = singleLine(
        isDescribed(squashed) ? defectMessage(squashed) : "unknown failure",
        credentials,
      ).slice(0, maxDefectLineLength);

      return printStderr(`Error: ${line}\ninternal error, please report`).pipe(
        Effect.andThen(Effect.fail(new InternalError())),
      );
    });
