#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Match, Option, Schema } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import type { HttpClientError } from "effect/http";
import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * Decodes an HTTP(S) API root without embedded credentials, query, or fragment.
 */
const BaseUrl = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    { message: "Expected an HTTP(S) base URL without credentials, query, or fragment" },
  ),
);

/**
 * Parses the API root without echoing rejected values that can contain secrets.
 * Param.withSchema includes the original input in InvalidValue; mapEffect lets
 * this boundary retain the Schema cause while presenting a safe message.
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
            userMessage:
              "Invalid --base-url. Use an absolute HTTP(S) URL without credentials, query, or fragment.",
          }),
      ),
    ),
  ),
  Flag.withDescription(
    "API base URL including any path prefix (for example http://localhost:43123/api)",
  ),
);

/**
 * Explains HTTP failures without exposing response bodies or nested diagnostics.
 *
 * @param reason - The typed HTTP failure retained as the CLI error cause.
 * @returns A bounded explanation and a relevant next step for this read request.
 */
const httpErrorMessage = (reason: HttpClientError.HttpClientErrorReason): string =>
  Match.value(reason).pipe(
    Match.tagsExhaustive({
      DecodeError: () =>
        "Could not list users: the response could not be read. Retry the request; if it persists, check the API server.",
      EmptyBodyError: () =>
        "Could not list users: the response was empty. Check the API server and its response format.",
      EncodeError: () =>
        "Could not list users: the request could not be encoded. Check the command inputs and API documentation.",
      InvalidUrlError: () =>
        "Could not list users: the request URL is invalid. Check --base-url and its path prefix.",
      StatusCodeError: ({ response }) => {
        const message = `Could not list users: server returned HTTP ${response.status}.`;
        if (response.status === 404) {
          return `${message} Check --base-url and its path prefix.`;
        }

        if (response.status >= 500) {
          return `${message} Retry later or check the API service status.`;
        }

        return `${message} Check the API documentation for this status and the supplied --base-url.`;
      },
      TransportError: () =>
        "Could not list users: connection failed. Check --base-url and that the server is reachable.",
    }),
  );

/**
 * Lists users while preserving the distinction between omitted, true, and false filters.
 */
const listUsersCommand = Command.make(
  "list",
  // oxlint-disable-next-line sort-keys -- Preserve the intended flag order in native help.
  {
    baseUrl,
    active: Flag.Literals("active", ["true", "false"]).pipe(Flag.optional),
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
      Effect.mapError(
        (cause) =>
          new CliError.UserError({
            cause,
            userMessage: httpErrorMessage(cause.reason),
          }),
      ),
    ),
).pipe(Command.withDescription("List users, optionally filtered by active status"));

/**
 * Groups operations on users beneath their command namespace.
 */
const users = Command.make("users").pipe(Command.withSubcommands([listUsersCommand]));

/**
 * Defines the standalone reference CLI root and its native help.
 */
const command = Command.make("users-reference").pipe(Command.withSubcommands([users]));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
