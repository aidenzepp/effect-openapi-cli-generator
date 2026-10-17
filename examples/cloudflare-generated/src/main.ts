#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import * as Commands from "./commands.js";

/**
 * Assemble the API command tree and provide the Node runtime services.
 */
const rootCommand = Command.make("cloudflare-api").pipe(
  Command.withDescription(
    "Welcome to Cloudflare's API documentation site. We are experimenting with an updated version of our API documentation - check out [developers.cloudflare.com/api-next/](https://developers.cloudflare.com/api-next/) to test out the new experience.\n\nTo get started using Cloudflare's products and services via the API, refer to [how to interact with Cloudflare](https://developers.cloudflare.com/fundamentals/basic-tasks/interact-with-cloudflare/), which covers using tools like [Terraform](https://developers.cloudflare.com/terraform/#cloudflare-terraform) and the [official SDKs](https://developers.cloudflare.com/fundamentals/api/reference/sdks/) to maintain your Cloudflare resources.\n\nUsing the Cloudflare API requires authentication so that Cloudflare knows who is making requests and what permissions you have. Create an API token to grant access to the API to perform actions. You can also authenticate with [API keys](https://developers.cloudflare.com/fundamentals/api/get-started/keys/), but these keys have [several limitations](https://developers.cloudflare.com/fundamentals/api/get-started/keys/#limitations) that make them less secure than API tokens. Whenever possible, use API tokens to interact with the Cloudflare API.\n\nTo create an API token, from the Cloudflare dashboard, go to My Profile > API Tokens and select Create Token. For more information on how to create and troubleshoot API tokens, refer to\nour [API fundamentals](https://developers.cloudflare.com/fundamentals/api/).\n\nFor information regarding rate limits, refer to our [API Rate Limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/limits/#api-rate-limits).\n\nTotally new to Cloudflare? [Start here](https://developers.cloudflare.com/fundamentals/get-started/).",
  ),
  Command.withSubcommands([Commands.UserCommand]),
);

Command.run(rootCommand, { version: "0.0.0" }).pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
