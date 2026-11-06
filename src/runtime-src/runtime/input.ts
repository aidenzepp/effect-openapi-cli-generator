import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { CliError, Flag } from "effect/cli";
import { HttpBody } from "effect/http";
import { UsageError } from "../domain/errors.ts";
import { FileBody } from "./file-body.ts";
import type { MediaDeclaration } from "./negotiate.ts";
import * as Negotiate from "./negotiate.ts";

/**
 * Ceiling for a body read from `--body-file`, a file or stdin, in bytes. A runtime choice: design
 * I5 says only "bounded". It matches the 64 MiB the generator proposes for a specification (§3).
 */
export const maxBodyBytes = 67_108_864;

const bodyFileName = "body-file";

const encoder = new TextEncoder();

/**
 * Whole request body as text; field flags override it.
 */
export const bodyFlag = Flag.String("body").pipe(
  Flag.optional,
  Flag.withDescription("Whole request body; field flags override it"),
);

/**
 * Whole request body from a file, or from stdin when the value is `-`. `Flag.String` keeps `-`
 * literal, so no path fix-up is needed here.
 */
export const bodyFileFlag = Flag.String(bodyFileName).pipe(
  Flag.withMetavar("path|-"),
  Flag.optional,
  Flag.withDescription("Whole request body from a file or stdin"),
);

/**
 * The invocation's single stdin claim (design 4.5, C1). `claim` succeeds once per layer and then
 * refuses every later claimant with a `UsageError` that names flags only.
 */
export class StdinClaim extends Context.Service<
  StdinClaim,
  { readonly claim: (flag: string) => Effect.Effect<void, UsageError> }
>()("openapi-cli/runtime/StdinClaim") {}

/**
 * A fresh claim for one invocation. The root `services` layer provides it once.
 */
export const stdinClaimLayer: Layer.Layer<StdinClaim> = Layer.effect(
  StdinClaim,
  Effect.gen(function* build() {
    const holder = yield* Ref.make(Option.none<string>());

    return {
      claim: (flag) =>
        Ref.modify(holder, (held) =>
          Option.isSome(held) ? [held, held] : [Option.none<string>(), Option.some(flag)],
        ).pipe(
          Effect.flatMap((first) =>
            Option.isSome(first)
              ? Effect.fail(
                  new UsageError({
                    flag,
                    message: `--${flag}: standard input is already read by --${first.value}`,
                  }),
                )
              : Effect.void,
          ),
        ),
    };
  }),
);

const usage = (flag: string, cause: string): UsageError =>
  new UsageError({ flag, message: `--${flag}: ${cause}` });

const cannotReadIn = (flag: string): UsageError => usage(flag, "cannot read the file or stdin");

const overLimitIn = (flag: string): UsageError =>
  usage(flag, `the body is over ${maxBodyBytes} bytes`);

const cannotRead = (): UsageError => cannotReadIn(bodyFileName);

const overLimit = (): UsageError => overLimitIn(bodyFileName);

const notAFile = (): UsageError =>
  usage(bodyFileName, `is not a regular file; for a pipe use --${bodyFileName} -`);

class OverLimit {
  readonly _tag = "OverLimit";
}

class ReadFailed {
  readonly _tag = "ReadFailed";
}

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  let size = 0;
  for (const chunk of chunks) {
    size += chunk.length;
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }

  return joined;
};

const bounded = (
  source: Stream.Stream<Uint8Array, unknown>,
  limit: number = maxBodyBytes,
): Stream.Stream<Uint8Array, OverLimit | ReadFailed> =>
  source.pipe(
    Stream.mapError((): OverLimit | ReadFailed => new ReadFailed()),
    Stream.limitBytes(limit, (): Stream.Stream<Uint8Array, OverLimit | ReadFailed> =>
      Stream.fail(new OverLimit()),
    ),
  );

const toUsage = (cause: OverLimit | ReadFailed, flag: string = bodyFileName): UsageError =>
  cause instanceof OverLimit ? overLimitIn(flag) : cannotReadIn(flag);

const collect = (
  source: Stream.Stream<Uint8Array, unknown>,
  flag: string = bodyFileName,
): Effect.Effect<Uint8Array, UsageError> =>
  bounded(source).pipe(
    Stream.runCollect,
    Effect.map(concat),
    Effect.mapError((cause) => toUsage(cause, flag)),
  );

// A bounded read of a path, or of stdin for `-` under the one stdin claim, failing in `flag`.
const readFlagFile = (
  path: string,
  flag: string,
): Effect.Effect<Uint8Array, UsageError, FileSystem.FileSystem | Stdio.Stdio | StdinClaim> =>
  path === "-"
    ? Effect.service(StdinClaim).pipe(
        Effect.flatMap((claim) => claim.claim(flag)),
        Effect.flatMap(() => Effect.service(Stdio.Stdio)),
        Effect.flatMap((stdio) => collect(stdio.stdin, flag)),
      )
    : Effect.service(FileSystem.FileSystem).pipe(
        Effect.flatMap((fs) => collect(fs.stream(path, { bytesToRead: maxBodyBytes + 1 }), flag)),
      );

/**
 * Reads `--body-file` into memory, bounded: a file by path, or stdin for `-` (which takes the one
 * stdin claim). Failures name the flag, never the path or the file-system cause (design 4.6).
 */
export const readBodyFile = (
  path: string,
): Effect.Effect<Uint8Array, UsageError, FileSystem.FileSystem | Stdio.Stdio | StdinClaim> =>
  readFlagFile(path, bodyFileName);

// A body stream that counts the bytes it yields, so a file that grows past its stat size, or a
// `FileBody` that under-declares, still stops at the limit; the send step sees a `UsageError`.
const limited = (
  body: HttpBody.HttpBody,
  limit: number,
): Effect.Effect<HttpBody.HttpBody, UsageError> => {
  if (body._tag !== "Stream") {
    return Effect.succeed(body);
  }

  return (body.contentLength ?? 0) > limit
    ? Effect.fail(overLimit())
    : Effect.succeed(
        HttpBody.stream(
          bounded(body.stream, limit).pipe(Stream.mapError(toUsage)),
          body.contentType,
          body.contentLength,
        ),
      );
};

// Only a regular file is accepted. It is opened once here, so a missing read permission fails at
// flag time, then streamed through `FileBody` with its size. A directory is refused, and so is a
// pipe or device (a FIFO, `<(cmd)`): it has no size to trust, and the platform file system reads
// by position, which a pipe refuses. Such input goes through `-` instead. `limit` is the in-memory
// ceiling the file is counted against; `undefined` streams it unguarded.
const openFile = (
  path: string,
  limit?: number,
): Effect.Effect<HttpBody.HttpBody, UsageError, FileBody | FileSystem.FileSystem> =>
  Effect.gen(function* open() {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path).pipe(Effect.mapError(cannotRead));

    if (info.type !== "File") {
      return yield* Effect.fail(notAFile());
    }

    if (limit !== undefined && info.size > BigInt(limit)) {
      return yield* Effect.fail(overLimit());
    }

    yield* fs.open(path, { flag: "r" }).pipe(Effect.scoped, Effect.mapError(cannotRead));

    const fileBody = yield* FileBody;

    const opened = fileBody.open(path).pipe(Effect.mapError(cannotRead));

    return yield* limit === undefined
      ? opened
      : opened.pipe(Effect.flatMap((body) => limited(body, limit)));
  });

/**
 * A binary request body from `--body-file` only. A regular file streams through `FileBody` with its
 * size, its bytes counted against the limit; stdin (`-`) is read into memory, bounded, so an
 * over-limit or unreadable input is a `UsageError` before any request. `--body` is refused, and so
 * is `--body` together with `--body-file`. With neither flag a required body is a `UsageError`
 * naming `--body-file` and an optional one is empty. `maxBytes` replaces the default limit.
 */
export const binaryBody = (options: {
  readonly body: Option.Option<string>;
  readonly bodyFile: Option.Option<string>;
  readonly required: boolean;
  readonly maxBytes?: number;
}): Effect.Effect<
  HttpBody.HttpBody,
  UsageError,
  FileBody | FileSystem.FileSystem | Stdio.Stdio | StdinClaim
> => {
  if (Option.isSome(options.body)) {
    return Effect.fail(
      usage(
        "body",
        Option.isSome(options.bodyFile)
          ? `cannot be used with --${bodyFileName}`
          : `this request body is binary; use --${bodyFileName}`,
      ),
    );
  }

  if (Option.isNone(options.bodyFile)) {
    return options.required
      ? Effect.fail(usage(bodyFileName, `this request needs a body; use --${bodyFileName}`))
      : Effect.succeed(HttpBody.empty);
  }

  return options.bodyFile.value === "-"
    ? readBodyFile("-").pipe(Effect.map((read) => HttpBody.uint8Array(read)))
    : openFile(options.bodyFile.value, options.maxBytes ?? maxBodyBytes);
};

/**
 * A sequential request body (NDJSON, JSON Lines, JSON-seq; design 6.3 Sequential uploads) exactly
 * as the operator gives it: `--body` is the text as given; a `--body-file` regular file streams
 * through `FileBody` with its size; `-` streams stdin chunked under the one stdin claim. The bytes
 * are never parsed, re-framed, buffered whole, asserted against a schema or counted against the
 * in-memory read limit, which bounds only reads into memory (design I5). The caller sets the
 * declared media type as `Content-Type`. `--body` together with `--body-file` is refused. With
 * neither flag a required body is a `UsageError` and an optional one is empty.
 */
export const sequentialBody = (options: {
  readonly body: Option.Option<string>;
  readonly bodyFile: Option.Option<string>;
  readonly required: boolean;
}): Effect.Effect<
  HttpBody.HttpBody,
  UsageError,
  FileBody | FileSystem.FileSystem | Stdio.Stdio | StdinClaim
> => {
  if (Option.isSome(options.body)) {
    return Option.isSome(options.bodyFile)
      ? Effect.fail(usage("body", `cannot be used with --${bodyFileName}`))
      : Effect.succeed(HttpBody.text(options.body.value));
  }

  if (Option.isNone(options.bodyFile)) {
    return options.required
      ? Effect.fail(usage(bodyFileName, `this request needs a body; use --${bodyFileName}`))
      : Effect.succeed(HttpBody.empty);
  }

  const path = options.bodyFile.value;

  return path === "-"
    ? Effect.service(StdinClaim).pipe(
        Effect.flatMap((claim) => claim.claim(bodyFileName)),
        Effect.flatMap(() => Effect.service(Stdio.Stdio)),
        Effect.map((stdio) => HttpBody.stream(stdio.stdin.pipe(Stream.mapError(cannotRead)))),
      )
    : openFile(path);
};

/**
 * A JSON number kept as its source text. A field flag for an `int64` property passes its digit
 * string this way; a merged body marks any number whose text `JSON.parse` would change (digits
 * past 2^53, `1.50`, `1e2`). `mergeBody` writes it with `JSON.rawJSON` at serialization only.
 */
export class JsonNumber {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

const jsonNumberGrammar = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

/**
 * Whether `text` is a JSON number (RFC 8259 section 6). A `JsonNumber` is sent as its text, so a
 * text outside this grammar is refused before it reaches the wire.
 */
export const isJsonNumberText = (text: string): boolean => jsonNumberGrammar.test(text);

/**
 * A field flag's value: a scalar, an `int64` digit string as a `JsonNumber`, or a decoded JSON
 * value (an object, an array, `null`) for a property that is not flattened (design 4.5).
 */
export type FieldValue =
  | null
  | boolean
  | number
  | string
  | JsonNumber
  | readonly FieldValue[]
  | { readonly [key: string]: FieldValue };

/**
 * Text encodings a base64 body property takes (RFC 4648 section 4 and 5), padding kept for both.
 */
export type FieldEncoding = "base64" | "base64url";

/**
 * A field flag whose value is a path, or `-` for stdin, to a file the runtime reads and encodes
 * into the property at its pointer. `flag` is the flag's name, the only thing a failure names.
 */
export class FileField {
  readonly encoding: FieldEncoding;
  readonly flag: string;
  readonly path: string;

  constructor(options: {
    readonly encoding: FieldEncoding;
    readonly flag: string;
    readonly path: string;
  }) {
    this.encoding = options.encoding;
    this.flag = options.flag;
    this.path = options.path;
  }
}

export type Fields = Readonly<
  Record<string, Option.Option<FieldValue | FileField> | readonly FieldValue[]>
>;

export type JsonNode =
  | null
  | boolean
  | number
  | string
  | JsonNumber
  | readonly JsonNode[]
  | JsonObject;

export interface JsonObject {
  [key: string]: JsonNode;
}

/**
 * What `JSON.rawJSON` returns: a value `JSON.stringify` writes as its text, unchanged.
 */
export interface RawJson {
  readonly rawJSON: string;
}

type Reviver = (key: string, value: JsonNode, context: { readonly source?: string }) => JsonNode;

// TypeScript 7.0.2 and @types/bun 1.4.2 declare no `JSON.rawJSON` and no reviver `context`, while
// Bun provides both (measured, m1.md 3). One typed binding here, no global augmentation.
// oxlint-disable-next-line typescript/no-inferrable-types -- the wide type selects Reflect.get's untyped overload
const jsonGlobal: string = "JSON";

const bunJson: {
  readonly parse: (text: string, reviver?: Reviver) => JsonNode;
  readonly rawJSON: (text: string) => RawJson;
  // oxlint-disable-next-line anti-slop/no-reflect-get, typescript/no-unsafe-assignment -- the one way to type Bun's JSON without a global augmentation
} = Reflect.get(globalThis, jsonGlobal);

/**
 * `text` as raw JSON for a `JSON.stringify` replacer, written unchanged. Throws `SyntaxError` when
 * `text` is not a JSON primitive.
 */
export const rawJson = (text: string): RawJson => bunJson.rawJSON(text);

const int64Digits = /^-?(?:0|[1-9]\d*)$/u;

/**
 * Deepest array and object nesting accepted in operator JSON (`--body`, `--body-file`, a JSON field
 * flag, a field value). A runtime choice: no real request body nests this deep, and past a few
 * thousand levels the engine's recursive reviver and every recursive walk overflow the stack.
 */
export const maxJsonDepth = 128;

// Iterative scan of JSON text, so the bound holds before any recursive parse or walk runs. A
// bracket inside a string never counts; malformed text is left for the parser to refuse.
const nestsTooDeep = (text: string): boolean => {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      depth += 1;

      if (depth > maxJsonDepth) {
        return true;
      }
    } else if (char === "]" || char === "}") {
      depth -= 1;
    }
  }

  return false;
};

/**
 * An `int64` field flag's value as a `JsonNumber`, checked against the same digit pattern a merged
 * body is. A non-digit text is a `UsageError` naming the flag only, never the text.
 */
export const jsonNumber = (digits: string, flag: string): Effect.Effect<JsonNumber, UsageError> =>
  int64Digits.test(digits)
    ? Effect.succeed(new JsonNumber(digits))
    : Effect.fail(usage(flag, "an integer field is not a digit string"));

// A flag's mapEffect fails in CliError; the UsageError rides as the cause with its own message.
const asCliError = (error: UsageError): CliError.CliError =>
  new CliError.UserError({ cause: error, userMessage: error.message });

/**
 * The flag for an `int64` field: its digit string parsed to a `JsonNumber`, so a later merge writes
 * the digits unchanged. A non-digit value fails the flag with an error that names `--name` and
 * never the value.
 */
export const int64Flag = (name: string) =>
  Flag.String(name).pipe(
    Flag.mapEffect((raw) => jsonNumber(raw, name).pipe(Effect.mapError(asCliError))),
  );

const isObject = (value: JsonNode | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value) && !(value instanceof JsonNumber);

// oxlint-disable-next-line typescript/no-unsafe-return -- Object.create(null) is any; the result holds only JsonNode values
const bare = (source: JsonObject = {}): JsonObject => Object.assign(Object.create(null), source);

const revive: Reviver = (_key, value, context) => {
  if (Predicate.isNumber(value)) {
    return context.source !== undefined && String(value) !== context.source
      ? new JsonNumber(context.source)
      : value;
  }

  return isObject(value) ? bare(value) : value;
};

// A field value keeps only integers whose digits `JSON.parse` would change; `1.50` and `1e2` decode
// to the same number, and a `JsonNumber` in a field must be a digit string.
// A number that overflows (`1e400`) decodes to Infinity, which `JSON.stringify` would send as
// `null`; it throws here, and the flag's catch turns that into a value-free failure.
const reviveIntegers: Reviver = (key, value, context) => {
  if (Predicate.isNumber(value) && !Number.isFinite(value)) {
    throw new RangeError("a JSON number is not finite");
  }

  return Predicate.isNumber(value) &&
    context.source !== undefined &&
    !int64Digits.test(context.source)
    ? value
    : revive(key, value, context);
};

/**
 * The flag for a JSON-valued field: its text parsed with the number-preserving parse `mergeBody`
 * uses (digits past 2^53 stay a `JsonNumber`, objects have no prototype). A text that is not JSON,
 * holds a number that is not finite, or nests deeper than `maxJsonDepth` fails the flag with an
 * error that names `--name` and never the text.
 */
export const jsonFlag = (name: string) =>
  Flag.String(name).pipe(
    Flag.mapEffect((raw) =>
      Effect.try({
        catch: () => asCliError(usage(name, "is not valid JSON")),
        try: () => {
          if (nestsTooDeep(raw)) {
            throw new RangeError("JSON nesting is too deep");
          }

          return bunJson.parse(raw, reviveIntegers);
        },
      }),
    ),
  );

// A `JsonNumber` whose text is not a JSON number throws here, before `JSON.rawJSON` could write it
// as some other JSON primitive; the merge's catch turns that into a value-free failure.
const replace = (_key: string, value: JsonNode): JsonNode | RawJson => {
  if (!(value instanceof JsonNumber)) {
    return value;
  }

  if (!isJsonNumberText(value.text)) {
    throw new SyntaxError("a JSON number has no JSON text form");
  }

  return bunJson.rawJSON(value.text);
};

const segmentsOf = (pointer: string): readonly string[] | undefined =>
  pointer.startsWith("/")
    ? pointer
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    : undefined;

const setAt = (
  root: JsonObject,
  pointer: string,
  value: JsonNode,
): Effect.Effect<void, UsageError> => {
  const segments = segmentsOf(pointer);
  const last = segments?.at(-1);

  if (segments === undefined || last === undefined) {
    return Effect.fail(usage("body", "a field has no valid body pointer"));
  }

  let node = root;
  for (const segment of segments.slice(0, -1)) {
    const next = Object.hasOwn(node, segment) ? node[segment] : undefined;

    if (isObject(next)) {
      node = next;
    } else {
      const fresh = bare();

      node[segment] = fresh;
      node = fresh;
    }
  }

  node[last] = value;

  return Effect.void;
};

const supplied = (value: Fields[string]): FieldValue | FileField | undefined => {
  if (Option.isOption(value)) {
    return Option.getOrUndefined(value);
  }

  return value.length === 0 ? undefined : value;
};

// Walks a field value with an explicit stack, so a deep value cannot overflow it. After a
// "fine" verdict `toNode` recurses at most `maxJsonDepth` levels.
const inspectField = (root: FieldValue): "badNumber" | "fine" | "tooDeep" => {
  const pending: { readonly depth: number; readonly value: FieldValue }[] = [
    { depth: 0, value: root },
  ];

  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const { depth, value } = item;

    if (value instanceof JsonNumber) {
      if (!int64Digits.test(value.text)) {
        return "badNumber";
      }
    } else if (Array.isArray(value) || Predicate.isObject(value)) {
      if (depth >= maxJsonDepth) {
        return "tooDeep";
      }

      for (const child of Object.values<FieldValue>(value)) {
        pending.push({ depth: depth + 1, value: child });
      }
    }
  }

  return "fine";
};

// A field value enters the body as a deep copy whose objects have no prototype, so a later field
// flag that writes `__proto__` beneath it sets an own key, as it does everywhere else.
const toNode = (value: FieldValue): JsonNode => {
  if (Array.isArray(value)) {
    return value.map(toNode);
  }

  if (value instanceof JsonNumber || !Predicate.isObject(value)) {
    return value;
  }

  const copy = bare();
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = toNode(entry);
  }

  return copy;
};

const base64Chunk = 0x80_00;

// btoa over binary-string chunks, so a large file never spreads into one call's arguments.
const encodeBytes = (bytes: Uint8Array, encoding: FieldEncoding): string => {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += base64Chunk) {
    text += btoa(String.fromCodePoint(...bytes.subarray(offset, offset + base64Chunk)));
  }

  return encoding === "base64url" ? text.replaceAll("+", "-").replaceAll("/", "_") : text;
};

const readEncoded = (
  field: FileField,
): Effect.Effect<string, UsageError, FileSystem.FileSystem | Stdio.Stdio | StdinClaim> =>
  readFlagFile(field.path, field.flag).pipe(
    Effect.map((bytes) => encodeBytes(bytes, field.encoding)),
  );

const decodeText = (bytes: Uint8Array, flag: string): Effect.Effect<string, UsageError> =>
  Effect.try({
    catch: () => usage(flag, "is not valid UTF-8"),
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  });

const sourceOf = (options: {
  readonly body: Option.Option<string>;
  readonly bodyFile: Option.Option<string>;
}): Effect.Effect<
  Option.Option<{ readonly bytes: Uint8Array; readonly flag: string }>,
  UsageError,
  FileSystem.FileSystem | Stdio.Stdio | StdinClaim
> => {
  if (Option.isSome(options.body)) {
    return Option.isSome(options.bodyFile)
      ? Effect.fail(usage("body", `cannot be used with --${bodyFileName}`))
      : Effect.succeed(Option.some({ bytes: encoder.encode(options.body.value), flag: "body" }));
  }

  return Option.isSome(options.bodyFile)
    ? readBodyFile(options.bodyFile.value).pipe(
        Effect.map((bytes) => Option.some({ bytes, flag: bodyFileName })),
      )
    : Effect.succeed(Option.none());
};

interface BodyOptions {
  readonly body: Option.Option<string>;
  readonly bodyFile: Option.Option<string>;
  readonly fields: Fields;
  readonly required: boolean;
  readonly schema: Schema.Top;
}

// What the merge of the body sources settled on: no body, the operator's bytes as given, or the
// merged value with its text. Every variant that carries text was asserted against the schema.
type Merged =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Verbatim"; readonly bytes: Uint8Array; readonly text: string }
  | { readonly _tag: "Merged"; readonly text: string; readonly value: JsonNode };

// The merge `mergeBody` and `structuredBody` share; `flag` names the source a failure blames, and
// `parse` is the bounded, number-preserving parse that blames it.
const mergeSources = (
  options: BodyOptions,
): Effect.Effect<
  {
    readonly merged: Merged;
    readonly parse: (text: string) => Effect.Effect<JsonNode, UsageError>;
  },
  UsageError,
  FileSystem.FileSystem | Stdio.Stdio | StdinClaim
> =>
  Effect.gen(function* merge() {
    const source = yield* sourceOf(options);
    const flag = Option.match(source, { onNone: () => "body", onSome: (found) => found.flag });
    const overrides = Object.entries(options.fields).flatMap(([pointer, field]) => {
      const value = supplied(field);

      return value === undefined ? [] : [[pointer, value] as const];
    });
    const parse = (text: string, reviver?: Reviver): Effect.Effect<JsonNode, UsageError> =>
      nestsTooDeep(text)
        ? Effect.fail(usage(flag, `is nested over ${maxJsonDepth} levels`))
        : Effect.try({
            catch: () => usage(flag, "is not valid JSON"),
            try: () => bunJson.parse(text, reviver),
          });
    const settled = (merged: Merged) => ({
      merged,
      parse: (text: string) => parse(text, revive),
    });
    const assert = (text: string) =>
      parse(text).pipe(
        Effect.filterOrFail(Schema.is(options.schema), () =>
          usage(flag, "the request body does not match its schema"),
        ),
      );

    if (Option.isNone(source) && overrides.length === 0) {
      if (!options.required) {
        return settled({ _tag: "Empty" });
      }

      yield* assert("{}");

      return settled({ _tag: "Merged", text: "{}", value: bare() });
    }

    if (Option.isSome(source) && overrides.length === 0) {
      const text = yield* decodeText(source.value.bytes, flag);

      yield* assert(text);

      return settled({ _tag: "Verbatim", bytes: source.value.bytes, text });
    }

    const base = Option.isSome(source)
      ? yield* decodeText(source.value.bytes, flag).pipe(
          Effect.flatMap((text) => parse(text, revive)),
        )
      : bare();

    if (!isObject(base)) {
      return yield* Effect.fail(usage(flag, "must be a JSON object to take field flags"));
    }

    for (const [pointer, given] of overrides) {
      const value = given instanceof FileField ? yield* readEncoded(given) : given;
      const verdict = inspectField(value);

      if (verdict === "badNumber") {
        return yield* Effect.fail(usage(flag, "an integer field is not a digit string"));
      }

      if (verdict === "tooDeep") {
        return yield* Effect.fail(
          usage(flag, `a field value is nested over ${maxJsonDepth} levels`),
        );
      }

      yield* setAt(base, pointer, toNode(value));
    }

    const text = yield* Effect.try({
      catch: () => usage(flag, "the merged body cannot be serialized"),
      try: () => JSON.stringify(base, replace),
    });

    yield* assert(text);

    return settled({ _tag: "Merged", text, value: base });
  });

/**
 * The JSON request body from `--body` or `--body-file` and the field flags (design 4.5). Field
 * flags are keyed by RFC 6901 pointer from the body root and override the body; the objects they
 * touch have no prototype, so `__proto__`, `constructor` and `prototype` are ordinary own keys.
 * The merged value is asserted against `schema`, never decoded, and the merged value is what is
 * sent. Without a field flag the operator's bytes are sent verbatim. With no input at all a
 * required body is `{}` (still asserted) and an optional one is empty. Failures name a flag and
 * never a value or a path.
 */
export const mergeBody = (
  options: BodyOptions,
): Effect.Effect<HttpBody.HttpBody, UsageError, FileSystem.FileSystem | Stdio.Stdio | StdinClaim> =>
  mergeSources(options).pipe(
    Effect.map(({ merged }) => {
      if (merged._tag === "Empty") {
        return HttpBody.empty;
      }

      return HttpBody.uint8Array(
        merged._tag === "Verbatim" ? merged.bytes : encoder.encode(merged.text),
      );
    }),
  );

/**
 * A structured request body (`application/x-www-form-urlencoded`) as the JSON value its encoder
 * takes, merged from the same sources by the same rules and failures as `mergeBody`. Numbers whose
 * text `JSON.parse` would change stay a `JsonNumber`, and objects have no prototype. With no input
 * an optional body is `undefined` and a required one is `{}`.
 */
export const structuredBody = (
  options: BodyOptions,
): Effect.Effect<
  JsonNode | undefined,
  UsageError,
  FileSystem.FileSystem | Stdio.Stdio | StdinClaim
> =>
  mergeSources(options).pipe(
    Effect.flatMap(({ merged, parse }) => {
      if (merged._tag === "Empty") {
        return Effect.undefined;
      }

      return merged._tag === "Merged" ? Effect.succeed(merged.value) : parse(merged.text);
    }),
  );

/**
 * The `Content-Type` a declared request media key sends: the key itself, or any concrete string
 * when the key is a range (`image/*`), where the operator names the type.
 */
export type SentType<K> = K extends `${string}*${string}` ? string : K;

/**
 * The request body alternative `--content-type` chose (design 6.6): the declared key, the
 * `Content-Type` it sends, and the body value for that key. A union over the keys of `V`, so the
 * key narrows the body.
 */
export type Chosen<V> = {
  readonly [P in keyof V & string]: {
    readonly body: V[P];
    readonly contentType: SentType<P>;
    readonly key: P;
  };
}[keyof V & string];

/**
 * The body flags of one request media key that do not apply to it, each mapped to whether the
 * operator supplied it.
 */
export type ForeignFlags = Readonly<Record<string, boolean>>;

/**
 * The unevaluated body effect of each declared request media key.
 */
interface BodyAlternatives {
  readonly [key: string]: Effect.Effect<unknown, unknown, unknown>;
}

/**
 * The request body for the media key `--content-type` selects (design 6.6). `alternatives` maps
 * each declared request media key to its unevaluated body effect, whose value type is that key's
 * own; only the chosen one is run, so the others' flag refusals never fire and stdin is read at
 * most once. `foreign` lists, per key, the body flags that do not apply to it: one the operator
 * supplied is a `UsageError` (exit 2) before any alternative runs, so no input is dropped silently.
 * Returns the chosen key, the `Content-Type` to send, and the body. A key the media declaration
 * lists without an alternative is a defect of the generated code, not of the operator.
 */
export const selectBody = <A extends BodyAlternatives>(options: {
  readonly alternatives: A;
  readonly chosen: Option.Option<string>;
  readonly foreign?: { readonly [P in keyof A & string]?: ForeignFlags };
  readonly media: MediaDeclaration;
}): Effect.Effect<
  Chosen<{ readonly [P in keyof A]: Effect.Success<A[P]> }>,
  UsageError | Effect.Error<A[keyof A]>,
  Effect.Services<A[keyof A]>
> =>
  Effect.gen(function* select() {
    const picked = yield* Negotiate.selectRequestMedia(options.media, options.chosen);
    const declared: BodyAlternatives = options.alternatives;
    const entry = Object.hasOwn(declared, picked.key) ? declared[picked.key] : undefined;

    if (entry === undefined) {
      return yield* Effect.die(
        new Error("selectBody: a declared request media key has no body alternative"),
      );
    }

    // SAFETY: `entry` is one of the values of `A`, so its failures and services are among theirs.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an entry of `A` fails and requires within the union over `A`'s values
    const alternative = entry as Effect.Effect<
      unknown,
      Effect.Error<A[keyof A]>,
      Effect.Services<A[keyof A]>
    >;

    const foreign: { readonly [key: string]: ForeignFlags | undefined } = options.foreign ?? {};
    const flags = Object.hasOwn(foreign, picked.key) ? foreign[picked.key] : undefined;
    const misplaced = Object.entries(flags ?? {}).find(([, given]) => given)?.[0];

    if (misplaced !== undefined) {
      return yield* Effect.fail(
        new UsageError({
          flag: misplaced,
          message: `--${misplaced}: does not apply to --content-type ${picked.key}`,
        }),
      );
    }

    const chosen = { body: yield* alternative, contentType: picked.contentType, key: picked.key };

    // SAFETY: selectRequestMedia returns a declared key of `A` and its own content type (the key, or
    // a concrete type inside a declared range), and `alternative` is that key's entry.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the picked key, its content type and its entry's value form one member of `Chosen`
    return chosen as Chosen<{ readonly [P in keyof A]: Effect.Success<A[P]> }>;
  });
