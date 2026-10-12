# Readable decoding

## POSITIVE — Native stream composition and focused decoding

Decisive evidence: `Stream.mapEffect` consumes each part before advancing, `runCollect` collects decoded strings rather than unconsumed file objects, Schema owns byte and cardinality checks, and `Match.exhaustive` verifies parser-reason coverage. The main operation has no mutable accumulator or nested generator. The helper owns the coherent task of decoding one part; it is not an arbitrary line-count split.

This complete example supplies its own imports, schemas, errors, and formatter. It does not depend on application files. It is a body-only boundary, not an attachment implementation: an HttpApi endpoint must supply a multipart stream limited to one part and a bounded total request size, and declare its error schemas. The allowance is UTF-8 bytes, not characters. Strict TextDecoder use bridges the platform capability; it does not justify replacing existing Effect multipart collection.

```ts
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Multipart from "effect/http/Multipart";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Predicate from "effect/Predicate";

/**
 * Bounds text separately from the multipart envelope.
 */
const MessageLimits = { bodyBytes: 64 * 1024, requestBytes: 68 * 1024 } as const;

/**
 * Requires nonempty text within the UTF-8 byte allowance.
 */
const MessageBody = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => new TextEncoder().encode(value).length <= MessageLimits.bodyBytes),
);

/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError is a schema class factory. */
/**
 * Reports invalid multipart or text encoding input without exposing parser internals.
 */
class MessageInputError extends Schema.TaggedError<MessageInputError>()(
  "MessageInputError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/**
 * Reports a body or envelope exceeding its configured byte allowance.
 */
class MessageTooLarge extends Schema.TaggedError<MessageTooLarge>()(
  "MessageTooLarge",
  { message: Schema.String },
  { httpApiStatus: 413 },
) {}

/**
 * Carries schema issues using Effect's default messages and paths.
 */
class RequestValidationError extends Schema.TaggedError<RequestValidationError>()(
  "RequestValidationError",
  {
    details: Schema.Array(
      Schema.Struct({ message: Schema.String, path: Schema.Array(Schema.String) }),
    ),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

/**
 * Formats native schema issues consistently at the caller boundary.
 *
 * @param issue The decoder's structured issue.
 * @returns A tagged failure with default Effect messages and field paths.
 */
const requestValidationError = (issue: SchemaIssue.Issue) =>
  new RequestValidationError({
    details: SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues.map((detail) => ({
      message: detail.message,
      path: (detail.path ?? []).map((segment) =>
        String(Predicate.isObject(segment) ? segment.key : segment),
      ),
    })),
    message: "Request validation failed.",
  });

/**
 * Accepts the body field with either the normal text-field MIME type or Markdown.
 */
const MarkdownPart = Schema.Struct({
  contentType: Schema.Literals(["text/plain", "text/markdown"]),
  key: Schema.Literal("body"),
});

/**
 * Enforces the body byte allowance independently of multipart envelope overhead.
 */
const BodyBytes = Schema.Uint8Array.check(Schema.isMaxLength(MessageLimits.bodyBytes));

/**
 * Requires one decoded Markdown body; collecting parts must not silently drop extras.
 */
const SingleBody = Schema.Tuple([MessageBody]);

/**
 * Reads one part using Effect's native multipart collector and validates its Markdown.
 * The parser bounds the envelope before collection. Check body bytes before UTF-8
 * decoding so oversized input returns 413, even if its last bytes are incomplete.
 *
 * @param part A parsed multipart field or file-shaped text part.
 * @returns Nonempty Markdown within the byte allowance, or a typed input failure.
 */
const decodeBodyPart = Effect.fnUntraced(function* decodeBodyPart(part: Multipart.Part) {
  yield* Schema.decodeUnknownEffect(MarkdownPart)(part).pipe(
    Effect.mapError((error) => requestValidationError(error.issue)),
  );

  const bytes = Multipart.isFile(part)
    ? yield* part.contentEffect
    : new TextEncoder().encode(part.value);
  yield* Schema.decodeUnknownEffect(BodyBytes)(bytes).pipe(
    Effect.mapError(
      () =>
        new MessageTooLarge({
          message: `The Markdown body may contain at most ${MessageLimits.bodyBytes} UTF-8 bytes. No message was saved.`,
        }),
    ),
  );

  const text = Multipart.isFile(part)
    ? yield* Effect.try({
        catch: () =>
          new MessageInputError({
            message: "Encode the Markdown body as valid UTF-8 text. No message was saved.",
          }),
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      })
    : part.value;

  return yield* Schema.decodeUnknownEffect(MessageBody)(text).pipe(
    Effect.mapError((error) => requestValidationError(error.issue)),
  );
});

/**
 * Maps Effect's multipart parser reasons into the declared input and size failures.
 *
 * @param error A parser failure, including envelope and part-count limits.
 * @returns A caller-safe error without exposing parser internals.
 */
const multipartFailure = (error: Multipart.MultipartError) =>
  Match.value(error.reason._tag).pipe(
    Match.whenOr(
      "TooManyParts",
      "Parse",
      "InternalError",
      () =>
        new MessageInputError({
          message:
            "Send a complete multipart/form-data request containing exactly one body part and its boundary. No message was saved.",
        }),
    ),
    Match.whenOr(
      "BodyTooLarge",
      "FieldTooLarge",
      "FileTooLarge",
      () =>
        new MessageTooLarge({
          message: `The Markdown body may contain at most ${MessageLimits.bodyBytes} UTF-8 bytes; the complete multipart request may contain at most ${MessageLimits.requestBytes} bytes. No message was saved.`,
        }),
    ),
    Match.exhaustive,
  );

/**
 * Decodes exactly one multipart Markdown body before storage can run.
 * Each file part is consumed before advancing the outer multipart stream;
 * collecting unconsumed File objects first would skip their streamed contents.
 *
 * @param parts Effect's parsed multipart stream with the endpoint's size limits.
 * @returns Validated Markdown, or a declared input, size, or schema failure.
 * @see https://effect.website/docs/v4/api/effect/http/Multipart
 */
export const decodeMessageBody = Effect.fn("Messages.decodeBody")(function* decodeMessageBody(
  parts: Stream.Stream<Multipart.Part, Multipart.MultipartError>,
) {
  const bodies = yield* parts.pipe(
    Stream.mapEffect(decodeBodyPart),
    Stream.runCollect,
    Effect.catchTag("MultipartError", (error) => Effect.fail(multipartFailure(error))),
  );
  const [body] = yield* Schema.decodeUnknownEffect(SingleBody)(bodies).pipe(
    Effect.mapError((error) => requestValidationError(error.issue)),
  );

  return body;
});
```

## NEGATIVE — Custom accumulation around an available stream operator

Decisive evidence: this uses the same validated helper, tuple schema, limits, and typed failures as the positive example, but introduces a mutable array, a side-effecting callback, and a nested generator solely to recreate `Stream.mapEffect` followed by `runCollect`. Its behavior is valid; its extra bookkeeping has no useful responsibility.

This alternative function uses the declarations in the complete example above. It is negative only on composition/readability, not on the correctness of its input contract.

```ts
/**
 * Decodes one multipart Markdown body with the same validation and failure contract.
 *
 * @param parts The endpoint-bounded multipart stream.
 * @returns Validated Markdown or a declared failure.
 */
export const decodeWithBookkeeping = Effect.fnUntraced(function* decodeWithBookkeeping(
  parts: Stream.Stream<Multipart.Part, Multipart.MultipartError>,
) {
  const bodies: string[] = [];
  yield* parts.pipe(
    Stream.runForEach((part) =>
      Effect.gen(function* consumePart() {
        const body = yield* decodeBodyPart(part);
        bodies.push(body);
      }),
    ),
    Effect.catchTag("MultipartError", (error) => Effect.fail(multipartFailure(error))),
  );

  const [body] = yield* Schema.decodeUnknownEffect(SingleBody)(bodies).pipe(
    Effect.mapError((error) => requestValidationError(error.issue)),
  );

  return body;
});
```

## Preserve the streaming contract

Do not generalize the example by collecting raw multipart File objects and reading them later: their content streams must be consumed before advancing the outer stream. Future attachments require separate file count/size limits and streamed storage, not a larger in-memory body collector. Cross-system writes require explicit cleanup; a scoped finalizer alone does not create a transaction between D1 and R2.

## Native capability evidence

The positive example uses installed Effect v4 APIs: `Multipart.File.contentEffect`, `Schema.isMaxLength`, `Schema.Tuple([schema])`, `Stream.mapEffect`, and `Match.whenOr` / `Match.exhaustive`. Before adapting it, check the installed version's documentation and source rather than assuming these signatures are universal. This example teaches a review process, not a requirement that every decoder use the same pipeline.

A useful implementation rationale names the selected native primitive and any actual gap: “Effect collects bounded multipart file content; Schema checks bytes and body count; strict UTF-8 text decoding uses the platform TextDecoder through Effect.try.” “I did not find an API” without naming the documentation/source checked is insufficient evidence for a custom replacement.
