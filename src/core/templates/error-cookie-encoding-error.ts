/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError is a schema class factory. */
import { Schema } from "effect";

// template:body
/**
 * A cookie value could not be URI-encoded during API-key preparation.
 */
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
