#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import * as Commands from "./commands.js";

/**
 * Assemble the API command tree and provide the Node runtime services.
 */
const rootCommand = Command.make("local-demo").pipe(
  Command.withDescription("Users, posts and file metadata served on your machine."),
  Command.withSubcommands([Commands.FilesCommand, Commands.PostsCommand, Commands.UsersCommand]),
);

Command.run(rootCommand, { version: "0.0.0" }).pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
