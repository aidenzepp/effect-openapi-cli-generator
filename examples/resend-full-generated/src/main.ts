#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import * as Commands from "./commands.js";

/**
 * Assemble the API command tree and provide the Node runtime services.
 */
const rootCommand = Command.make("resend-full-generated").pipe(
  Command.withDescription("Resend is the email platform for developers."),
  Command.withSubcommands([
    Commands.ApiKeysCommand,
    Commands.AudiencesCommand,
    Commands.AutomationsCommand,
    Commands.BroadcastsCommand,
    Commands.ContactPropertiesCommand,
    Commands.ContactsCommand,
    Commands.DomainsCommand,
    Commands.EmailsCommand,
    Commands.EventsCommand,
    Commands.LogsCommand,
    Commands.OauthCommand,
    Commands.SegmentsCommand,
    Commands.SuppressionsCommand,
    Commands.TemplatesCommand,
    Commands.TopicsCommand,
    Commands.UsageCommand,
    Commands.WebhooksCommand,
  ]),
);

Command.run(rootCommand, { version: "0.0.0" }).pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
