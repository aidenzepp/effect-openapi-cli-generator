/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError is a schema class factory. */
import { Schema } from "effect";

// template:body
/**
 * Validated Basic fields could not be represented by the native encoder.
 */
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
