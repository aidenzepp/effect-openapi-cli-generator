import { Schema } from "effect";

export class GenerationError extends Schema.TaggedError<GenerationError>()("GenerationError", {
  code: Schema.Literals(["invalid_input", "unsupported", "invalid_options", "format"]),
  location: Schema.String,
  message: Schema.String,
  hint: Schema.String,
}) {}
