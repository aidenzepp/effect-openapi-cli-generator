#!/usr/bin/env node

import { Effect, Option, Schema } from "effect";
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

const alternateDeepReadCommand = Command.make("read", {}, () =>
  Effect.gen(function* alternateDeepReadRequest() {
    const { baseUrl } = yield* root;

    const path = "/alias";

    const query = new URLSearchParams();

    const suffix = query.toString();

    const url = `${baseUrl}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;

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
const accountDeepItemsBulkUpdateParentFlag = Flag.String("parent").pipe(
  Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const accountDeepItemsBulkUpdateIdFlag = Flag.String("id").pipe(
  Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const accountDeepItemsBulkUpdateEnabledFlag = Flag.Literals("enabled", ["true", "false"])
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
const accountDeepItemsBulkUpdateCountFlag = Flag.Int("count")
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const accountDeepItemsBulkUpdateWireNameFlag = Flag.String("wire-name")
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const accountDeepItemsBulkUpdateCommand = Command.make(
  "bulk-update",
  {
    countFlag: accountDeepItemsBulkUpdateCountFlag,
    enabledFlag: accountDeepItemsBulkUpdateEnabledFlag,
    idFlag: accountDeepItemsBulkUpdateIdFlag,
    parentFlag: accountDeepItemsBulkUpdateParentFlag,
    "wire-nameFlag": accountDeepItemsBulkUpdateWireNameFlag,
  },
  (input) =>
    Effect.gen(function* accountDeepItemsBulkUpdateRequest() {
      const { baseUrl } = yield* root;

      let path = "/bulk/{parent}/{id}";

      const query = new URLSearchParams();

      path = path.replace("{parent}", yield* pathValue(input.parentFlag));

      path = path.replace("{id}", yield* pathValue(input.idFlag));

      if (Option.isSome(input.enabledFlag)) {
        query.append("enabled", String(input.enabledFlag.value));
      }

      if (Option.isSome(input.countFlag)) {
        query.append("count", String(input.countFlag.value));
      }

      if (Option.isSome(input["wire-nameFlag"])) {
        query.append("wire_name", input["wire-nameFlag"].value);
      }

      const suffix = query.toString();

      const url = `${baseUrl}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;

      const body = Option.none();

      yield* executeRequest("POST", url, body);
    }).pipe(
      Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
    ),
).pipe(
  Command.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

const emptyGetCommand = Command.make("get", {}, () =>
  Effect.gen(function* emptyGetRequest() {
    const { baseUrl } = yield* root;

    const path = "/empty";

    const query = new URLSearchParams();

    const suffix = query.toString();

    const url = `${baseUrl}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;

    const body = Option.none();

    yield* executeRequest("GET", url, body);
  }).pipe(
    Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
  ),
).pipe(Command.withDescription(""));

const failureGetCommand = Command.make("get", {}, () =>
  Effect.gen(function* failureGetRequest() {
    const { baseUrl } = yield* root;

    const path = "/failure";

    const query = new URLSearchParams();

    const suffix = query.toString();

    const url = `${baseUrl}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;

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
const accountDeepItemsListParentFlag = Flag.String("parent").pipe(
  Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const accountDeepItemsListIdFlag = Flag.String("id").pipe(
  Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const accountDeepItemsListEnabledFlag = Flag.Literals("enabled", ["true", "false"])
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
const accountDeepItemsListCountFlag = Flag.Int("count")
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const accountDeepItemsListWireNameFlag = Flag.String("wire-name")
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const accountDeepItemsListCommand = Command.make(
  "list",
  {
    countFlag: accountDeepItemsListCountFlag,
    enabledFlag: accountDeepItemsListEnabledFlag,
    idFlag: accountDeepItemsListIdFlag,
    parentFlag: accountDeepItemsListParentFlag,
    "wire-nameFlag": accountDeepItemsListWireNameFlag,
  },
  (input) =>
    Effect.gen(function* accountDeepItemsListRequest() {
      const { baseUrl } = yield* root;

      let path = "/list/{parent}/{id}";

      const query = new URLSearchParams();

      path = path.replace("{parent}", yield* pathValue(input.parentFlag));

      path = path.replace("{id}", yield* pathValue(input.idFlag));

      if (Option.isSome(input.enabledFlag)) {
        query.append("enabled", String(input.enabledFlag.value));
      }

      if (Option.isSome(input.countFlag)) {
        query.append("count", String(input.countFlag.value));
      }

      if (Option.isSome(input["wire-nameFlag"])) {
        query.append("wire_name", input["wire-nameFlag"].value);
      }

      const suffix = query.toString();

      const url = `${baseUrl}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;

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
const accountDeepItemsGetParentFlag = Flag.String("parent").pipe(
  Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const accountDeepItemsGetIdArgument = Argument.String("id").pipe(
  Argument.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const accountDeepItemsGetEnabledFlag = Flag.Literals("enabled", ["true", "false"])
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
const accountDeepItemsGetCountFlag = Flag.Int("count")
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const accountDeepItemsGetWireNameFlag = Flag.String("wire-name")
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  )
  .pipe(Flag.optional);

const accountDeepItemsGetBodySchema = Schema.StructWithRest(
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
const accountDeepItemsGetCommand = Command.make(
  "get",
  {
    body: Flag.String("body").pipe(Flag.optional),
    bodyFile: Flag.String("body-file").pipe(Flag.optional),
    countFlag: accountDeepItemsGetCountFlag,
    enabledFlag: accountDeepItemsGetEnabledFlag,
    idArgument: accountDeepItemsGetIdArgument,
    parentFlag: accountDeepItemsGetParentFlag,
    "wire-nameFlag": accountDeepItemsGetWireNameFlag,
  },
  (input) =>
    Effect.gen(function* accountDeepItemsGetRequest() {
      const { baseUrl } = yield* root;

      let path = "/parents/{parent}/items/{id}";

      const query = new URLSearchParams();

      path = path.replace("{parent}", yield* pathValue(input.parentFlag));

      path = path.replace("{id}", yield* pathValue(input.idArgument));

      if (Option.isSome(input.enabledFlag)) {
        query.append("enabled", String(input.enabledFlag.value));
      }

      if (Option.isSome(input.countFlag)) {
        query.append("count", String(input.countFlag.value));
      }

      if (Option.isSome(input["wire-nameFlag"])) {
        query.append("wire_name", input["wire-nameFlag"].value);
      }

      const suffix = query.toString();

      const url = `${baseUrl}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;

      const body = yield* readBody(input, false, accountDeepItemsGetBodySchema);

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
const requiredSendConfirmFlag = Flag.Literals("confirm", ["true", "false"])
  .pipe(Flag.map((value) => value === "true"))
  .pipe(
    Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
  );

const requiredSendBodySchema = Schema.Struct({ value: Schema.Int });

const requiredSendCommand = Command.make(
  "send",
  {
    body: Flag.String("body").pipe(Flag.optional),
    bodyFile: Flag.String("body-file").pipe(Flag.optional),
    confirmFlag: requiredSendConfirmFlag,
  },
  (input) =>
    Effect.gen(function* requiredSendRequest() {
      const { baseUrl } = yield* root;

      const path = "/required";

      const query = new URLSearchParams();

      query.append("confirm", String(input.confirmFlag));

      const suffix = query.toString();

      const url = `${baseUrl}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;

      const body = yield* readBody(input, true, requiredSendBodySchema);

      yield* executeRequest("POST", url, body);
    }).pipe(
      Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
    ),
).pipe(Command.withDescription(""));

const accountDeepItemsGroup = Command.make("items").pipe(
  Command.withSubcommands([
    accountDeepItemsBulkUpdateCommand,
    accountDeepItemsListCommand,
    accountDeepItemsGetCommand,
  ]),
);

const accountDeepGroup = Command.make("deep").pipe(
  Command.withSubcommands([accountDeepItemsGroup]),
);

const alternateDeepGroup = Command.make("deep").pipe(
  Command.withSubcommands([alternateDeepReadCommand]),
);

const accountGroup = Command.make("account").pipe(Command.withSubcommands([accountDeepGroup]));

const alternateGroup = Command.make("alternate").pipe(
  Command.withSubcommands([alternateDeepGroup]),
);

const emptyGroup = Command.make("empty").pipe(Command.withSubcommands([emptyGetCommand]));

const failureGroup = Command.make("failure").pipe(Command.withSubcommands([failureGetCommand]));

const requiredGroup = Command.make("required").pipe(Command.withSubcommands([requiredSendCommand]));

const command = root.pipe(
  Command.withSubcommands([accountGroup, alternateGroup, emptyGroup, failureGroup, requiredGroup]),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
