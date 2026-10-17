import { Effect, Option, Schema } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { HttpClientRequest } from "effect/http";
import * as Body from "./builtins/body.js";
import * as Errors from "./builtins/errors.js";
import * as Http from "./builtins/http.js";
import * as Url from "./builtins/url.js";

const aliasGetCommand = Command.make("read", { baseUrl: Url.baseUrl }, ({ baseUrl: apiUrl }) =>
  HttpClientRequest.post(apiUrl).pipe(
    Url.appendPathSegments("alias"),
    Effect.flatMap(Http.runRequest),
    Effect.mapError(Errors.toCliError),
    Effect.withSpan("alias-get"),
  ),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const itemsBulkUpdateCommand = Command.make(
  "bulk-update",
  {
    baseUrl: Url.baseUrl,
    count: Flag.Int("count").pipe(
      Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
      Flag.optional,
    ),
    enabled: Flag.Literals("enabled", ["true", "false"])
      .pipe(Flag.map((value) => value === "true"))
      .pipe(
        Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
        Flag.optional,
      ),
    id: Flag.String("id").pipe(
      Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
    ),
    parent: Flag.String("parent").pipe(
      Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
    ),
    wireName: Flag.String("wire-name").pipe(
      Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
      Flag.optional,
    ),
  },
  ({ baseUrl: apiUrl, count, enabled, id, parent, wireName }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        count: Option.getOrUndefined(count),
        enabled: Option.getOrUndefined(enabled),
        wire_name: Option.getOrUndefined(wireName),
      }),
      Url.appendPathSegments("bulk", parent, id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("items-bulk-update"),
    ),
).pipe(
  Command.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

const emptyGetCommand = Command.make("get", { baseUrl: Url.baseUrl }, ({ baseUrl: apiUrl }) =>
  HttpClientRequest.get(apiUrl).pipe(
    Url.appendPathSegments("empty"),
    Effect.flatMap(Http.runRequest),
    Effect.mapError(Errors.toCliError),
    Effect.withSpan("empty-get"),
  ),
);

const failureGetCommand = Command.make("get", { baseUrl: Url.baseUrl }, ({ baseUrl: apiUrl }) =>
  HttpClientRequest.get(apiUrl).pipe(
    Url.appendPathSegments("failure"),
    Effect.flatMap(Http.runRequest),
    Effect.mapError(Errors.toCliError),
    Effect.withSpan("failure-get"),
  ),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const itemsListCommand = Command.make(
  "list",
  {
    baseUrl: Url.baseUrl,
    count: Flag.Int("count").pipe(
      Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
      Flag.optional,
    ),
    enabled: Flag.Literals("enabled", ["true", "false"])
      .pipe(Flag.map((value) => value === "true"))
      .pipe(
        Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
        Flag.optional,
      ),
    id: Flag.String("id").pipe(
      Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
    ),
    parent: Flag.String("parent").pipe(
      Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
    ),
    wireName: Flag.String("wire-name").pipe(
      Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
      Flag.optional,
    ),
  },
  ({ baseUrl: apiUrl, count, enabled, id, parent, wireName }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        count: Option.getOrUndefined(count),
        enabled: Option.getOrUndefined(enabled),
        wire_name: Option.getOrUndefined(wireName),
      }),
      Url.appendPathSegments("list", parent, id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("items-list"),
    ),
).pipe(
  Command.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

/**
 * Quote" ` ${globalThis.injected = true} *\/
 * \@tag
 */
const itemsGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.StructWithRest(
              Schema.Struct({
                ["__proto__"]: Schema.optionalKey(
                  Schema.StructWithRest(Schema.Struct({}), [
                    Schema.Record(Schema.String, Schema.Json),
                  ]),
                ),
                /**
                 * Quote" ` ${globalThis.injected = true} *\/
                 * \@tag
                 *
                 * @deprecated
                 * @see https://example.test
                 */
                // oxlint-disable-next-line typescript/no-deprecated -- Required schema registration for a supported deprecated API field.
                enabled: Schema.optionalKey(Schema.Boolean),
                nested: Schema.optionalKey(
                  Schema.Struct({ value: Schema.optionalKey(Schema.Int) }),
                ),
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
            ),
          ),
        )(value, { onExcessProperty: "error", reportInput: false }).pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        ),
      ),
      Flag.withDescription(""),
      Flag.optional,
    ),
    bodyFile: Flag.String("body-file").pipe(
      Flag.withDescription("Read a JSON request body from a file; exclusive with --body."),
      Flag.optional,
    ),
    count: Flag.Int("count").pipe(
      Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
      Flag.optional,
    ),
    enabled: Flag.Literals("enabled", ["true", "false"])
      .pipe(Flag.map((value) => value === "true"))
      .pipe(
        Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
        Flag.optional,
      ),
    id: Flag.String("id").pipe(
      Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
    ),
    parent: Flag.String("parent").pipe(
      Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
    ),
    wireName: Flag.String("wire-name").pipe(
      Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
      Flag.optional,
    ),
  },
  ({ baseUrl: apiUrl, body, bodyFile, count, enabled, id, parent, wireName }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        count: Option.getOrUndefined(count),
        enabled: Option.getOrUndefined(enabled),
        wire_name: Option.getOrUndefined(wireName),
      }),
      Url.appendPathSegments("parents", parent, "items", id),
      Effect.flatMap(
        Body.withBody(
          body,
          bodyFile,
          false,
          Schema.StructWithRest(
            Schema.Struct({
              ["__proto__"]: Schema.optionalKey(
                Schema.StructWithRest(Schema.Struct({}), [
                  Schema.Record(Schema.String, Schema.Json),
                ]),
              ),
              /**
               * Quote" ` ${globalThis.injected = true} *\/
               * \@tag
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
          ),
        ),
      ),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("items-get"),
    ),
).pipe(
  Command.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
);

const requiredSendCommand = Command.make(
  "send",
  {
    baseUrl: Url.baseUrl,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ value: Schema.Int })))(
          value,
          { onExcessProperty: "error", reportInput: false },
        ).pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        ),
      ),
      Flag.withDescription(""),
      Flag.optional,
    ),
    bodyFile: Flag.String("body-file").pipe(
      Flag.withDescription("Read a JSON request body from a file; exclusive with --body."),
      Flag.optional,
    ),
    confirm: Flag.Literals("confirm", ["true", "false"])
      .pipe(Flag.map((value) => value === "true"))
      .pipe(
        Flag.withDescription(`quote" \` \${globalThis.injected = true} */
@tag`),
      ),
  },
  ({ baseUrl: apiUrl, body, bodyFile, confirm }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.setUrlParams({ confirm }),
      Url.appendPathSegments("required"),
      Effect.flatMap(Body.withBody(body, bodyFile, true, Schema.Struct({ value: Schema.Int }))),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("required-send"),
    ),
);

const AccountDeepItemsCommand = Command.make("items").pipe(
  Command.withSubcommands([itemsBulkUpdateCommand, itemsListCommand, itemsGetCommand]),
);

const AccountDeepCommand = Command.make("deep").pipe(
  Command.withSubcommands([AccountDeepItemsCommand]),
);

const AlternateDeepCommand = Command.make("deep").pipe(Command.withSubcommands([aliasGetCommand]));

export const AccountCommand = Command.make("account").pipe(
  Command.withSubcommands([AccountDeepCommand]),
);

export const AlternateCommand = Command.make("alternate").pipe(
  Command.withSubcommands([AlternateDeepCommand]),
);

export const EmptyCommand = Command.make("empty").pipe(Command.withSubcommands([emptyGetCommand]));

export const FailureCommand = Command.make("failure").pipe(
  Command.withSubcommands([failureGetCommand]),
);

export const RequiredCommand = Command.make("required").pipe(
  Command.withSubcommands([requiredSendCommand]),
);
