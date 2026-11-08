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
  Option,
  Path,
  Ref,
  Runtime,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import type { Command, HelpDoc } from "effect/cli";
import { CliError, CliOutput, Flag, GlobalFlag } from "effect/cli";
import { Headers, HttpClient, HttpClientRequest } from "effect/http";
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
import type { Credential, SecurityRequirement } from "./auth.ts";
import {
  allowCredentialsForBaseUrl,
  attach,
  credentialOrigins,
  evaluate,
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
import { redirectLoop, withUserAgent } from "./client.ts";
import type { MediaDeclaration } from "./negotiate.ts";
import { accept as acceptValue, dispatchResponse } from "./negotiate.ts";
import type { ScrubEntry } from "./redact.ts";
import { dropTrailingFragment, longestFormBytes, RunCredentials, scrubAround } from "./redact.ts";
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
 * given. EPIPE on stdout stops the stream and succeeds.
 */
export const writeBody = <E, R>(response: ResponseBody<E, R>) =>
  writeStream(response.bytes, !isText(response.mediaType));

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
 * The text printed on stderr for a known error (design 7.4): `Error: <message>`, for an
 * `ApiResponseError` then `Request ID: <id>` when set, then the excerpt (omitted when empty).
 * Every part is scrubbed and sanitized again here, because the error may come from anywhere.
 */
export const renderError = (error: KnownError, credentials: readonly ScrubEntry[]): string => {
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

const recordedCredentials: Effect.Effect<readonly ScrubEntry[], never, RunCredentials> =
  Effect.flatMap(Effect.service(RunCredentials), Ref.get);

const renderCause = <E>(
  cause: Cause.Cause<E>,
  credentials: readonly ScrubEntry[],
): Effect.Effect<never, E | InternalError, Stdio.Stdio> => {
  const failure = Cause.findErrorOption(cause);

  if (Cause.hasInterruptsOnly(cause)) {
    return Effect.failCause(cause);
  }

  if (Option.isSome(failure) && CliError.isCliError(failure.value)) {
    const text = renderCliError(failure.value);

    return text === undefined
      ? Effect.failCause(cause)
      : reportOnce(scrubbedAndSanitized(text, credentials), failure.value);
  }

  if (Option.isSome(failure) && isKnownError(failure.value)) {
    const error = failure.value;

    return reportOnce(renderError(error, credentials), error);
  }

  const squashed = Cause.squash(cause);
  const line = singleLine(
    isDescribed(squashed) ? defectMessage(squashed) : "unknown failure",
    credentials,
  ).slice(0, maxDefectLineLength);

  return printStderr(`Error: ${line}\ninternal error, please report`).pipe(
    Effect.andThen(Effect.fail(new InternalError())),
  );
};

/**
 * The final catch around `Command.run` (design 7.4), the only error renderer: the CLI runs
 * `Command.run` with `renderErrors: false`. A known error is rendered once and fails again as
 * itself, so its exit code stands; a `CliError` parse error is rendered once through
 * `valueFreeFormatter`; help and interruption pass through; anything else prints one scrubbed
 * line and "internal error, please report" and fails with `InternalError`, exit 70.
 * `credentials` are the values to scrub that the caller holds; `RunCredentials`, provided outside
 * the catch, adds the credentials the command handler evaluated and its secret-file values.
 */
export const finalCatch =
  (credentials: readonly ScrubEntry[]) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | InternalError, R | RunCredentials | Stdio.Stdio> =>
    Effect.catchCause(effect, (cause) =>
      recordedCredentials.pipe(
        Effect.flatMap((recorded) => renderCause(cause, [...credentials, ...recorded])),
      ),
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
 * Send one built request (design 4.8): the one path from a `Serialize.Request` to a sink or a typed
 * error, and the only runtime function that sends. In order: the base URL (`--base-url`,
 * `<PREFIX>_BASE_URL`, `--server`, `--server-variable` or the accepted default, from the
 * operation's effective servers: its meta's override, else the root table from `Servers`) joined to
 * the builder's path and query; `Accept` from the declared response media or `accept` (`--accept`),
 * leaving the builder's `Content-Type`; the security requirement evaluated against `Schemes` before
 * any connection (`CredentialMissing`); the policy client (redirect loop with the per-hop attach
 * gated by the base's provenance, method allowlist, direct route for loopback hops, `User-Agent`);
 * then response matching, after a stderr warning for each required header the matched case declares
 * and the response lacks. A 2xx streams to the output sink (a bodiless one, `isBodiless`, writes
 * nothing and reads nothing); any other status fails with `ApiResponseError` carrying the body
 * excerpt, bounded and scrubbed of every value the run recorded (its credentials, added to the
 * record, and its secret-file values). Every body read, the excerpt's included, is bounded by the
 * stream idle timeout (`effectiveIdleTimeoutSeconds`, read before anything is sent). The request
 * and every body read run in one scope. Errors are not rendered here: `finalCatch` does.
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

      const credentials = yield* evaluate(operation, meta.security);
      // Merged, never replaced: a secret-file value the body recorded before `send` stays
      // recorded, and the error excerpt below scrubs it (audit ad9f808b F3).
      const recorded = yield* Effect.service(RunCredentials);
      const scrubbed = yield* Ref.updateAndGet(recorded, (entries) => [...entries, ...credentials]);

      const { table: security } = yield* Schemes;
      const baseOrigin = new URL(baseUrl).origin;
      const origins = credentialOrigins({
        allowUnboundBase: yield* allowCredentialsForBaseUrl,
        baseOrigin,
        boundOrigins: servers.boundOrigins,
        provenance: selection.provenance,
      });

      if (credentials.length > 0 && !origins.includes(baseOrigin)) {
        yield* printStderr(withheldNotice(credentials));
      }

      const idleSeconds = yield* effectiveIdleTimeoutSeconds(envPrefix);
      const policy = yield* ClientPolicy;
      const client = (yield* HttpClient.HttpClient).pipe(
        redirectLoop(attach(security, { credentials, origins }), policy.direct, policy.allowed),
        withUserAgent(policy.binName, policy.version),
      );
      const table = {
        operation,
        requestIdHeader: meta.requestIdHeader,
        responses: meta.media.responses,
      };

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
                    Effect.fail(toApiResponseError(table, response, excerpt, credentials)),
                  ),
                ),
              onSuccess: (ok) =>
                isBodiless(ok)
                  ? Effect.void
                  : writeResponse({
                      bytes: bodyOf(ok, idleSeconds),
                      mediaType: dispatchResponse(
                        declaredMedia(meta, ok.status),
                        Option.getOrUndefined(Headers.get(ok.headers, "content-type")),
                      ),
                    }),
            }),
          ),
        ),
        Effect.scoped,
        Effect.provide(redactedNames(security)),
      );
    });
