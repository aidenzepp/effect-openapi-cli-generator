#!/usr/bin/env node

import { Config, Effect, Option, Schema } from "effect";

import { Argument, CliError, Command, Flag } from "effect/cli";

import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";

import { executeRequest, pathValue, readBody, validateBaseUrl } from "./runtime.js";

/**
 * Sample API
 * quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const root = Command.make("sample-api").pipe(
  Command.withDescription(`Sample API
quote" \` \${globalThis.injected = true} */
@tag`),
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

const operation0 = Command.make("read", {}, () =>
  Effect.gen(function* runOperation0() {
    const { baseUrl } = yield* root;
    const base = yield* Config.succeed(baseUrl);
    const path = "/alias";
    const query = new URLSearchParams();
    const suffix = query.toString();
    const url = `${base}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;
    const body = Option.none();
    yield* executeRequest("POST", url, body);
  }).pipe(
    Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
  ),
).pipe(Command.withDescription(""));

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter1_0 = Flag.String("parent").pipe(
  Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter1_1 = Flag.String("id").pipe(
  Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter1_2 = Flag.Literals("enabled", ["true", "false"])
  .pipe(Flag.map((value) => value === "true"))
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter1_3 = Flag.Int("count")
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter1_4 = Flag.String("wire-name")
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const operation1 = Command.make(
  "bulk-update",
  {
    value0: parameter1_0,
    value1: parameter1_1,
    value2: parameter1_2,
    value3: parameter1_3,
    value4: parameter1_4,
  },
  (input) =>
    Effect.gen(function* runOperation1() {
      const { baseUrl } = yield* root;
      const base = yield* Config.succeed(baseUrl);
      let path = "/bulk/{parent}/{id}";
      const query = new URLSearchParams();
      path = path.replace("{parent}", yield* pathValue(input.value0));
      path = path.replace("{id}", yield* pathValue(input.value1));
      if (Option.isSome(input.value2)) {
        query.append("enabled", String(input.value2.value));
      }
      if (Option.isSome(input.value3)) {
        query.append("count", String(input.value3.value));
      }
      if (Option.isSome(input.value4)) {
        query.append("wire_name", input.value4.value);
      }
      const suffix = query.toString();
      const url = `${base}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;
      const body = Option.none();
      yield* executeRequest("POST", url, body);
    }).pipe(
      Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
    ),
).pipe(
  Command.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

const operation2 = Command.make("get", {}, () =>
  Effect.gen(function* runOperation2() {
    const { baseUrl } = yield* root;
    const base = yield* Config.succeed(baseUrl);
    const path = "/empty";
    const query = new URLSearchParams();
    const suffix = query.toString();
    const url = `${base}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;
    const body = Option.none();
    yield* executeRequest("GET", url, body);
  }).pipe(
    Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
  ),
).pipe(Command.withDescription(""));

const operation3 = Command.make("get", {}, () =>
  Effect.gen(function* runOperation3() {
    const { baseUrl } = yield* root;
    const base = yield* Config.succeed(baseUrl);
    const path = "/failure";
    const query = new URLSearchParams();
    const suffix = query.toString();
    const url = `${base}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;
    const body = Option.none();
    yield* executeRequest("GET", url, body);
  }).pipe(
    Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
  ),
).pipe(Command.withDescription(""));

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter4_0 = Flag.String("parent").pipe(
  Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter4_1 = Flag.String("id").pipe(
  Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter4_2 = Flag.Literals("enabled", ["true", "false"])
  .pipe(Flag.map((value) => value === "true"))
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter4_3 = Flag.Int("count")
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter4_4 = Flag.String("wire-name")
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const operation4 = Command.make(
  "list",
  {
    value0: parameter4_0,
    value1: parameter4_1,
    value2: parameter4_2,
    value3: parameter4_3,
    value4: parameter4_4,
  },
  (input) =>
    Effect.gen(function* runOperation4() {
      const { baseUrl } = yield* root;
      const base = yield* Config.succeed(baseUrl);
      let path = "/list/{parent}/{id}";
      const query = new URLSearchParams();
      path = path.replace("{parent}", yield* pathValue(input.value0));
      path = path.replace("{id}", yield* pathValue(input.value1));
      if (Option.isSome(input.value2)) {
        query.append("enabled", String(input.value2.value));
      }
      if (Option.isSome(input.value3)) {
        query.append("count", String(input.value3.value));
      }
      if (Option.isSome(input.value4)) {
        query.append("wire_name", input.value4.value);
      }
      const suffix = query.toString();
      const url = `${base}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;
      const body = Option.none();
      yield* executeRequest("GET", url, body);
    }).pipe(
      Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
    ),
).pipe(
  Command.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter5_0 = Flag.String("parent").pipe(
  Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter5_1 = Argument.String("id").pipe(
  Argument.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter5_2 = Flag.Literals("enabled", ["true", "false"])
  .pipe(Flag.map((value) => value === "true"))
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter5_3 = Flag.Int("count")
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter5_4 = Flag.String("wire-name")
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

const schema5 = Schema.StructWithRest(
  Schema.Struct({
    ["__proto__"]: Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({}), [Schema.Record(Schema.String, Schema.Json)]),
    ),
    /**
     * Quote" ` ${globalThis.injected = true} *\/
     * \@tag
     * Deprecated.
     *
     * @deprecated
     * @see https://example.test
     */
    // oxlint-disable-next-line typescript/no-deprecated -- Required schema registration for a supported deprecated API field.
    enabled: Schema.optionalKey(Schema.Boolean),
    nested: Schema.optionalKey(Schema.Struct({ value: Schema.optionalKey(Schema.Int) })),
    nullable: Schema.optionalKey(Schema.NullOr(Schema.Literals(["yes"]))),
    /**
     * Quote" ` ${globalThis.injected = true} *\/
     * \@tag
     */
    [`quote" \` \${globalThis.injected = true} */
@tag`]: Schema.optionalKey(
      Schema.Literals([
        `quote" \` \${globalThis.injected = true} */
@tag`,
      ]),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const operation5 = Command.make(
  "get",
  {
    body: Flag.String("body").pipe(Flag.optional),
    bodyFile: Flag.String("body-file").pipe(Flag.optional),
    value0: parameter5_0,
    value1: parameter5_1,
    value2: parameter5_2,
    value3: parameter5_3,
    value4: parameter5_4,
  },
  (input) =>
    Effect.gen(function* runOperation5() {
      const { baseUrl } = yield* root;
      const base = yield* Config.succeed(baseUrl);
      let path = "/parents/{parent}/items/{id}";
      const query = new URLSearchParams();
      path = path.replace("{parent}", yield* pathValue(input.value0));
      path = path.replace("{id}", yield* pathValue(input.value1));
      if (Option.isSome(input.value2)) {
        query.append("enabled", String(input.value2.value));
      }
      if (Option.isSome(input.value3)) {
        query.append("count", String(input.value3.value));
      }
      if (Option.isSome(input.value4)) {
        query.append("wire_name", input.value4.value);
      }
      const suffix = query.toString();
      const url = `${base}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;
      const body = yield* readBody(input, false, schema5);
      yield* executeRequest("POST", url, body);
    }).pipe(
      Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
    ),
).pipe(
  Command.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const parameter6_0 = Flag.Literals("confirm", ["true", "false"])
  .pipe(Flag.map((value) => value === "true"))
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  );

const schema6 = Schema.Struct({ value: Schema.Int });

const operation6 = Command.make(
  "send",
  {
    body: Flag.String("body").pipe(Flag.optional),
    bodyFile: Flag.String("body-file").pipe(Flag.optional),
    value0: parameter6_0,
  },
  (input) =>
    Effect.gen(function* runOperation6() {
      const { baseUrl } = yield* root;
      const base = yield* Config.succeed(baseUrl);
      const path = "/required";
      const query = new URLSearchParams();
      query.append("confirm", String(input.value0));
      const suffix = query.toString();
      const url = `${base}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;
      const body = yield* readBody(input, true, schema6);
      yield* executeRequest("POST", url, body);
    }).pipe(
      Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
    ),
).pipe(Command.withDescription(""));

const group0 = Command.make("items").pipe(
  Command.withSubcommands([operation1, operation4, operation5]),
);

const group1 = Command.make("deep").pipe(Command.withSubcommands([group0]));

const group2 = Command.make("deep").pipe(Command.withSubcommands([operation0]));

const group3 = Command.make("account").pipe(Command.withSubcommands([group1]));

const group4 = Command.make("alternate").pipe(Command.withSubcommands([group2]));

const group5 = Command.make("empty").pipe(Command.withSubcommands([operation2]));

const group6 = Command.make("failure").pipe(Command.withSubcommands([operation3]));

const group7 = Command.make("required").pipe(Command.withSubcommands([operation6]));

const command = root.pipe(Command.withSubcommands([group3, group4, group5, group6, group7]));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
