#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Option, Schema, Stdio, Stream } from "effect";
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

const [, invokedPath] = process.argv;
const isEntryPoint =
  invokedPath !== undefined && invokedPath !== ""
    ? await Effect.gen(function* isEntryPointEffect2() {
        const fs = yield* FileSystem.FileSystem;
        const invoked = yield* fs.realPath(invokedPath);
        // oxlint-disable-next-line unicorn/prefer-import-meta-properties -- fileURLToPath supports the existing Node ESM runtime floor.
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
    Effect.tapError((failure) =>
      Effect.gen(function* writeDiagnostic() {
        if (failure._tag !== "GenerationError" && failure._tag !== "OutputError") {
          return;
        }
        const stdio = yield* Stdio.Stdio;
        const location = failure._tag === "GenerationError" ? failure.location : failure.path;
        yield* Stream.make(`${location}: ${failure.message.replaceAll("\n", " ")}\n`).pipe(
          Stream.run(stdio.stderr({ endOnDone: false })),
        );
      }),
    ),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
