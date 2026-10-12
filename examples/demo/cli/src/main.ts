#!/usr/bin/env node

import { Effect, Option, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { executeRequest, pathValue, readBody, validateBaseUrl } from "./runtime.js";

/**
 * Local Demo
 * Users, posts and file metadata served on your machine.
 */
const root = Command.make("local-demo").pipe(
  Command.withDescription("Local Demo\nUsers, posts and file metadata served on your machine."),
  Command.withSharedFlags({
    baseUrl: Flag.String("base-url").pipe(
      Flag.mapEffect((value) =>
        validateBaseUrl(value).pipe(
          Effect.mapError(
            (cause) =>
              new CliError.InvalidValue({
                expected: "HTTP(S) URL without credentials, query or fragment",
                kind: "flag",
                option: "base-url",
                value: cause.value,
              }),
          ),
        ),
      ),
    ),
  }),
);

const filesGetIdArgument = Argument.String("id");

/**
 * Get file metadata (no upload)
 */
const filesGetCommand = Command.make("get", { idArgument: filesGetIdArgument }, (input) =>
  Effect.gen(function* filesGetRequest() {
    const { baseUrl } = yield* root;

    let path = "/files/{id}";

    const query = new URLSearchParams();

    path = path.replace("{id}", yield* pathValue(input.idArgument));

    const suffix = query.toString();

    const url = `${baseUrl}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;

    const body = Option.none();

    yield* executeRequest("GET", url, body);
  }).pipe(
    Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
  ),
).pipe(Command.withDescription("Get file metadata (no upload)"));

const postsCreateBodySchema = Schema.Struct({ published: Schema.Boolean, title: Schema.String });

/**
 * Echo a new post
 */
const postsCreateCommand = Command.make(
  "create",
  {
    body: Flag.String("body").pipe(Flag.optional),
    bodyFile: Flag.String("body-file").pipe(Flag.optional),
  },
  (input) =>
    Effect.gen(function* postsCreateRequest() {
      const { baseUrl } = yield* root;

      const path = "/posts";

      const query = new URLSearchParams();

      const suffix = query.toString();

      const url = `${baseUrl}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;

      const body = yield* readBody(input, true, postsCreateBodySchema);

      yield* executeRequest("POST", url, body);
    }).pipe(
      Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
    ),
).pipe(Command.withDescription("Echo a new post"));

const usersListActiveFlag = Flag.Literals("active", ["true", "false"])
  .pipe(Flag.map((value) => value === "true"))
  .pipe(Flag.optional);

/**
 * List demo users
 */
const usersListCommand = Command.make("list", { activeFlag: usersListActiveFlag }, (input) =>
  Effect.gen(function* usersListRequest() {
    const { baseUrl } = yield* root;

    const path = "/users";

    const query = new URLSearchParams();

    if (Option.isSome(input.activeFlag)) {
      query.append("active", String(input.activeFlag.value));
    }

    const suffix = query.toString();

    const url = `${baseUrl}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;

    const body = Option.none();

    yield* executeRequest("GET", url, body);
  }).pipe(
    Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
  ),
).pipe(Command.withDescription("List demo users"));

const usersGetIdArgument = Argument.String("id");

/**
 * Get a demo user
 */
const usersGetCommand = Command.make("get", { idArgument: usersGetIdArgument }, (input) =>
  Effect.gen(function* usersGetRequest() {
    const { baseUrl } = yield* root;

    let path = "/users/{id}";

    const query = new URLSearchParams();

    path = path.replace("{id}", yield* pathValue(input.idArgument));

    const suffix = query.toString();

    const url = `${baseUrl}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;

    const body = Option.none();

    yield* executeRequest("GET", url, body);
  }).pipe(
    Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
  ),
).pipe(Command.withDescription("Get a demo user"));

const filesGroup = Command.make("files").pipe(Command.withSubcommands([filesGetCommand]));

const postsGroup = Command.make("posts").pipe(Command.withSubcommands([postsCreateCommand]));

const usersGroup = Command.make("users").pipe(
  Command.withSubcommands([usersListCommand, usersGetCommand]),
);

const command = root.pipe(Command.withSubcommands([filesGroup, postsGroup, usersGroup]));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
