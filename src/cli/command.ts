import { Effect, FileSystem, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { GenerationError } from "../core/errors.js";
import { OutputError } from "./errors.js";
import { generate } from "../core/generate.js";
import { writeApplication } from "./write.js";

/**
 * Declares the native generator command and its file-read, decode, generate, and write workflow.
 */
export const generatorCommand = Command.make(
  "effect-openapi-cli-generator",
  {
    input: Flag.String("input"),
    name: Flag.String("name").pipe(Flag.optional),
    output: Flag.String("output"),
  },
  ({ input, output, name }) =>
    Effect.gen(function* generateFromFile() {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs
        .readFileString(input)
        .pipe(
          Effect.mapError(
            (error) => new OutputError({ code: "io", message: error.message, path: input }),
          ),
        );
      const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
        text,
      ).pipe(
        Effect.mapError(
          () =>
            new GenerationError({
              code: "invalid_input",
              hint: "",
              location: input,
              message: "Input must be valid JSON",
            }),
        ),
      );
      const application = yield* generate(
        document,
        Option.isSome(name) ? { name: name.value } : undefined,
      );
      yield* writeApplication(application, output);
    }),
);
