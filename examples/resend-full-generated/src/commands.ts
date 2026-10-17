import { Effect, Option, Schema } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { HttpClientRequest } from "effect/http";
import * as Body from "./builtins/body.js";
import * as Errors from "./builtins/errors.js";
import * as Http from "./builtins/http.js";
import * as Multipart from "./builtins/multipart.js";
import * as Query from "./builtins/query.js";
import * as Url from "./builtins/url.js";
import * as MultipartComponents from "./components/multipart.js";
import * as Parameters from "./components/parameters.js";
import * as Schemas from "./components/schemas.js";
import * as SecuritySchemes from "./components/security-schemes.js";

/**
 * Retrieve a list of API keys
 */
const apiKeysListCommand = Command.make(
  "list",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("api-keys"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("api-keys/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of API keys"));

/**
 * Create a new API key
 */
const apiKeysCreateCommand = Command.make(
  "create",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.CreateApiKeyRequest))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("api-keys"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.CreateApiKeyRequest)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("api-keys/create"),
    ),
).pipe(Command.withDescription("Create a new API key"));

/**
 * Remove an existing API key
 */
const apiKeysRemoveCommand = Command.make(
  "remove",
  {
    apiKeyId: Flag.String("api-key-id").pipe(Flag.withDescription("The API key ID.")),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
  },
  ({ apiKeyId, baseUrl: apiUrl, bearerAuth }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("api-keys", apiKeyId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("api-keys/remove"),
    ),
).pipe(Command.withDescription("Remove an existing API key"));

/**
 * Update an existing API key
 */
const apiKeysUpdateCommand = Command.make(
  "update",
  {
    apiKeyId: Flag.String("api-key-id").pipe(Flag.withDescription("The API key ID.")),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.UpdateApiKeyRequest))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ apiKeyId, baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("api-keys", apiKeyId),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.UpdateApiKeyRequest)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("api-keys/update"),
    ),
).pipe(Command.withDescription("Update an existing API key"));

/**
 * Deprecated: Use Segments instead. These endpoints still work, but will be removed in the future.
 *
 * @deprecated
 */
const audiencesListCommand = Command.make(
  "list",
  { baseUrl: Url.baseUrl, bearerAuth: SecuritySchemes.BearerAuth },
  ({ baseUrl: apiUrl, bearerAuth }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("audiences"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("audiences/list"),
    ),
).pipe(
  Command.withDescription(
    "Deprecated: Use Segments instead. These endpoints still work, but will be removed in the future.",
  ),
);

/**
 * Deprecated: Use Segments instead. These endpoints still work, but will be removed in the future.
 *
 * @deprecated
 */
const audiencesCreateCommand = Command.make(
  "create",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            // oxlint-disable-next-line typescript/no-deprecated -- Required plumbing for a supported deprecated API element.
            Schemas.CreateAudienceOptions,
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("audiences"),
      Effect.flatMap(
        Body.withBody(
          body,
          bodyFile,
          false,
          // oxlint-disable-next-line typescript/no-deprecated -- Required plumbing for a supported deprecated API element.
          Schemas.CreateAudienceOptions,
        ),
      ),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("audiences/create"),
    ),
).pipe(
  Command.withDescription(
    "Deprecated: Use Segments instead. These endpoints still work, but will be removed in the future.",
  ),
);

/**
 * Deprecated: Use Segments instead. These endpoints still work, but will be removed in the future.
 *
 * @deprecated
 */
const audiencesGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Audience ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("audiences", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("audiences/get"),
    ),
).pipe(
  Command.withDescription(
    "Deprecated: Use Segments instead. These endpoints still work, but will be removed in the future.",
  ),
);

/**
 * Deprecated: Use Segments instead. These endpoints still work, but will be removed in the future.
 *
 * @deprecated
 */
const audiencesRemoveCommand = Command.make(
  "remove",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Audience ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("audiences", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("audiences/remove"),
    ),
).pipe(
  Command.withDescription(
    "Deprecated: Use Segments instead. These endpoints still work, but will be removed in the future.",
  ),
);

/**
 * Retrieve a list of automations
 */
const automationsListCommand = Command.make(
  "list",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
    status: Flag.Literals("status", ["enabled", "disabled"]).pipe(
      Flag.withDescription("Filter automations by status."),
      Flag.optional,
    ),
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit, status }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
        status: Option.getOrUndefined(status),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("automations"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("automations/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of automations"));

/**
 * Create an automation
 */
const automationsCreateCommand = Command.make(
  "create",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.CreateAutomationRequest))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("automations"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.CreateAutomationRequest)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("automations/create"),
    ),
).pipe(Command.withDescription("Create an automation"));

/**
 * Retrieve a single automation
 */
const automationsGetCommand = Command.make(
  "get",
  {
    automationId: Flag.String("automation-id").pipe(
      Flag.withDescription("The ID of the automation."),
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
  },
  ({ automationId, baseUrl: apiUrl, bearerAuth }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("automations", automationId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("automations/get"),
    ),
).pipe(Command.withDescription("Retrieve a single automation"));

/**
 * Delete an automation
 */
const automationsRemoveCommand = Command.make(
  "remove",
  {
    automationId: Flag.String("automation-id").pipe(
      Flag.withDescription("The ID of the automation."),
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
  },
  ({ automationId, baseUrl: apiUrl, bearerAuth }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("automations", automationId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("automations/remove"),
    ),
).pipe(Command.withDescription("Delete an automation"));

/**
 * Update an automation
 */
const automationsUpdateCommand = Command.make(
  "update",
  {
    automationId: Flag.String("automation-id").pipe(
      Flag.withDescription("The ID of the automation."),
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.PatchAutomationRequest))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ automationId, baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("automations", automationId),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.PatchAutomationRequest)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("automations/update"),
    ),
).pipe(Command.withDescription("Update an automation"));

/**
 * Duplicate an automation
 */
const automationsDuplicateCommand = Command.make(
  "duplicate",
  {
    automationId: Flag.String("automation-id").pipe(
      Flag.withDescription("The ID of the automation."),
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
  },
  ({ automationId, baseUrl: apiUrl, bearerAuth }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("automations", automationId, "duplicate"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("automations/duplicate"),
    ),
).pipe(Command.withDescription("Duplicate an automation"));

/**
 * Retrieve a list of automation runs
 */
const automationsListRunsCommand = Command.make(
  "list-runs",
  {
    after: Parameters.PaginationAfter,
    automationId: Flag.String("automation-id").pipe(
      Flag.withDescription("The ID of the automation."),
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
    status: Flag.String("status").pipe(
      Flag.withDescription(
        "Filter runs by status. Comma-separated list of: running, completed, failed, cancelled.",
      ),
      Flag.optional,
    ),
  },
  ({ after, automationId, baseUrl: apiUrl, bearerAuth, before, limit, status }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
        status: Option.getOrUndefined(status),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("automations", automationId, "runs"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("automations/list-runs"),
    ),
).pipe(Command.withDescription("Retrieve a list of automation runs"));

/**
 * Retrieve a single automation run
 */
const automationsGetRunCommand = Command.make(
  "get-run",
  {
    automationId: Flag.String("automation-id").pipe(
      Flag.withDescription("The ID of the automation."),
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    runId: Flag.String("run-id").pipe(Flag.withDescription("The ID of the automation run.")),
  },
  ({ automationId, baseUrl: apiUrl, bearerAuth, runId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("automations", automationId, "runs", runId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("automations/get-run"),
    ),
).pipe(Command.withDescription("Retrieve a single automation run"));

/**
 * Stop an automation
 */
const automationsStopCommand = Command.make(
  "stop",
  {
    automationId: Flag.String("automation-id").pipe(
      Flag.withDescription("The ID of the automation."),
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
  },
  ({ automationId, baseUrl: apiUrl, bearerAuth }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("automations", automationId, "stop"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("automations/stop"),
    ),
).pipe(Command.withDescription("Stop an automation"));

/**
 * Retrieve a list of broadcasts
 */
const broadcastsListCommand = Command.make(
  "list",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("broadcasts"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("broadcasts/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of broadcasts"));

/**
 * Create a broadcast
 */
const broadcastsCreateCommand = Command.make(
  "create",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.CreateBroadcastOptions))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("broadcasts"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.CreateBroadcastOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("broadcasts/create"),
    ),
).pipe(Command.withDescription("Create a broadcast"));

/**
 * Retrieve a single broadcast
 */
const broadcastsGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Broadcast ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("broadcasts", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("broadcasts/get"),
    ),
).pipe(Command.withDescription("Retrieve a single broadcast"));

/**
 * Remove an existing broadcast that is in the draft status
 */
const broadcastsRemoveCommand = Command.make(
  "remove",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Broadcast ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("broadcasts", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("broadcasts/remove"),
    ),
).pipe(Command.withDescription("Remove an existing broadcast that is in the draft status"));

/**
 * Update an existing broadcast
 */
const broadcastsUpdateCommand = Command.make(
  "update",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.UpdateBroadcastOptions))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
    id: Flag.String("id").pipe(Flag.withDescription("The Broadcast ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, id }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("broadcasts", id),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.UpdateBroadcastOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("broadcasts/update"),
    ),
).pipe(Command.withDescription("Update an existing broadcast"));

/**
 * Cancels a broadcast that is queued or scheduled. Canceling a queued broadcast stops it mid-send;
 * emails already sent are not affected, but no further emails will go out.
 */
const broadcastsCancelCommand = Command.make(
  "cancel",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Broadcast ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("broadcasts", id, "cancel"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("broadcasts/cancel"),
    ),
).pipe(
  Command.withDescription(
    "Cancels a broadcast that is queued or scheduled. Canceling a queued broadcast stops it mid-send; emails already sent are not affected, but no further emails will go out.",
  ),
);

/**
 * Retrieve a broadcast's clicked links
 */
const broadcastsListClickedLinksCommand = Command.make(
  "list-clicked-links",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    id: Flag.String("id").pipe(Flag.withDescription("The Broadcast ID.")),
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, id, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("broadcasts", id, "clicked-links"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("broadcasts/list-clicked-links"),
    ),
).pipe(Command.withDescription("Retrieve a broadcast's clicked links"));

/**
 * Creates a new draft broadcast with the same segment, topic, sender, subject, reply-to, preview
 * text, and content as the source. The copy is named after the source with " (copy)" appended,
 * truncated to 70 characters.
 */
const broadcastsDuplicateCommand = Command.make(
  "duplicate",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Broadcast ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("broadcasts", id, "duplicate"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("broadcasts/duplicate"),
    ),
).pipe(
  Command.withDescription(
    'Creates a new draft broadcast with the same segment, topic, sender, subject, reply-to, preview text, and content as the source. The copy is named after the source with " (copy)" appended, truncated to 70 characters.',
  ),
);

/**
 * Retrieve the recipients of a broadcast for a given event type, such as who opened, clicked, or
 * bounced.
 */
const broadcastsRecipientsCommand = Command.make(
  "recipients",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    bounceType: Flag.Literals("bounce-type", ["permanent", "transient", "undetermined"]).pipe(
      Flag.withDescription(
        "Filter bounced recipients by bounce type. Only valid when `type` is `bounced`.",
      ),
      Flag.optional,
    ),
    email: Flag.String("email").pipe(
      Flag.withDescription("Filter recipients whose email address contains this value."),
      Flag.optional,
    ),
    id: Flag.String("id").pipe(Flag.withDescription("The Broadcast ID.")),
    limit: Parameters.PaginationLimit,
    type: Flag.Literals("type", [
      "sent",
      "delivered",
      "opened",
      "clicked",
      "bounced",
      "complained",
      "unsubscribed",
      "suppressed",
    ]).pipe(Flag.withDescription("The recipient event type to filter by.")),
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, bounceType, email, id, limit, type }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        bounce_type: Option.getOrUndefined(bounceType),
        email: Option.getOrUndefined(email),
        limit: Option.getOrUndefined(limit),
        type,
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("broadcasts", id, "recipients"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("broadcasts/recipients"),
    ),
).pipe(
  Command.withDescription(
    "Retrieve the recipients of a broadcast for a given event type, such as who opened, clicked, or bounced.",
  ),
);

/**
 * Send or schedule a broadcast
 */
const broadcastsSendCommand = Command.make(
  "send",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.SendBroadcastOptions))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
    id: Flag.String("id").pipe(Flag.withDescription("The Broadcast ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, id }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("broadcasts", id, "send"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.SendBroadcastOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("broadcasts/send"),
    ),
).pipe(Command.withDescription("Send or schedule a broadcast"));

/**
 * Retrieve a list of contact properties
 */
const contactPropertiesListCommand = Command.make(
  "list",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contact-properties"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contact-properties/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of contact properties"));

/**
 * Create a new contact property
 */
const contactPropertiesCreateCommand = Command.make(
  "create",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.CreateContactPropertyOptions))(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contact-properties"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.CreateContactPropertyOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contact-properties/create"),
    ),
).pipe(Command.withDescription("Create a new contact property"));

/**
 * Retrieve a single contact property
 */
const contactPropertiesGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Contact Property ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contact-properties", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contact-properties/get"),
    ),
).pipe(Command.withDescription("Retrieve a single contact property"));

/**
 * Remove an existing contact property
 */
const contactPropertiesRemoveCommand = Command.make(
  "remove",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Contact Property ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contact-properties", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contact-properties/remove"),
    ),
).pipe(Command.withDescription("Remove an existing contact property"));

/**
 * Update an existing contact property
 */
const contactPropertiesUpdateCommand = Command.make(
  "update",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.UpdateContactPropertyOptions))(
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
    id: Flag.String("id").pipe(Flag.withDescription("The Contact Property ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, id }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contact-properties", id),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.UpdateContactPropertyOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contact-properties/update"),
    ),
).pipe(Command.withDescription("Update an existing contact property"));

/**
 * Retrieve a list of contacts
 */
const contactsListCommand = Command.make(
  "list",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contacts"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contacts/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of contacts"));

/**
 * Create a new contact
 */
const contactsCreateCommand = Command.make(
  "create",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.CreateContactOptions))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contacts"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.CreateContactOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contacts/create"),
    ),
).pipe(
  Command.withDescription("Create a new contact"),
  Command.withExamples([
    {
      command: `resend-full-generated contacts create --base-url="\${API_BASE_URL:?Set API_BASE_URL}" --bearer-auth="\${API_TOKEN:?Set API_TOKEN}" --body='{"audience_id":"78261eea-8f8b-4381-83c6-79fa7120f1cf","email":"steve.wozniak@gmail.com","first_name":"Steve","last_name":"Wozniak","unsubscribed":false}'`,
    },
  ]),
);

/**
 * Retrieve a list of contact imports
 */
const contactsListImportsCommand = Command.make(
  "list-imports",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
    status: Flag.Literals("status", ["queued", "in_progress", "completed", "failed"]).pipe(
      Flag.withDescription("Filter contact imports by status."),
      Flag.optional,
    ),
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit, status }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
        status: Option.getOrUndefined(status),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contacts", "imports"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contacts/list-imports"),
    ),
).pipe(Command.withDescription("Retrieve a list of contact imports"));

/**
 * Create a contact import
 */
const contactsCreateImportCommand = Command.make(
  "create-import",
  {
    additionalFields: Flag.String("additional-fields").pipe(
      Flag.withSchema(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))),
      Flag.withDescription(
        "Additional multipart text fields as a JSON object; declared names cannot be overridden.",
      ),
      Flag.optional,
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    columnMap: MultipartComponents.CreateContactImportOptions.column_map,
    file: MultipartComponents.CreateContactImportOptions.file,
    onConflict: MultipartComponents.CreateContactImportOptions.on_conflict,
    segments: MultipartComponents.CreateContactImportOptions.segments,
    topics: MultipartComponents.CreateContactImportOptions.topics,
  },
  ({
    additionalFields,
    baseUrl: apiUrl,
    bearerAuth,
    columnMap,
    file,
    onConflict,
    segments,
    topics,
  }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contacts", "imports"),
      Effect.flatMap((request) =>
        Effect.all({ file: Multipart.file(file) }).pipe(
          Effect.flatMap((files) =>
            Multipart.withBody(
              {
                column_map: Option.getOrUndefined(columnMap),
                file: files.file,
                on_conflict: Option.getOrUndefined(onConflict),
                segments: Option.getOrUndefined(segments),
                topics: Option.getOrUndefined(topics),
              },
              additionalFields,
              ["file"],
              true,
            )(request),
          ),
        ),
      ),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contacts/create-import"),
    ),
).pipe(Command.withDescription("Create a contact import"));

/**
 * Retrieve a single contact import
 */
const contactsGetImportCommand = Command.make(
  "get-import",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Contact Import ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contacts", "imports", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contacts/get-import"),
    ),
).pipe(Command.withDescription("Retrieve a single contact import"));

/**
 * Retrieve a list of segments for a contact
 */
const contactsListSegmentsCommand = Command.make(
  "list-segments",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    contactId: Flag.String("contact-id").pipe(
      Flag.withDescription("The Contact ID or email address."),
    ),
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, contactId, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contacts", contactId, "segments"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contacts/list-segments"),
    ),
).pipe(Command.withDescription("Retrieve a list of segments for a contact"));

/**
 * Add a contact to a segment
 */
const contactsAddSegmentCommand = Command.make(
  "add-segment",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    contactId: Flag.String("contact-id").pipe(
      Flag.withDescription("The Contact ID or email address."),
    ),
    segmentId: Flag.String("segment-id").pipe(Flag.withDescription("The Segment ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, contactId, segmentId }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contacts", contactId, "segments", segmentId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contacts/add-segment"),
    ),
).pipe(Command.withDescription("Add a contact to a segment"));

/**
 * Remove a contact from a segment
 */
const contactsRemoveSegmentCommand = Command.make(
  "remove-segment",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    contactId: Flag.String("contact-id").pipe(
      Flag.withDescription("The Contact ID or email address."),
    ),
    segmentId: Flag.String("segment-id").pipe(Flag.withDescription("The Segment ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, contactId, segmentId }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contacts", contactId, "segments", segmentId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contacts/remove-segment"),
    ),
).pipe(Command.withDescription("Remove a contact from a segment"));

/**
 * Retrieve topics for a contact
 */
const contactsListTopicsCommand = Command.make(
  "list-topics",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    contactId: Flag.String("contact-id").pipe(
      Flag.withDescription("The Contact ID or email address."),
    ),
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, contactId, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contacts", contactId, "topics"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contacts/list-topics"),
    ),
).pipe(Command.withDescription("Retrieve topics for a contact"));

/**
 * Update topics for a contact
 */
const contactsUpdateTopicsCommand = Command.make(
  "update-topics",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.UpdateContactTopicsOptions))(
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
    contactId: Flag.String("contact-id").pipe(
      Flag.withDescription("The Contact ID or email address."),
    ),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, contactId }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contacts", contactId, "topics"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.UpdateContactTopicsOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contacts/update-topics"),
    ),
).pipe(Command.withDescription("Update topics for a contact"));

/**
 * Retrieve a single contact by ID or email
 */
const contactsGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Contact ID or email address.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contacts", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contacts/get"),
    ),
).pipe(Command.withDescription("Retrieve a single contact by ID or email"));

/**
 * Remove an existing contact by ID or email
 */
const contactsRemoveCommand = Command.make(
  "remove",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Contact ID or email address.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contacts", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contacts/remove"),
    ),
).pipe(Command.withDescription("Remove an existing contact by ID or email"));

/**
 * Update a single contact by ID or email
 */
const contactsUpdateCommand = Command.make(
  "update",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.UpdateContactOptions))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
    id: Flag.String("id").pipe(Flag.withDescription("The Contact ID or email address.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, id }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("contacts", id),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.UpdateContactOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("contacts/update"),
    ),
).pipe(Command.withDescription("Update a single contact by ID or email"));

/**
 * Retrieve a list of domains
 */
const domainsListCommand = Command.make(
  "list",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("domains"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("domains/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of domains"));

/**
 * Create a new domain
 */
const domainsCreateCommand = Command.make(
  "create",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.CreateDomainRequest))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("domains"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.CreateDomainRequest)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("domains/create"),
    ),
).pipe(Command.withDescription("Create a new domain"));

/**
 * Start a claim for a domain that another Resend account has already verified. The domain is
 * recreated under your account with fresh DKIM keys, so the previous account's DNS records cannot
 * be reused. Returns a TXT record to add to your DNS to prove ownership. Uses the same request body
 * as creating a domain.
 */
const domainsCreateClaimCommand = Command.make(
  "create-claim",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.CreateDomainClaimRequest))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("domains", "claim"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.CreateDomainClaimRequest)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("domains/create-claim"),
    ),
).pipe(
  Command.withDescription(
    "Start a claim for a domain that another Resend account has already verified. The domain is recreated under your account with fresh DKIM keys, so the previous account's DNS records cannot be reused. Returns a TXT record to add to your DNS to prove ownership. Uses the same request body as creating a domain.",
  ),
);

/**
 * Retrieve a single domain
 */
const domainsGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    domainId: Flag.String("domain-id").pipe(Flag.withDescription("The ID of the domain.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, domainId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("domains", domainId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("domains/get"),
    ),
).pipe(Command.withDescription("Retrieve a single domain"));

/**
 * Remove an existing domain
 */
const domainsRemoveCommand = Command.make(
  "remove",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    domainId: Flag.String("domain-id").pipe(Flag.withDescription("The ID of the domain.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, domainId }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("domains", domainId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("domains/remove"),
    ),
).pipe(Command.withDescription("Remove an existing domain"));

/**
 * Update an existing domain
 */
const domainsUpdateCommand = Command.make(
  "update",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.UpdateDomainOptions))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
    domainId: Flag.String("domain-id").pipe(Flag.withDescription("The ID of the domain.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, domainId }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("domains", domainId),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.UpdateDomainOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("domains/update"),
    ),
).pipe(Command.withDescription("Update an existing domain"));

/**
 * Retrieve the latest claim for the placeholder domain created by the claim.
 */
const domainsGetClaimCommand = Command.make(
  "get-claim",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    domainId: Flag.String("domain-id").pipe(
      Flag.withDescription("The ID of the placeholder domain created by the claim."),
    ),
  },
  ({ baseUrl: apiUrl, bearerAuth, domainId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("domains", domainId, "claim"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("domains/get-claim"),
    ),
).pipe(
  Command.withDescription(
    "Retrieve the latest claim for the placeholder domain created by the claim.",
  ),
);

/**
 * Trigger asynchronous DNS verification and ownership transfer for a domain claim. The claim stays
 * `pending` while verification runs; poll the retrieve endpoint for status. Once `completed`, the
 * transferred domain has new DKIM records that must be added to DNS and verified via the standard
 * domain verify endpoint.
 */
const domainsVerifyClaimCommand = Command.make(
  "verify-claim",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    domainId: Flag.String("domain-id").pipe(
      Flag.withDescription("The ID of the placeholder domain created by the claim."),
    ),
  },
  ({ baseUrl: apiUrl, bearerAuth, domainId }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("domains", domainId, "claim", "verify"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("domains/verify-claim"),
    ),
).pipe(
  Command.withDescription(
    "Trigger asynchronous DNS verification and ownership transfer for a domain claim. The claim stays `pending` while verification runs; poll the retrieve endpoint for status. Once `completed`, the transferred domain has new DKIM records that must be added to DNS and verified via the standard domain verify endpoint.",
  ),
);

/**
 * Triggers verification of the domain's DNS records including DKIM, SPF, and the tracking CNAME (if
 * a tracking subdomain is configured).
 */
const domainsVerifyCommand = Command.make(
  "verify",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    domainId: Flag.String("domain-id").pipe(Flag.withDescription("The ID of the domain.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, domainId }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("domains", domainId, "verify"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("domains/verify"),
    ),
).pipe(
  Command.withDescription(
    "Triggers verification of the domain's DNS records including DKIM, SPF, and the tracking CNAME (if a tracking subdomain is configured).",
  ),
);

/**
 * Retrieve a list of emails
 */
const emailsListCommand = Command.make(
  "list",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of emails"));

/**
 * Send an email
 */
const emailsSendCommand = Command.make(
  "send",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.SendEmailRequest))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
    idempotencyKey: Flag.String("idempotency-key").pipe(
      Flag.withSchema(Schema.String.check(Schema.isMaxCodePoints(256))),
      Flag.withDescription(
        "A unique identifier for the request to ensure emails are only sent once. [Learn more](https://resend.com/docs/dashboard/emails/idempotency-keys)",
      ),
      Flag.optional,
    ),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, idempotencyKey }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.setHeaders({ "Idempotency-Key": Option.getOrUndefined(idempotencyKey) }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.SendEmailRequest)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/send"),
    ),
).pipe(Command.withDescription("Send an email"));

/**
 * Trigger up to 100 batch emails at once.
 */
const emailsSendBatchCommand = Command.make(
  "send-batch",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schemas.SendEmailRequest)))(
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
    idempotencyKey: Flag.String("idempotency-key").pipe(
      Flag.withSchema(Schema.String.check(Schema.isMaxCodePoints(256))),
      Flag.withDescription(
        "A unique identifier for the request to ensure emails are only sent once. [Learn more](https://resend.com/docs/dashboard/emails/idempotency-keys)",
      ),
      Flag.optional,
    ),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, idempotencyKey }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.setHeaders({ "Idempotency-Key": Option.getOrUndefined(idempotencyKey) }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails", "batch"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schema.Array(Schemas.SendEmailRequest))),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/send-batch"),
    ),
).pipe(Command.withDescription("Trigger up to 100 batch emails at once."));

/**
 * Retrieve account-level email metrics
 */
const emailsMetricsCommand = Command.make(
  "metrics",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    broadcastId: Flag.String("broadcast-id").pipe(
      Flag.withSchema(Schema.fromJsonString(Schema.Array(Schema.String))),
      Flag.withMetavar("JSON_ARRAY"),
      Flag.withDescription(
        "List of broadcast IDs to restrict the response to, up to 100. Cannot be combined with the `email` dimension or `email_id`. Accepts a comma-separated value, the parameter repeated, or a mix of both.",
      ),
      Flag.optional,
    ),
    dimensions: Flag.String("dimensions").pipe(
      Flag.withSchema(
        Schema.fromJsonString(
          Schema.Array(Schema.Literals(["period", "domain", "email", "broadcast"])),
        ),
      ),
      Flag.withMetavar("JSON_ARRAY"),
      Flag.withDescription(
        "List of dimensions to break the response down by. `email` cannot be combined with `broadcast`. Defaults to `[]`, returning a single `totals` row for the whole range, with no `data`. Accepts a comma-separated value, the parameter repeated, or a mix of both.",
      ),
      Flag.optional,
    ),
    domainId: Flag.String("domain-id").pipe(
      Flag.withSchema(Schema.fromJsonString(Schema.Array(Schema.String))),
      Flag.withMetavar("JSON_ARRAY"),
      Flag.withDescription(
        "List of sending domain IDs to restrict the response to, up to 100. Accepts a comma-separated value, the parameter repeated, or a mix of both.",
      ),
      Flag.optional,
    ),
    emailId: Flag.String("email-id").pipe(
      Flag.withSchema(Schema.fromJsonString(Schema.Array(Schema.String))),
      Flag.withMetavar("JSON_ARRAY"),
      Flag.withDescription(
        "List of email IDs to restrict the response to, up to 100. Cannot be combined with the `broadcast` dimension or `broadcast_id`. Accepts a comma-separated value, the parameter repeated, or a mix of both.",
      ),
      Flag.optional,
    ),
    endDate: Flag.String("end-date").pipe(
      Flag.withDescription(
        "The end of the date range, as an ISO 8601 date or datetime. Values in the future are clamped to the current time. Defaults to now.",
      ),
      Flag.optional,
    ),
    granularity: Flag.Literals("granularity", ["hourly", "daily", "weekly", "monthly"]).pipe(
      Flag.withDescription(
        "The bucket size used when `period` is in `dimensions`. The date range can't produce more than 10,000 periods at the chosen granularity.",
      ),
      Flag.optional,
    ),
    metrics: Flag.String("metrics").pipe(
      Flag.withSchema(
        Schema.fromJsonString(
          Schema.Array(
            Schema.Literals([
              "received",
              "delivered",
              "complained",
              "suppressed",
              "bounced",
              "bounced_transient",
              "bounced_permanent",
              "bounced_undetermined",
              "opened",
              "clicked",
              "unsubscribed",
              "delivery_delayed",
              "failed",
              "sent",
              "unique_opened",
              "unique_clicked",
              "delivery_rate",
              "open_rate",
              "click_rate",
              "bounce_rate",
              "complaint_rate",
              "unsubscribe_rate",
            ]),
          ),
        ),
      ),
      Flag.withMetavar("JSON_ARRAY"),
      Flag.withDescription(
        "List of metrics to include in the response. Defaults to all metrics. Accepts a comma-separated value, the parameter repeated, or a mix of both.",
      ),
      Flag.optional,
    ),
    startDate: Flag.String("start-date").pipe(
      Flag.withDescription(
        "The start of the date range, as an ISO 8601 date or datetime. Must be on or before `end_date`. Defaults to 6 days before `end_date`.",
      ),
      Flag.optional,
    ),
    timezone: Flag.String("timezone").pipe(
      Flag.withDescription(
        "The IANA timezone (e.g. `America/New_York`) used to bucket periods when `period` is in `dimensions`.",
      ),
      Flag.optional,
    ),
  },
  ({
    baseUrl: apiUrl,
    bearerAuth,
    broadcastId,
    dimensions,
    domainId,
    emailId,
    endDate,
    granularity,
    metrics,
    startDate,
    timezone,
  }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        end_date: Option.getOrUndefined(endDate),
        granularity: Option.getOrUndefined(granularity),
        start_date: Option.getOrUndefined(startDate),
        timezone: Option.getOrUndefined(timezone),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails", "metrics"),
      Effect.flatMap(Query.setArray("metrics", Option.getOrUndefined(metrics), false)),
      Effect.flatMap(Query.setArray("dimensions", Option.getOrUndefined(dimensions), false)),
      Effect.flatMap(Query.setArray("domain_id", Option.getOrUndefined(domainId), false)),
      Effect.flatMap(Query.setArray("email_id", Option.getOrUndefined(emailId), false)),
      Effect.flatMap(Query.setArray("broadcast_id", Option.getOrUndefined(broadcastId), false)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/metrics"),
    ),
).pipe(Command.withDescription("Retrieve account-level email metrics"));

/**
 * Retrieve a list of received emails
 */
const emailsListReceivingCommand = Command.make(
  "list-receiving",
  {
    after: Flag.String("after").pipe(
      Flag.withDescription(
        "Pagination cursor to fetch results after this email ID. Cannot be used with 'before'.",
      ),
      Flag.optional,
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Flag.String("before").pipe(
      Flag.withDescription(
        "Pagination cursor to fetch results before this email ID. Cannot be used with 'after'.",
      ),
      Flag.optional,
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Maximum number of received emails to return."),
      Flag.optional,
    ),
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails", "receiving"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/list-receiving"),
    ),
).pipe(Command.withDescription("Retrieve a list of received emails"));

/**
 * Retrieve a single received email
 */
const emailsGetReceivingCommand = Command.make(
  "get-receiving",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    emailId: Flag.String("email-id").pipe(Flag.withDescription("The ID of the received email.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, emailId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails", "receiving", emailId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/get-receiving"),
    ),
).pipe(Command.withDescription("Retrieve a single received email"));

/**
 * Retrieve a list of attachments for a received email
 */
const emailsListReceivingAttachmentsCommand = Command.make(
  "list-receiving-attachments",
  {
    after: Flag.String("after").pipe(
      Flag.withDescription(
        "Pagination cursor to fetch results after this attachment ID. Cannot be used with 'before'.",
      ),
      Flag.optional,
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Flag.String("before").pipe(
      Flag.withDescription(
        "Pagination cursor to fetch results before this attachment ID. Cannot be used with 'after'.",
      ),
      Flag.optional,
    ),
    emailId: Flag.String("email-id").pipe(Flag.withDescription("The ID of the received email.")),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Maximum number of attachments to return."),
      Flag.optional,
    ),
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, emailId, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails", "receiving", emailId, "attachments"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/list-receiving-attachments"),
    ),
).pipe(Command.withDescription("Retrieve a list of attachments for a received email"));

/**
 * Retrieve a single attachment for a received email
 */
const emailsGetReceivingAttachmentCommand = Command.make(
  "get-receiving-attachment",
  {
    attachmentId: Flag.String("attachment-id").pipe(
      Flag.withDescription("The ID of the attachment."),
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    emailId: Flag.String("email-id").pipe(Flag.withDescription("The ID of the received email.")),
  },
  ({ attachmentId, baseUrl: apiUrl, bearerAuth, emailId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails", "receiving", emailId, "attachments", attachmentId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/get-receiving-attachment"),
    ),
).pipe(Command.withDescription("Retrieve a single attachment for a received email"));

/**
 * Retrieve a single email
 */
const emailsGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    emailId: Flag.String("email-id").pipe(Flag.withDescription("The ID of the email.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, emailId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails", emailId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/get"),
    ),
).pipe(Command.withDescription("Retrieve a single email"));

/**
 * Update a single email
 */
const emailsUpdateCommand = Command.make(
  "update",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    emailId: Flag.String("email-id").pipe(Flag.withDescription("The ID of the email.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, emailId }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails", emailId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/update"),
    ),
).pipe(Command.withDescription("Update a single email"));

/**
 * Retrieve a list of attachments for a sent email
 */
const emailsListAttachmentsCommand = Command.make(
  "list-attachments",
  {
    after: Flag.String("after").pipe(
      Flag.withDescription(
        "Pagination cursor to fetch results after this attachment ID. Cannot be used with 'before'.",
      ),
      Flag.optional,
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Flag.String("before").pipe(
      Flag.withDescription(
        "Pagination cursor to fetch results before this attachment ID. Cannot be used with 'after'.",
      ),
      Flag.optional,
    ),
    emailId: Flag.String("email-id").pipe(Flag.withDescription("The ID of the email.")),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Maximum number of attachments to return."),
      Flag.optional,
    ),
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, emailId, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails", emailId, "attachments"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/list-attachments"),
    ),
).pipe(Command.withDescription("Retrieve a list of attachments for a sent email"));

/**
 * Retrieve a single attachment for a sent email
 */
const emailsGetAttachmentCommand = Command.make(
  "get-attachment",
  {
    attachmentId: Flag.String("attachment-id").pipe(
      Flag.withDescription("The ID of the attachment."),
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    emailId: Flag.String("email-id").pipe(Flag.withDescription("The ID of the email.")),
  },
  ({ attachmentId, baseUrl: apiUrl, bearerAuth, emailId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails", emailId, "attachments", attachmentId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/get-attachment"),
    ),
).pipe(Command.withDescription("Retrieve a single attachment for a sent email"));

/**
 * Cancel the schedule of the e-mail.
 */
const emailsCancelCommand = Command.make(
  "cancel",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    emailId: Flag.String("email-id").pipe(Flag.withDescription("The ID of the email.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, emailId }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails", emailId, "cancel"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/cancel"),
    ),
).pipe(Command.withDescription("Cancel the schedule of the e-mail."));

/**
 * Create a shareable link for a sent or received email.
 */
const emailsShareCommand = Command.make(
  "share",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.ShareEmailOptions))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
    emailId: Flag.String("email-id").pipe(Flag.withDescription("The ID of the email.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, emailId }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("emails", emailId, "share"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.ShareEmailOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("emails/share"),
    ),
).pipe(Command.withDescription("Create a shareable link for a sent or received email."));

/**
 * Retrieve a list of events
 */
const eventsListCommand = Command.make(
  "list",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("events"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("events/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of events"));

/**
 * Create an event
 */
const eventsCreateCommand = Command.make(
  "create",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.CreateEventRequest))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("events"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.CreateEventRequest)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("events/create"),
    ),
).pipe(Command.withDescription("Create an event"));

/**
 * Send an event
 */
const eventsSendCommand = Command.make(
  "send",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.SendEventRequest))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("events", "send"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.SendEventRequest)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("events/send"),
    ),
).pipe(Command.withDescription("Send an event"));

/**
 * Retrieve a single event
 */
const eventsGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    identifier: Flag.String("identifier").pipe(
      Flag.withDescription("The event ID (UUID) or event name."),
    ),
  },
  ({ baseUrl: apiUrl, bearerAuth, identifier }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("events", identifier),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("events/get"),
    ),
).pipe(Command.withDescription("Retrieve a single event"));

/**
 * Delete an event
 */
const eventsRemoveCommand = Command.make(
  "remove",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    identifier: Flag.String("identifier").pipe(
      Flag.withDescription("The event ID (UUID) or event name."),
    ),
  },
  ({ baseUrl: apiUrl, bearerAuth, identifier }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("events", identifier),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("events/remove"),
    ),
).pipe(Command.withDescription("Delete an event"));

/**
 * Update an event
 */
const eventsUpdateCommand = Command.make(
  "update",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.UpdateEventRequest))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
    identifier: Flag.String("identifier").pipe(
      Flag.withDescription("The event ID (UUID) or event name."),
    ),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, identifier }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("events", identifier),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.UpdateEventRequest)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("events/update"),
    ),
).pipe(Command.withDescription("Update an event"));

/**
 * Retrieve a list of logs
 */
const logsListCommand = Command.make(
  "list",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("logs"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("logs/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of logs"));

/**
 * Retrieve a single log
 */
const logsGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    logId: Flag.String("log-id").pipe(Flag.withDescription("The ID of the log.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, logId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("logs", logId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("logs/get"),
    ),
).pipe(Command.withDescription("Retrieve a single log"));

/**
 * Retrieve a list of OAuth grants
 */
const oauthListGrantsCommand = Command.make(
  "list-grants",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("oauth", "grants"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("oauth/list-grants"),
    ),
).pipe(Command.withDescription("Retrieve a list of OAuth grants"));

/**
 * Revoke an OAuth grant
 */
const oauthRevokeGrantCommand = Command.make(
  "revoke-grant",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    oauthGrantId: Flag.String("oauth-grant-id").pipe(Flag.withDescription("The OAuth grant ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, oauthGrantId }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("oauth", "grants", oauthGrantId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("oauth/revoke-grant"),
    ),
).pipe(Command.withDescription("Revoke an OAuth grant"));

/**
 * Retrieve a list of segments
 */
const segmentsListCommand = Command.make(
  "list",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("segments"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("segments/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of segments"));

/**
 * Create a new segment
 */
const segmentsCreateCommand = Command.make(
  "create",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.CreateSegmentOptions))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("segments"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.CreateSegmentOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("segments/create"),
    ),
).pipe(Command.withDescription("Create a new segment"));

/**
 * Retrieve a single segment
 */
const segmentsGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Segment ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("segments", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("segments/get"),
    ),
).pipe(Command.withDescription("Retrieve a single segment"));

/**
 * Remove an existing segment
 */
const segmentsRemoveCommand = Command.make(
  "remove",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Segment ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("segments", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("segments/remove"),
    ),
).pipe(Command.withDescription("Remove an existing segment"));

/**
 * Update an existing segment
 */
const segmentsUpdateCommand = Command.make(
  "update",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.UpdateSegmentOptions))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
    id: Flag.String("id").pipe(Flag.withDescription("The Segment ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, id }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("segments", id),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.UpdateSegmentOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("segments/update"),
    ),
).pipe(Command.withDescription("Update an existing segment"));

/**
 * Retrieve a list of contacts in a segment
 */
const segmentsListContactsCommand = Command.make(
  "list-contacts",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    id: Flag.String("id").pipe(Flag.withDescription("The Segment ID.")),
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, id, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("segments", id, "contacts"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("segments/list-contacts"),
    ),
).pipe(Command.withDescription("Retrieve a list of contacts in a segment"));

/**
 * Retrieve a list of suppressions
 */
const suppressionsListCommand = Command.make(
  "list",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
    origin: Flag.Literals("origin", ["bounce", "complaint", "manual"]).pipe(
      Flag.withDescription("Filter suppressions by origin."),
      Flag.optional,
    ),
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit, origin }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
        origin: Option.getOrUndefined(origin),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("suppressions"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("suppressions/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of suppressions"));

/**
 * Create a suppression
 */
const suppressionsAddCommand = Command.make(
  "add",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.CreateSuppressionOptions))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("suppressions"),
      Effect.flatMap(Body.withBody(body, bodyFile, true, Schemas.CreateSuppressionOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("suppressions/add"),
    ),
).pipe(
  Command.withDescription("Create a suppression"),
  Command.withExamples([
    {
      command: `resend-full-generated suppressions add --base-url="\${API_BASE_URL:?Set API_BASE_URL}" --bearer-auth="\${API_TOKEN:?Set API_TOKEN}" --body='{"email":"steve.wozniak@gmail.com"}'`,
    },
  ]),
);

/**
 * Add up to 100 suppressions at once
 */
const suppressionsBatchAddCommand = Command.make(
  "batch-add",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.BatchAddSuppressionsOptions))(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("suppressions", "batch", "add"),
      Effect.flatMap(Body.withBody(body, bodyFile, true, Schemas.BatchAddSuppressionsOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("suppressions/batch-add"),
    ),
).pipe(
  Command.withDescription("Add up to 100 suppressions at once"),
  Command.withExamples([
    {
      command: `resend-full-generated suppressions batch-add --base-url="\${API_BASE_URL:?Set API_BASE_URL}" --bearer-auth="\${API_TOKEN:?Set API_TOKEN}" --body='{"emails":["steve.wozniak@gmail.com"]}'`,
    },
  ]),
);

/**
 * Remove up to 100 suppressions at once
 */
const suppressionsBatchRemoveCommand = Command.make(
  "batch-remove",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.BatchRemoveSuppressionsOptions))(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("suppressions", "batch", "remove"),
      Effect.flatMap(Body.withBody(body, bodyFile, true, Schemas.BatchRemoveSuppressionsOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("suppressions/batch-remove"),
    ),
).pipe(
  Command.withDescription("Remove up to 100 suppressions at once"),
  Command.withExamples([
    {
      command: `resend-full-generated suppressions batch-remove --base-url="\${API_BASE_URL:?Set API_BASE_URL}" --bearer-auth="\${API_TOKEN:?Set API_TOKEN}" --body='{"emails":["steve.wozniak@gmail.com"],"ids":["e169aa45-1ecf-4183-9955-b1499d5701d3"]}'`,
    },
  ]),
);

/**
 * Retrieve a single suppression by ID or email
 */
const suppressionsGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    suppression: Flag.String("suppression").pipe(
      Flag.withDescription("The Suppression ID or email address."),
    ),
  },
  ({ baseUrl: apiUrl, bearerAuth, suppression }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("suppressions", suppression),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("suppressions/get"),
    ),
).pipe(Command.withDescription("Retrieve a single suppression by ID or email"));

/**
 * Remove a single suppression by ID or email
 */
const suppressionsRemoveCommand = Command.make(
  "remove",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    suppression: Flag.String("suppression").pipe(
      Flag.withDescription("The Suppression ID or email address."),
    ),
  },
  ({ baseUrl: apiUrl, bearerAuth, suppression }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("suppressions", suppression),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("suppressions/remove"),
    ),
).pipe(Command.withDescription("Remove a single suppression by ID or email"));

/**
 * Retrieve a list of templates
 */
const templatesListCommand = Command.make(
  "list",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("templates"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("templates/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of templates"));

/**
 * Create a template
 */
const templatesCreateCommand = Command.make(
  "create",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.CreateTemplateRequest))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("templates"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.CreateTemplateRequest)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("templates/create"),
    ),
).pipe(Command.withDescription("Create a template"));

/**
 * Retrieve a single template
 */
const templatesGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Template ID or alias.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("templates", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("templates/get"),
    ),
).pipe(Command.withDescription("Retrieve a single template"));

/**
 * Remove an existing template
 */
const templatesRemoveCommand = Command.make(
  "remove",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Template ID or alias.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("templates", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("templates/remove"),
    ),
).pipe(Command.withDescription("Remove an existing template"));

/**
 * Update an existing template
 */
const templatesUpdateCommand = Command.make(
  "update",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.UpdateTemplateOptions))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
    id: Flag.String("id").pipe(Flag.withDescription("The Template ID or alias.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, id }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("templates", id),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.UpdateTemplateOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("templates/update"),
    ),
).pipe(Command.withDescription("Update an existing template"));

/**
 * Duplicate a template
 */
const templatesDuplicateCommand = Command.make(
  "duplicate",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Template ID or alias.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("templates", id, "duplicate"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("templates/duplicate"),
    ),
).pipe(Command.withDescription("Duplicate a template"));

/**
 * Publish a template
 */
const templatesPublishCommand = Command.make(
  "publish",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Template ID or alias.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("templates", id, "publish"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("templates/publish"),
    ),
).pipe(Command.withDescription("Publish a template"));

/**
 * Retrieve a list of topics
 */
const topicsListCommand = Command.make(
  "list",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Parameters.PaginationBefore,
    limit: Parameters.PaginationLimit,
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("topics"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("topics/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of topics"));

/**
 * Create a new topic
 */
const topicsCreateCommand = Command.make(
  "create",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.CreateTopicOptions))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("topics"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.CreateTopicOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("topics/create"),
    ),
).pipe(Command.withDescription("Create a new topic"));

/**
 * Retrieve a single topic
 */
const topicsGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Topic ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("topics", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("topics/get"),
    ),
).pipe(Command.withDescription("Retrieve a single topic"));

/**
 * Remove an existing topic
 */
const topicsRemoveCommand = Command.make(
  "remove",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    id: Flag.String("id").pipe(Flag.withDescription("The Topic ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, id }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("topics", id),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("topics/remove"),
    ),
).pipe(Command.withDescription("Remove an existing topic"));

/**
 * Update an existing topic
 */
const topicsUpdateCommand = Command.make(
  "update",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.UpdateTopicOptions))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
    id: Flag.String("id").pipe(Flag.withDescription("The Topic ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, id }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("topics", id),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.UpdateTopicOptions)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("topics/update"),
    ),
).pipe(Command.withDescription("Update an existing topic"));

/**
 * Retrieve your account's current usage and plan limits.
 */
const usageGetCommand = Command.make(
  "get",
  { baseUrl: Url.baseUrl, bearerAuth: SecuritySchemes.BearerAuth },
  ({ baseUrl: apiUrl, bearerAuth }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("usage"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("usage/get"),
    ),
).pipe(Command.withDescription("Retrieve your account's current usage and plan limits."));

/**
 * Retrieve a list of webhooks
 */
const webhooksListCommand = Command.make(
  "list",
  {
    after: Flag.String("after").pipe(
      Flag.withDescription(
        "Pagination cursor to fetch results after this webhook ID. Cannot be used with 'before'.",
      ),
      Flag.optional,
    ),
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    before: Flag.String("before").pipe(
      Flag.withDescription(
        "Pagination cursor to fetch results before this webhook ID. Cannot be used with 'after'.",
      ),
      Flag.optional,
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Maximum number of webhooks to return."),
      Flag.optional,
    ),
  },
  ({ after, baseUrl: apiUrl, bearerAuth, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("webhooks"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("webhooks/list"),
    ),
).pipe(Command.withDescription("Retrieve a list of webhooks"));

/**
 * Create a new webhook
 */
const webhooksCreateCommand = Command.make(
  "create",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.CreateWebhookRequest))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("webhooks"),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.CreateWebhookRequest)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("webhooks/create"),
    ),
).pipe(
  Command.withDescription("Create a new webhook"),
  Command.withExamples([
    {
      command: `resend-full-generated webhooks create --base-url="\${API_BASE_URL:?Set API_BASE_URL}" --bearer-auth="\${API_TOKEN:?Set API_TOKEN}" --body='{"endpoint":"https://webhook.example.com/handler","events":["email.sent","email.delivered","email.bounced","email.suppressed"]}'`,
    },
  ]),
);

/**
 * Retrieve a single webhook
 */
const webhooksGetCommand = Command.make(
  "get",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    webhookId: Flag.String("webhook-id").pipe(Flag.withDescription("The Webhook ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, webhookId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("webhooks", webhookId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("webhooks/get"),
    ),
).pipe(Command.withDescription("Retrieve a single webhook"));

/**
 * Remove an existing webhook
 */
const webhooksRemoveCommand = Command.make(
  "remove",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    webhookId: Flag.String("webhook-id").pipe(Flag.withDescription("The Webhook ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, webhookId }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("webhooks", webhookId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("webhooks/remove"),
    ),
).pipe(Command.withDescription("Remove an existing webhook"));

/**
 * Update an existing webhook
 */
const webhooksUpdateCommand = Command.make(
  "update",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.UpdateWebhookRequest))(value, {
          onExcessProperty: "error",
          reportInput: false,
        }).pipe(
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
    webhookId: Flag.String("webhook-id").pipe(Flag.withDescription("The Webhook ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, body, bodyFile, webhookId }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("webhooks", webhookId),
      Effect.flatMap(Body.withBody(body, bodyFile, false, Schemas.UpdateWebhookRequest)),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("webhooks/update"),
    ),
).pipe(Command.withDescription("Update an existing webhook"));

/**
 * Retrieve a list of webhook events
 */
const webhooksListEventsCommand = Command.make(
  "list-events",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    limit: Parameters.PaginationLimit,
    webhookId: Flag.String("webhook-id").pipe(Flag.withDescription("The Webhook ID.")),
  },
  ({ after, baseUrl: apiUrl, bearerAuth, limit, webhookId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("webhooks", webhookId, "events"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("webhooks/list-events"),
    ),
).pipe(Command.withDescription("Retrieve a list of webhook events"));

/**
 * Retrieve a single webhook event
 */
const webhooksGetEventCommand = Command.make(
  "get-event",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    eventId: Flag.String("event-id").pipe(Flag.withDescription("The Webhook Event ID.")),
    webhookId: Flag.String("webhook-id").pipe(Flag.withDescription("The Webhook ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, eventId, webhookId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("webhooks", webhookId, "events", eventId),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("webhooks/get-event"),
    ),
).pipe(Command.withDescription("Retrieve a single webhook event"));

/**
 * Retrieve a list of webhook event attempts
 */
const webhooksListEventAttemptsCommand = Command.make(
  "list-event-attempts",
  {
    after: Parameters.PaginationAfter,
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    eventId: Flag.String("event-id").pipe(Flag.withDescription("The Webhook Event ID.")),
    limit: Parameters.PaginationLimit,
    webhookId: Flag.String("webhook-id").pipe(Flag.withDescription("The Webhook ID.")),
  },
  ({ after, baseUrl: apiUrl, bearerAuth, eventId, limit, webhookId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        limit: Option.getOrUndefined(limit),
      }),
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("webhooks", webhookId, "events", eventId, "attempts"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("webhooks/list-event-attempts"),
    ),
).pipe(Command.withDescription("Retrieve a list of webhook event attempts"));

/**
 * Queues one more delivery of the event to the webhook. The event must be retrievable through the
 * get event endpoint and the webhook must be enabled; a disabled webhook returns a 422
 * validation_error. A manual replay does not schedule automatic retries.
 */
const webhooksReplayEventCommand = Command.make(
  "replay-event",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    eventId: Flag.String("event-id").pipe(Flag.withDescription("The Webhook Event ID.")),
    webhookId: Flag.String("webhook-id").pipe(Flag.withDescription("The Webhook ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, eventId, webhookId }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("webhooks", webhookId, "events", eventId, "replay"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("webhooks/replay-event"),
    ),
).pipe(
  Command.withDescription(
    "Queues one more delivery of the event to the webhook. The event must be retrievable through the get event endpoint and the webhook must be enabled; a disabled webhook returns a 422 validation_error. A manual replay does not schedule automatic retries.",
  ),
);

/**
 * Generates a new signing secret for the webhook and returns it. Payloads delivered after the
 * rotation are signed with the new secret. The previous secret keeps verifying payloads for 24
 * hours, so both secrets are accepted during that window. A webhook that does not exist or was
 * removed returns a 404 not_found.
 */
const webhooksRotateSigningSecretCommand = Command.make(
  "rotate-signing-secret",
  {
    baseUrl: Url.baseUrl,
    bearerAuth: SecuritySchemes.BearerAuth,
    webhookId: Flag.String("webhook-id").pipe(Flag.withDescription("The Webhook ID.")),
  },
  ({ baseUrl: apiUrl, bearerAuth, webhookId }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(bearerAuth),
      Url.appendPathSegments("webhooks", webhookId, "signing-secret", "rotate"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("webhooks/rotate-signing-secret"),
    ),
).pipe(
  Command.withDescription(
    "Generates a new signing secret for the webhook and returns it. Payloads delivered after the rotation are signed with the new secret. The previous secret keeps verifying payloads for 24 hours, so both secrets are accepted during that window. A webhook that does not exist or was removed returns a 404 not_found.",
  ),
);

export const ApiKeysCommand = Command.make("api-keys").pipe(
  Command.withSubcommands([
    apiKeysListCommand,
    apiKeysCreateCommand,
    apiKeysRemoveCommand,
    apiKeysUpdateCommand,
  ]),
);

export const AudiencesCommand = Command.make("audiences").pipe(
  Command.withSubcommands([
    // oxlint-disable-next-line typescript/no-deprecated -- Required plumbing for a supported deprecated API element.
    audiencesListCommand,
    // oxlint-disable-next-line typescript/no-deprecated -- Required plumbing for a supported deprecated API element.
    audiencesCreateCommand,
    // oxlint-disable-next-line typescript/no-deprecated -- Required plumbing for a supported deprecated API element.
    audiencesGetCommand,
    // oxlint-disable-next-line typescript/no-deprecated -- Required plumbing for a supported deprecated API element.
    audiencesRemoveCommand,
  ]),
);

export const AutomationsCommand = Command.make("automations").pipe(
  Command.withSubcommands([
    automationsListCommand,
    automationsCreateCommand,
    automationsGetCommand,
    automationsRemoveCommand,
    automationsUpdateCommand,
    automationsDuplicateCommand,
    automationsListRunsCommand,
    automationsGetRunCommand,
    automationsStopCommand,
  ]),
);

export const BroadcastsCommand = Command.make("broadcasts").pipe(
  Command.withSubcommands([
    broadcastsListCommand,
    broadcastsCreateCommand,
    broadcastsGetCommand,
    broadcastsRemoveCommand,
    broadcastsUpdateCommand,
    broadcastsCancelCommand,
    broadcastsListClickedLinksCommand,
    broadcastsDuplicateCommand,
    broadcastsRecipientsCommand,
    broadcastsSendCommand,
  ]),
);

export const ContactPropertiesCommand = Command.make("contact-properties").pipe(
  Command.withSubcommands([
    contactPropertiesListCommand,
    contactPropertiesCreateCommand,
    contactPropertiesGetCommand,
    contactPropertiesRemoveCommand,
    contactPropertiesUpdateCommand,
  ]),
);

export const ContactsCommand = Command.make("contacts").pipe(
  Command.withSubcommands([
    contactsListCommand,
    contactsCreateCommand,
    contactsListImportsCommand,
    contactsCreateImportCommand,
    contactsGetImportCommand,
    contactsListSegmentsCommand,
    contactsAddSegmentCommand,
    contactsRemoveSegmentCommand,
    contactsListTopicsCommand,
    contactsUpdateTopicsCommand,
    contactsGetCommand,
    contactsRemoveCommand,
    contactsUpdateCommand,
  ]),
);

export const DomainsCommand = Command.make("domains").pipe(
  Command.withSubcommands([
    domainsListCommand,
    domainsCreateCommand,
    domainsCreateClaimCommand,
    domainsGetCommand,
    domainsRemoveCommand,
    domainsUpdateCommand,
    domainsGetClaimCommand,
    domainsVerifyClaimCommand,
    domainsVerifyCommand,
  ]),
);

export const EmailsCommand = Command.make("emails").pipe(
  Command.withSubcommands([
    emailsListCommand,
    emailsSendCommand,
    emailsSendBatchCommand,
    emailsMetricsCommand,
    emailsListReceivingCommand,
    emailsGetReceivingCommand,
    emailsListReceivingAttachmentsCommand,
    emailsGetReceivingAttachmentCommand,
    emailsGetCommand,
    emailsUpdateCommand,
    emailsListAttachmentsCommand,
    emailsGetAttachmentCommand,
    emailsCancelCommand,
    emailsShareCommand,
  ]),
);

export const EventsCommand = Command.make("events").pipe(
  Command.withSubcommands([
    eventsListCommand,
    eventsCreateCommand,
    eventsSendCommand,
    eventsGetCommand,
    eventsRemoveCommand,
    eventsUpdateCommand,
  ]),
);

export const LogsCommand = Command.make("logs").pipe(
  Command.withSubcommands([logsListCommand, logsGetCommand]),
);

export const OauthCommand = Command.make("oauth").pipe(
  Command.withSubcommands([oauthListGrantsCommand, oauthRevokeGrantCommand]),
);

export const SegmentsCommand = Command.make("segments").pipe(
  Command.withSubcommands([
    segmentsListCommand,
    segmentsCreateCommand,
    segmentsGetCommand,
    segmentsRemoveCommand,
    segmentsUpdateCommand,
    segmentsListContactsCommand,
  ]),
);

export const SuppressionsCommand = Command.make("suppressions").pipe(
  Command.withSubcommands([
    suppressionsListCommand,
    suppressionsAddCommand,
    suppressionsBatchAddCommand,
    suppressionsBatchRemoveCommand,
    suppressionsGetCommand,
    suppressionsRemoveCommand,
  ]),
);

export const TemplatesCommand = Command.make("templates").pipe(
  Command.withSubcommands([
    templatesListCommand,
    templatesCreateCommand,
    templatesGetCommand,
    templatesRemoveCommand,
    templatesUpdateCommand,
    templatesDuplicateCommand,
    templatesPublishCommand,
  ]),
);

export const TopicsCommand = Command.make("topics").pipe(
  Command.withSubcommands([
    topicsListCommand,
    topicsCreateCommand,
    topicsGetCommand,
    topicsRemoveCommand,
    topicsUpdateCommand,
  ]),
);

export const UsageCommand = Command.make("usage").pipe(Command.withSubcommands([usageGetCommand]));

export const WebhooksCommand = Command.make("webhooks").pipe(
  Command.withSubcommands([
    webhooksListCommand,
    webhooksCreateCommand,
    webhooksGetCommand,
    webhooksRemoveCommand,
    webhooksUpdateCommand,
    webhooksListEventsCommand,
    webhooksGetEventCommand,
    webhooksListEventAttemptsCommand,
    webhooksReplayEventCommand,
    webhooksRotateSigningSecretCommand,
  ]),
);
