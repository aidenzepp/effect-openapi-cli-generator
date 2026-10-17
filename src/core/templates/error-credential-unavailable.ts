/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError is a schema class factory. */
import { Schema } from "effect";

// template:body
/**
 * A redacted credential was erased or is otherwise unavailable. Basic fields
 * and API-key locations are represented separately without retaining secrets.
 */
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
