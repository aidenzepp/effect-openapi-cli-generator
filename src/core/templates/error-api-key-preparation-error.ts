/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError is a schema class factory. */
import { Schema } from "effect";

// template:body
/**
 * Local header or query API-key construction failed before execution. Wire
 * validation may still be deferred until execution when preparation succeeds.
 */
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
