import { Effect, Option, Schema } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { HttpClientRequest } from "effect/http";
import * as Body from "./builtins/body.js";
import * as Errors from "./builtins/errors.js";
import * as Http from "./builtins/http.js";
import * as Url from "./builtins/url.js";

/**
 * Get file metadata (no upload)
 */
const filesGetCommand = Command.make(
  "get",
  { baseUrl: Url.baseUrl, id: Flag.String("id") },
  ({ baseUrl: apiUrl, id }) =>
    HttpClientRequest.get(apiUrl).pipe(
      Url.appendPathSegments("files", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("files-get"),
    ),
).pipe(Command.withDescription("Get file metadata (no upload)"));

/**
 * Echo a new post
 */
const postsCreateCommand = Command.make(
  "create",
  {
    baseUrl: Url.baseUrl,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ published: Schema.Boolean, title: Schema.String })),
        )(value, { onExcessProperty: "error", reportInput: false }).pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        ),
      ),
      Flag.optional,
    ),
    bodyFile: Flag.String("body-file").pipe(
      Flag.withDescription("Read a JSON request body from a file; exclusive with --body."),
      Flag.optional,
    ),
  },
  ({ baseUrl: apiUrl, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      Url.appendPathSegments("posts"),
      Effect.flatMap(
        Body.withBody(
          body,
          bodyFile,
          true,
          Schema.Struct({ published: Schema.Boolean, title: Schema.String }),
        ),
      ),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("posts-create"),
    ),
).pipe(Command.withDescription("Echo a new post"));

/**
 * List demo users
 */
const usersListCommand = Command.make(
  "list",
  {
    active: Flag.Literals("active", ["true", "false"])
      .pipe(Flag.map((value) => value === "true"))
      .pipe(Flag.optional),
    baseUrl: Url.baseUrl,
  },
  ({ active, baseUrl: apiUrl }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({ active: Option.getOrUndefined(active) }),
      Url.appendPathSegments("users"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("users-list"),
    ),
).pipe(Command.withDescription("List demo users"));

/**
 * Get a demo user
 */
const usersGetCommand = Command.make(
  "get",
  { baseUrl: Url.baseUrl, id: Flag.String("id") },
  ({ baseUrl: apiUrl, id }) =>
    HttpClientRequest.get(apiUrl).pipe(
      Url.appendPathSegments("users", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("users-get"),
    ),
).pipe(Command.withDescription("Get a demo user"));

export const FilesCommand = Command.make("files").pipe(Command.withSubcommands([filesGetCommand]));

export const PostsCommand = Command.make("posts").pipe(
  Command.withSubcommands([postsCreateCommand]),
);

export const UsersCommand = Command.make("users").pipe(
  Command.withSubcommands([usersListCommand, usersGetCommand]),
);
