import { Schema } from "effect";

const tagged = Schema.TaggedError;

export class GenerationError extends tagged<GenerationError>()("GenerationError", {
  code: Schema.Literals(["invalid_input", "unsupported", "invalid_options", "format"]),
  hint: Schema.String,
  location: Schema.String,
  message: Schema.String,
}) {}

export class OutputError extends tagged<OutputError>()("OutputError", {
  code: Schema.Literals(["exists", "io"]),
  message: Schema.String,
  path: Schema.String,
}) {}
