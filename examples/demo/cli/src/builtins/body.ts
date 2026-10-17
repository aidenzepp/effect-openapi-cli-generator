import { Effect, FileSystem, Option, Schema } from "effect";
import { CliError } from "effect/cli";
import { HttpClientRequest } from "effect/http";

/**
 * Resolve exclusive inline/file JSON inputs and validate without echoing rejected data.
 */
const readBody = <A extends Schema.Json>(
  body: Option.Option<A>,
  bodyFile: Option.Option<string>,
  required: boolean,
  schema: Schema.Codec<A>,
) =>
  Effect.gen(function* readRequestBody() {
    if (Option.isSome(body) && Option.isSome(bodyFile)) {
      return yield* new CliError.UserError({
        cause: undefined,
        userMessage: "Use exactly one of --body and --body-file.",
      });
    }

    if (Option.isSome(bodyFile)) {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(bodyFile.value).pipe(
        Effect.mapError(
          (cause) =>
            new CliError.UserError({
              cause,
              userMessage:
                "The body file could not be read. Check --body-file and its permissions.",
            }),
        ),
      );

      return Option.some(
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        ),
      );
    }

    if (required && Option.isNone(body)) {
      return yield* new CliError.UserError({
        cause: undefined,
        userMessage: "A JSON --body or --body-file is required.",
      });
    }

    return body;
  });

/**
 * Encode an optional validated body while preserving omission and typed encoding failures.
 */
export const withBody =
  <A extends Schema.Json>(
    body: Option.Option<A>,
    bodyFile: Option.Option<string>,
    required: boolean,
    schema: Schema.Codec<A>,
  ) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    readBody(body, bodyFile, required, schema).pipe(
      Effect.flatMap((value) =>
        Option.isSome(value)
          ? HttpClientRequest.bodyJson(request, value.value).pipe(
              Effect.mapError(
                (cause) =>
                  new CliError.UserError({
                    cause,
                    userMessage:
                      "The request body could not be encoded as JSON. Check the body values.",
                  }),
              ),
            )
          : Effect.succeed(request),
      ),
    );
