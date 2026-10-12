#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, Match, Option, Schema, SchemaIssue } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import type { HttpClientError } from "effect/http";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { CreateDomainRequest, SendEmailRequest, UpdateDomainOptions } from "./models.js";

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
