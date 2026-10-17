#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import * as Commands from "./commands.js";

/**
 * Assemble the API command tree and provide the Node runtime services.
 */
const rootCommand = Command.make("resend-generated").pipe(
  Command.withDescription("Resend is the email platform for developers."),
  Command.withSubcommands([Commands.DomainsCommand, Commands.EmailsCommand]),
);

Command.run(rootCommand, { version: "0.0.0" }).pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
