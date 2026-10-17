import { Match, Schema } from "effect";
import { CliError } from "effect/cli";
import type { HttpClientError } from "effect/http";

/**
 * A path value that cannot be transported literally without changing its meaning.
 * The rejected value is never stored in the error.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Native schema class factory, not an error throw.
export class PathError extends Schema.TaggedError<PathError>()("PathError", {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.Literals(["DotSegment", "InvalidUnicode"]),
}) {}

/**
 * A Basic credential field could not be read or validated, or the native encoder
 * could not represent the pair. Credential values and raw causes are excluded.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Native schema class factory, not an error throw.
export class BasicAuthenticationError extends Schema.TaggedError<BasicAuthenticationError>()(
  "BasicAuthenticationError",
  {
    reason: Schema.Literals([
      "UsernameUnavailable",
      "PasswordUnavailable",
      "UsernameInvalid",
      "PasswordInvalid",
      "Encoding",
    ]),
  },
) {}

/**
 * An API key could not be prepared at its configured transport location.
 * The reason describes a local stage, never a server's credential decision.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Native schema class factory, not an error throw.
export class ApiKeyAuthenticationError extends Schema.TaggedError<ApiKeyAuthenticationError>()(
  "ApiKeyAuthenticationError",
  {
    location: Schema.Literals(["header", "query", "cookie"]),
    reason: Schema.Literals([
      "CredentialUnavailable",
      "InvalidConfiguration",
      "Encoding",
      "Preparation",
    ]),
  },
) {}

/**
 * Give field-specific Basic recovery guidance without showing supplied values.
 */
const basicErrorMessage = (reason: BasicAuthenticationError["reason"]): string =>
  Match.value(reason).pipe(
    Match.when(
      "UsernameUnavailable",
      () =>
        "The Basic authentication username is unavailable. Supply the username again; no request was sent.",
    ),
    Match.when(
      "PasswordUnavailable",
      () =>
        "The Basic authentication password is unavailable. Supply the password again; no request was sent.",
    ),
    Match.when(
      "UsernameInvalid",
      () =>
        "The Basic authentication username is invalid. Remove colons and control characters; no request was sent.",
    ),
    Match.when(
      "PasswordInvalid",
      () =>
        "The Basic authentication password is invalid. Remove control characters; no request was sent.",
    ),
    Match.when(
      "Encoding",
      () =>
        "Basic authentication could not be encoded. Use credentials containing only characters supported by Basic authentication encoding; no request was sent.",
    ),
    Match.exhaustive,
  );

/**
 * Identify the configured API-key location and failed local preparation stage.
 * Header and query wire validation may still occur during HTTP execution.
 */
const apiKeyErrorMessage = (error: ApiKeyAuthenticationError): string =>
  Match.value(error.reason).pipe(
    Match.when(
      "CredentialUnavailable",
      () =>
        `The API key for ${error.location} authentication is unavailable. Supply the credential again; no request was sent.`,
    ),
    Match.when(
      "InvalidConfiguration",
      () =>
        `The API key for ${error.location} authentication could not be prepared. Check its configured name and existing ${error.location} values; no request was sent.`,
    ),
    Match.when(
      "Encoding",
      () =>
        `The API key for ${error.location} authentication could not be encoded. Use valid Unicode in the credential and existing ${error.location} values; no request was sent.`,
    ),
    Match.when(
      "Preparation",
      () =>
        `The API key for ${error.location} authentication could not be prepared. Check its configuration; no request was sent.`,
    ),
    Match.exhaustive,
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
 * Convert transport failures at the command boundary to safe CLI messages.
 * Preserve native HTTP causes and already-safe CLI errors without reformatting.
 */
export const toCliError = (
  cause:
    | PathError
    | BasicAuthenticationError
    | ApiKeyAuthenticationError
    | HttpClientError.HttpClientError
    | CliError.UserError,
) =>
  Match.value(cause).pipe(
    Match.tagsExhaustive({
      ApiKeyAuthenticationError: (error) =>
        new CliError.UserError({ cause: error, userMessage: apiKeyErrorMessage(error) }),
      BasicAuthenticationError: (error) =>
        new CliError.UserError({ cause: error, userMessage: basicErrorMessage(error.reason) }),
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
