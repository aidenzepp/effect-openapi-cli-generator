import { Schema } from "effect";

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
