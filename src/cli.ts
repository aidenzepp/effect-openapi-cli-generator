#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Effect, FileSystem, Option, Stdio, Stream } from "effect";
import { Command, Flag } from "effect/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { GenerationError, OutputError } from "./errors.js";
import { generate } from "./index.js";
import { writeApplication } from "./write.js";

export const generatorCommand = Command.make(
  "effect-openapi-cli-generator",
  {
    input: Flag.String("input"),
    output: Flag.String("output"),
    name: Flag.String("name").pipe(Flag.optional),
  },
  ({ input, output, name }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs
        .readFileString(input)
        .pipe(
          Effect.mapError(
            (error) => new OutputError({ code: "io", path: input, message: error.message }),
          ),
        );
      const document: unknown = yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () =>
          new GenerationError({
            code: "invalid_input",
            location: input,
            message: "Input must be valid JSON",
            hint: "",
          }),
      });
      const application = yield* generate(
        document,
        Option.isSome(name) ? { name: name.value } : undefined,
      );
      yield* writeApplication(application, output);
    }),
);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Command.run(generatorCommand, { version: "0.0.0" }).pipe(
    Effect.tapError((error) =>
      Effect.gen(function* () {
        if (error._tag !== "GenerationError" && error._tag !== "OutputError") {
          return;
        }
        const stdio = yield* Stdio.Stdio;
        const location = error._tag === "GenerationError" ? error.location : error.path;
        yield* Stream.make(`${location}: ${error.message.replaceAll("\n", " ")}\n`).pipe(
          Stream.run(stdio.stderr({ endOnDone: false })),
        );
      }),
    ),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
