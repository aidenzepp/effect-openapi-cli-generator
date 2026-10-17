import { Console, Effect, Match, Schema, SchemaIssue } from "effect";
import { CliError, Flag } from "effect/cli";
import type { HttpClientError } from "effect/http";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/**
 * Format base URL failures without exposing the rejected input. Preserve static
 * schema check messages and use a safe fallback for malformed URLs.
 *
 * @see https://github.com/Effect-TS/effect/blob/effect%404.0.3/packages/effect/src/SchemaIssue.ts
 */
const formatBaseUrlIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: () => "Enter an absolute URL; for example https://api.example.com.",
});

/**
 * Require an HTTP or HTTPS API base URL, preserving any path prefix. Reject
 * credentials, queries and fragments without displaying their values;
 * Param.withSchema would echo rejected input.
 *
 * @see https://github.com/Effect-TS/effect/blob/effect%404.0.3/packages/effect/src/cli/Param.ts
 */
export const baseUrl = Flag.String("base-url").pipe(
  Flag.mapEffect((value) =>
    Schema.decodeUnknownEffect(
      Schema.URLFromString.check(
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
        Schema.makeFilter((url) => !url.hash, {
          message: "Remove the fragment from the API base URL.",
        }),
      ),
    )(value).pipe(
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
    "API base URL including any path prefix; for example https://api.resend.com",
  ),
);

/**
 * Describe HTTP failures with neutral guidance, without exposing request details
 * or response bodies. Status failures include the numeric HTTP status.
 */
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

/**
 * Encode one complete URL path segment. Reject whole dot segments before URL
 * parsing can redirect the request, and report invalid Unicode as a CLI error.
 */
const encodePathSegment = (segment: string) => {
  if (segment === "." || segment === "..") {
    return Effect.fail(
      new CliError.UserError({
        cause: { _tag: "UnrepresentablePathSegment" },
        userMessage:
          "The path parameter cannot be sent as a literal URL segment. Use an identifier other than . or ..; no request was sent.",
      }),
    );
  }

  return Effect.try({
    catch: (cause) =>
      new CliError.UserError({
        cause,
        userMessage:
          "The path parameter contains invalid Unicode. Use valid Unicode text; no request was sent.",
      }),
    try: () => encodeURIComponent(segment),
  });
};

/**
 * Append complete path segments while preserving the base URL path prefix.
 * Encode each segment separately so embedded slashes remain parameter data.
 */
export const appendPathSegments =
  (...segments: readonly string[]) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.forEach(encodePathSegment)(segments).pipe(
      Effect.map((encoded) => HttpClientRequest.appendUrl(request, encoded.join("/"))),
    );

/**
 * Execute a request once and print successful response text. Reject non-2xx
 * statuses and retain typed HTTP causes behind safe CLI messages.
 */
export const runRequest = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.flatMap(Console.log),
    Effect.mapError(
      (cause) => new CliError.UserError({ cause, userMessage: httpErrorMessage(cause.reason) }),
    ),
  );

/**
 * Read the token for the specification's bearerAuth HTTP bearer security scheme
 * as a redacted value. Authentication requires an explicit --bearer-auth flag.
 */
export const bearerAuth = Flag.Redacted("bearer-auth").pipe(
  Flag.withDescription("Bearer token for authentication."),
);
