#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Option } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { filter as filterFlag } from "effect/cli/Flag";
import { HttpClient, HttpClientRequest } from "effect/http";

const baseUrlFlag = Flag.String("base-url").pipe(
  Flag.mapTryCatch(
    (value) => new URL(value),
    () => "Expected an absolute HTTP(S) base URL",
  ),
  filterFlag(
    (url) =>
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    () => "Expected an HTTP(S) base URL without credentials, query, or fragment",
  ),
);

const listUsers = Command.make(
  "list",
  {
    active: Flag.Literals("active", ["true", "false"]).pipe(Flag.optional),
    baseUrl: baseUrlFlag,
  },
  ({ baseUrl, active }) =>
    Effect.gen(function* fetchUsers() {
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const request = HttpClientRequest.get(baseUrl).pipe(
        HttpClientRequest.appendUrl("/users"),
        HttpClientRequest.setUrlParams(Option.isSome(active) ? { active: active.value } : {}),
      );
      const response = yield* client.execute(request);
      yield* Console.log(yield* response.text);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CliError.UserError({
            cause,
            userMessage: `Could not list users: ${cause.message}`,
          }),
      ),
    ),
).pipe(Command.withDescription("List users, optionally filtered by active status"));

const users = Command.make("users").pipe(Command.withSubcommands([listUsers]));

const command = Command.make("users-reference").pipe(Command.withSubcommands([users]));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
