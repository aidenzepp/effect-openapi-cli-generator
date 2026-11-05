import { Command } from "effect/cli";

/**
 * Root command of the generator CLI.
 */
export const root = Command.make("effect-openapi-cli-generator");

/**
 * Runs the root command with the arguments supplied by the `Stdio` service.
 */
export const main = Command.run(root, { version: "0.0.0" });
