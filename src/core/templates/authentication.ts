/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError is a schema class factory. */
import { Schema } from "effect";
import { CredentialUnavailable } from "./error-credential-unavailable.js";
import { InvalidBasicCredential } from "./error-invalid-basic-credential.js";
import { BasicEncodingError } from "./error-basic-encoding-error.js";
import { CookieConfigurationError } from "./error-cookie-configuration-error.js";
import { CookieEncodingError } from "./error-cookie-encoding-error.js";
import { ApiKeyPreparationError } from "./error-api-key-preparation-error.js";

export { CredentialUnavailable } from "./error-credential-unavailable.js";

export { InvalidBasicCredential } from "./error-invalid-basic-credential.js";

export { BasicEncodingError } from "./error-basic-encoding-error.js";

export { CookieConfigurationError } from "./error-cookie-configuration-error.js";

export { CookieEncodingError } from "./error-cookie-encoding-error.js";

export { ApiKeyPreparationError } from "./error-api-key-preparation-error.js";

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
