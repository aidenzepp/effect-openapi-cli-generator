import { Effect, Option, Record as Rec, Schema } from "effect";
import type { HttpClientError, HttpClientResponse } from "effect/http";
import { Headers, UrlParams } from "effect/http";
import { ApiResponseError, TransportError } from "../domain/errors.ts";
import type { ScrubEntry } from "./redact.ts";
import { scrubAround } from "./redact.ts";
import { mediaEssence } from "./sequential.ts";

/**
 * What the matcher needs of one operation: its display name, its declared response keys (an
 * explicit code, a range such as `2XX`, or `default`, each with its media types) and the
 * request-id header chosen at generation, if the operation declares one.
 */
export interface ResponseTable {
  readonly operation: string;
  readonly requestIdHeader?: string | undefined;
  readonly responses: Readonly<Record<string, readonly string[]>>;
}

/**
 * Bound on a request id read from a response header, matching the error class (design 7.1).
 */
const maxRequestIdLength = 256;

const declares = (responses: ResponseTable["responses"], key: string): boolean =>
  Rec.has(responses, key);

/**
 * Explicit code, then range, then `default`, else `"undeclared"` (design 7.3).
 */
export const matchResponse = (responses: ResponseTable["responses"], status: number): string => {
  const code = String(status);
  const range = `${Math.floor(status / 100)}XX`;

  if (declares(responses, code)) {
    return code;
  }

  if (declares(responses, range)) {
    return range;
  }

  return declares(responses, "default") ? "default" : "undeclared";
};

/**
 * A response that by definition carries no body (RFC 9110 9.3.2, 15.2, 15.3.5, 15.4.5): the answer
 * to a HEAD, any 1xx, a 204 or a 304. Its `Content-Length` describes another representation and is
 * not enforced; nothing is read.
 */
export const isBodiless = (response: HttpClientResponse.HttpClientResponse): boolean =>
  response.request.method === "HEAD" ||
  (response.status >= 100 && response.status < 200) ||
  response.status === 204 ||
  response.status === 304;

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

const mediaTypeOf = (response: HttpClientResponse.HttpClientResponse): string | undefined =>
  Option.map(Headers.get(response.headers, "content-type"), mediaEssence).pipe(
    Option.getOrUndefined,
  );

/**
 * The characters `sanitize` in `output.ts` removes (C0 except LF and TAB, DEL, C1, format
 * characters, U+2028, U+2029, lone surrogates). `output.ts` imports this module, so the set is
 * restated here rather than imported.
 */
const unsafeText = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;

/**
 * The first `maxRequestIdLength` UTF-16 units of `text`, never ending in half a surrogate pair.
 */
const boundRequestId = (text: string): string => {
  const head = text.slice(0, maxRequestIdLength);

  return /[\uD800-\uDBFF]$/u.test(head) && text.length > maxRequestIdLength
    ? head.slice(0, -1)
    : head;
};

/**
 * The declared request-id header, the run's recorded values scrubbed, sanitized and scrubbed
 * again (design 7.1, audit S2), then bounded (audit F6): bounding first could cut a value so that
 * the remaining prefix no longer matches. `scrubbed` is the full recorded list, credentials and
 * secret-file values alike (design 9 I4; audit F2): the final catch cannot match a cut prefix.
 */
const requestIdOf = (
  table: ResponseTable,
  response: HttpClientResponse.HttpClientResponse,
  scrubbed: readonly ScrubEntry[],
): string | undefined => {
  if (table.requestIdHeader === undefined) {
    return undefined;
  }

  const header = Option.getOrUndefined(Headers.get(response.headers, table.requestIdHeader));

  return header === undefined
    ? undefined
    : boundRequestId(scrubAround(header, scrubbed, (text) => text.replaceAll(unsafeText, "")));
};

const locationNote = (response: HttpClientResponse.HttpClientResponse): string => {
  const location = Option.getOrUndefined(Headers.get(response.headers, "location"));

  return location === undefined ? "" : `Location: ${UrlParams.redactUrl(location)}`;
};

/**
 * Build the error for a final non-2xx response. `Location` is redacted with the redacted-name list
 * of the running fiber (`UrlParams.CurrentRedactedNames`, which the runtime extends with every spec
 * `apiKey` name); outside a fiber only Effect's defaults apply. The body excerpt is bounded and
 * rendered elsewhere (RT-6), so the caller passes it in. A 3xx with no excerpt carries its redacted
 * `Location` there instead. `scrubbed`, the run's full recorded list, is scrubbed from the request
 * id before it is bounded; it is required so a caller cannot silently skip the scrub.
 * `retryAfterSeconds` is the server's `Retry-After` delay when retrying stopped at the cap (design
 * D-AD7, 7.1; m3 P14), and sets `ApiResponseError.retryAfterSeconds`; `None`, the default, leaves
 * it unset.
 */
export const toApiResponseError = (
  table: ResponseTable,
  response: HttpClientResponse.HttpClientResponse,
  bodyExcerpt: string,
  scrubbed: readonly ScrubEntry[],
  retryAfterSeconds: Option.Option<number> = Option.none(),
): ApiResponseError => {
  const key = matchResponse(table.responses, response.status);
  const mediaType = mediaTypeOf(response);
  const requestId = requestIdOf(table, response, scrubbed);
  const redirect = response.status >= 300 && response.status < 400 ? locationNote(response) : "";

  const base = {
    bodyExcerpt: bodyExcerpt === "" ? redirect : bodyExcerpt,
    matched: key,
    operation: table.operation,
    status: response.status,
  } as const;
  const withMediaType = mediaType === undefined ? base : { ...base, mediaType };
  const withRequestId = requestId === undefined ? withMediaType : { ...withMediaType, requestId };

  return new ApiResponseError(
    Option.match(retryAfterSeconds, {
      onNone: () => withRequestId,
      onSome: (seconds) => ({ ...withRequestId, retryAfterSeconds: seconds }),
    }),
  );
};

/**
 * A 2xx response passes through whichever key matched. Any other final status fails with
 * an `ApiResponseError`, its request id scrubbed of `scrubbed`, the run's full recorded list.
 * `filterStatusOk` is never used: it would discard declared error bodies.
 */
export const classify = (
  table: ResponseTable,
  response: HttpClientResponse.HttpClientResponse,
  scrubbed: readonly ScrubEntry[],
): Effect.Effect<HttpClientResponse.HttpClientResponse, ApiResponseError> =>
  Effect.suspend(() =>
    isSuccess(response.status)
      ? Effect.succeed(response)
      : Effect.fail(toApiResponseError(table, response, "", scrubbed)),
  );

/**
 * The fields of a failure cause that identify a transport failure. A system error's `code`
 * is a string, a `DOMException`'s a legacy number.
 */
interface CauseLink {
  readonly cause?: unknown;
  readonly code?: string | number | undefined;
  readonly message?: string | undefined;
  readonly name?: string | undefined;
}

const CauseLinkSchema = Schema.Struct({
  cause: Schema.optional(Schema.Unknown),
  code: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  message: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

const decodeCauseLink = Schema.decodeUnknownOption(CauseLinkSchema);

const maxCauseDepth = 8;

/**
 * The cause, its own `cause`, and so on. Each link is decoded on its own, with the depth bound
 * checked before every decode, so a cyclic chain terminates without recursion.
 */
const causeChain = (cause: unknown): readonly CauseLink[] => {
  const chain: CauseLink[] = [];
  let current = cause;

  while (current !== undefined && chain.length < maxCauseDepth) {
    const link = Option.getOrUndefined(decodeCauseLink(current));

    if (link === undefined) {
      break;
    }

    chain.push(link);
    current = link.cause;
  }

  return chain;
};

const dnsCodes: ReadonlySet<string> = new Set(["EAI_AGAIN", "EAI_NODATA", "ENOTFOUND"]);

const tlsCodes: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const tlsMessage = /certificate|\bssl\b|\btls\b/iu;

const dnsMessage = /getaddrinfo|\bdns\b/iu;

const isTimeout = (link: CauseLink): boolean => link.name === "TimeoutError";

const isAbort = (link: CauseLink): boolean => link.name === "AbortError";

const isTls = (link: CauseLink): boolean => {
  const code = String(link.code ?? "");

  return (
    tlsCodes.has(code) || /^ERR_(?:SSL|TLS)/u.test(code) || tlsMessage.test(link.message ?? "")
  );
};

const isDns = (link: CauseLink): boolean =>
  dnsCodes.has(String(link.code ?? "")) || dnsMessage.test(link.message ?? "");

type TransportReason = TransportError["reason"];

const classified: readonly (readonly [TransportReason, (link: CauseLink) => boolean])[] = [
  ["timeout", isTimeout],
  ["aborted", isAbort],
  ["tls", isTls],
  ["dns", isDns],
];

/**
 * Effect's `TransportError` carries only an opaque cause, so the reason is read from the
 * cause chain, strongest signal first. Anything unrecognized is a connect failure.
 */
const transportReason = (cause: unknown): TransportReason => {
  const chain = causeChain(cause);

  return classified.find(([, matches]) => chain.some(matches))?.[0] ?? "connect";
};

/**
 * `HttpClientError` with a transport reason becomes `TransportError` (exit 4) with the URL
 * redacted by the current redacted-name lists. Every other reason cannot arise on the raw
 * output path (`InvalidUrlError` is validated earlier, no status filter, no decoding), so it
 * is a defect (exit 70).
 */
export const mapClientError = (
  error: HttpClientError.HttpClientError,
): Effect.Effect<never, TransportError> => {
  const { reason } = error;

  return Effect.suspend(() =>
    reason._tag === "TransportError"
      ? Effect.fail(
          new TransportError({
            reason: transportReason(reason.cause ?? reason.description),
            url: UrlParams.redactUrl(reason.request.url),
          }),
        )
      : Effect.die(error),
  );
};
