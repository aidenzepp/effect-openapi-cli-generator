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
import { Flag } from "effect/cli";
import { HttpBody } from "effect/http";
import { UsageError } from "../domain/errors.ts";
import { FileBody } from "./file-body.ts";

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
>()("runtime/StdinClaim") {}

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

const cannotRead = (): UsageError => usage(bodyFileName, "cannot read the file or stdin");

const overLimit = (): UsageError => usage(bodyFileName, `the body is over ${maxBodyBytes} bytes`);

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
): Stream.Stream<Uint8Array, OverLimit | ReadFailed> =>
  source.pipe(
    Stream.mapError((): OverLimit | ReadFailed => new ReadFailed()),
    Stream.limitBytes(maxBodyBytes, (): Stream.Stream<Uint8Array, OverLimit | ReadFailed> =>
      Stream.fail(new OverLimit()),
    ),
  );

const toUsage = (cause: OverLimit | ReadFailed): UsageError =>
  cause instanceof OverLimit ? overLimit() : cannotRead();

const collect = (
  source: Stream.Stream<Uint8Array, unknown>,
): Effect.Effect<Uint8Array, UsageError> =>
  bounded(source).pipe(Stream.runCollect, Effect.map(concat), Effect.mapError(toUsage));

/**
 * Reads `--body-file` into memory, bounded: a file by path, or stdin for `-` (which takes the one
 * stdin claim). Failures name the flag, never the path or the file-system cause (design 4.6).
 */
export const readBodyFile = (
  path: string,
): Effect.Effect<Uint8Array, UsageError, FileSystem.FileSystem | Stdio.Stdio | StdinClaim> =>
  path === "-"
    ? Effect.service(StdinClaim).pipe(
        Effect.flatMap((claim) => claim.claim(bodyFileName)),
        Effect.flatMap(() => Effect.service(Stdio.Stdio)),
        Effect.flatMap((stdio) => collect(stdio.stdin)),
      )
    : Effect.service(FileSystem.FileSystem).pipe(
        Effect.flatMap((fs) => collect(fs.stream(path, { bytesToRead: maxBodyBytes + 1 }))),
      );

// A body stream that counts the bytes it yields, so a file that grows past its stat size, or a
// `FileBody` that under-declares, still stops at the limit; the send step sees a `UsageError`.
const limited = (body: HttpBody.HttpBody): Effect.Effect<HttpBody.HttpBody, UsageError> => {
  if (body._tag !== "Stream") {
    return Effect.succeed(body);
  }

  return (body.contentLength ?? 0) > maxBodyBytes
    ? Effect.fail(overLimit())
    : Effect.succeed(
        HttpBody.stream(
          bounded(body.stream).pipe(Stream.mapError(toUsage)),
          body.contentType,
          body.contentLength,
        ),
      );
};

// Only a regular file is accepted. It is opened once here, so a missing read permission fails at
// flag time, then streamed through `FileBody` with its size. A directory is refused, and so is a
// pipe or device (a FIFO, `<(cmd)`): it has no size to trust, and the platform file system reads
// by position, which a pipe refuses. Such input goes through `-` instead.
const openFile = (
  path: string,
): Effect.Effect<HttpBody.HttpBody, UsageError, FileBody | FileSystem.FileSystem> =>
  Effect.gen(function* open() {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path).pipe(Effect.mapError(cannotRead));

    if (info.type !== "File") {
      return yield* Effect.fail(notAFile());
    }

    if (info.size > BigInt(maxBodyBytes)) {
      return yield* Effect.fail(overLimit());
    }

    yield* fs.open(path, { flag: "r" }).pipe(Effect.scoped, Effect.mapError(cannotRead));

    const fileBody = yield* FileBody;

    return yield* fileBody.open(path).pipe(Effect.mapError(cannotRead), Effect.flatMap(limited));
  });

/**
 * A binary request body from `--body-file` only. A regular file streams through `FileBody` with its
 * size, its bytes counted against the limit; stdin (`-`) is read into memory, bounded, so an
 * over-limit or unreadable input is a `UsageError` before any request. `--body` is refused, and so
 * is `--body` together with `--body-file`. With neither flag a required body is a `UsageError`
 * naming `--body-file` and an optional one is empty.
 */
export const binaryBody = (options: {
  readonly body: Option.Option<string>;
  readonly bodyFile: Option.Option<string>;
  readonly required: boolean;
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
    : openFile(options.bodyFile.value);
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

/**
 * A field flag's value: a scalar, an `int64` digit string as a `JsonNumber`, or a decoded JSON
 * value (an object, an array, `null`) for a property that is not flattened (design 4.5).
 */
type FieldValue =
  | null
  | boolean
  | number
  | string
  | JsonNumber
  | readonly FieldValue[]
  | { readonly [key: string]: FieldValue };

type Fields = Readonly<Record<string, Option.Option<FieldValue> | readonly FieldValue[]>>;

type JsonNode = null | boolean | number | string | JsonNumber | readonly JsonNode[] | JsonObject;

interface JsonObject {
  [key: string]: JsonNode;
}

interface RawJson {
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

const int64Digits = /^-?(?:0|[1-9]\d*)$/u;

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

const replace = (_key: string, value: JsonNode): JsonNode | RawJson =>
  value instanceof JsonNumber ? bunJson.rawJSON(value.text) : value;

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

const supplied = (value: Fields[string]): FieldValue | undefined => {
  if (Option.isOption(value)) {
    return Option.getOrUndefined(value);
  }

  return value.length === 0 ? undefined : value;
};

const hasBadNumber = (value: FieldValue): boolean => {
  if (value instanceof JsonNumber) {
    return !int64Digits.test(value.text);
  }

  if (Array.isArray(value)) {
    return value.some(hasBadNumber);
  }

  return Predicate.isObject(value) && Object.values(value).some(hasBadNumber);
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

/**
 * The JSON request body from `--body` or `--body-file` and the field flags (design 4.5). Field
 * flags are keyed by RFC 6901 pointer from the body root and override the body; the objects they
 * touch have no prototype, so `__proto__`, `constructor` and `prototype` are ordinary own keys.
 * The merged value is asserted against `schema`, never decoded, and the merged value is what is
 * sent. Without a field flag the operator's bytes are sent verbatim. With no input at all a
 * required body is `{}` (still asserted) and an optional one is empty. Failures name a flag and
 * never a value or a path.
 */
export const mergeBody = (options: {
  readonly body: Option.Option<string>;
  readonly bodyFile: Option.Option<string>;
  readonly fields: Fields;
  readonly required: boolean;
  readonly schema: Schema.Top;
}): Effect.Effect<
  HttpBody.HttpBody,
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
      Effect.try({
        catch: () => usage(flag, "is not valid JSON"),
        try: () => bunJson.parse(text, reviver),
      });
    const assert = (text: string) =>
      parse(text).pipe(
        Effect.filterOrFail(Schema.is(options.schema), () =>
          usage(flag, "the request body does not match its schema"),
        ),
      );

    if (Option.isNone(source) && overrides.length === 0) {
      if (!options.required) {
        return HttpBody.empty;
      }

      yield* assert("{}");

      return HttpBody.uint8Array(encoder.encode("{}"));
    }

    if (Option.isSome(source) && overrides.length === 0) {
      yield* assert(yield* decodeText(source.value.bytes, flag));

      return HttpBody.uint8Array(source.value.bytes);
    }

    const base = Option.isSome(source)
      ? yield* decodeText(source.value.bytes, flag).pipe(
          Effect.flatMap((text) => parse(text, revive)),
        )
      : bare();

    if (!isObject(base)) {
      return yield* Effect.fail(usage(flag, "must be a JSON object to take field flags"));
    }

    for (const [pointer, value] of overrides) {
      if (hasBadNumber(value)) {
        return yield* Effect.fail(usage(flag, "an integer field is not a digit string"));
      }

      yield* setAt(base, pointer, toNode(value));
    }

    const text = yield* Effect.try({
      catch: () => usage(flag, "the merged body cannot be serialized"),
      try: () => JSON.stringify(base, replace),
    });

    yield* assert(text);

    return HttpBody.uint8Array(encoder.encode(text));
  });
