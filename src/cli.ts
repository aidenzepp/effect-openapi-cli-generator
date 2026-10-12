#!/usr/bin/env node
import { fileURLToPath } from "node:url";
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
    name: Flag.String("name").pipe(Flag.optional),
    output: Flag.String("output"),
  },
  ({ input, output, name }) =>
    Effect.gen(function* generatorCommandEffect1() {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs
        .readFileString(input)
        .pipe(
          Effect.mapError(
            (error) => new OutputError({ code: "io", message: error.message, path: input }),
          ),
        );
      const document: unknown = yield* Effect.try({
        catch: () =>
          new GenerationError({
            code: "invalid_input",
            hint: "",
            location: input,
            message: "Input must be valid JSON",
          }),
        try: () => JSON.parse(text) as unknown,
      });
      const application = yield* generate(
        document,
        Option.isSome(name) ? { name: name.value } : undefined,
      );
      yield* writeApplication(application, output);
    }),
);

const invokedPath = process.argv[1];
const isEntryPoint = invokedPath
  ? await Effect.gen(function* isEntryPointEffect2() {
      const fs = yield* FileSystem.FileSystem;
      const invoked = yield* fs.realPath(invokedPath);
      const module = yield* fs.realPath(fileURLToPath(import.meta.url));
      return invoked === module;
    }).pipe(
      Effect.orElseSucceed(() => false),
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    )
  : false;

if (isEntryPoint) {
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
