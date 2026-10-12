import { Schema } from "effect";

/**
 * Preserves native tagged-error constructor inference.
 */
const tagged = Schema.TaggedError;

/**
 * Identifies an invalid or unsupported generation input with a JSON Pointer and repair hint.
 */
export class GenerationError extends tagged<GenerationError>()("GenerationError", {
  code: Schema.Literals(["invalid_input", "unsupported", "invalid_options", "format"]),
  hint: Schema.String,
  location: Schema.String,
  message: Schema.String,
}) {}
