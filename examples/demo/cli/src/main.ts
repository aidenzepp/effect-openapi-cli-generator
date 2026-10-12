#!/usr/bin/env node

import { Config, Effect, Option, Schema } from "effect";

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

const parameter0_0 = Argument.String("id");

/**
 * Get file metadata (no upload)
 */
const operation0 = Command.make("get", { value0: parameter0_0 }, (input) =>
  Effect.gen(function* runOperation0() {
    const { baseUrl } = yield* root;
    const base = yield* Config.succeed(baseUrl);
    let path = "/files/{id}";
    const query = new URLSearchParams();
    path = path.replace("{id}", yield* pathValue(input.value0));
    const suffix = query.toString();
    const url = `${base}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;
    const body = Option.none();
    yield* executeRequest("GET", url, body);
  }).pipe(
    Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
  ),
).pipe(Command.withDescription("Get file metadata (no upload)"));

const schema1 = Schema.Struct({ published: Schema.Boolean, title: Schema.String });

/**
 * Echo a new post
 */
const operation1 = Command.make(
  "create",
  {
    body: Flag.String("body").pipe(Flag.optional),
    bodyFile: Flag.String("body-file").pipe(Flag.optional),
  },
  (input) =>
    Effect.gen(function* runOperation1() {
      const { baseUrl } = yield* root;
      const base = yield* Config.succeed(baseUrl);
      const path = "/posts";
      const query = new URLSearchParams();
      const suffix = query.toString();
      const url = `${base}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;
      const body = yield* readBody(input, true, schema1);
      yield* executeRequest("POST", url, body);
    }).pipe(
      Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
    ),
).pipe(Command.withDescription("Echo a new post"));

const parameter2_0 = Flag.Literals("active", ["true", "false"])
  .pipe(Flag.map((value) => value === "true"))
  .pipe(Flag.optional);

/**
 * List demo users
 */
const operation2 = Command.make("list", { value0: parameter2_0 }, (input) =>
  Effect.gen(function* runOperation2() {
    const { baseUrl } = yield* root;
    const base = yield* Config.succeed(baseUrl);
    const path = "/users";
    const query = new URLSearchParams();
    if (Option.isSome(input.value0)) {
      query.append("active", String(input.value0.value));
    }
    const suffix = query.toString();
    const url = `${base}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;
    const body = Option.none();
    yield* executeRequest("GET", url, body);
  }).pipe(
    Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
  ),
).pipe(Command.withDescription("List demo users"));

const parameter3_0 = Argument.String("id");

/**
 * Get a demo user
 */
const operation3 = Command.make("get", { value0: parameter3_0 }, (input) =>
  Effect.gen(function* runOperation3() {
    const { baseUrl } = yield* root;
    const base = yield* Config.succeed(baseUrl);
    let path = "/users/{id}";
    const query = new URLSearchParams();
    path = path.replace("{id}", yield* pathValue(input.value0));
    const suffix = query.toString();
    const url = `${base}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;
    const body = Option.none();
    yield* executeRequest("GET", url, body);
  }).pipe(
    Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
  ),
).pipe(Command.withDescription("Get a demo user"));

const group0 = Command.make("files").pipe(Command.withSubcommands([operation0]));

const group1 = Command.make("posts").pipe(Command.withSubcommands([operation1]));

const group2 = Command.make("users").pipe(Command.withSubcommands([operation2, operation3]));

const command = root.pipe(Command.withSubcommands([group0, group1, group2]));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
