import { Schema } from "effect";

export class GenerationError extends Schema.TaggedError<GenerationError>()("GenerationError", {
  code: Schema.Literals(["invalid_input", "unsupported", "invalid_options", "format"]),
  hint: Schema.String,
  location: Schema.String,
  message: Schema.String,
}) {}

export class OutputError extends Schema.TaggedError<OutputError>()("OutputError", {
  code: Schema.Literals(["exists", "io"]),
  message: Schema.String,
  path: Schema.String,
}) {}
