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
 * A redacted credential was erased or is otherwise unavailable. Basic fields
 * and API-key locations are represented separately without retaining secrets.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Native schema class factory, not an error throw.
export class CredentialUnavailable extends Schema.TaggedError<CredentialUnavailable>()(
  "CredentialUnavailable",
  {
    credential: Schema.Union([
      Schema.Struct({
        field: Schema.Literals(["username", "password"]),
        mechanism: Schema.Literal("basic"),
      }),
      Schema.Struct({
        location: Schema.Literals(["header", "query", "cookie"]),
        mechanism: Schema.Literal("apiKey"),
      }),
    ]),
  },
) {
  /**
   * Identify the missing credential field or location without showing its value.
   */
  override get message(): string {
    if (this.credential.mechanism === "basic") {
      return `The Basic authentication ${this.credential.field} is unavailable. Supply the ${this.credential.field} again; no request was sent.`;
    }

    return `The API key for ${this.credential.location} authentication is unavailable. Supply the credential again; no request was sent.`;
  }
}

/**
 * A Basic field failed its native transport schema, without retaining the input.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Native schema class factory, not an error throw.
export class InvalidBasicCredential extends Schema.TaggedError<InvalidBasicCredential>()(
  "InvalidBasicCredential",
  {
    field: Schema.Literals(["username", "password"]),
  },
) {
  /**
   * Describe the transport restriction belonging to the invalid field.
   */
  override get message(): string {
    return this.field === "username"
      ? "The Basic authentication username is invalid. Remove colons and control characters; no request was sent."
      : "The Basic authentication password is invalid. Remove control characters; no request was sent.";
  }
}

/**
 * Validated Basic fields could not be represented by the native encoder.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Native schema class factory, not an error throw.
export class BasicEncodingError extends Schema.TaggedError<BasicEncodingError>()(
  "BasicEncodingError",
  {},
) {
  /**
   * Explain the encoding limitation without exposing either credential.
   */
  // oxlint-disable-next-line class-methods-use-this -- Overrides the native Error instance message contract.
  override get message(): string {
    return "Basic authentication could not be encoded. Use credentials containing only characters supported by Basic authentication encoding; no request was sent.";
  }
}

/**
 * Native cookie validation rejected API-key preparation or an existing cookie.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Native schema class factory, not an error throw.
export class CookieConfigurationError extends Schema.TaggedError<CookieConfigurationError>()(
  "CookieConfigurationError",
  {},
) {
  /**
   * Direct configuration repair without revealing the configured cookie name.
   */
  // oxlint-disable-next-line class-methods-use-this -- Overrides the native Error instance message contract.
  override get message(): string {
    return "The API key for cookie authentication could not be prepared. Check its configured name and existing cookie values; no request was sent.";
  }
}

/**
 * A cookie value could not be URI-encoded during API-key preparation.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Native schema class factory, not an error throw.
export class CookieEncodingError extends Schema.TaggedError<CookieEncodingError>()(
  "CookieEncodingError",
  {},
) {
  /**
   * Request valid Unicode without reproducing cookie values.
   */
  // oxlint-disable-next-line class-methods-use-this -- Overrides the native Error instance message contract.
  override get message(): string {
    return "The API key for cookie authentication could not be encoded. Use valid Unicode in the credential and existing cookie values; no request was sent.";
  }
}

/**
 * Local header or query API-key construction failed before execution. Wire
 * validation may still be deferred until execution when preparation succeeds.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Native schema class factory, not an error throw.
export class ApiKeyPreparationError extends Schema.TaggedError<ApiKeyPreparationError>()(
  "ApiKeyPreparationError",
  {
    location: Schema.Literals(["header", "query"]),
  },
) {
  /**
   * Identify the configured location and its preparation boundary.
   */
  override get message(): string {
    return `The API key for ${this.location} authentication could not be prepared. Check its configuration; no request was sent.`;
  }
}

/**
 * Supported local authentication failures, each with its own safe message.
 */
export const AuthenticationErrorReason = Schema.Union([
  CredentialUnavailable,
  InvalidBasicCredential,
  BasicEncodingError,
  CookieConfigurationError,
  CookieEncodingError,
  ApiKeyPreparationError,
]);

/**
 * Authentication preparation failed for a structured, secret-free reason.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Native schema class factory, not an error throw.
export class AuthenticationError extends Schema.TaggedError<AuthenticationError>()(
  "AuthenticationError",
  {
    reason: AuthenticationErrorReason,
  },
) {
  /**
   * Preserve the reason's owned message at the authentication boundary.
   */
  override get message(): string {
    return this.reason.message;
  }
}

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
  cause: PathError | AuthenticationError | HttpClientError.HttpClientError | CliError.UserError,
) =>
  Match.value(cause).pipe(
    Match.tagsExhaustive({
      AuthenticationError: (error) =>
        new CliError.UserError({ cause: error, userMessage: error.message }),
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
