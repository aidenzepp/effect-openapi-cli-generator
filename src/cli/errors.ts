import { Schema } from "effect";

/**
 * Preserves native tagged-error constructor inference.
 */
const tagged = Schema.TaggedError;

/**
 * Identifies an IO failure or an existing destination without changing unrelated files.
 */
export class OutputError extends tagged<OutputError>()("OutputError", {
  code: Schema.Literals(["exists", "io"]),
  message: Schema.String,
  path: Schema.String,
}) {}
