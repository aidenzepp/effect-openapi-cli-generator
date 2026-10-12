#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Match, Option, Schema, SchemaIssue } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import type { HttpClientError } from "effect/http";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

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

// Problem Details members with invalid types are ignored independently.
const ProblemDetails = Schema.Struct({
  detail: Schema.optionalKey(Schema.Unknown),
  title: Schema.optionalKey(Schema.Unknown),
});

const problemText = Schema.decodeUnknownOption(Schema.Trim.check(Schema.isNonEmpty()));

const httpErrorMessage = Effect.fnUntraced(function* httpErrorMessage(
  reason: HttpClientError.HttpClientErrorReason,
  descriptions: Readonly<Record<number, string>>,
) {
  if (reason._tag === "StatusCodeError") {
    const { response } = reason;
    const fallback = descriptions[response.status] ?? "The request failed.";
    const mediaType = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/problem+json") {
      return `HTTP ${response.status}: ${fallback}`;
    }

    const message = yield* HttpClientResponse.schemaBodyJson(ProblemDetails)(response).pipe(
      Effect.map((problem) =>
        problemText(problem.detail).pipe(
          Option.orElse(() => problemText(problem.title)),
          Option.getOrElse(() => fallback),
        ),
      ),
      Effect.orElseSucceed(() => fallback),
    );

    return `HTTP ${response.status}: ${message}`;
  }

  return Match.value(reason).pipe(
    Match.tagsExhaustive({
      DecodeError: () => "The response could not be read. Check the API server and connection.",
      EmptyBodyError: () => "The response was empty. Check the API server and its response format.",
      EncodeError: () =>
        "The request could not be encoded. Check the command inputs and API documentation.",
      InvalidUrlError: () => "The request URL is invalid. Check --base-url and its path prefix.",
      TransportError: () => "Connection failed. Check --base-url and that the server is reachable.",
    }),
  );
});

const listUsersResponses = {
  404: "The users collection is unavailable.",
  503: "The service is temporarily unavailable.",
};

/**
 * Return users, optionally filtered by whether their accounts are active.
 */
const listUsersCommand = Command.make(
  "list",
  {
    active: Flag.Literals("active", ["true", "false"]).pipe(
      Flag.withDescription(
        "Return only active users when true or inactive users when false. Omit to return all users.",
      ),
      Flag.optional,
    ),
    baseUrl,
  },
  ({ baseUrl: apiUrl, active }) =>
    Effect.gen(function* listUsers() {
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const request = HttpClientRequest.get(apiUrl).pipe(
        HttpClientRequest.appendUrl("/users"),
        HttpClientRequest.setUrlParams(Option.isSome(active) ? { active: active.value } : {}),
      );
      const response = yield* client.execute(request);
      yield* Console.log(yield* response.text);
    }).pipe(
      Effect.withSpan("users.list"),
      Effect.catchTag("HttpClientError", (cause) =>
        httpErrorMessage(cause.reason, listUsersResponses).pipe(
          Effect.flatMap((userMessage) =>
            Effect.fail(new CliError.UserError({ cause, userMessage })),
          ),
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    "List users. Return users, optionally filtered by whether their accounts are active.",
  ),
);

/**
 * Browse user accounts.
 */
const users = Command.make("users").pipe(
  Command.withDescription("Browse user accounts."),
  Command.withSubcommands([listUsersCommand]),
);

/**
 * Inspect user accounts through the Users API.
 */
const command = Command.make("users-reference").pipe(
  Command.withDescription("Inspect user accounts through the Users API."),
  Command.withSubcommands([users]),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
