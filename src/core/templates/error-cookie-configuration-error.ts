/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError is a schema class factory. */
import { Schema } from "effect";

// template:body
/**
 * Native cookie validation rejected API-key preparation or an existing cookie.
 */
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
