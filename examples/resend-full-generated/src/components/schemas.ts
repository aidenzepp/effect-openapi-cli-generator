import { Schema } from "effect";

export const CreateApiKeyRequest = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Restrict an API key to send emails only from a specific domain. Only used when the permission
     * is sending_access.
     */
    domain_id: Schema.optionalKey(Schema.String),
    /**
     * The API key name.
     */
    name: Schema.String,
    /**
     * The API key can have full access to Resend’s API or be only restricted to send emails. *
     * full_access - Can create, delete, get, and update any resource. * sending_access - Can only
     * send emails.
     */
    permission: Schema.optionalKey(Schema.Literals(["full_access", "sending_access"])),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const UpdateApiKeyRequest = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The API key name.
     */
    name: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

/**
 * Deprecated.
 *
 * @deprecated
 */
export const CreateAudienceOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The name of the audience you want to create.
     */
    name: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

/**
 * A connection between two steps in the automation graph.
 */
const AutomationConnection = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The `key` of the source step.
     */
    from: Schema.String,
    /**
     * The `key` of the target step.
     */
    to: Schema.String,
    /**
     * The type of connection. Defaults to `default`.
     */
    type: Schema.optionalKey(
      Schema.Literals([
        "default",
        "condition_met",
        "condition_not_met",
        "timeout",
        "event_received",
      ]),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

/**
 * A step in an automation workflow. The `config` object varies based on the step `type`.
 */
const AutomationStep = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Configuration for the step. Shape depends on `type`: - **trigger**: `{ event_name: string }` -
     * **send_email**: `{ template: { id: string, variables?: object }, subject?: string, from?:
     * string, reply_to?: string }` - **delay**: `{ duration: string }` — a human-readable duration
     * (e.g. `"30 minutes"`) - **wait_for_event**: `{ event_name: string, timeout?: string,
     * filter_rule?: object }` — `timeout` is a human-readable duration (e.g. `"1 hour"`) -
     * **condition**: A rule tree with `type` (`rule`, `and`, `or`), `field`, `operator`, and
     * `value` - **contact_update**: `{ first_name?: string|object, last_name?: string|object,
     * unsubscribed?: boolean|object, properties?: object }` - **contact_delete**: `{}` -
     * **add_to_segment**: `{ segment_id: string }`
     */
    config: Schema.StructWithRest(Schema.Struct({}), [Schema.Record(Schema.String, Schema.Json)]),
    /**
     * A unique key for this step within the automation graph.
     */
    key: Schema.String,
    /**
     * The type of automation step.
     */
    type: Schema.Literals([
      "trigger",
      "send_email",
      "delay",
      "wait_for_event",
      "condition",
      "contact_update",
      "contact_delete",
      "add_to_segment",
    ]),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const CreateAutomationRequest = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The connections between steps in the automation graph.
     */
    connections: Schema.Array(AutomationConnection),
    /**
     * The name of the automation.
     */
    name: Schema.String.check(Schema.isMinCodePoints(1)),
    /**
     * The initial status of the automation. Defaults to `disabled`.
     */
    status: Schema.optionalKey(Schema.Literals(["enabled", "disabled"])),
    /**
     * The steps that compose the automation workflow. Must include at least one `trigger` step.
     */
    steps: Schema.Array(AutomationStep).check(Schema.isMinLength(1), Schema.isMaxLength(150)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

/**
 * At least one of `name`, `status`, or `steps` and `connections` must be provided. When updating
 * the workflow graph, both `steps` and `connections` must be provided together.
 */
export const PatchAutomationRequest = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The connections between steps in the automation graph. Must be provided together with
     * `steps`.
     */
    connections: Schema.optionalKey(Schema.Array(AutomationConnection)),
    /**
     * The name of the automation.
     */
    name: Schema.optionalKey(Schema.String.check(Schema.isMinCodePoints(1))),
    /**
     * The status of the automation.
     */
    status: Schema.optionalKey(Schema.Literals(["enabled", "disabled"])),
    /**
     * The steps that compose the automation workflow. Must be provided together with `connections`.
     */
    steps: Schema.optionalKey(
      Schema.Array(AutomationStep).check(Schema.isMinLength(1), Schema.isMaxLength(150)),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const CreateBroadcastOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Use `segment_id` instead. Unique identifier of the segment this broadcast will be sent to.
     * Deprecated.
     *
     * @deprecated
     */
    // oxlint-disable-next-line typescript/no-deprecated -- Required schema registration for a supported deprecated API field.
    audience_id: Schema.optionalKey(Schema.String),
    /**
     * The email address of the sender.
     */
    from: Schema.String,
    /**
     * The HTML version of the message.
     */
    html: Schema.optionalKey(Schema.String),
    /**
     * Name of the broadcast.
     */
    name: Schema.optionalKey(Schema.String),
    /**
     * The preview text of the email.
     */
    preview_text: Schema.optionalKey(Schema.String),
    /**
     * The email addresses to which replies should be sent.
     */
    reply_to: Schema.optionalKey(Schema.Array(Schema.String)),
    /**
     * Schedule time to send the broadcast. Can only be used if `send` is true.
     */
    scheduled_at: Schema.optionalKey(Schema.String),
    /**
     * Unique identifier of the segment this broadcast will be sent to.
     */
    segment_id: Schema.String,
    /**
     * Whether to send the broadcast immediately or keep it as a draft.
     */
    send: Schema.optionalKey(Schema.Boolean),
    /**
     * The subject line of the email.
     */
    subject: Schema.String,
    /**
     * The plain text version of the message.
     */
    text: Schema.optionalKey(Schema.String),
    /**
     * The topic ID that the broadcast will be scoped to.
     */
    topic_id: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const UpdateBroadcastOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Use `segment_id` instead. Unique identifier of the audience this broadcast will be sent to.
     * Deprecated.
     *
     * @deprecated
     */
    // oxlint-disable-next-line typescript/no-deprecated -- Required schema registration for a supported deprecated API field.
    audience_id: Schema.optionalKey(Schema.String),
    /**
     * The email address of the sender.
     */
    from: Schema.optionalKey(Schema.String),
    /**
     * The HTML version of the message.
     */
    html: Schema.optionalKey(Schema.String),
    /**
     * Name of the broadcast.
     */
    name: Schema.optionalKey(Schema.String),
    /**
     * The preview text of the email.
     */
    preview_text: Schema.optionalKey(Schema.String),
    /**
     * The email addresses to which replies should be sent.
     */
    reply_to: Schema.optionalKey(Schema.Array(Schema.String)),
    /**
     * Unique identifier of the segment this broadcast will be sent to.
     */
    segment_id: Schema.optionalKey(Schema.String),
    /**
     * The subject line of the email.
     */
    subject: Schema.optionalKey(Schema.String),
    /**
     * The plain text version of the message.
     */
    text: Schema.optionalKey(Schema.String),
    /**
     * The topic ID that the broadcast will be scoped to.
     */
    topic_id: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const SendBroadcastOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Schedule email to be sent later. The date should be in ISO 8601 format.
     */
    scheduled_at: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const CreateContactPropertyOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The default value to use when the property is not set for a contact. Must match the type
     * specified in the type field.
     */
    fallback_value: Schema.optionalKey(
      Schema.Union([Schema.String, Schema.Finite], { mode: "oneOf" }),
    ),
    /**
     * The property key. Max length is 50 characters. Only alphanumeric characters and underscores
     * are allowed.
     */
    key: Schema.String,
    /**
     * The property type.
     */
    type: Schema.Literals(["string", "number"]),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const UpdateContactPropertyOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The default value to use when the property is not set for a contact. Must match the type of
     * the property.
     */
    fallback_value: Schema.optionalKey(
      Schema.Union([Schema.String, Schema.Finite], { mode: "oneOf" }),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const CreateContactOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Unique identifier of the audience to which the contact belongs.
     * Deprecated.
     *
     * @deprecated
     */
    // oxlint-disable-next-line typescript/no-deprecated -- Required schema registration for a supported deprecated API field.
    audience_id: Schema.optionalKey(Schema.String),
    /**
     * Email address of the contact.
     */
    email: Schema.String,
    /**
     * First name of the contact.
     */
    first_name: Schema.optionalKey(Schema.String),
    /**
     * Last name of the contact.
     */
    last_name: Schema.optionalKey(Schema.String),
    /**
     * A map of custom property keys and values to create.
     */
    properties: Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({}), [
        Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Null])),
      ]),
    ),
    /**
     * Array of segment IDs to add the contact to.
     */
    segments: Schema.optionalKey(
      Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({
            /**
             * The segment ID
             */
            id: Schema.optionalKey(Schema.String),
          }),
          [Schema.Record(Schema.String, Schema.Json)],
        ),
      ),
    ),
    /**
     * Array of topic subscriptions for the contact.
     */
    topics: Schema.optionalKey(
      Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({
            /**
             * The topic ID.
             */
            id: Schema.optionalKey(Schema.String),
            /**
             * The subscription status for this topic.
             */
            subscription: Schema.optionalKey(Schema.Literals(["opt_in", "opt_out"])),
          }),
          [Schema.Record(Schema.String, Schema.Json)],
        ),
      ),
    ),
    /**
     * The Contact's global subscription status. If set to true, the contact will be unsubscribed
     * from all Broadcasts.
     */
    unsubscribed: Schema.optionalKey(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const UpdateContactTopicsOptions = Schema.StructWithRest(
  Schema.Struct({
    topics: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          /**
           * The ID of the topic.
           */
          id: Schema.optionalKey(Schema.String),
          /**
           * The subscription status (opt_in or opt_out).
           */
          subscription: Schema.optionalKey(Schema.Literals(["opt_in", "opt_out"])),
        }),
        [Schema.Record(Schema.String, Schema.Json)],
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const UpdateContactOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Email address of the contact.
     */
    email: Schema.optionalKey(Schema.String),
    /**
     * First name of the contact.
     */
    first_name: Schema.optionalKey(Schema.String),
    /**
     * Last name of the contact.
     */
    last_name: Schema.optionalKey(Schema.String),
    /**
     * A map of custom property keys and values to update.
     */
    properties: Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({}), [
        Schema.Record(
          Schema.String,
          Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
        ),
      ]),
    ),
    /**
     * The Contact's global subscription status. If set to true, the contact will be unsubscribed
     * from all Broadcasts.
     */
    unsubscribed: Schema.optionalKey(Schema.Boolean),
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

export const CreateDomainRequest = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Configure the domain capabilities for sending and receiving emails. At least one capability
     * must be enabled.
     */
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

export const CreateDomainClaimRequest = Schema.StructWithRest(
  Schema.Struct({
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
     * The name of the domain you want to claim.
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
     * The subdomain to use for click and open tracking.
     */
    tracking_subdomain: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const UpdateDomainOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Configure the domain capabilities for sending and receiving emails. At least one capability
     * must be enabled.
     */
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
      Schema.StructWithRest(Schema.Struct({}), [
        Schema.Record(
          Schema.String,
          Schema.Union([Schema.String, Schema.Finite], { mode: "oneOf" }),
        ),
      ]),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const SendEmailRequest = Schema.StructWithRest(
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
     * Sender email address. To include a friendly name, use the format "Your Name
     * [sender@domain.com](mailto:sender@domain.com)".
     */
    from: Schema.String,
    /**
     * Custom headers to add to the email.
     */
    headers: Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({}), [Schema.Record(Schema.String, Schema.Json)]),
    ),
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

export const ShareEmailOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * How long the link stays valid for, as a duration like `10m`, `2 hours`, or `1 day`. Defaults
     * to `48h` and cannot exceed 48 hours.
     */
    expires_in: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const CreateEventRequest = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The name of the event. Cannot start with the reserved `resend:` prefix.
     */
    name: Schema.String,
    /**
     * An optional flat key/type map defining the event payload schema. Supported types are
     * `string`, `number`, `boolean`, and `date`.
     */
    schema: Schema.optionalKey(
      Schema.NullOr(
        Schema.StructWithRest(Schema.Struct({}), [Schema.Record(Schema.String, Schema.Json)]),
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const SendEventRequest = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The ID of the contact to associate with this event. Exactly one of `contact_id` or `email`
     * must be provided.
     */
    contact_id: Schema.optionalKey(Schema.String),
    /**
     * The email address to associate with this event. Exactly one of `contact_id` or `email` must
     * be provided.
     */
    email: Schema.optionalKey(Schema.String),
    /**
     * The name of the event to send.
     */
    event: Schema.String,
    /**
     * An optional payload of key/value pairs to include with the event.
     */
    payload: Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({}), [Schema.Record(Schema.String, Schema.Json)]),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const UpdateEventRequest = Schema.StructWithRest(
  Schema.Struct({
    /**
     * A flat key/type map defining the event payload schema. Set to `null` to clear the schema.
     * Supported types are `string`, `number`, `boolean`, and `date`.
     */
    schema: Schema.NullOr(
      Schema.StructWithRest(Schema.Struct({}), [Schema.Record(Schema.String, Schema.Json)]),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const CreateSegmentOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The ID of the audience this segment belongs to.
     * Deprecated.
     *
     * @deprecated
     */
    // oxlint-disable-next-line typescript/no-deprecated -- Required schema registration for a supported deprecated API field.
    audience_id: Schema.optionalKey(Schema.String),
    /**
     * Filter conditions for the segment.
     */
    filter: Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({}), [Schema.Record(Schema.String, Schema.Json)]),
    ),
    /**
     * The name of the segment.
     */
    name: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const UpdateSegmentOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The name of the segment.
     */
    name: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const CreateSuppressionOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Email address to suppress.
     */
    email: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const BatchAddSuppressionsOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Email addresses to suppress.
     */
    emails: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

/**
 * Provide either `emails` or `ids`, but not both.
 */
export const BatchRemoveSuppressionsOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * Email addresses to remove from the suppression list.
     */
    emails: Schema.optionalKey(
      Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    ),
    /**
     * Suppression IDs to remove from the suppression list.
     */
    ids: Schema.optionalKey(
      Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const TemplateVariableInput = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The fallback value of the variable.
     */
    fallback_value: Schema.optionalKey(
      Schema.Union(
        [
          Schema.String,
          Schema.Finite,
          Schema.Boolean,
          Schema.StructWithRest(Schema.Struct({}), [Schema.Record(Schema.String, Schema.Json)]),
          Schema.Array(Schema.Json),
        ],
        { mode: "oneOf" },
      ),
    ),
    /**
     * The key of the variable.
     */
    key: Schema.String,
    /**
     * The type of the variable.
     */
    type: Schema.Literals(["string", "number", "boolean", "object", "list"]),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const CreateTemplateRequest = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The alias of the template.
     */
    alias: Schema.optionalKey(Schema.String),
    /**
     * Sender email address. To include a friendly name, use the format "Your Name
     * [sender@domain.com](mailto:sender@domain.com)".
     */
    from: Schema.optionalKey(Schema.String),
    /**
     * The HTML version of the template.
     */
    html: Schema.String,
    /**
     * The name of the template.
     */
    name: Schema.String,
    /**
     * Reply-to email addresses.
     */
    reply_to: Schema.optionalKey(Schema.Array(Schema.String)),
    /**
     * Email subject.
     */
    subject: Schema.optionalKey(Schema.String),
    /**
     * The plain text version of the template.
     */
    text: Schema.optionalKey(Schema.String),
    variables: Schema.optionalKey(Schema.Array(TemplateVariableInput)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const UpdateTemplateOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The alias of the template.
     */
    alias: Schema.optionalKey(Schema.String),
    /**
     * Sender email address. To include a friendly name, use the format "Your Name
     * [sender@domain.com](mailto:sender@domain.com)".
     */
    from: Schema.optionalKey(Schema.String),
    /**
     * The HTML version of the template.
     */
    html: Schema.optionalKey(Schema.String),
    /**
     * The name of the template.
     */
    name: Schema.optionalKey(Schema.String),
    /**
     * Reply-to email addresses.
     */
    reply_to: Schema.optionalKey(Schema.Array(Schema.String)),
    /**
     * Email subject.
     */
    subject: Schema.optionalKey(Schema.String),
    /**
     * The plain text version of the template.
     */
    text: Schema.optionalKey(Schema.String),
    variables: Schema.optionalKey(Schema.Array(TemplateVariableInput)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const CreateTopicOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The default subscription status for the topic. Cannot be changed after creation.
     */
    default_subscription: Schema.Literals(["opt_in", "opt_out"]),
    /**
     * A description of the topic. Max 200 characters.
     */
    description: Schema.optionalKey(Schema.String.check(Schema.isMaxCodePoints(200))),
    /**
     * The name of the topic. Max 50 characters.
     */
    name: Schema.String.check(Schema.isMaxCodePoints(50)),
    /**
     * The visibility of the topic. Public topics are visible to all contacts on the unsubscribe
     * page. Private topics are only visible to opted-in contacts.
     */
    visibility: Schema.optionalKey(Schema.Literals(["public", "private"])),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const UpdateTopicOptions = Schema.StructWithRest(
  Schema.Struct({
    /**
     * A description of the topic. Max 200 characters.
     */
    description: Schema.optionalKey(Schema.String.check(Schema.isMaxCodePoints(200))),
    /**
     * The name of the topic. Max 50 characters.
     */
    name: Schema.optionalKey(Schema.String.check(Schema.isMaxCodePoints(50))),
    /**
     * The visibility of the topic.
     */
    visibility: Schema.optionalKey(Schema.Literals(["public", "private"])),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const CreateWebhookRequest = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The URL where webhook events will be sent.
     */
    endpoint: Schema.String,
    /**
     * Array of event types to subscribe to.
     */
    events: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const UpdateWebhookRequest = Schema.StructWithRest(
  Schema.Struct({
    /**
     * The URL where webhook events will be sent.
     */
    endpoint: Schema.optionalKey(Schema.String),
    /**
     * Array of event types to subscribe to.
     */
    events: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMinLength(1))),
    /**
     * The status of the webhook.
     */
    status: Schema.optionalKey(Schema.Literals(["enabled", "disabled"])),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
