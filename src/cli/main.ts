import { Effect, Stdio, Stream } from "effect";
import { Command } from "effect/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { generatorCommand } from "./command.js";

/**
 * Runs the generator with Node services and renders location-bearing failures.
 */
export const main = () => {
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
};
