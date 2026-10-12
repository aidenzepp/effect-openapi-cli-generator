import { Effect, Option, Schema } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { HttpClientRequest } from "effect/http";
import * as Builtins from "./builtins.js";
import * as Models from "./models.js";

/**
 * Retrieve a list of domains
 */
const domainsListCommand = Command.make(
  "list",
  {
    after: Flag.String("after").pipe(
      Flag.withDescription("Return items after this cursor."),
      Flag.optional,
    ),
    apiKey: Builtins.apiKey,
    baseUrl: Builtins.baseUrl,
    before: Flag.String("before").pipe(
      Flag.withDescription("Return items before this cursor."),
      Flag.optional,
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withSchema(Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }))),
      Flag.withDescription("Number of items to return."),
      Flag.optional,
    ),
  },
  ({ after, apiKey: token, baseUrl: apiUrl, before, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      Builtins.appendPathSegments("domains"),
      Effect.flatMap(Builtins.runRequest),
      Effect.withSpan("domains.list"),
    ),
).pipe(Command.withDescription("Retrieve a list of domains"));

/**
 * Create a new domain
 */
const domainsCreateCommand = Command.make(
  "create",
  {
    apiKey: Builtins.apiKey,
    baseUrl: Builtins.baseUrl,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Models.CreateDomainRequest))(value, {
          reportInput: false,
        }).pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        ),
      ),
      Flag.withDescription("JSON request body."),
      Flag.optional,
    ),
  },
  ({ apiKey: token, baseUrl: apiUrl, body }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(token),
      Builtins.appendPathSegments("domains"),
      Effect.flatMap((request) =>
        Effect.suspend(() =>
          Option.isSome(body)
            ? HttpClientRequest.bodyJson(request, body.value)
            : Effect.succeed(request),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CliError.UserError({
                cause,
                userMessage:
                  "The request body could not be encoded as JSON. Check the body values.",
              }),
          ),
        ),
      ),
      Effect.flatMap(Builtins.runRequest),
      Effect.withSpan("domains.create"),
    ),
).pipe(Command.withDescription("Create a new domain"));

/**
 * Update an existing domain
 */
const domainsUpdateCommand = Command.make(
  "update",
  {
    apiKey: Builtins.apiKey,
    baseUrl: Builtins.baseUrl,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Models.UpdateDomainOptions))(value, {
          reportInput: false,
        }).pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        ),
      ),
      Flag.withDescription("JSON request body."),
      Flag.optional,
    ),
    domainId: Flag.String("domain-id").pipe(Flag.withDescription("The ID of the domain.")),
  },
  ({ apiKey: token, baseUrl: apiUrl, body, domainId }) =>
    HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.bearerToken(token),
      Builtins.appendPathSegments("domains", domainId),
      Effect.flatMap((request) =>
        Effect.suspend(() =>
          Option.isSome(body)
            ? HttpClientRequest.bodyJson(request, body.value)
            : Effect.succeed(request),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CliError.UserError({
                cause,
                userMessage:
                  "The request body could not be encoded as JSON. Check the body values.",
              }),
          ),
        ),
      ),
      Effect.flatMap(Builtins.runRequest),
      Effect.withSpan("domains.update"),
    ),
).pipe(Command.withDescription("Update an existing domain"));

/**
 * Remove an existing domain
 */
const domainsRemoveCommand = Command.make(
  "delete",
  {
    apiKey: Builtins.apiKey,
    baseUrl: Builtins.baseUrl,
    domainId: Flag.String("domain-id").pipe(Flag.withDescription("The ID of the domain.")),
  },
  ({ apiKey: token, baseUrl: apiUrl, domainId }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(token),
      Builtins.appendPathSegments("domains", domainId),
      Effect.flatMap(Builtins.runRequest),
      Effect.withSpan("domains.remove"),
    ),
).pipe(Command.withDescription("Remove an existing domain"));

/**
 * Send an email
 */
const emailsSendCommand = Command.make(
  "send",
  {
    apiKey: Builtins.apiKey,
    baseUrl: Builtins.baseUrl,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Models.SendEmailRequest))(value, {
          reportInput: false,
        }).pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        ),
      ),
      Flag.withDescription("JSON request body."),
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
  ({ apiKey: token, baseUrl: apiUrl, body, idempotencyKey }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeaders({ "Idempotency-Key": Option.getOrUndefined(idempotencyKey) }),
      Builtins.appendPathSegments("emails"),
      Effect.flatMap((request) =>
        Effect.suspend(() =>
          Option.isSome(body)
            ? HttpClientRequest.bodyJson(request, body.value)
            : Effect.succeed(request),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CliError.UserError({
                cause,
                userMessage:
                  "The request body could not be encoded as JSON. Check the body values.",
              }),
          ),
        ),
      ),
      Effect.flatMap(Builtins.runRequest),
      Effect.withSpan("emails.send"),
    ),
).pipe(Command.withDescription("Send an email"));

/**
 * Trigger up to 100 batch emails at once.
 */
const emailsSendBatchCommand = Command.make(
  "send",
  {
    apiKey: Builtins.apiKey,
    baseUrl: Builtins.baseUrl,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Models.SendEmailRequest)))(
          value,
          {
            reportInput: false,
          },
        ).pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        ),
      ),
      Flag.withDescription("JSON request body."),
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
  ({ apiKey: token, baseUrl: apiUrl, body, idempotencyKey }) =>
    HttpClientRequest.post(apiUrl).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeaders({ "Idempotency-Key": Option.getOrUndefined(idempotencyKey) }),
      Builtins.appendPathSegments("emails", "batch"),
      Effect.flatMap((request) =>
        Effect.suspend(() =>
          Option.isSome(body)
            ? HttpClientRequest.bodyJson(request, body.value)
            : Effect.succeed(request),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CliError.UserError({
                cause,
                userMessage:
                  "The request body could not be encoded as JSON. Check the body values.",
              }),
          ),
        ),
      ),
      Effect.flatMap(Builtins.runRequest),
      Effect.withSpan("emails.send-batch"),
    ),
).pipe(Command.withDescription("Trigger up to 100 batch emails at once."));

/**
 * Retrieve a list of attachments for a sent email
 */
const emailsListAttachmentsCommand = Command.make(
  "list",
  {
    after: Flag.String("after").pipe(
      Flag.withDescription(
        "Pagination cursor to fetch results after this attachment ID. Cannot be used with 'before'.",
      ),
      Flag.optional,
    ),
    apiKey: Builtins.apiKey,
    baseUrl: Builtins.baseUrl,
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
  ({ after, apiKey: token, baseUrl: apiUrl, before, emailId, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      Builtins.appendPathSegments("emails", emailId, "attachments"),
      Effect.flatMap(Builtins.runRequest),
      Effect.withSpan("emails.list-attachments"),
    ),
).pipe(Command.withDescription("Retrieve a list of attachments for a sent email"));

/**
 * Retrieve a single attachment for a sent email
 */
const emailsGetAttachmentCommand = Command.make(
  "get",
  {
    apiKey: Builtins.apiKey,
    attachmentId: Flag.String("attachment-id").pipe(
      Flag.withDescription("The ID of the attachment."),
    ),
    baseUrl: Builtins.baseUrl,
    emailId: Flag.String("email-id").pipe(Flag.withDescription("The ID of the email.")),
  },
  ({ apiKey: token, attachmentId, baseUrl: apiUrl, emailId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(token),
      Builtins.appendPathSegments("emails", emailId, "attachments", attachmentId),
      Effect.flatMap(Builtins.runRequest),
      Effect.withSpan("emails.get-attachment"),
    ),
).pipe(Command.withDescription("Retrieve a single attachment for a sent email"));

export const DomainsCommand = Command.make("domains").pipe(
  Command.withSubcommands([
    domainsListCommand,
    domainsCreateCommand,
    domainsUpdateCommand,
    domainsRemoveCommand,
  ]),
);

const EmailsAttachmentsCommand = Command.make("attachments").pipe(
  Command.withSubcommands([emailsListAttachmentsCommand, emailsGetAttachmentCommand]),
);

const EmailsBatchCommand = Command.make("batch").pipe(
  Command.withSubcommands([emailsSendBatchCommand]),
);

export const EmailsCommand = Command.make("emails").pipe(
  Command.withSubcommands([emailsSendCommand, EmailsBatchCommand, EmailsAttachmentsCommand]),
);
