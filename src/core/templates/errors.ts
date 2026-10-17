/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError is a schema class factory. */
import { Match, Schema } from "effect";
import { CliError } from "effect/cli";
import type { HttpClientError } from "effect/http";

/**
 * No authentication preparation failure is needed in the base template.
 */
type TransportFailure = PathError | HttpClientError.HttpClientError | CliError.UserError;

// template:body
/**
 * A path value that cannot be transported literally without changing its meaning.
 * The rejected value is never stored in the error.
 */
export class PathError extends Schema.TaggedError<PathError>()("PathError", {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.Literals(["DotSegment", "InvalidUnicode"]),
}) {}

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

/* template:authentication-declarations */

/**
 * Convert transport failures at the command boundary to safe CLI messages.
 * Preserve native HTTP causes and already-safe CLI errors without reformatting.
 */
export const toCliError = (cause: TransportFailure) =>
  Match.value(cause).pipe(
    Match.tagsExhaustive({
      /* template:authentication-case */
      HttpClientError: (error) =>
        new CliError.UserError({ cause: error, userMessage: httpErrorMessage(error.reason) }),
      PathError: (error) =>
        new CliError.UserError({
          cause: error,
          userMessage:
            error.reason === "DotSegment"
              ? "The path parameter cannot be sent as a literal URL segment. Use an identifier other than . or ..; no request was sent."
              : "The path parameter contains invalid Unicode. Use valid Unicode text; no request was sent.",
        }),
      UserError: (error) => error,
    }),
  );
