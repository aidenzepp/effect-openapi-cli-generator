/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError is a schema class factory. */
import { Schema } from "effect";

// template:body
/**
 * A Basic field failed its native transport schema, without retaining the input.
 */
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
