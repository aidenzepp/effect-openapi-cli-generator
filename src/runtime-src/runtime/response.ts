import { Effect, Option, Schema } from "effect";
import type { HttpClientError, HttpClientResponse } from "effect/http";
import { Headers, UrlParams } from "effect/http";
import { ApiResponseError, TransportError } from "../domain/errors.ts";

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

type MatchedKey = ApiResponseError["matched"];

const matchedKeys: ReadonlySet<string> = new Set(["404", "4XX", "default", "undeclared"]);

const isMatchedKey = (key: string): key is MatchedKey => matchedKeys.has(key);

const declares = (responses: ResponseTable["responses"], key: string): boolean =>
  Object.hasOwn(responses, key);

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

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

const mediaTypeOf = (response: HttpClientResponse.HttpClientResponse): string | undefined =>
  Option.getOrUndefined(Headers.get(response.headers, "content-type"))
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();

const requestIdOf = (
  table: ResponseTable,
  response: HttpClientResponse.HttpClientResponse,
): string | undefined =>
  table.requestIdHeader === undefined
    ? undefined
    : Option.getOrUndefined(Headers.get(response.headers, table.requestIdHeader))?.slice(
        0,
        maxRequestIdLength,
      );

const locationNote = (response: HttpClientResponse.HttpClientResponse): string => {
  const location = Option.getOrUndefined(Headers.get(response.headers, "location"));

  return location === undefined ? "" : `Location: ${UrlParams.redactUrl(location)}`;
};

/**
 * Build the error for a final non-2xx response. `Location` is redacted with the redacted-name list
 * of the running fiber (`UrlParams.CurrentRedactedNames`, which the runtime extends with every spec
 * `apiKey` name); outside a fiber only Effect's defaults apply. The body excerpt is bounded and
 * rendered elsewhere (RT-6), so the caller passes it in. A 3xx with no excerpt carries its redacted
 * `Location` there instead.
 */
export const toApiResponseError = (
  table: ResponseTable,
  response: HttpClientResponse.HttpClientResponse,
  bodyExcerpt = "",
): ApiResponseError => {
  const key = matchResponse(table.responses, response.status);
  const mediaType = mediaTypeOf(response);
  const requestId = requestIdOf(table, response);
  const redirect = response.status >= 300 && response.status < 400 ? locationNote(response) : "";

  const base = {
    bodyExcerpt: bodyExcerpt === "" ? redirect : bodyExcerpt,
    // The error class names four literals (design 7.1); a declared key outside them is not
    // representable there and reports as undeclared until the class widens.
    matched: isMatchedKey(key) ? key : "undeclared",
    operation: table.operation,
    status: response.status,
  } as const;
  const withMediaType = mediaType === undefined ? base : { ...base, mediaType };

  return new ApiResponseError(
    requestId === undefined ? withMediaType : { ...withMediaType, requestId },
  );
};

/**
 * A 2xx response passes through whichever key matched. Any other final status fails with
 * an `ApiResponseError`. `filterStatusOk` is never used: it would discard declared error bodies.
 */
export const classify = (
  table: ResponseTable,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<HttpClientResponse.HttpClientResponse, ApiResponseError> =>
  Effect.suspend(() =>
    isSuccess(response.status)
      ? Effect.succeed(response)
      : Effect.fail(toApiResponseError(table, response)),
  );

/**
 * The fields of a failure cause that identify a transport failure. A system error's `code`
 * is a string, a `DOMException`'s a legacy number.
 */
interface CauseLink {
  readonly cause?: CauseLink | undefined;
  readonly code?: string | number | undefined;
  readonly message?: string | undefined;
  readonly name?: string | undefined;
}

const CauseLinkSchema: Schema.Codec<CauseLink> = Schema.Struct({
  cause: Schema.optional(Schema.suspend(() => CauseLinkSchema)),
  code: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  message: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

const decodeCauseLink = Schema.decodeUnknownOption(CauseLinkSchema);

const maxCauseDepth = 8;

/**
 * The cause, its own `cause`, and so on, bounded so a cyclic chain terminates.
 */
const causeChain = (cause: unknown): readonly CauseLink[] => {
  const chain: CauseLink[] = [];
  let current = Option.getOrUndefined(decodeCauseLink(cause));

  while (current !== undefined && chain.length < maxCauseDepth) {
    chain.push(current);
    current = current.cause;
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
