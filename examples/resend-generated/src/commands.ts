import { Effect, Option, Schema } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { HttpClientRequest } from "effect/http";
import * as Body from "./builtins/body.js";
import * as Errors from "./builtins/errors.js";
import * as Http from "./builtins/http.js";
import * as Url from "./builtins/url.js";
import * as Parameters from "./components/parameters.js";
import * as Schemas from "./components/schemas.js";
import * as SecuritySchemes from "./components/security-schemes.js";

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
 * Remove an existing domain
 */
const domainsRemoveCommand = Command.make(
  "delete",
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
  "send",
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
  "get",
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

const EmailsAttachmentsCommand = Command.make("attachments").pipe(
  Command.withSubcommands([emailsListAttachmentsCommand, emailsGetAttachmentCommand]),
);

const EmailsBatchCommand = Command.make("batch").pipe(
  Command.withSubcommands([emailsSendBatchCommand]),
);

export const DomainsCommand = Command.make("domains").pipe(
  Command.withSubcommands([
    domainsListCommand,
    domainsCreateCommand,
    domainsRemoveCommand,
    domainsUpdateCommand,
  ]),
);

export const EmailsCommand = Command.make("emails").pipe(
  Command.withSubcommands([emailsSendCommand, EmailsAttachmentsCommand, EmailsBatchCommand]),
);
