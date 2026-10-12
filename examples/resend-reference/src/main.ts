#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, Match, Option, Schema, SchemaIssue } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import type { HttpClientError } from "effect/http";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const Attachment = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Content of an attached file.
     */
    content: Schema.optionalKey(Schema.String),
    /**
     * Content ID for embedding inline images using cid references (e.g., cid:image001).
     */
    content_id: Schema.optionalKey(Schema.String),
    /**
     * Optional content type for the attachment, if not set it will be derived from the filename
     * property
     */
    content_type: Schema.optionalKey(Schema.String),
    /**
     * Name of attached file.
     */
    filename: Schema.optionalKey(Schema.String),
    /**
     * Path where the attachment file is hosted
     */
    path: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const Tag = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The name of the email tag. It can only contain ASCII letters (a–z, A–Z), numbers (0–9),
     * underscores (_), or dashes (-). It can contain no more than 256 characters.
     */
    name: Schema.optionalKey(Schema.String),
    /**
     * The value of the email tag.It can only contain ASCII letters (a–z, A–Z), numbers (0–9),
     * underscores (_), or dashes (-). It can contain no more than 256 characters.
     */
    value: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const EmailTemplateInput = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The id of the published email template.
     */
    id: Schema.String,
    /**
     * Template variables object with key/value pairs.
     */
    variables: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite], { mode: "oneOf" })),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

/**
 * Configure the domain capabilities for sending and receiving emails. At least one capability must
 * be enabled.
 */
const DomainCapabilities = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Enable or disable receiving emails to this domain.
     */
    receiving: Schema.optionalKey(Schema.Literals(["enabled", "disabled"])),
    /**
     * Enable or disable sending emails from this domain.
     */
    sending: Schema.optionalKey(Schema.Literals(["enabled", "disabled"])),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const SendEmailRequest = Schema.StructWithRest(
  Schema.Struct({
    attachments: Schema.optionalKey(Schema.Array(Attachment)),
    /**
     * Bcc recipient email address. For multiple addresses, send as an array of strings.
     */
    bcc: Schema.optionalKey(
      Schema.Union([Schema.String, Schema.Array(Schema.String)], { mode: "oneOf" }),
    ),
    /**
     * Cc recipient email address. For multiple addresses, send as an array of strings.
     */
    cc: Schema.optionalKey(
      Schema.Union([Schema.String, Schema.Array(Schema.String)], { mode: "oneOf" }),
    ),
    /**
     * Sender email address. To include a friendly name, use the format
     * `Your Name <sender@domain.com>`.
     */
    from: Schema.String,
    /**
     * Custom headers to add to the email.
     */
    headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    /**
     * The HTML version of the message.
     */
    html: Schema.optionalKey(Schema.String),
    /**
     * Reply-to email address. For multiple addresses, send as an array of strings.
     */
    reply_to: Schema.optionalKey(
      Schema.Union([Schema.String, Schema.Array(Schema.String)], { mode: "oneOf" }),
    ),
    /**
     * Schedule email to be sent later. The date should be in ISO 8601 format.
     */
    scheduled_at: Schema.optionalKey(Schema.String),
    /**
     * Email subject.
     */
    subject: Schema.String,
    tags: Schema.optionalKey(Schema.Array(Tag)),
    /**
     * Use a published template to send the email. If provided, do not include html or text.
     */
    template: Schema.optionalKey(EmailTemplateInput),
    /**
     * The plain text version of the message.
     */
    text: Schema.optionalKey(Schema.String),
    /**
     * Recipient email address. For multiple addresses, send as an array of strings. Max 50.
     */
    to: Schema.Union(
      [
        Schema.String,
        Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
      ],
      { mode: "oneOf" },
    ),
    /**
     * The topic ID to scope the email to. If the recipient is a contact and opted-in to the topic,
     * the email is sent. If opted-out, the email is not sent. If the recipient is not a contact,
     * the email is sent if the topic's default subscription is opt_in.
     */
    topic_id: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const CreateDomainRequest = Schema.StructWithRest(
  Schema.Struct({
    capabilities: Schema.optionalKey(DomainCapabilities),
    /**
     * Track clicks within the body of each HTML email.
     */
    click_tracking: Schema.optionalKey(Schema.Boolean),
    /**
     * For advanced use cases, choose a subdomain for the Return-Path address. Defaults to 'send'
     * (i.e., send.yourdomain.tld).
     */
    custom_return_path: Schema.optionalKey(Schema.String),
    /**
     * The name of the domain you want to create.
     */
    name: Schema.String,
    /**
     * Track the open rate of each email.
     */
    open_tracking: Schema.optionalKey(Schema.Boolean),
    /**
     * The region where emails will be sent from. Possible values are us-east-1 | eu-west-1 |
     * sa-east-1 | ap-northeast-1
     */
    region: Schema.optionalKey(
      Schema.Literals(["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"]),
    ),
    /**
     * TLS mode. Opportunistic attempts secure connection but falls back to unencrypted. Enforced
     * requires TLS or email won't be sent.
     */
    tls: Schema.optionalKey(Schema.Literals(["opportunistic", "enforced"])),
    /**
     * The subdomain to use for click and open tracking.
     */
    tracking_subdomain: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const UpdateDomainOptions = Schema.StructWithRest(
  Schema.Struct({
    capabilities: Schema.optionalKey(DomainCapabilities),
    /**
     * Track clicks within the body of each HTML email.
     */
    click_tracking: Schema.optionalKey(Schema.Boolean),
    /**
     * Track the open rate of each email.
     */
    open_tracking: Schema.optionalKey(Schema.Boolean),
    /**
     * Enforced | opportunistic.
     */
    tls: Schema.optionalKey(Schema.Literals(["opportunistic", "enforced"])),
    /**
     * The subdomain to use for click and open tracking.
     */
    tracking_subdomain: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

/**
 * Exposes only the static flag check messages; malformed URL issues receive a
 * safe fallback instead of the native formatter's potentially sensitive input.
 *
 * @see https://github.com/Effect-TS/effect/blob/effect%404.0.3/packages/effect/src/SchemaIssue.ts
 */
const formatBaseUrlIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: () => "Enter an absolute URL; for example https://api.example.com.",
});

/**
 * Param.withSchema echoes rejected values. This boundary retains the typed cause
 * while rendering only the safe Schema issue message.
 *
 * @see https://github.com/Effect-TS/effect/blob/effect%404.0.3/packages/effect/src/cli/Param.ts
 */
const baseUrl = Flag.String("base-url").pipe(
  Flag.mapEffect((value) =>
    Schema.decodeUnknownEffect(
      Schema.URLFromString.check(
        Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:", {
          message: "Use HTTP or HTTPS for the API base URL.",
        }),
        Schema.makeFilter((url) => !url.username, {
          message: "Remove the username from the API base URL.",
        }),
        Schema.makeFilter((url) => !url.password, {
          message: "Remove the password from the API base URL.",
        }),
        Schema.makeFilter((url) => !url.search, {
          message: "Remove the query string from the API base URL.",
        }),
        Schema.makeFilter((url) => !url.hash, {
          message: "Remove the fragment from the API base URL.",
        }),
      ),
    )(value).pipe(
      Effect.mapError(
        (cause) =>
          new CliError.UserError({
            cause,
            userMessage: `Invalid --base-url. ${formatBaseUrlIssue(cause.issue).issues[0]?.message ?? "Enter an absolute URL."}`,
          }),
      ),
    ),
  ),
  Flag.withDescription(
    "API base URL including any path prefix; for example https://api.resend.com",
  ),
);

const httpErrorMessage = (reason: HttpClientError.HttpClientErrorReason): string =>
  Match.value(reason).pipe(
    Match.tagsExhaustive({
      DecodeError: () => "The response could not be read. Check the API server and connection.",
      EmptyBodyError: () => "The response was empty. Check the API server and its response format.",
      EncodeError: () =>
        "The request could not be encoded. Check the command inputs and API documentation.",
      InvalidUrlError: () => "The request URL is invalid. Check --base-url and its path prefix.",
      StatusCodeError: ({ response }) => {
        const message = `The server returned HTTP ${response.status}.`;
        if (response.status >= 500) {
          return `${message} Check the API service status.`;
        }

        return `${message} Check the API documentation for this status.`;
      },
      TransportError: () => "Connection failed. Check --base-url and that the server is reachable.",
    }),
  );

const runRequest = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.flatMap(Console.log),
    Effect.mapError(
      (cause) => new CliError.UserError({ cause, userMessage: httpErrorMessage(cause.reason) }),
    ),
  );

const apiKey = Flag.Redacted("api-key").pipe(
  Flag.withFallbackConfig(Config.Redacted("RESEND_API_KEY")),
  Flag.withDescription("Resend bearer API key; defaults to RESEND_API_KEY."),
);

/**
 * Retrieve a list of domains
 */
const domainsList = Command.make(
  "list",
  {
    after: Flag.String("after").pipe(
      Flag.withDescription("Return items after this cursor."),
      Flag.optional,
    ),
    apiKey,
    baseUrl,
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
      HttpClientRequest.appendUrl(`/domains`),
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      runRequest,
      Effect.withSpan("domains.list"),
    ),
).pipe(Command.withDescription("Retrieve a list of domains"));

/**
 * Create a new domain
 */
const domainsCreate = Command.make(
  "create",
  {
    apiKey,
    baseUrl,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(CreateDomainRequest))(value, {
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
      HttpClientRequest.appendUrl(`/domains`),
      HttpClientRequest.bearerToken(token),
      (request) =>
        Effect.suspend(() =>
          Option.isSome(body)
            ? HttpClientRequest.bodyJson(request, body.value)
            : Effect.succeed(request),
        ),
      Effect.mapError(
        (cause) =>
          new CliError.UserError({
            cause,
            userMessage: "The request body could not be encoded as JSON. Check the body values.",
          }),
      ),
      Effect.flatMap(runRequest),
      Effect.withSpan("domains.create"),
    ),
).pipe(Command.withDescription("Create a new domain"));

/**
 * Update an existing domain
 */
const domainsUpdate = Command.make(
  "update",
  {
    apiKey,
    baseUrl,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(UpdateDomainOptions))(value, {
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
  ({ apiKey: token, baseUrl: apiUrl, body, domainId }) => {
    // URL parsing normalizes dot segments; refuse a different request before execution.
    if (domainId === "." || domainId === "..") {
      return Effect.fail(
        new CliError.UserError({
          cause: { _tag: "UnrepresentablePathSegment" },
          userMessage:
            "The path parameter cannot be sent as a literal URL segment. Use an identifier other than . or ..; no request was sent.",
        }),
      );
    }

    return HttpClientRequest.patch(apiUrl).pipe(
      HttpClientRequest.appendUrl(`/domains/${encodeURIComponent(domainId)}`),
      HttpClientRequest.bearerToken(token),
      (request) =>
        Effect.suspend(() =>
          Option.isSome(body)
            ? HttpClientRequest.bodyJson(request, body.value)
            : Effect.succeed(request),
        ),
      Effect.mapError(
        (cause) =>
          new CliError.UserError({
            cause,
            userMessage: "The request body could not be encoded as JSON. Check the body values.",
          }),
      ),
      Effect.flatMap(runRequest),
      Effect.withSpan("domains.update"),
    );
  },
).pipe(Command.withDescription("Update an existing domain"));

/**
 * Remove an existing domain
 */
const domainsRemove = Command.make(
  "delete",
  {
    apiKey,
    baseUrl,
    domainId: Flag.String("domain-id").pipe(Flag.withDescription("The ID of the domain.")),
  },
  ({ apiKey: token, baseUrl: apiUrl, domainId }) => {
    // URL parsing normalizes dot segments; refuse a different request before execution.
    if (domainId === "." || domainId === "..") {
      return Effect.fail(
        new CliError.UserError({
          cause: { _tag: "UnrepresentablePathSegment" },
          userMessage:
            "The path parameter cannot be sent as a literal URL segment. Use an identifier other than . or ..; no request was sent.",
        }),
      );
    }

    return HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.appendUrl(`/domains/${encodeURIComponent(domainId)}`),
      HttpClientRequest.bearerToken(token),
      runRequest,
      Effect.withSpan("domains.remove"),
    );
  },
).pipe(Command.withDescription("Remove an existing domain"));

/**
 * Send an email
 */
const emailsSend = Command.make(
  "send",
  {
    apiKey,
    baseUrl,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(SendEmailRequest))(value, {
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
      HttpClientRequest.appendUrl(`/emails`),
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeaders({ "Idempotency-Key": Option.getOrUndefined(idempotencyKey) }),
      (request) =>
        Effect.suspend(() =>
          Option.isSome(body)
            ? HttpClientRequest.bodyJson(request, body.value)
            : Effect.succeed(request),
        ),
      Effect.mapError(
        (cause) =>
          new CliError.UserError({
            cause,
            userMessage: "The request body could not be encoded as JSON. Check the body values.",
          }),
      ),
      Effect.flatMap(runRequest),
      Effect.withSpan("emails.send"),
    ),
).pipe(Command.withDescription("Send an email"));

/**
 * Trigger up to 100 batch emails at once.
 */
const emailsSendBatch = Command.make(
  "send",
  {
    apiKey,
    baseUrl,
    body: Flag.String("body").pipe(
      Flag.mapEffect((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(SendEmailRequest)))(value, {
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
      HttpClientRequest.appendUrl(`/emails/batch`),
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeaders({ "Idempotency-Key": Option.getOrUndefined(idempotencyKey) }),
      (request) =>
        Effect.suspend(() =>
          Option.isSome(body)
            ? HttpClientRequest.bodyJson(request, body.value)
            : Effect.succeed(request),
        ),
      Effect.mapError(
        (cause) =>
          new CliError.UserError({
            cause,
            userMessage: "The request body could not be encoded as JSON. Check the body values.",
          }),
      ),
      Effect.flatMap(runRequest),
      Effect.withSpan("emails.send-batch"),
    ),
).pipe(Command.withDescription("Trigger up to 100 batch emails at once."));

/**
 * Retrieve a list of attachments for a sent email
 */
const emailsListAttachments = Command.make(
  "list",
  {
    after: Flag.String("after").pipe(
      Flag.withDescription(
        "Pagination cursor to fetch results after this attachment ID. Cannot be used with 'before'.",
      ),
      Flag.optional,
    ),
    apiKey,
    baseUrl,
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
  ({ after, apiKey: token, baseUrl: apiUrl, before, emailId, limit }) => {
    // URL parsing normalizes dot segments; refuse a different request before execution.
    if (emailId === "." || emailId === "..") {
      return Effect.fail(
        new CliError.UserError({
          cause: { _tag: "UnrepresentablePathSegment" },
          userMessage:
            "The path parameter cannot be sent as a literal URL segment. Use an identifier other than . or ..; no request was sent.",
        }),
      );
    }

    return HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.appendUrl(`/emails/${encodeURIComponent(emailId)}/attachments`),
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      runRequest,
      Effect.withSpan("emails.list-attachments"),
    );
  },
).pipe(Command.withDescription("Retrieve a list of attachments for a sent email"));

/**
 * Retrieve a single attachment for a sent email
 */
const emailsGetAttachment = Command.make(
  "get",
  {
    apiKey,
    attachmentId: Flag.String("attachment-id").pipe(
      Flag.withDescription("The ID of the attachment."),
    ),
    baseUrl,
    emailId: Flag.String("email-id").pipe(Flag.withDescription("The ID of the email.")),
  },
  ({ apiKey: token, attachmentId, baseUrl: apiUrl, emailId }) => {
    // URL parsing normalizes dot segments; refuse a different request before execution.
    if (emailId === "." || emailId === ".." || attachmentId === "." || attachmentId === "..") {
      return Effect.fail(
        new CliError.UserError({
          cause: { _tag: "UnrepresentablePathSegment" },
          userMessage:
            "The path parameter cannot be sent as a literal URL segment. Use an identifier other than . or ..; no request was sent.",
        }),
      );
    }

    return HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.appendUrl(
        `/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
      ),
      HttpClientRequest.bearerToken(token),
      runRequest,
      Effect.withSpan("emails.get-attachment"),
    );
  },
).pipe(Command.withDescription("Retrieve a single attachment for a sent email"));

const Domains = Command.make("domains").pipe(
  Command.withSubcommands([domainsList, domainsCreate, domainsUpdate, domainsRemove]),
);

const EmailsAttachments = Command.make("attachments").pipe(
  Command.withSubcommands([emailsListAttachments, emailsGetAttachment]),
);

const EmailsBatch = Command.make("batch").pipe(Command.withSubcommands([emailsSendBatch]));

const Emails = Command.make("emails").pipe(
  Command.withSubcommands([emailsSend, EmailsBatch, EmailsAttachments]),
);

const rootCommand = Command.make("resend-reference").pipe(
  Command.withDescription("Resend is the email platform for developers."),
  Command.withSubcommands([Domains, Emails]),
);

Command.run(rootCommand, { version: "0.0.0" }).pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
