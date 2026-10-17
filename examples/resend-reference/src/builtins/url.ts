import { Effect, Schema, SchemaIssue } from "effect";
import { CliError, Flag } from "effect/cli";
import { HttpClientRequest } from "effect/http";
import * as Errors from "./errors.js";

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
    "API base URL including any path prefix; for example https://api.example.com",
  ),
);

/**
 * Encode one complete URL path segment. Reject whole dot segments before URL
 * parsing can redirect the request, and report invalid Unicode as a typed path error.
 */
export const encodePathSegment = (segment: string) => {
  if (segment === "." || segment === "..") {
    return Effect.fail(new Errors.PathError({ reason: "DotSegment" }));
  }

  return Effect.try({
    catch: (cause) => new Errors.PathError({ cause, reason: "InvalidUnicode" }),
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
