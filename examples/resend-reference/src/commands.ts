import { Config, Console, Effect, Match, Option, Schema, SchemaIssue } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import type { HttpClientError } from "effect/http";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Models from "./models.js";

/**
 * Format base URL failures without exposing the rejected input. Preserve static
 * schema check messages and use a safe fallback for malformed URLs.
 *
 * @see https://github.com/Effect-TS/effect/blob/effect%404.0.3/packages/effect/src/SchemaIssue.ts
 */
const formatBaseUrlIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: () => "Enter an absolute URL; for example https://api.example.com.",
});

/**
 * Require an HTTP or HTTPS API base URL, preserving any path prefix. Reject
 * credentials, queries and fragments without displaying their values;
 * Param.withSchema would echo rejected input.
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

/**
 * Describe HTTP failures with neutral guidance, without exposing request details
 * or response bodies. Status failures include the numeric HTTP status.
 */
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

/**
 * Encode one complete URL path segment. Reject whole dot segments before URL
 * parsing can redirect the request, and report invalid Unicode as a CLI error.
 */
const encodePathSegment = (segment: string) => {
  if (segment === "." || segment === "..") {
    return Effect.fail(
      new CliError.UserError({
        cause: { _tag: "UnrepresentablePathSegment" },
        userMessage:
          "The path parameter cannot be sent as a literal URL segment. Use an identifier other than . or ..; no request was sent.",
      }),
    );
  }

  return Effect.try({
    catch: (cause) =>
      new CliError.UserError({
        cause,
        userMessage:
          "The path parameter contains invalid Unicode. Use valid Unicode text; no request was sent.",
      }),
    try: () => encodeURIComponent(segment),
  });
};

/**
 * Append complete path segments while preserving the base URL path prefix.
 * Encode each segment separately so embedded slashes remain parameter data.
 */
const appendPathSegments =
  (...segments: readonly string[]) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.forEach(encodePathSegment)(segments).pipe(
      Effect.map((encoded) => HttpClientRequest.appendUrl(request, encoded.join("/"))),
    );

/**
 * Execute a request once and print successful response text. Reject non-2xx
 * statuses and retain typed HTTP causes behind safe CLI messages.
 */
const runRequest = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.flatMap(Console.log),
    Effect.mapError(
      (cause) => new CliError.UserError({ cause, userMessage: httpErrorMessage(cause.reason) }),
    ),
  );

/**
 * Read the bearer credential as a redacted value. An explicit --api-key takes
 * precedence over the RESEND_API_KEY environment fallback.
 */
const apiKey = Flag.Redacted("api-key").pipe(
  Flag.withFallbackConfig(Config.Redacted("RESEND_API_KEY")),
  Flag.withDescription("Resend bearer API key; defaults to RESEND_API_KEY."),
);

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
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      appendPathSegments("domains"),
      Effect.flatMap(runRequest),
      Effect.withSpan("domains.list"),
    ),
).pipe(Command.withDescription("Retrieve a list of domains"));

/**
 * Create a new domain
 */
const domainsCreateCommand = Command.make(
  "create",
  {
    apiKey,
    baseUrl,
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
      appendPathSegments("domains"),
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
      Effect.flatMap(runRequest),
      Effect.withSpan("domains.create"),
    ),
).pipe(Command.withDescription("Create a new domain"));

/**
 * Update an existing domain
 */
const domainsUpdateCommand = Command.make(
  "update",
  {
    apiKey,
    baseUrl,
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
      appendPathSegments("domains", domainId),
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
      Effect.flatMap(runRequest),
      Effect.withSpan("domains.update"),
    ),
).pipe(Command.withDescription("Update an existing domain"));

/**
 * Remove an existing domain
 */
const domainsRemoveCommand = Command.make(
  "delete",
  {
    apiKey,
    baseUrl,
    domainId: Flag.String("domain-id").pipe(Flag.withDescription("The ID of the domain.")),
  },
  ({ apiKey: token, baseUrl: apiUrl, domainId }) =>
    HttpClientRequest.delete(apiUrl).pipe(
      HttpClientRequest.bearerToken(token),
      appendPathSegments("domains", domainId),
      Effect.flatMap(runRequest),
      Effect.withSpan("domains.remove"),
    ),
).pipe(Command.withDescription("Remove an existing domain"));

/**
 * Send an email
 */
const emailsSendCommand = Command.make(
  "send",
  {
    apiKey,
    baseUrl,
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
      appendPathSegments("emails"),
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
      Effect.flatMap(runRequest),
      Effect.withSpan("emails.send"),
    ),
).pipe(Command.withDescription("Send an email"));

/**
 * Trigger up to 100 batch emails at once.
 */
const emailsSendBatchCommand = Command.make(
  "send",
  {
    apiKey,
    baseUrl,
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
      appendPathSegments("emails", "batch"),
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
      Effect.flatMap(runRequest),
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
  ({ after, apiKey: token, baseUrl: apiUrl, before, emailId, limit }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setUrlParams({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        limit: Option.getOrUndefined(limit),
      }),
      appendPathSegments("emails", emailId, "attachments"),
      Effect.flatMap(runRequest),
      Effect.withSpan("emails.list-attachments"),
    ),
).pipe(Command.withDescription("Retrieve a list of attachments for a sent email"));

/**
 * Retrieve a single attachment for a sent email
 */
const emailsGetAttachmentCommand = Command.make(
  "get",
  {
    apiKey,
    attachmentId: Flag.String("attachment-id").pipe(
      Flag.withDescription("The ID of the attachment."),
    ),
    baseUrl,
    emailId: Flag.String("email-id").pipe(Flag.withDescription("The ID of the email.")),
  },
  ({ apiKey: token, attachmentId, baseUrl: apiUrl, emailId }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(token),
      appendPathSegments("emails", emailId, "attachments", attachmentId),
      Effect.flatMap(runRequest),
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
