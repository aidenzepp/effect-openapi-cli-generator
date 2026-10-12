import { Effect, FileSystem, Option, Schema, Stdio, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * Preserves Schema.TaggedError constructor inference for the generated error classes.
 */
const tagged = Schema.TaggedError;

/**
 * Reports a base URL that cannot safely prefix the original OpenAPI path.
 */
export class InvalidBaseUrl extends tagged<InvalidBaseUrl>()("InvalidBaseUrl", {
  message: Schema.String,
  value: Schema.String,
}) {}

/**
 * Identifies invalid JSON, conflicting body inputs, or a body schema violation.
 */
export class InvalidBody extends tagged<InvalidBody>()("InvalidBody", {
  message: Schema.String,
  source: Schema.String,
}) {}

/**
 * Reports transport, encoding, and output failures through the CLI error channel.
 */
export class RequestFailed extends tagged<RequestFailed>()("RequestFailed", {
  message: Schema.String,
}) {}

/**
 * Retains the HTTP status and response text for unsuccessful API responses.
 */
export class HttpStatusFailure extends tagged<HttpStatusFailure>()("HttpStatusFailure", {
  body: Schema.String,
  status: Schema.Number,
}) {
  override get message() {
    return `HTTP ${this.status}: ${this.body}`;
  }
}

/**
 * The failures callers may receive while preparing or executing a request.
 */
export type RequestFailure = InvalidBaseUrl | InvalidBody | RequestFailed | HttpStatusFailure;

/**
 * Validates the explicit HTTP(S) base URL and removes trailing slashes.
 * Credentials, queries, and fragments would change request composition and are rejected.
 *
 * @param value The untrusted value supplied through --base-url.
 * @returns A normalized prefix or a typed URL failure.
 */
export const validateBaseUrl = (value: string) =>
  Effect.try({
    catch: (cause) => new InvalidBaseUrl({ message: String(cause), value }),
    try: () => {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        throw new Error("Expected HTTP(S) URL without credentials, query or fragment");
      }

      return url.href.replaceAll(/\/+$/gu, "");
    },
  });

/**
 * The mutually exclusive inline JSON and filesystem JSON inputs supplied by native flags.
 */
interface BodyInput {
  readonly body: Option.Option<string>;
  readonly bodyFile: Option.Option<string>;
}

/**
 * Reads and validates a JSON body while retaining its original values.
 * Schema decoding is validation only: returning the original JSON preserves allowed
 * unknown properties, false, zero, and empty strings without coercion or defaults.
 *
 * @param input The native optional body flags.
 * @param required Whether this operation requires a request body.
 * @param schema The generated validator for the original wire schema.
 * @returns The original valid JSON, no body, or a location-bearing body failure.
 */
export const readBody = (input: BodyInput, required: boolean, schema: Schema.Codec<Schema.Json>) =>
  Effect.gen(function* readRequestBody() {
    if (Option.isSome(input.body) && Option.isSome(input.bodyFile)) {
      return yield* new InvalidBody({
        message: "Use exactly one of --body and --body-file",
        source: "input",
      });
    }

    if (Option.isNone(input.body) && Option.isNone(input.bodyFile)) {
      if (required) {
        return yield* new InvalidBody({
          message: "A JSON --body or --body-file is required",
          source: "input",
        });
      }

      return Option.none();
    }

    const source = Option.isSome(input.bodyFile) ? input.bodyFile.value : "--body";
    const text = Option.isSome(input.body)
      ? input.body.value
      : yield* (yield* FileSystem.FileSystem)
          .readFileString(source)
          .pipe(Effect.mapError((cause) => new InvalidBody({ message: String(cause), source })));
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
      Effect.mapError((cause) => new InvalidBody({ message: String(cause), source })),
    );
    yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
      Effect.mapError((cause) => new InvalidBody({ message: String(cause), source })),
    );

    return Option.some(value);
  });

/**
 * Encodes one parameter as a single path segment.
 * Dot segments are rejected because URL normalization would alter the original route.
 *
 * @param value The parsed scalar parameter before URL encoding.
 * @returns An encoded segment or a typed encoding failure.
 */
export const pathValue = (value: string | number | boolean) =>
  Effect.try({
    catch: (cause) => new RequestFailed({ message: String(cause) }),
    try: () => {
      const text = String(value);
      if (text === "." || text === "..") {
        throw new Error("Dot segments are not valid path parameter values");
      }

      return encodeURIComponent(text).replaceAll(/[!'()*]/gu, (character) => {
        const point = character.codePointAt(0);
        if (point === undefined) {
          throw new Error("Expected a path character");
        }

        return `%${point.toString(16).toUpperCase()}`;
      });
    },
  });

/**
 * Executes the original HTTP method and writes successful response text to stdout.
 * The scope keeps the HTTP response alive through body consumption and releases
 * transport resources on success, failure, or interruption.
 *
 * @param method The method from the OpenAPI operation, independent of command naming.
 * @param url The fully serialized URL including query parameters.
 * @param body The original validated JSON, when supplied.
 * @returns Completion after output, or a typed HTTP, transport, or output failure.
 */
export const executeRequest = (
  method: "GET" | "PUT" | "POST" | "DELETE" | "OPTIONS" | "HEAD" | "PATCH" | "TRACE",
  url: string,
  body: Option.Option<Schema.Json>,
) =>
  Effect.scoped(
    Effect.gen(function* sendRequest() {
      let request = HttpClientRequest.make(method)(url);
      if (Option.isSome(body)) {
        request = yield* HttpClientRequest.bodyJson(request, body.value).pipe(
          Effect.mapError((cause) => new RequestFailed({ message: String(cause) })),
        );
      }

      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .execute(request)
        .pipe(Effect.mapError((cause) => new RequestFailed({ message: String(cause) })));
      const text = yield* response.text.pipe(
        Effect.mapError((cause) => new RequestFailed({ message: String(cause) })),
      );
      if (response.status < 200 || response.status > 299) {
        yield* new HttpStatusFailure({ body: text, status: response.status });
      }

      if (text.length > 0) {
        const stdio = yield* Stdio.Stdio;
        yield* Stream.make(text).pipe(
          Stream.run(stdio.stdout({ endOnDone: false })),
          Effect.mapError((cause) => new RequestFailed({ message: String(cause) })),
        );
      }
    }),
  );
