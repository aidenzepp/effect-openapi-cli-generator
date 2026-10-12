#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Match, Option, Schema, SchemaIssue } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import type { HttpClientError } from "effect/http";
import { HttpClient, HttpClientRequest } from "effect/http";

const BaseUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:", {
    message: "Use HTTP or HTTPS for the API base URL.",
  }),
  Schema.makeFilter((url) => !url.username, {
    message: "Remove the username from the API base URL.",
  }),
  Schema.makeFilter((url) => !url.password, {
    message: "Remove the password from the API base URL.",
  }),
  Schema.makeFilter((url) => !url.search, {
    message: "Remove the query string from the API base URL.",
  }),
  Schema.makeFilter((url) => !url.hash, { message: "Remove the fragment from the API base URL." }),
);

/**
 * Exposes only the static check messages above; malformed URL issues receive a
 * safe fallback instead of the native formatter's potentially sensitive input.
 *
 * @see https://github.com/Effect-TS/effect/blob/effect%404.0.3/packages/effect/src/SchemaIssue.ts
 */
const formatBaseUrlIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: () => "Enter an absolute URL; for example https://api.example.com.",
});

/**
 * Param.withSchema echoes rejected values. This boundary retains the typed cause
 * while rendering only the safe Schema issue message.
 *
 * @see https://github.com/Effect-TS/effect/blob/effect%404.0.3/packages/effect/src/cli/Param.ts
 */
const baseUrl = Flag.String("base-url").pipe(
  Flag.mapEffect((value) =>
    Schema.decodeUnknownEffect(BaseUrl)(value).pipe(
      Effect.mapError(
        (cause) =>
          new CliError.UserError({
            cause,
            userMessage: `Invalid --base-url. ${formatBaseUrlIssue(cause.issue).issues[0]?.message ?? "Enter an absolute URL."}`,
          }),
      ),
    ),
  ),
  Flag.withDescription(
    "API base URL including any path prefix; for example http://localhost:43123/api",
  ),
);

const httpErrorMessage = (reason: HttpClientError.HttpClientErrorReason): string =>
  Match.value(reason).pipe(
    Match.tagsExhaustive({
      DecodeError: () => "The response could not be read. Check the API server and connection.",
      EmptyBodyError: () => "The response was empty. Check the API server and its response format.",
      EncodeError: () =>
        "The request could not be encoded. Check the command inputs and API documentation.",
      InvalidUrlError: () => "The request URL is invalid. Check --base-url and its path prefix.",
      StatusCodeError: ({ response }) => {
        const message = `The server returned HTTP ${response.status}.`;
        if (response.status >= 500) {
          return `${message} Check the API service status.`;
        }

        return `${message} Check the API documentation for this status.`;
      },
      TransportError: () => "Connection failed. Check --base-url and that the server is reachable.",
    }),
  );

const PathId = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => value !== "." && value !== "..", {
    message: "Use a nonempty identifier other than . or ..",
  }),
);

const userFlag = Flag.String("user").pipe(
  Flag.withSchema(PathId),
  Flag.withDescription("The owner of the posts."),
);

const postFlag = Flag.String("post").pipe(
  Flag.withSchema(PathId),
  Flag.withDescription("The post whose files should be listed."),
);

const CreatePost = Schema.Struct({
  published: Schema.optionalKey(Schema.Boolean),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  title: Schema.NonEmptyString,
});

const bodyFlag = Flag.String("body").pipe(
  Flag.mapEffect((value) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(CreatePost))(value, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CliError.UserError({
            cause,
            userMessage:
              "Invalid --body. Provide a JSON object with a nonempty title, optional boolean published and optional string-array tags; no other fields are allowed.",
          }),
      ),
    ),
  ),
  Flag.withDescription("Create a post with a title and optional publication status and tags."),
);

/**
 * List an owner's posts, optionally filtered by status and publication state.
 */
const listPosts = Command.make(
  "list",
  {
    baseUrl,
    limit: Flag.Int("limit").pipe(
      Flag.withSchema(Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }))),
      Flag.withDescription("Return at most this many posts, from 1 through 100."),
      Flag.optional,
    ),
    published: Flag.Literals("published", ["true", "false"]).pipe(
      Flag.withDescription("Filter by publication state; omit to include both states."),
      Flag.optional,
    ),
    status: Flag.Literals("status", ["draft", "published"]).pipe(
      Flag.withDescription("Filter posts by editorial status."),
      Flag.optional,
    ),
    user: userFlag,
  },
  ({ baseUrl: apiUrl, limit, published, status, user }) =>
    Effect.gen(function* fetchPosts() {
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const request = HttpClientRequest.get(apiUrl).pipe(
        HttpClientRequest.appendUrl(`/users/${encodeURIComponent(user)}/posts`),
        HttpClientRequest.setUrlParams({
          limit: Option.getOrUndefined(limit),
          published: Option.getOrUndefined(published),
          status: Option.getOrUndefined(status),
        }),
      );
      const response = yield* client.execute(request);
      yield* Console.log(yield* response.text);
    }).pipe(
      Effect.withSpan("posts.list"),
      Effect.mapError(
        (cause) => new CliError.UserError({ cause, userMessage: httpErrorMessage(cause.reason) }),
      ),
    ),
).pipe(
  Command.withDescription(
    "List an owner's posts, optionally filtered by status and publication state.",
  ),
);

/**
 * Create a post without supplying defaults for omitted fields.
 */
const createPost = Command.make(
  "create",
  { baseUrl, body: bodyFlag, user: userFlag },
  ({ baseUrl: apiUrl, body, user }) =>
    Effect.gen(function* submitPost() {
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const request = HttpClientRequest.post(apiUrl).pipe(
        HttpClientRequest.appendUrl(`/users/${encodeURIComponent(user)}/posts`),
        // Schema-decoded JSON strings, booleans and arrays remain JSON-serializable.
        HttpClientRequest.bodyJsonUnsafe(body),
      );
      const response = yield* client.execute(request);
      yield* Console.log(yield* response.text);
    }).pipe(
      Effect.withSpan("posts.create"),
      Effect.mapError(
        (cause) => new CliError.UserError({ cause, userMessage: httpErrorMessage(cause.reason) }),
      ),
    ),
).pipe(Command.withDescription("Create a post without supplying defaults for omitted fields."));

/**
 * List the files attached to a post.
 */
const listFiles = Command.make(
  "list",
  { baseUrl, post: postFlag, user: userFlag },
  ({ baseUrl: apiUrl, post, user }) =>
    Effect.gen(function* fetchFiles() {
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const request = HttpClientRequest.get(apiUrl).pipe(
        HttpClientRequest.appendUrl(
          `/users/${encodeURIComponent(user)}/posts/${encodeURIComponent(post)}/files`,
        ),
      );
      const response = yield* client.execute(request);
      yield* Console.log(yield* response.text);
    }).pipe(
      Effect.withSpan("posts.files.list"),
      Effect.mapError(
        (cause) => new CliError.UserError({ cause, userMessage: httpErrorMessage(cause.reason) }),
      ),
    ),
).pipe(Command.withDescription("List the files attached to a post."));

const files = Command.make("files").pipe(
  Command.withDescription("Browse files attached to posts."),
  Command.withSubcommands([listFiles]),
);

const posts = Command.make("posts").pipe(
  Command.withDescription("Browse and create user posts."),
  Command.withSubcommands([listPosts, createPost, files]),
);

const users = Command.make("users").pipe(
  Command.withDescription("Work with content owned by a user."),
  Command.withSubcommands([posts]),
);

const command = Command.make("content-reference").pipe(
  Command.withDescription("Manage user posts and their attached files."),
  Command.withSubcommands([users]),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
