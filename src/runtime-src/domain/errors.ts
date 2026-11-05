/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError<Self>()(tag, fields) declares a class; nothing is thrown */
import { Runtime, Schema } from "effect";
import { CliError } from "effect/cli";

/**
 * Ceiling for `--max-error-bytes` (design 7.1), counted in UTF-16 code units.
 */
const maxBodyExcerptLength = 65_536;

/**
 * Bound on the request id read from a response header (design 7.1).
 */
const maxRequestIdLength = 256;

const BodyExcerpt = Schema.String.pipe(Schema.check(Schema.isMaxLength(maxBodyExcerptLength)));

const RequestId = Schema.String.pipe(Schema.check(Schema.isMaxLength(maxRequestIdLength)));

/**
 * Flag or `--body` validation, mutually exclusive inputs, a refused header or cookie value,
 * binary output to a terminal.
 */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  flag: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {
  readonly [Runtime.errorExitCode] = 2;

  get [CliError.userMessage](): string {
    return this.message;
  }
}

/**
 * No security alternative of the operation is satisfiable.
 */
export class CredentialMissing extends Schema.TaggedError<CredentialMissing>()(
  "CredentialMissing",
  {
    alternatives: Schema.Array(Schema.String),
    operation: Schema.String,
  },
) {
  readonly [Runtime.errorExitCode] = 3;

  get [CliError.userMessage](): string {
    return `${this.operation} needs a credential: ${this.alternatives.join(" or ")}`;
  }
}

/**
 * The final status was not 2xx. Exits 3 for 401 and 403, otherwise 1.
 */
export class ApiResponseError extends Schema.TaggedError<ApiResponseError>()("ApiResponseError", {
  bodyExcerpt: BodyExcerpt,
  matched: Schema.Literals(["404", "4XX", "default", "undeclared"]),
  mediaType: Schema.optionalKey(Schema.String),
  operation: Schema.String,
  requestId: Schema.optionalKey(RequestId),
  retryAfterSeconds: Schema.optionalKey(Schema.Int),
  status: Schema.Int,
}) {
  get [Runtime.errorExitCode](): number {
    return this.status === 401 || this.status === 403 ? 3 : 1;
  }

  get [CliError.userMessage](): string {
    return `${this.operation} returned ${this.status} (matched ${this.matched})`;
  }
}

/**
 * A connect, DNS, TLS, timeout or abort failure. The URL arrives already redacted.
 */
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  reason: Schema.Literals(["connect", "dns", "tls", "timeout", "aborted"]),
  url: Schema.String,
}) {
  readonly [Runtime.errorExitCode] = 4;

  get [CliError.userMessage](): string {
    return `request to ${this.url} failed: ${this.reason}`;
  }
}

/**
 * The runtime redirect loop refused a hop. Origins only, never a full `Location`.
 */
export class RedirectRefused extends Schema.TaggedError<RedirectRefused>()("RedirectRefused", {
  from: Schema.String,
  reason: Schema.Literals([
    "crossOriginBody",
    "downgrade",
    "hopLimit",
    "scheme",
    "userinfo",
    "unreplayableBody",
  ]),
  to: Schema.String,
}) {
  readonly [Runtime.errorExitCode] = 4;

  get [CliError.userMessage](): string {
    return `redirect from ${this.from} to ${this.to} refused: ${this.reason}`;
  }
}

/**
 * Sequential decoding failed, or a response body stream went idle.
 */
export class ResponseStreamError extends Schema.TaggedError<ResponseStreamError>()(
  "ResponseStreamError",
  {
    itemIndex: Schema.optionalKey(Schema.Int),
    reason: Schema.Literals(["truncated", "recordTooLarge", "invalidFraming", "idleTimeout"]),
  },
) {
  readonly [Runtime.errorExitCode] = 5;

  get [CliError.userMessage](): string {
    return this.itemIndex === undefined
      ? `response stream failed: ${this.reason}`
      : `response stream failed at item ${this.itemIndex}: ${this.reason}`;
  }
}

/**
 * `--output` found an existing path or could not write.
 */
export class OutputError extends Schema.TaggedError<OutputError>()("OutputError", {
  path: Schema.String,
  reason: Schema.Literals(["exists", "write"]),
}) {
  readonly [Runtime.errorExitCode] = 5;

  get [CliError.userMessage](): string {
    return `cannot write ${this.path}: ${this.reason}`;
  }
}
