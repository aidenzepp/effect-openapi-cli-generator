import type { PlatformError } from "effect";
import {
  Cause,
  Config,
  Console,
  Context,
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Ref,
  Runtime,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import type { Command, HelpDoc } from "effect/cli";
import { CliError, CliOutput, Flag, GlobalFlag } from "effect/cli";
import { Headers, HttpClient, HttpClientRequest, UrlParams } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import {
  ApiResponseError,
  CredentialMissing,
  OutputError,
  RedirectRefused,
  ResponseStreamError,
  TransportError,
  UsageError,
} from "../domain/errors.ts";
import type { Credential, Placeholder, SecurityRequirement } from "./auth.ts";
import {
  allowCredentialsForBaseUrl,
  attach,
  attachPlaceholders,
  credentialOrigins,
  evaluate,
  placeholder,
  plaintextWarning,
  preview,
  redactedNames,
  Schemes,
} from "./auth.ts";
import {
  baseUrlSetting,
  requestUrl,
  resolve,
  select,
  serverSetting,
  Servers,
  serverVariableSetting,
} from "./base-url.ts";
import type { ServersTable } from "./base-url.ts";
import type { DirectRoute } from "./client.ts";
import {
  redirectLoop,
  retryAfterCapSeconds,
  retryTransform,
  verboseSetting,
  verboseTransform,
  withUserAgent,
  wouldRetry,
} from "./client.ts";
import type { MediaDeclaration } from "./negotiate.ts";
import { accept as acceptValue, dispatchResponse } from "./negotiate.ts";
import type { ScrubEntry } from "./redact.ts";
import {
  dropTrailingFragment,
  longestFormBytes,
  queryWireForm,
  RunCredentials,
  scrub as scrubValues,
  scrubAround,
} from "./redact.ts";
import {
  classify,
  isBodiless,
  mapClientError,
  matchResponse,
  toApiResponseError,
} from "./response.ts";
import { jsonSeqRecords, ndjsonRecords, sseRecords } from "./sequential.ts";

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
 * `--raw` writes a sequential response (SSE, NDJSON/JSONL, JSON-seq) as the bytes received
 * instead of one JSON value per line (design 4.6).
 */
export const Raw = GlobalFlag.Setting("raw")({
  flag: Flag.Boolean("raw").pipe(
    Flag.withDescription("Write a streamed response as the bytes received, not one item per line"),
    Flag.withDefault(false),
  ),
});

/**
 * Default `--max-record-bytes`: 16 MiB per record (planner choice P6; the design names no number).
 */
export const defaultMaxRecordBytes = 16 * 1024 * 1024;

const isPositive = (n: number): boolean => n >= 1;

const recordBytesRangeMessage = (): string => "must be 1 or more";

/**
 * `--max-record-bytes` bounds one record of a sequential response, in UTF-8 bytes.
 */
export const MaxRecordBytes = GlobalFlag.Setting("max-record-bytes")({
  flag: Flag.Int("max-record-bytes").pipe(
    // Flag.filter takes (predicate, onFalse); it is not an array method with a thisArg.
    // oxlint-disable-next-line unicorn/no-array-method-this-argument
    Flag.filter(isPositive, recordBytesRangeMessage),
    Flag.withDescription("Largest record of a streamed response, in bytes"),
    Flag.withDefault(defaultMaxRecordBytes),
  ),
});

const errorFormats = ["text", "json"] as const;

/**
 * How errors render on stderr (design 7.4): `text` lines, or one `json` object.
 */
export type ErrorFormat = (typeof errorFormats)[number];

/**
 * `--error-format text|json`. The flag holds only the operator's choice; `recordRun` applies the
 * fallbacks, because the env name needs the prefix the root supplies.
 */
export const errorFormatSetting = GlobalFlag.Setting("error-format")({
  flag: Flag.Literals("error-format", errorFormats).pipe(
    Flag.withDescription("Print errors as text lines or as one JSON object"),
    Flag.optional,
  ),
});

/**
 * `--dry-run` prints the request `send` would send, with every credential replaced, and sends
 * nothing (design 4.6, D-OUT3).
 */
export const dryRunSetting = GlobalFlag.Setting("dry-run")({
  flag: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the request with credentials replaced instead of sending it"),
    Flag.withDefault(false),
  ),
});

/**
 * `--help` without effect's `-h` alias. A flag value that starts with "-" lexes as short options,
 * so with `-h` registered, `--hostname -bad_.host-` would run help and exit 0 with no request
 * sent; without it the value is a usage error (exit 2). It runs effect's built-in help.
 */
export const HelpFlag: GlobalFlag.Action<boolean> = GlobalFlag.Action({
  flag: Flag.Boolean("help").pipe(
    Flag.withDescription("Show help information"),
    Flag.withDefault(false),
  ),
  run: GlobalFlag.Help.run,
});

/**
 * `--version` without effect's `-v` alias, for the reason `HelpFlag` drops `-h`.
 */
export const VersionFlag: GlobalFlag.Action<boolean> = GlobalFlag.Action({
  flag: Flag.Boolean("version").pipe(
    Flag.withDescription("Show version information"),
    Flag.withDefault(false),
  ),
  run: GlobalFlag.Version.run,
});

/**
 * The generated CLI's built-in global flags (design 4.3), in precedence order: every effect
 * default but `--wizard`, with help and version carrying no short alias. `bin.ts` provides them
 * through `CliConfig.layer`.
 */
export const builtIns = [
  HelpFlag,
  VersionFlag,
  GlobalFlag.Completions,
  GlobalFlag.LogLevel,
] as const;

/**
 * How to pass a flag value that starts with "-": the line of the root help's last section,
 * `FLAG VALUES`.
 */
export const dashValueEscape = 'Write a flag value that starts with "-" as --flag=-value';

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
 * A sequential framer: one record's text per element, without a line terminator.
 */
type Framer = (
  maxRecordBytes: number,
) => <E, R>(
  body: Stream.Stream<Uint8Array, E, R>,
) => Stream.Stream<string, E | ResponseStreamError, R>;

const jsonSeqSuffix = /^[^/;]+\/[^/;]+\+json-seq$/u;

/**
 * The framer the matched response media key selects (design 4.6, 5), or `undefined` for raw
 * bytes: NDJSON for `application/x-ndjson` and `application/jsonl`, JSON-seq for
 * `application/json-seq` and any `+json-seq` type, SSE for `text/event-stream`.
 */
const framerFor = (mediaType: string | undefined): Framer | undefined => {
  const key = mediaType?.trim().toLowerCase();

  if (key === "application/x-ndjson" || key === "application/jsonl") {
    return ndjsonRecords;
  }

  if (key === "application/json-seq" || (key !== undefined && jsonSeqSuffix.test(key))) {
    return jsonSeqRecords;
  }

  return key === "text/event-stream" ? sseRecords : undefined;
};

// A root that registers no `--raw` or `--max-record-bytes` gets their defaults.
const rawRequested = Effect.map(
  Effect.serviceOption(Raw),
  Option.getOrElse(() => false),
);

const recordBound = Effect.map(
  Effect.serviceOption(MaxRecordBytes),
  Option.getOrElse(() => defaultMaxRecordBytes),
);

/**
 * Each record as one LF-terminated line, its own chunk, so the sink writes it as it arrives.
 */
const asLines = <E, R>(records: Stream.Stream<string, E, R>): Stream.Stream<Uint8Array, E, R> =>
  records.pipe(
    Stream.map((record) => `${record}\n`),
    Stream.encodeText,
  );

/**
 * The destination the output settings name: with `--output <path>` a temp sibling renamed into
 * place (an existing path is refused unless `--force`), else stdout (`--output -` is stdout).
 * `binary` refuses a terminal before the body is read unless `--output -` is given. EPIPE on
 * stdout stops the stream and succeeds.
 */
const writeStream = <E, R>(
  bytes: Stream.Stream<Uint8Array, E, R>,
  binary: boolean,
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
      return yield* toFile(bytes, target, force);
    }

    if (target === undefined && binary) {
      const stdio = yield* Stdio.Stdio;

      if (yield* stdio.stdoutIsTerminal) {
        return yield* new UsageError({
          flag: "output",
          message:
            "refusing to write binary output to a terminal; use --output <path> or --output -",
        });
      }
    }

    return yield* toStdout(bytes);
  });

/**
 * Write a response body as received to its destination: stdout, or with `--output <path>` a temp
 * sibling renamed into place (an existing path is refused unless `--force`). `--output -` is
 * stdout. Binary media to a terminal is refused before the body is read unless `--output -` is
 * given; the sequential types (`framerFor`) are text, so their raw bytes (`--raw`) are not. EPIPE
 * on stdout stops the stream and succeeds.
 */
export const writeBody = <E, R>(response: ResponseBody<E, R>) =>
  writeStream(
    response.bytes,
    !isText(response.mediaType) && framerFor(response.mediaType) === undefined,
  );

/**
 * Write a 2xx response body by its matched media key (design 4.6): a sequential type
 * (`framerFor`) one compact JSON line per record, each written as it arrives and bounded by
 * `--max-record-bytes`; with `--raw`, or for any other type, the bytes received (`writeBody`).
 * Sequential lines are text, so the binary terminal guard does not apply to them.
 */
export const writeResponse = <E, R>(response: ResponseBody<E, R>) =>
  Effect.gen(function* dispatchOutput() {
    const framer = (yield* rawRequested) ? undefined : framerFor(response.mediaType);

    return framer === undefined
      ? yield* writeBody(response)
      : yield* writeStream(asLines(framer(yield* recordBound)(response.bytes)), false);
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

/**
 * Credential values scrubbed, then the text sanitized, then scrubbed again (design 7.4, audit
 * S2), so neither a credential holding a removed character nor one split by them survives.
 */
const scrubbedAndSanitized = (text: string, credentials: readonly ScrubEntry[]): string =>
  scrubAround(text, credentials, sanitize);

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
 * The excerpt of an error body: credential values scrubbed, sanitized and scrubbed again, then
 * bounded to `maxBytes` of UTF-8. The bound comes last because scrubbing can lengthen text and
 * `ApiResponseError` refuses an excerpt over 64 KiB (audit F6).
 */
export const boundedExcerpt = (
  text: string,
  maxBytes: number,
  credentials: readonly ScrubEntry[],
): string => truncateUtf8(scrubbedAndSanitized(text, credentials), maxBytes);

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
 * `--max-error-bytes` (0 reads nothing). It reads that many bytes plus the longest credential
 * form, so a credential cut by the limit is still found and scrubbed. When the read stops at that
 * budget, an incomplete character and any trailing partial credential are dropped first; then the
 * text is scrubbed, sanitized, scrubbed again and bounded.
 */
export const readExcerpt = <E, R>(
  body: Stream.Stream<Uint8Array, E, R>,
  credentials: readonly ScrubEntry[],
): Effect.Effect<string, E, R | GlobalFlag.Setting.Identifier<"max-error-bytes">> =>
  Effect.gen(function* step5() {
    const maxBytes = yield* MaxErrorBytes;

    if (maxBytes === 0) {
      return "";
    }

    const budget = maxBytes + longestFormBytes(credentials);
    const read = concatBytes(yield* Stream.runCollect(takeBytes(body, budget)));
    const text =
      read.length < budget
        ? new TextDecoder().decode(read)
        : dropTrailingFragment(
            new TextDecoder().decode(read, { stream: true }),
            credentials,
            sanitize,
          );

    return boundedExcerpt(text, maxBytes, credentials);
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

const singleLine = (text: string, credentials: readonly ScrubEntry[]): string =>
  oneLine(scrubbedAndSanitized(text, credentials));

/**
 * The sentence a message carries when the failed request is one D-AD7 would retry (SM-16):
 * running it again is safe. After a request D-AD7 would not retry, no message carries it.
 */
export const retryHint = "The request is idempotent, so running the command again is safe.";

/**
 * The sentence the text form adds when retrying stopped because the server's `Retry-After`
 * exceeded the `--timeout` cap (design 7.4, m3 P14).
 */
const cappedSentence = (seconds: number): string =>
  `Retrying stopped: the server's Retry-After of ${seconds} second${seconds === 1 ? "" : "s"} ` +
  "exceeds the --timeout cap.";

/**
 * The failures of an exchange with the server, the errors a retry hint may follow (SM-16).
 */
const isExchangeFailure = (error: KnownError): boolean =>
  error instanceof ApiResponseError ||
  error instanceof TransportError ||
  error instanceof ResponseStreamError;

/**
 * The text printed on stderr for a known error (design 7.4): `Error: <message>`; for an
 * `ApiResponseError` whose retrying stopped at the cap, the sentence naming the server's
 * `Retry-After`; `retryHint` when `hint` is set and the error is an exchange failure; for an
 * `ApiResponseError` then `Request ID: <id>` when set, then the excerpt (omitted when empty).
 * Every part is scrubbed and sanitized again here, because the error may come from anywhere.
 */
export const renderError = (
  error: KnownError,
  credentials: readonly ScrubEntry[],
  hint = false,
): string => {
  const lines = [`Error: ${singleLine(error[CliError.userMessage], credentials)}`];

  if (error instanceof ApiResponseError && error.retryAfterSeconds !== undefined) {
    lines.push(cappedSentence(error.retryAfterSeconds));
  }

  if (hint && isExchangeFailure(error)) {
    lines.push(retryHint);
  }

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

const invalidValueMessage = (error: CliError.InvalidValue): string => {
  const subject = error.kind === "flag" ? `flag --${error.option}` : `argument <${error.option}>`;

  return `Invalid value for ${subject}. Run with --help for usage.`;
};

const valueFreeMessage = (error: CliError.CliError): string =>
  error._tag === "InvalidValue" ? invalidValueMessage(error) : base.formatCliError(error);

const errorsText = (messages: readonly string[]): string =>
  messages.length === 0
    ? ""
    : `\nERROR${messages.length === 1 ? "" : "S"}\n${messages
        .map((message) => `  ${message}`)
        .join("\n")}`;

/**
 * Renders a `CliError.InvalidValue` by `kind` and `option` only: its `value` is the raw flag text
 * and its `expected` can quote it (design 7.5, SM-3). Everything else renders as the default
 * formatter does, without colors.
 */
export const valueFreeFormatter: CliOutput.Formatter = {
  formatCliError: valueFreeMessage,
  formatError: (error) => errorsText([valueFreeMessage(error)]),
  formatErrors: (errors) => errorsText(errors.map(valueFreeMessage)),
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

const rawMessage = (error: CliError.CliError): string =>
  error._tag === "InvalidValue" ? invalidValueMessage(error) : error.message;

/**
 * The text printed on stderr for a `CliError`, or `undefined` when there is nothing to print:
 * help with no parse errors, which `Command.run` has already presented. It has the layout of
 * `valueFreeFormatter`, so an `InvalidValue` shows its kind and option, never its value; other
 * messages stay raw, because the default formatter escapes C0 characters into text that no longer
 * matches a credential holding them (audit S2). The caller scrubs and sanitizes the result.
 */
const renderCliError = (error: CliError.CliError): string | undefined => {
  const errors = error._tag === "ShowHelp" ? error.errors : [error];

  return errors.length === 0 ? undefined : errorsText(errors.map(rawMessage));
};

/**
 * Print already scrubbed text, then fail again with `error` marked reported, so its exit code
 * stands and nothing renders it a second time.
 */
const reportOnce = <E extends object>(
  text: string,
  error: E,
): Effect.Effect<never, E, Stdio.Stdio> =>
  printStderr(text).pipe(
    Effect.andThen(Effect.fail(Object.assign(error, { [Runtime.errorReported]: false }))),
  );

// `RunCredentials` lives in `redact.ts`, beside the entries it holds, so `input.ts` records a
// secret-file value without an import cycle (this module imports `auth.ts`, which imports
// `input.ts`).
export { RunCredentials, runCredentialsLayer } from "./redact.ts";

/**
 * What the run recorded for its error rendering (design 7.4 revision 31b): the effective format,
 * once `recordRun` ran, and the retry-hint input, once `send` reached the client.
 */
export interface RunRecordState {
  readonly format?: ErrorFormat | undefined;
  readonly sent?: { readonly idempotencyKey: boolean; readonly method: string } | undefined;
}

/**
 * The run-scoped error-rendering record, provided outside the final catch like `RunCredentials`.
 * Every reader and writer takes it with `Effect.serviceOption`; without it the documented default
 * applies: format `text` (or, in `finalCatch`, `<PREFIX>_ERROR_FORMAT`) and no retry hint.
 */
export class RunRecord extends Context.Service<RunRecord, Ref.Ref<RunRecordState>>()(
  "openapi-cli/runtime/RunRecord",
) {}

/**
 * A fresh record per run: nothing recorded yet.
 */
export const runRecordLayer: Layer.Layer<RunRecord> = Layer.effect(RunRecord)(
  Ref.make<RunRecordState>({}),
);

const errorFormatName = (envPrefix: string): string => `${envPrefix}_ERROR_FORMAT`;

const isErrorFormat = Schema.is(Schema.Literals(errorFormats));

/**
 * `<envPrefix>_ERROR_FORMAT`, read by that explicit name (memo 6f21e261), then `text`. A value
 * other than `text` or `json` is a `UsageError` naming the variable, never the value.
 */
const envErrorFormat = Effect.fnUntraced(function* readErrorFormat(envPrefix: string) {
  const name = errorFormatName(envPrefix);
  const invalid = new UsageError({ flag: name, message: `${name} must be text or json` });
  const env = yield* Config.option(Config.String(name)).pipe(Effect.mapError(() => invalid));
  if (Option.isNone(env)) {
    return "text" as const;
  }

  return isErrorFormat(env.value) ? env.value : yield* invalid;
});

// The operator's `--error-format`, if the root registers the setting and the flag was given.
const flagErrorFormat = Effect.map(Effect.serviceOption(errorFormatSetting), Option.flatten);

/**
 * Record the run's effective error format (design 7.4 revision 31b): `--error-format`, then
 * `<envPrefix>_ERROR_FORMAT`, then `text`. A generated command runs it after argument parsing and
 * before its handler's first step that can fail, so an error raised before `send` renders in that
 * format. Without `RunRecord` it does nothing.
 */
export const recordRun = Effect.fnUntraced(function* recordRunFormat(envPrefix: string) {
  const record = yield* Effect.serviceOption(RunRecord);
  if (Option.isNone(record)) {
    return;
  }

  const flag = yield* flagErrorFormat;
  const format = Option.isSome(flag) ? flag.value : yield* envErrorFormat(envPrefix);
  yield* Ref.update(record.value, (state) => ({ ...state, format }));
});

/**
 * The retry-hint input `send` adds to `RunRecord` before the request reaches the client: the
 * method and whether an `Idempotency-Key` header was sent, read before the attach step, as
 * `retryTransform` reads it.
 */
const recordSent = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<void> =>
  Effect.flatMap(
    Effect.serviceOption(RunRecord),
    Option.match({
      onNone: () => Effect.void,
      onSome: (record) =>
        Ref.update(record, (state) => ({
          ...state,
          sent: {
            idempotencyKey: Headers.has(request.headers, "idempotency-key"),
            method: request.method,
          },
        })),
    }),
  );

/**
 * How the final catch renders this run's error: the format and whether a retry hint applies.
 */
interface Rendering {
  readonly format: ErrorFormat;
  readonly hint: boolean;
}

/**
 * The format a parse-time error renders in, when nothing was recorded: `json` when
 * `<envPrefix>_ERROR_FORMAT` is `json`, text otherwise (design 7.4).
 */
const parseTimeFormat = (envPrefix: string): Effect.Effect<ErrorFormat> =>
  Config.option(Config.String(errorFormatName(envPrefix))).pipe(
    Effect.map((env): ErrorFormat => (Option.getOrUndefined(env) === "json" ? "json" : "text")),
    Effect.orElseSucceed((): ErrorFormat => "text"),
  );

/**
 * The run's rendering from `RunRecord`: the recorded format, else the parse-time format when the
 * caller named the env prefix, else `text`; the hint when `send` recorded a method D-AD7 would
 * retry (`wouldRetry`).
 */
const runRendering = Effect.fnUntraced(function* readRendering(envPrefix: string | undefined) {
  const record = yield* Effect.serviceOption(RunRecord);
  const state: RunRecordState = Option.isSome(record) ? yield* Ref.get(record.value) : {};
  const fallback: ErrorFormat =
    envPrefix === undefined ? "text" : yield* parseTimeFormat(envPrefix);
  const rendering: Rendering = {
    format: state.format ?? fallback,
    hint: state.sent !== undefined && wouldRetry(state.sent.method, state.sent.idempotencyKey),
  };

  return rendering;
});

const recordedCredentials: Effect.Effect<readonly ScrubEntry[], never, RunCredentials> =
  Effect.flatMap(Effect.service(RunCredentials), Ref.get);

/**
 * The fields of the `--error-format json` object (design 7.4). Declared in alphabetical order,
 * which `JSON.stringify` keeps; an `undefined` field is left out.
 */
interface ErrorFields {
  readonly body?: string | undefined;
  readonly kind: string;
  readonly matched?: string | undefined;
  readonly message: string;
  readonly operation?: string | undefined;
  readonly requestId?: string | undefined;
  readonly retryAfter?: number | undefined;
  readonly status?: number | undefined;
}

/**
 * One line holding `{"error":{...}}`, keys alphabetical. Every string arrives scrubbed and
 * sanitized; the JSON escaping covers the characters sanitizing keeps (design 7.4, C5).
 */
const jsonLine = (fields: ErrorFields): string =>
  JSON.stringify({
    error: {
      body: fields.body,
      kind: fields.kind,
      matched: fields.matched,
      message: fields.message,
      operation: fields.operation,
      requestId: fields.requestId,
      retryAfter: fields.retryAfter,
      status: fields.status,
    },
  });

const withHint = (message: string, hint: boolean): string =>
  hint ? `${message} ${retryHint}` : message;

/**
 * The JSON object for a known error: `operation` only for the classes that carry one, and for an
 * `ApiResponseError` its status, matched key, excerpt (when not empty), request id and capped
 * `Retry-After` (design 7.4, m3 P14, P15).
 */
const renderErrorJson = (
  error: KnownError,
  credentials: readonly ScrubEntry[],
  hint: boolean,
): string => {
  const api = error instanceof ApiResponseError ? error : undefined;
  const excerpt =
    api === undefined ? "" : boundedExcerpt(api.bodyExcerpt, maxErrorBytesCeiling, credentials);
  const operation =
    error instanceof ApiResponseError || error instanceof CredentialMissing
      ? singleLine(error.operation, credentials)
      : undefined;

  return jsonLine({
    body: excerpt === "" ? undefined : excerpt,
    kind: error._tag,
    matched: api?.matched,
    message: withHint(
      singleLine(error[CliError.userMessage], credentials),
      hint && isExchangeFailure(error),
    ),
    operation,
    requestId: api?.requestId === undefined ? undefined : singleLine(api.requestId, credentials),
    retryAfter: api?.retryAfterSeconds,
    status: api?.status,
  });
};

/**
 * The JSON object for a parse-time `CliError`, value-free as `renderCliError` is, or `undefined`
 * when there is nothing to print. `kind` is the one parse error's tag, or the failure's own tag
 * when help carries several.
 */
const renderCliErrorJson = (
  error: CliError.CliError,
  credentials: readonly ScrubEntry[],
): string | undefined => {
  const errors = error._tag === "ShowHelp" ? error.errors : [error];
  const [only] = errors;

  return only === undefined
    ? undefined
    : jsonLine({
        kind: errors.length === 1 ? only._tag : error._tag,
        message: errors.map((each) => singleLine(rawMessage(each), credentials)).join("; "),
      });
};

const renderCause = <E>(
  cause: Cause.Cause<E>,
  credentials: readonly ScrubEntry[],
  rendering: Rendering,
): Effect.Effect<never, E | InternalError, Stdio.Stdio> => {
  const failure = Cause.findErrorOption(cause);
  const json = rendering.format === "json";

  if (Cause.hasInterruptsOnly(cause)) {
    return Effect.failCause(cause);
  }

  if (Option.isSome(failure) && CliError.isCliError(failure.value)) {
    const raw = renderCliError(failure.value);
    const text = raw === undefined ? undefined : scrubbedAndSanitized(raw, credentials);
    const rendered = json ? renderCliErrorJson(failure.value, credentials) : text;

    return rendered === undefined ? Effect.failCause(cause) : reportOnce(rendered, failure.value);
  }

  if (Option.isSome(failure) && isKnownError(failure.value)) {
    const error = failure.value;
    const rendered = json
      ? renderErrorJson(error, credentials, rendering.hint)
      : renderError(error, credentials, rendering.hint);

    return reportOnce(rendered, error);
  }

  const squashed = Cause.squash(cause);
  const line = singleLine(
    isDescribed(squashed) ? defectMessage(squashed) : "unknown failure",
    credentials,
  ).slice(0, maxDefectLineLength);
  const rendered = json
    ? jsonLine({ kind: "Internal", message: `${line}; internal error, please report` })
    : `Error: ${line}\ninternal error, please report`;

  return printStderr(rendered).pipe(Effect.andThen(Effect.fail(new InternalError())));
};

/**
 * The final catch around `Command.run` (design 7.4), the only error renderer: the CLI runs
 * `Command.run` with `renderErrors: false`. A known error is rendered once and fails again as
 * itself, so its exit code stands; a `CliError` parse error is rendered once, value-free; help and
 * interruption pass through; anything else prints one scrubbed line and "internal error, please
 * report" and fails with `InternalError`, exit 70. Exit codes do not depend on the format.
 * `credentials` are the values to scrub that the caller holds; `RunCredentials`, provided outside
 * the catch, adds the credentials the command handler evaluated and its secret-file values.
 *
 * The format is the one `recordRun` put in `RunRecord`; when nothing was recorded (a parse-time
 * error) and `options.envPrefix` is given, `json` when `<envPrefix>_ERROR_FORMAT` is `json`; else
 * text. `json` prints one `{"error":{...}}` object per error. An exchange failure carries
 * `retryHint` when the method `send` recorded is one D-AD7 would retry. Without `RunRecord`
 * nothing is recorded and no hint applies.
 */
export const finalCatch =
  (credentials: readonly ScrubEntry[], options?: { readonly envPrefix: string }) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | InternalError, R | RunCredentials | Stdio.Stdio> =>
    Effect.catchCause(effect, (cause) =>
      Effect.gen(function* renderFailure() {
        const recorded = yield* recordedCredentials;
        const rendering = yield* runRendering(options?.envPrefix);

        return yield* renderCause(cause, [...credentials, ...recorded], rendering);
      }),
    );

/**
 * Where help, version and invalid-invocation output go. Requested help and the
 * version are the answer, so they go to stdout; implicit help (a group run without a
 * subcommand) and an invalid invocation explain a run that did nothing, so they go to stderr.
 * The text comes from the `CliOutput.Formatter` in context and is sanitized before it is printed.
 */
export const presenter: CliOutput.Presenter = {
  present: (event) =>
    Effect.gen(function* present() {
      const format = yield* CliOutput.Formatter;

      if (event._tag === "Version") {
        yield* Console.log(sanitize(format.formatVersion(event.name, event.version)));

        return;
      }

      const help = sanitize(format.formatHelpDoc(event.helpDoc));

      if (event._tag === "InvalidInvocation") {
        yield* Console.error(help);
        yield* Console.error(sanitize(format.formatErrors(event.errors)));

        return;
      }

      yield* event.reason === "Requested" ? Console.log(help) : Console.error(help);
    }),
};

/**
 * Exit code of an invocation that does not parse.
 */
const invalidInvocationExitCode = 2;

const isShowHelp = (error: unknown): error is CliError.ShowHelp =>
  CliError.isCliError(error) && error._tag === "ShowHelp";

/**
 * Maps `CliError.ShowHelp` to the entry's exit status. Help with parse errors fails again as
 * itself with exit 2, so `finalCatch` renders its errors once; help without errors (already
 * presented) succeeds, exit 0. Other failures pass through. Apply it inside `finalCatch`.
 */
export const exitForHelp = <E, R>(effect: Effect.Effect<void, E, R>): Effect.Effect<void, E, R> =>
  Effect.catchIf(
    effect,
    (error): error is E & CliError.ShowHelp => isShowHelp(error),
    (help) =>
      help.errors.length === 0
        ? Effect.void
        : Effect.fail(Object.assign(help, { [Runtime.errorExitCode]: invalidInvocationExitCode })),
  );

/**
 * The notes a generated command adds to its help (design 4.6): a note per argument and per flag,
 * keyed by its visible name, and the ordered sections printed after FLAGS.
 */
export interface HelpNotes {
  readonly arguments: { readonly [name: string]: string };
  readonly flags: { readonly [name: string]: string };
  readonly sections: readonly (readonly [label: string, text: string])[];
}

/**
 * The `Command.annotate` key under which a generated command carries its help notes.
 */
export const Help = Context.Service<HelpNotes>("openapi-cli/runtime/output/Help");

const helpBase = CliOutput.defaultFormatter({ colors: false, globalFlags: "summary" });

interface HelpRow {
  readonly left: string;
  readonly description: string;
  readonly note: string | undefined;
}

const indent = 2;

const columnGap = 4;

// effect's ARGUMENTS table caps its first column here; its FLAGS table does not.
const argumentColumnCap = 25;

const cellWidth = CliOutput.displayWidth;

const padTo = (text: string, width: number): string =>
  text + " ".repeat(Math.max(0, width - cellWidth(text)));

const noteFor = (notes: { readonly [name: string]: string }, name: string): string | undefined =>
  Object.hasOwn(notes, name) ? notes[name] : undefined;

/**
 * A table of rows, laid out as effect's `renderTable` lays out two columns (first column as wide
 * as its widest cell plus 4, capped at `cap`, never closer than one space to its description),
 * plus a third column of parenthesized notes. The notes column starts at the same character in
 * every row that has a note: the widest description end among those rows plus 4, as
 * `expected/help.txt` measures it (the long `--body` descriptions, which carry no note, do not
 * widen it). A row without a note has no trailing spaces.
 */
const renderRows = (rows: readonly HelpRow[], cap = Number.POSITIVE_INFINITY): string => {
  const column = Math.min(Math.max(...rows.map((row) => cellWidth(row.left))) + columnGap, cap);
  const leftWidth = (row: HelpRow): number => Math.max(column, cellWidth(row.left) + 1);
  const noteColumn =
    Math.max(
      0,
      ...rows
        .filter((row) => row.note !== undefined)
        .map((row) => indent + leftWidth(row) + cellWidth(row.description)),
    ) + columnGap;

  return rows
    .map((row) => {
      const text =
        row.note === undefined
          ? row.description
          : `${padTo(row.description, noteColumn - indent - leftWidth(row))}(${row.note})`;

      return `${" ".repeat(indent)}${padTo(row.left, leftWidth(row))}${text}`.trimEnd();
    })
    .join("\n");
};

const argumentRow = (arg: HelpDoc.ArgDoc, notes: HelpNotes): HelpRow => ({
  description: Option.getOrElse(arg.description, () => "") + (arg.required ? "" : " (optional)"),
  left: `${arg.name}${arg.variadic ? "..." : ""} ${arg.type}`,
  note: noteFor(notes.arguments, arg.name),
});

const flagRow = (flag: HelpDoc.FlagDoc, notes: HelpNotes): HelpRow => ({
  description: Option.getOrElse(flag.description, () => ""),
  left: `${[`--${flag.name}`, ...flag.aliases].join(", ")}${flag.type === "boolean" ? "" : ` ${flag.type}`}`,
  note: noteFor(notes.flags, flag.name),
});

const declaresGlobalFlags = (doc: HelpDoc.HelpDoc): boolean =>
  doc.commandPath === undefined ||
  (doc.globalFlagsScope ?? doc.commandPath.slice(0, 1)).length === doc.commandPath.length;

/**
 * The notes-bearing layout applies to a leaf command that points at the global flags rather than
 * declaring them. Anything else prints as the default formatter prints it, so no part of the
 * document (subcommands, examples, the global flag table) is dropped.
 */
const isNotesLayout = (doc: HelpDoc.HelpDoc): boolean =>
  (doc.subcommands ?? []).length === 0 &&
  (doc.examples ?? []).length === 0 &&
  !declaresGlobalFlags(doc);

const renderNotedHelp = (doc: HelpDoc.HelpDoc, notes: HelpNotes): string => {
  const blocks: string[][] = [];
  const table = (title: string, rows: readonly HelpRow[], cap?: number): void => {
    if (rows.length > 0) {
      blocks.push([title, renderRows(rows, cap)]);
    }
  };

  if (doc.description !== "") {
    blocks.push(["DESCRIPTION", `  ${doc.description}`]);
  }

  blocks.push(["USAGE", `  ${doc.usage}`]);
  table(
    "ARGUMENTS",
    (doc.args ?? []).map((arg) => argumentRow(arg, notes)),
    argumentColumnCap,
  );
  table(
    "FLAGS",
    doc.flags.map((flag) => flagRow(flag, notes)),
  );
  table(
    "INHERITED FLAGS",
    (doc.inheritedFlags ?? []).map((flag) => flagRow(flag, notes)),
  );

  const labelWidth = Math.max(0, ...notes.sections.map(([label]) => cellWidth(label))) + 1;

  if (notes.sections.length > 0) {
    blocks.push(notes.sections.map(([label, text]) => `${padTo(label, labelWidth)}${text}`));
  }

  if ((doc.globalFlags ?? []).length > 0) {
    const scope = doc.globalFlagsScope ?? doc.commandPath?.slice(0, 1) ?? [];

    blocks.push([`Run '${scope.join(" ")} --help' for global flags`]);
  }

  return blocks.map((lines) => lines.join("\n")).join("\n\n");
};

const findCommand = (
  root: Command.Command.Any,
  path: readonly string[],
): Command.Command.Any | undefined => {
  let node: Command.Command.Any | undefined = path[0] === root.name ? root : undefined;

  for (const name of path.slice(1)) {
    node = node?.subcommands
      .flatMap((group) => group.commands)
      .find((child) => child.name === name);
  }

  return node;
};

const helpNotesOf = (
  root: Command.Command.Any,
  path: readonly string[] | undefined,
): Option.Option<HelpNotes> =>
  Option.flatMap(Option.fromNullishOr(path), (known) =>
    Option.flatMap(Option.fromNullishOr(findCommand(root, known)), (command) =>
      Context.getOption(command.annotations, Help),
    ),
  );

const isRootHelp = (doc: HelpDoc.HelpDoc): boolean => (doc.commandPath ?? []).length <= 1;

/**
 * The help formatter for a command tree (design 4.6). A command that carries `Output.Help` prints
 * its DESCRIPTION, USAGE, ARGUMENTS and FLAGS with a third column of notes, then its sections,
 * then the pointer to the global flags. Any other command prints as effect's default formatter
 * prints it, without colors and with global flags as a pointer. Root help ends with a
 * `FLAG VALUES` section holding `dashValueEscape`, apart from SUBCOMMANDS so nothing reading that
 * list sees it. Errors render through `valueFreeFormatter`.
 */
export const formatter = (root: Command.Command.Any): CliOutput.Formatter => ({
  formatCliError: valueFreeFormatter.formatCliError,
  formatError: valueFreeFormatter.formatError,
  formatErrors: valueFreeFormatter.formatErrors,
  formatHelpDoc: (doc) => {
    const text = Option.match(helpNotesOf(root, doc.commandPath), {
      onNone: () => helpBase.formatHelpDoc(doc),
      onSome: (notes) =>
        isNotesLayout(doc) ? renderNotedHelp(doc, notes) : helpBase.formatHelpDoc(doc),
    });

    return isRootHelp(doc) ? `${text.trimEnd()}\n\nFLAG VALUES\n  ${dashValueEscape}` : text;
  },
  formatVersion: valueFreeFormatter.formatVersion,
});

/**
 * What `send` reads of an operation's emitted meta (`api/<group>.ts`): its method and path
 * template (the display name when it has no `operationId`), its declared media, its security
 * requirement, when the operation declares one, the request-id header chosen at generation, and,
 * when the operation or its path item overrides the root servers, its effective servers table.
 * `deprecated` is printed only for an operation the document marks deprecated; the meta object is
 * not `as const`, so it arrives widened to `boolean`, and only `true` writes the notice.
 * `requiredHeaders` lists, by response key, the required headers a case declares; it is present
 * only when some case declares one.
 */
export interface OperationMeta {
  readonly deprecated?: boolean | undefined;
  readonly media: MediaDeclaration;
  readonly method: string;
  readonly operationId?: string | undefined;
  readonly pathTemplate: string;
  readonly requestIdHeader?: string | undefined;
  readonly requiredHeaders?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly security: SecurityRequirement;
  readonly servers?: ServersTable | undefined;
}

/**
 * The client policy inputs `bin.ts` provides: the method allowlist (design 6.7), the request
 * init a loopback hop executes with (design 6.5 Loopback hosts), and the `User-Agent` name and
 * version (design 6.2).
 */
export class ClientPolicy extends Context.Service<
  ClientPolicy,
  {
    readonly allowed: ReadonlySet<string>;
    readonly binName: string;
    readonly direct: DirectRoute;
    readonly version: string;
  }
>()("openapi-cli/runtime/ClientPolicy") {}

/**
 * The once-per-run warning lines this run has printed (design 13.1 R3): `send` prints such a line
 * only when it is not here yet, then records it. Run-scoped, like `RunCredentials`; the emitted
 * `bin.ts` provides `runWarningsLayer`. `send` reads it with `Effect.serviceOption`, and without it
 * the documented default applies: nothing printed yet, so each `send` prints its warning (audit
 * ad9f808b F2).
 */
export class RunWarnings extends Context.Service<RunWarnings, Ref.Ref<ReadonlySet<string>>>()(
  "openapi-cli/runtime/RunWarnings",
) {}

/**
 * A fresh record per run: no warning printed yet.
 */
export const runWarningsLayer: Layer.Layer<RunWarnings> = Layer.effect(RunWarnings)(
  Ref.make<ReadonlySet<string>>(new Set()),
);

/**
 * The errors `send` fails with.
 */
export type SendError =
  | ApiResponseError
  | CredentialMissing
  | OutputError
  | RedirectRefused
  | ResponseStreamError
  | TransportError
  | UsageError;

const displayName = (meta: OperationMeta): string =>
  meta.operationId ?? `${meta.method} ${meta.pathTemplate}`;

/**
 * The builder's URL is its path and serialized query; `requestUrl` takes them apart.
 */
const splitTarget = (target: string): readonly [path: string, query: string] => {
  const at = target.indexOf("?");

  return at === -1 ? [target, ""] : [target.slice(0, at), target.slice(at + 1)];
};

/**
 * The one stderr notice of design 6.4 (F:R1): a configured credential is withheld from an unbound
 * operator-chosen base URL. It names schemes and the flag, never a value.
 */
const withheldNotice = (credentials: readonly Credential[]): string => {
  const schemes = [...new Set(credentials.map((credential) => credential.scheme))].join(", ");

  return sanitize(
    `Notice: not sending credentials (${schemes}) to an unbound base URL; ` +
      "--allow-credentials-for-base-url sends them",
  );
};

/**
 * The built-in stream idle timeout in seconds (design D-AD7), used when neither
 * `<PREFIX>_IDLE_TIMEOUT` nor an author default sets one.
 */
export const defaultIdleTimeoutSeconds = 300;

const wholeSeconds = /^\d+$/u;

/**
 * The effective stream idle timeout in seconds: `<envPrefix>_IDLE_TIMEOUT` read by that explicit
 * name (as `base-url.ts` reads `<PREFIX>_BASE_URL`), then `defaultIdleTimeoutSeconds`. The author
 * default reaches the env read through the `ConfigProvider` `main.ts` provides (design D-AD7);
 * there is no flag. The value is whole seconds, 1 or more; anything else is a `UsageError` naming
 * the variable, never the value. An unprefixed `IDLE_TIMEOUT` is never read.
 */
export const effectiveIdleTimeoutSeconds = (envPrefix: string): Effect.Effect<number, UsageError> =>
  Effect.gen(function* resolveIdleTimeout() {
    const name = `${envPrefix}_IDLE_TIMEOUT`;
    const invalid = new UsageError({
      flag: name,
      message: `${name} must be a whole number of seconds, 1 or more`,
    });
    const env = yield* Config.option(Config.String(name)).pipe(Effect.mapError(() => invalid));
    if (Option.isNone(env)) {
      return defaultIdleTimeoutSeconds;
    }

    const seconds = Number(env.value);

    return wholeSeconds.test(env.value) && Number.isSafeInteger(seconds) && seconds >= 1
      ? seconds
      : yield* invalid;
  });

/**
 * A response body read that fails part-way is a truncated body (exit 5). A read that waits longer
 * than `idleSeconds` for its next chunk fails `idleTimeout` (exit 5; design 9 I5): the only bound
 * on a raw stream. `Stream.timeoutOrElse` with a failure, because `Stream.timeout` ends a stalled
 * stream successfully. A bodiless response (`isBodiless`) is the empty body and is never read.
 */
const bodyOf = (
  response: HttpClientResponse.HttpClientResponse,
  idleSeconds: number,
): Stream.Stream<Uint8Array, ResponseStreamError> =>
  isBodiless(response)
    ? Stream.empty
    : response.stream.pipe(
        Stream.mapError(() => new ResponseStreamError({ reason: "truncated" })),
        Stream.timeoutOrElse({
          duration: Duration.seconds(idleSeconds),
          orElse: () => Stream.fail(new ResponseStreamError({ reason: "idleTimeout" })),
        }),
      );

const declaredMedia = (meta: OperationMeta, status: number): readonly string[] => {
  const key = matchResponse(meta.media.responses, status);

  return Object.hasOwn(meta.media.responses, key) ? (meta.media.responses[key] ?? []) : [];
};

/**
 * One stderr warning per required header the matched case declares and the response lacks, in
 * document order (HDR-03). Names are matched case-insensitively and only the name is printed,
 * never a value; an undeclared status matches no case and checks nothing.
 */
const warnMissingHeaders = (
  meta: OperationMeta,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<void, never, Stdio.Stdio> => {
  const key = matchResponse(meta.media.responses, response.status);
  const required =
    meta.requiredHeaders !== undefined && Object.hasOwn(meta.requiredHeaders, key)
      ? (meta.requiredHeaders[key] ?? [])
      : [];

  return Effect.forEach(
    required.filter((name) => Option.isNone(Headers.get(response.headers, name))),
    (name) => printStderr(`Warning: the response is missing the required header ${name}`),
    { discard: true },
  );
};

/**
 * Print `line` on stderr unless this run printed it already (`RunWarnings`).
 */
const warnOncePerRun = (line: Option.Option<string>): Effect.Effect<void, never, Stdio.Stdio> =>
  Effect.gen(function* warnOnce() {
    if (Option.isNone(line)) {
      return;
    }

    const record = yield* Effect.serviceOption(RunWarnings);
    const first = Option.isNone(record)
      ? true
      : yield* Ref.modify(record.value, (printed) =>
          printed.has(line.value) ? [false, printed] : [true, new Set([...printed, line.value])],
        );
    if (first) {
      yield* printStderr(sanitize(line.value));
    }
  });

/**
 * Under `--verbose`, one stderr notice that a 2xx response's media type matches no declared key
 * of its status, so its bytes are written as received (design 6.6). The type is the response's
 * `Content-Type` through `scrub`, or `none` when it has none.
 */
const undeclaredMediaNotice = (
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
  scrub: (text: string) => string,
): Effect.Effect<void, never, Stdio.Stdio> =>
  Effect.gen(function* noticeUndeclaredMedia() {
    if (!Option.getOrElse(yield* Effect.serviceOption(verboseSetting), () => false)) {
      return;
    }

    const type = Option.match(Headers.get(response.headers, "content-type"), {
      onNone: () => "none",
      onSome: scrub,
    });
    yield* printStderr(
      oneLine(
        `Notice: ${operation} returned ${response.status} with the undeclared media type ` +
          `${type}; writing its bytes as received`,
      ),
    );
  });

const encoder = new TextEncoder();

const crlf = encoder.encode("\r\n");

const headEnd = encoder.encode("\r\n\r\n");

// The longest part head the dry-run summary holds while it looks for the head's end. The writer's
// heads are a few lines; a longer one ends the summary (`MultipartSummary`), so memory stays bound.
const maxPartHeadBytes = 65_536;

// Whether `needle` occurs in `haystack` at `at`.
const matchesAt = (haystack: Uint8Array, needle: Uint8Array, at: number): boolean =>
  needle.every((byte, offset) => haystack[at + offset] === byte);

// The first index of `needle` in `haystack`, or -1.
const indexOfBytes = (haystack: Uint8Array, needle: Uint8Array): number => {
  for (let at = 0; at + needle.length <= haystack.length; at += 1) {
    if (matchesAt(haystack, needle, at)) {
      return at;
    }
  }

  return -1;
};

const multipartBoundary =
  /^multipart\/[^;]+;\s*boundary=(?<quote>"?)(?<boundary>[^";\r\n]+)\k<quote>/iu;

const boundaryOf = (mediaType: string | undefined): string | undefined =>
  multipartBoundary.exec(mediaType?.trim() ?? "")?.groups?.boundary;

const partFilename = /;\s*filename="(?<filename>[^"]*)"/u;

const partContentType = /^content-type:\s*(?<type>[^\r\n]*)$/imu;

const unchanged = (text: string): string => text;

/**
 * The recorded-value scrub over text that arrives in chunks, for the `--dry-run` body: each piece
 * is emitted scrubbed (`scrub`) once it ends with no proper prefix of any recorded form, found by
 * `dropTrailingFragment` repeated until it holds, so every occurrence lies whole inside one emitted
 * piece, as a scrub of the whole text would find it. What it holds back is shorter than the longest
 * form, so memory stays bound. The text is decoded as UTF-8 across chunk ends.
 */
class StreamScrubber {
  private readonly decoder = new TextDecoder();
  private pending = "";
  private readonly recorded: readonly ScrubEntry[];

  constructor(recorded: readonly ScrubEntry[]) {
    this.recorded = recorded;
  }

  push(chunk: Uint8Array): readonly Uint8Array[] {
    const text = this.pending + this.decoder.decode(chunk, { stream: true });
    let safe = text;
    let shorter = dropTrailingFragment(safe, this.recorded, unchanged);
    while (shorter.length < safe.length) {
      safe = shorter;
      shorter = dropTrailingFragment(safe, this.recorded, unchanged);
    }

    this.pending = text.slice(safe.length);

    return this.emit(safe);
  }

  end(): readonly Uint8Array[] {
    const rest = this.pending + this.decoder.decode();
    this.pending = "";

    return this.emit(rest);
  }

  private emit(text: string): readonly Uint8Array[] {
    return text === "" ? [] : [encoder.encode(scrubValues(text, this.recorded))];
  }
}

const scrubStream =
  (recorded: readonly ScrubEntry[]) =>
  <E, R>(body: Stream.Stream<Uint8Array, E, R>): Stream.Stream<Uint8Array, E, R> =>
    body.pipe(
      Stream.mapAccum(
        () => new StreamScrubber(recorded),
        (scrubber, chunk: Uint8Array) => [scrubber, scrubber.push(chunk)] as const,
        { onHalt: (scrubber) => scrubber.end() },
      ),
    );

/**
 * The `--dry-run` view of a multipart body (design 4.6), as a streaming state machine over the
 * bytes the writer produced: delimiters, part heads and text parts as given, the heads and text
 * through the recorded-value scrub (`StreamScrubber`); a file part's content
 * (one with a `filename`) as `<file <basename>, N bytes>`, and any other part with a binary content
 * type as `<binary part, N bytes>`, counted, never held. One nested multipart level is walked with
 * its own boundary. Every delimiter is read as CRLF `--<boundary>`, so a CRLF is put before the
 * first one and left out of the output.
 */
class MultipartSummary {
  private readonly boundaries: string[];
  private counted = 0;
  private first = true;
  private mode: "content" | "epilogue" | "head" | "opaque" = "content";
  private pending: Uint8Array = crlf;
  private readonly recorded: readonly ScrubEntry[];
  private summary: string | undefined = undefined;
  private text: StreamScrubber | undefined = undefined;

  constructor(boundary: string, recorded: readonly ScrubEntry[]) {
    this.boundaries = [boundary];
    this.recorded = recorded;
  }

  push(chunk: Uint8Array): readonly Uint8Array[] {
    this.pending = concatBytes([this.pending, chunk]);

    return this.drain(false);
  }

  end(): readonly Uint8Array[] {
    const out = [...this.drain(true)];
    this.flushText(out);

    return out;
  }

  // Text is emitted through the recorded-value scrub; a summarized part is only counted.
  private content(bytes: Uint8Array, out: Uint8Array[]): void {
    if (this.summary === undefined) {
      this.text ??= new StreamScrubber(this.recorded);
      out.push(...this.text.push(bytes));
    } else {
      this.counted += bytes.length;
    }
  }

  private flushText(out: Uint8Array[]): void {
    if (this.text !== undefined) {
      out.push(...this.text.end());
      this.text = undefined;
    }
  }

  private closePart(out: Uint8Array[]): void {
    this.flushText(out);
    if (this.summary !== undefined) {
      out.push(this.scrubbed(`<${this.summary}, ${this.counted} bytes>`));
    }

    this.summary = undefined;
    this.counted = 0;
  }

  private scrubbed(text: string): Uint8Array {
    return encoder.encode(scrubValues(text, this.recorded));
  }

  private drain(final: boolean): readonly Uint8Array[] {
    const out: Uint8Array[] = [];
    while (this.step(final, out)) {
      // Each step consumes input or changes mode; it returns false when it needs more bytes.
    }

    return out;
  }

  private step(final: boolean, out: Uint8Array[]): boolean {
    if (this.mode === "epilogue") {
      this.content(this.pending, out);
      this.pending = new Uint8Array(0);

      return false;
    }

    if (this.mode === "opaque") {
      this.counted += this.pending.length;
      this.pending = new Uint8Array(0);
      if (final) {
        out.push(encoder.encode(`<multipart body, ${this.counted} more bytes>`));
      }

      return false;
    }

    return this.mode === "head" ? this.head(final, out) : this.body(final, out);
  }

  private head(final: boolean, out: Uint8Array[]): boolean {
    const at = indexOfBytes(this.pending, headEnd);
    if (at === -1) {
      if (final) {
        this.content(this.pending, out);
        this.pending = new Uint8Array(0);
      } else if (this.pending.length > maxPartHeadBytes) {
        this.mode = "opaque";

        return true;
      }

      return false;
    }

    const head = new TextDecoder().decode(this.pending.subarray(0, at));
    const contentType = partContentType.exec(head)?.groups?.type;
    const nested = boundaryOf(contentType);
    if (nested === undefined) {
      out.push(this.scrubbed(`${head}\r\n\r\n`));
      this.pending = this.pending.subarray(at + headEnd.length);
      const filename = partFilename.exec(head)?.groups?.filename;
      if (filename !== undefined) {
        this.summary = `file ${filename}`;
      } else if (contentType !== undefined && !isText(contentType)) {
        this.summary = "binary part";
      }
    } else {
      // The head's last CRLF starts the nested body's first delimiter.
      out.push(this.scrubbed(`${head}\r\n`));
      this.pending = this.pending.subarray(at + 2);
      this.boundaries.push(nested);
    }

    this.mode = "content";

    return true;
  }

  private body(final: boolean, out: Uint8Array[]): boolean {
    const boundary = this.boundaries.at(-1) ?? "";
    const delimiter = encoder.encode(`\r\n--${boundary}`);
    const at = indexOfBytes(this.pending, delimiter);
    const after = at === -1 ? -1 : at + delimiter.length;
    if (at === -1 || after + 2 > this.pending.length) {
      // Keep a tail that may hold the start of a delimiter and the two bytes after it.
      let safe = at;
      if (final) {
        safe = this.pending.length;
      } else if (at === -1) {
        safe = Math.max(0, this.pending.length - delimiter.length - 1);
      }

      this.content(this.pending.subarray(0, safe), out);
      this.pending = this.pending.subarray(safe);
      if (final) {
        this.closePart(out);
      }

      return false;
    }

    const next = new TextDecoder().decode(this.pending.subarray(after, after + 2));
    if (next !== "\r\n" && next !== "--") {
      // The boundary text inside a part's content, not a delimiter.
      this.content(this.pending.subarray(0, after), out);
      this.pending = this.pending.subarray(after);

      return true;
    }

    this.content(this.pending.subarray(0, at), out);
    this.closePart(out);
    out.push(encoder.encode(`${this.first ? "" : "\r\n"}--${boundary}${next}`));
    this.first = false;
    this.pending = this.pending.subarray(after + 2);
    if (next === "--") {
      this.boundaries.pop();
    }

    if (next === "\r\n") {
      this.mode = "head";
    } else {
      this.mode = this.boundaries.length > 0 ? "content" : "epilogue";
    }

    return true;
  }
}

const summarizeMultipart = <E, R>(
  body: Stream.Stream<Uint8Array, E, R>,
  boundary: string,
  recorded: readonly ScrubEntry[],
): Stream.Stream<Uint8Array, E, R> =>
  body.pipe(
    Stream.mapAccum(
      () => new MultipartSummary(boundary, recorded),
      (summary, chunk: Uint8Array) => [summary, summary.push(chunk)] as const,
      { onHalt: (summary) => summary.end() },
    ),
  );

const newline = encoder.encode("\n");

// End a non-empty body with a newline, so the next prompt starts on its own line.
const endWithNewline = <E, R>(
  body: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<Uint8Array, E, R> =>
  body.pipe(
    Stream.mapAccum(
      () => true,
      (ended: boolean, chunk: Uint8Array) =>
        [chunk.length === 0 ? ended : chunk.at(-1) === newline[0], [chunk]] as const,
      { onHalt: (ended) => (ended ? [] : [newline]) },
    ),
  );

const line = (text: string): Stream.Stream<Uint8Array> => Stream.succeed(encoder.encode(text));

/**
 * The `--dry-run` body (design 4.6, DM3-8): a text-family body as given, with every recorded value
 * replaced (`scrub`, or `StreamScrubber` for a streamed one); a multipart body summarized by
 * `MultipartSummary`; a binary body as `<binary body, N bytes>` from its declared length, or, with
 * no length, which is stdin, as `<binary body from stdin>` (`<body from stdin>` for a text-family
 * one) without reading it. A file the runtime streams arrives with its size only, so its path
 * cannot be named here.
 */
const dryRunBody = (
  request: HttpClientRequest.HttpClientRequest,
  recorded: readonly ScrubEntry[],
): Stream.Stream<Uint8Array, UsageError> => {
  const { body } = request;
  if (body._tag === "Empty") {
    return Stream.empty;
  }

  const mediaType = Option.getOrElse(
    Headers.get(request.headers, "content-type"),
    (): string | undefined => body.contentType,
  );

  if (body._tag === "Uint8Array") {
    return isText(mediaType)
      ? line(scrubValues(new TextDecoder().decode(body.body), recorded))
      : line(`<binary body, ${body.body.length} bytes>`);
  }

  if (body._tag !== "Stream") {
    return line("<binary body>");
  }

  const boundary = boundaryOf(mediaType);
  if (boundary !== undefined) {
    return summarizeMultipart(
      body.stream.pipe(
        Stream.mapError(() => new UsageError({ message: "cannot read the request body" })),
      ),
      boundary,
      recorded,
    );
  }

  if (body.contentLength === undefined) {
    return line(isText(mediaType) ? "<body from stdin>" : "<binary body from stdin>");
  }

  return isText(mediaType)
    ? body.stream.pipe(
        Stream.mapError(() => new UsageError({ message: "cannot read the request body" })),
        scrubStream(recorded),
      )
    : line(`<binary body, ${body.contentLength} bytes>`);
};

const querySeparator = (url: string): string => {
  if (/[?&]$/u.test(url)) {
    return "";
  }

  return url.includes("?") ? "&" : "?";
};

// A query name as a server decodes it.
const decodedQueryName = (raw: string): string =>
  new URLSearchParams(`${raw}=`).keys().next().value ?? raw;

/**
 * The request target as the redirect loop sends it: `urlParams` folded in their `queryWireForm`,
 * a placeholder written as itself, no fragment. A query value whose decoded name
 * `UrlParams.CurrentRedactedNames` lists is `<redacted>`, unless it is a placeholder.
 */
const dryRunUrl = (
  request: HttpClientRequest.HttpClientRequest,
  placeholders: ReadonlySet<string>,
  names: readonly (string | RegExp)[],
): string => {
  // A `Redacted` param is a value the runtime holds secret; it prints as `<redacted>`.
  const wire = (value: string | Redacted.Redacted): string => {
    if (Redacted.isRedacted(value)) {
      return "<redacted>";
    }

    return placeholders.has(value) ? value : queryWireForm(value);
  };
  const pairs = UrlParams.fromInput(request.urlParams).params.map(
    ([name, value]) => `${queryWireForm(name)}=${wire(value)}`,
  );
  const url =
    pairs.length === 0
      ? request.url
      : `${request.url}${querySeparator(request.url)}${pairs.join("&")}`;
  const at = url.indexOf("?");
  if (at === -1) {
    return url;
  }

  const query = url
    .slice(at + 1)
    .split("&")
    .map((part) => {
      const equals = part.indexOf("=");
      const redacted =
        equals !== -1 &&
        !placeholders.has(part.slice(equals + 1)) &&
        UrlParams.isRedactedName(decodedQueryName(part.slice(0, equals)), names);

      return redacted ? `${part.slice(0, equals + 1)}<redacted>` : part;
    });

  return `${url.slice(0, at + 1)}${query.join("&")}`;
};

/**
 * Print the request `send` built instead of sending it (design 4.6 DM3-8, D-OUT3, 7.5): on stdout
 * `METHOD <absolute URL> HTTP/1.1`, the headers in send order, a blank line and `dryRunBody`. The
 * request carries `<redacted:<scheme>>` where a credential would go (`attachPlaceholders`); a
 * header value whose name `Headers.CurrentRedactedNames` lists is `<redacted>` unless it is exactly
 * a placeholder form, and a `Cookie` is redacted pair by pair; every line is scrubbed of the values
 * the run recorded, secret-file values among them, and sanitized.
 */
const printDryRun = (
  request: HttpClientRequest.HttpClientRequest,
  placeholders: readonly Placeholder[],
  recorded: readonly ScrubEntry[],
): Effect.Effect<void, OutputError | UsageError, Stdio.Stdio> =>
  Effect.gen(function* dryRun() {
    const written = new Set(placeholders.map(({ scheme }) => placeholder(scheme)));
    const headerNames = yield* Effect.service(Headers.CurrentRedactedNames);
    const queryNames = yield* Effect.service(UrlParams.CurrentRedactedNames);
    const exact = new Set(
      [...written].flatMap((text) => [text, `Bearer ${text}`, `Basic ${text}`]),
    );
    // A redacted header keeps only an exact placeholder form; a `Cookie` keeps each pair whose
    // value is exactly a placeholder and redacts the value of every other pair.
    const shownValue = (name: string, value: string): string => {
      if (!Headers.isRedactedName(name, headerNames)) {
        return value;
      }

      if (name.toLowerCase() !== "cookie") {
        return exact.has(value) ? value : "<redacted>";
      }

      return value
        .split(";")
        .map((pair) => pair.trim())
        .filter((pair) => pair !== "")
        .map((pair) => {
          const equals = pair.indexOf("=");
          if (equals === -1) {
            return "<redacted>";
          }

          return written.has(pair.slice(equals + 1)) ? pair : `${pair.slice(0, equals)}=<redacted>`;
        })
        .join("; ");
    };
    const lines = [
      `${request.method} ${dryRunUrl(request, written, queryNames)} HTTP/1.1`,
      ...Object.entries(request.headers).map(
        ([name, value]) => `${name}: ${shownValue(name, value)}`,
      ),
    ].map((text) => scrubbedAndSanitized(text, recorded));

    yield* toStdout(
      Stream.concat(line(`${lines.join("\n")}\n\n`), endWithNewline(dryRunBody(request, recorded))),
    );
  });

/**
 * Send one built request (design 4.8): the one path from a `Serialize.Request` to a sink or a typed
 * error, and the only runtime function that sends. In order: the base URL (`--base-url`,
 * `<PREFIX>_BASE_URL`, `--server`, `--server-variable` or the accepted default, from the
 * operation's effective servers: its meta's override, else the root table from `Servers`) joined to
 * the builder's path and query; `Accept` from the declared response media or `accept` (`--accept`),
 * leaving the builder's `Content-Type`; the security requirement evaluated against `Schemes` before
 * any connection (`CredentialMissing`); the plaintext warning of design 13.1 R3, once per run
 * (`RunWarnings`), when `--allow-credentials-for-base-url` is what lets credentials reach an
 * `http:` base; the policy client; then response matching, after a stderr warning for each required
 * header the matched case declares and the response lacks. A 2xx streams to the output sink (a
 * bodiless one, `isBodiless`, writes nothing and reads nothing), after the `--verbose` notice for
 * an undeclared media type; any other status fails with `ApiResponseError` carrying the body
 * excerpt, bounded and scrubbed of every value the run recorded (its credentials, added to the
 * record, and its secret-file values), and the server's `Retry-After` when retrying stopped at the
 * cap.
 *
 * The policy client, innermost first (design D-AD7; audit ad9f808b F5): `verboseTransform` on the
 * inner client the redirect loop receives, so `--verbose` sees each hop of each attempt as sent;
 * `redirectLoop` (per-hop attach gated by the base's provenance, method allowlist, direct route for
 * loopback hops, the per-attempt `--timeout`); `retryTransform`, so one attempt is one run of the
 * loop; `withUserAgent`. No transform wraps a response outside `retryTransform`, so the final
 * response is still the `CappedResponse` `retryAfterCapSeconds` reads. `retryTransform` sees the
 * request before the attach step, so its `Idempotency-Key` test sees only a header parameter the
 * operation declares and the operator supplied, never a credential (design D-AD7). Every line the
 * transforms print passes through the run's scrubber (`scrubbedAndSanitized` over the recorded
 * values). Every body read, the excerpt's included, is bounded by the stream idle timeout
 * (`effectiveIdleTimeoutSeconds`, read before anything is sent). The request and every body read
 * run in one scope. Before the client runs, `send` adds the retry-hint input (the method and
 * whether an `Idempotency-Key` header was sent) to `RunRecord`, when one is provided. Errors are
 * not rendered here: `finalCatch` does.
 *
 * Under `--dry-run` (`dryRunSetting`) the requirement is evaluated by `preview`, which never fails
 * for a missing credential and never prompts, and the built request, with its `User-Agent` and the
 * chosen alternative's placeholders, is printed by `printDryRun` instead of entering the client.
 */
export const send =
  (meta: OperationMeta, accept: Option.Option<string> = Option.none()) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* sendRequest() {
      const operation = displayName(meta);
      if (meta.deprecated === true) {
        yield* printStderr(`Notice: the operation ${operation} is deprecated`);
      }

      const { envPrefix, table: rootServers } = yield* Servers;
      const servers = meta.servers ?? rootServers;
      const selection = yield* select(
        {
          baseUrl: yield* baseUrlSetting,
          server: yield* serverSetting,
          serverVariables: yield* serverVariableSetting,
        },
        servers,
      );
      const baseUrl = yield* resolve(selection, servers);
      const [path, query] = splitTarget(request.url);
      const accepted = yield* acceptValue(meta.media, accept);
      const located = HttpClientRequest.setUrl(request, requestUrl(baseUrl, path, query));
      const built = Option.match(accepted, {
        onNone: () => located,
        onSome: (value) => HttpClientRequest.setHeader(located, "accept", value),
      });

      // `--dry-run` shows the chosen alternative's placeholders and never fails for a missing
      // credential or prompts for one.
      const dryRun = Option.getOrElse(yield* Effect.serviceOption(dryRunSetting), () => false);
      const chosen = dryRun
        ? yield* preview(meta.security)
        : { credentials: yield* evaluate(operation, meta.security), placeholders: [] };
      const { credentials } = chosen;
      // Merged, never replaced: a secret-file value the body recorded before `send` stays
      // recorded, and the error excerpt below scrubs it (audit ad9f808b F3).
      const recorded = yield* Effect.service(RunCredentials);
      const scrubbed = yield* Ref.updateAndGet(recorded, (entries) => [...entries, ...credentials]);

      const { table: security } = yield* Schemes;
      const baseOrigin = new URL(baseUrl).origin;
      const gate = {
        allowUnboundBase: yield* allowCredentialsForBaseUrl,
        baseOrigin,
        boundOrigins: servers.boundOrigins,
        provenance: selection.provenance,
      };
      const origins = credentialOrigins(gate);
      const sendsToBase = credentials.length > 0 && origins.includes(baseOrigin);

      if (credentials.length > 0 && !sendsToBase) {
        yield* printStderr(withheldNotice(credentials));
      }

      // The flag let them through only when the base is not bound without it.
      const allowedByFlag =
        sendsToBase &&
        !credentialOrigins({ ...gate, allowUnboundBase: false }).includes(baseOrigin);
      yield* warnOncePerRun(plaintextWarning(baseUrl, allowedByFlag));

      const policy = yield* ClientPolicy;
      if (dryRun) {
        // The `User-Agent` `withUserAgent` sets, then the attach step, in the policy client's order.
        const agent = HttpClientRequest.setHeader(
          built,
          "user-agent",
          `${policy.binName}/${policy.version}`,
        );
        const shown = yield* attachPlaceholders(security, chosen.placeholders, origins)(agent);
        yield* printDryRun(shown, chosen.placeholders, scrubbed).pipe(
          Effect.provide(redactedNames(security)),
        );

        return;
      }

      const idleSeconds = yield* effectiveIdleTimeoutSeconds(envPrefix);
      const scrub = (text: string): string => scrubbedAndSanitized(text, scrubbed);
      const client = (yield* HttpClient.HttpClient).pipe(
        verboseTransform(scrub),
        redirectLoop(attach(security, { credentials, origins }), policy.direct, policy.allowed),
        retryTransform(scrub),
        withUserAgent(policy.binName, policy.version),
      );
      const table = {
        operation,
        requestIdHeader: meta.requestIdHeader,
        responses: meta.media.responses,
      };

      yield* recordSent(built);
      yield* client.execute(built).pipe(
        Effect.catchTag("HttpClientError", mapClientError),
        Effect.tap((response) => warnMissingHeaders(meta, response)),
        Effect.flatMap((response) =>
          classify(table, response, credentials).pipe(
            Effect.matchEffect({
              onFailure: () =>
                readExcerpt(bodyOf(response, idleSeconds), scrubbed).pipe(
                  // A truncated excerpt is no excerpt; a stalled one is the idle timeout.
                  Effect.catchIf(
                    (error) => error.reason !== "idleTimeout",
                    () => Effect.succeed(""),
                  ),
                  Effect.flatMap((excerpt) =>
                    Effect.fail(
                      toApiResponseError(
                        table,
                        response,
                        excerpt,
                        credentials,
                        retryAfterCapSeconds(response),
                      ),
                    ),
                  ),
                ),
              onSuccess: (ok) =>
                isBodiless(ok)
                  ? Effect.void
                  : Effect.gen(function* writeOk() {
                      const mediaType = dispatchResponse(
                        declaredMedia(meta, ok.status),
                        Option.getOrUndefined(Headers.get(ok.headers, "content-type")),
                      );
                      if (mediaType === undefined) {
                        yield* undeclaredMediaNotice(operation, ok, scrub);
                      }

                      yield* writeResponse({ bytes: bodyOf(ok, idleSeconds), mediaType });
                    }),
            }),
          ),
        ),
        Effect.scoped,
        Effect.provide(redactedNames(security)),
      );
    });
