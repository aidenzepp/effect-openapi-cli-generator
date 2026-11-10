import type { Stdio } from "effect";
import {
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  Exit,
  Inspectable,
  Option,
  Pipeable,
  Pull,
  Redacted,
  Ref,
  Result,
  Schedule,
  Schema,
  SchemaTransformation,
  Scope,
  Stream,
} from "effect";
import { Flag, GlobalFlag } from "effect/cli";
import {
  FetchHttpClient,
  Headers,
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpIncomingMessage,
  Url,
  UrlParams,
} from "effect/http";
import { RedirectRefused, UsageError } from "../domain/errors.ts";
import type { TransportError } from "../domain/errors.ts";
import type { CertificateInit } from "./auth.ts";
import { credentialHeaders, isLoopbackHost } from "./auth.ts";
import { Servers } from "./base-url.ts";
import { asCliError, printStderr } from "./input.ts";
import { queryWireForm, redactedPlaceholder } from "./redact.ts";
import { mapClientError } from "./response.ts";

/**
 * The most redirects one request follows (design 6.5 Redirect loop). The response to the last
 * followed hop may not redirect again: an eleventh `Location` is refused with `hopLimit`.
 */
export const maxRedirects = 10;

/**
 * The built-in `--timeout` in seconds (design D-AD7), used when no flag, environment value or
 * author default sets one.
 */
export const defaultTimeoutSeconds = 30;

/**
 * A whole number the operator typed: ASCII digits only, decoded to a safe integer. Each caller
 * adds its own bounds and maps a failure to its own `UsageError`, which never carries the text.
 */
export const wholeNumber = Schema.String.check(Schema.isPattern(/^\d+$/u)).pipe(
  Schema.decodeTo(Schema.Int, SchemaTransformation.numberFromString),
);

export const decodeWholeNumber = Schema.decodeEffect(wholeNumber);

const invalidTimeout = (): UsageError =>
  new UsageError({
    flag: "--timeout",
    message: "--timeout must be a whole number of seconds, 0 or more",
  });

// Whole seconds, 0 or more. The failure names `--timeout` only, never the value.
const parseTimeout = (raw: string): Effect.Effect<number, UsageError> =>
  decodeWholeNumber(raw).pipe(Effect.mapError(invalidTimeout));

/**
 * `--timeout <seconds>` bounds each attempt's wait for response headers; 0 disables it (design
 * D-AD7). The flag holds only the operator's value; `effectiveTimeoutSeconds` applies the
 * fallbacks, because the env name needs the prefix the root supplies.
 */
export const timeoutSetting = GlobalFlag.Setting("timeout")({
  flag: Flag.String("timeout").pipe(
    Flag.withMetavar("seconds"),
    Flag.withDescription("Seconds to wait for response headers on each attempt; 0 waits forever"),
    Flag.mapEffect((raw) => parseTimeout(raw).pipe(Effect.mapError(asCliError))),
    Flag.optional,
  ),
});

// The operator's `--timeout`, if the root registers the setting and the flag was given.
const flagTimeout = Effect.map(Effect.serviceOption(timeoutSetting), Option.flatten);

/**
 * The effective `--timeout` in seconds: the flag, then `<envPrefix>_TIMEOUT` read by that explicit
 * name (as `base-url.ts` reads `<PREFIX>_BASE_URL`), then `defaultTimeoutSeconds`. The author
 * default reaches the env read through the `ConfigProvider` `main.ts` provides (design D-AD7). An
 * unprefixed `TIMEOUT` is never read. A root that registers no `timeoutSetting` has no flag value.
 */
export const effectiveTimeoutSeconds = (envPrefix: string): Effect.Effect<number, UsageError> =>
  Effect.gen(function* resolveTimeout() {
    const flag = yield* flagTimeout;
    if (Option.isSome(flag)) {
      return flag.value;
    }

    const env = yield* Config.option(Config.String(`${envPrefix}_TIMEOUT`)).pipe(
      Effect.mapError(invalidTimeout),
    );

    return Option.isSome(env) ? yield* parseTimeout(env.value) : defaultTimeoutSeconds;
  });

/**
 * The effective `--timeout` for a request. The prefix is the one the root supplies with the servers
 * table; without that layer there is no env name to read, so only the flag and the built-in value
 * apply.
 */
const requestTimeoutSeconds: Effect.Effect<number, UsageError> = Effect.serviceOption(Servers).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => flagTimeout.pipe(Effect.map(Option.getOrElse(() => defaultTimeoutSeconds))),
      onSome: ({ envPrefix }) => effectiveTimeoutSeconds(envPrefix),
    }),
  ),
);

/**
 * The per-hop attach step: `Auth.attach` with the run's table and attachment. It strips every
 * managed credential and re-attaches only for a bound origin.
 */
export type Attach = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientRequest.HttpClientRequest, UsageError>;

/**
 * The request init a loopback hop executes with (design 6.5 Loopback hosts). The runtime owns the
 * value (`directRoute` below, probe SP5c) and `bin.ts` passes it in; this type keeps the keys
 * opaque to callers.
 */
export type DirectRoute = FetchHttpClient.RequestInit["Service"];

/**
 * The direct-route value: `{ proxy: false }` routes a loopback hop around the proxy environment
 * (probe SP5c). The DOM `RequestInit` has no `proxy` key, so the one assertion below is the only
 * place the typing is bridged; Bun honors `proxy: false` at run time, which
 * `tests/contract/bun-proxy-false.test.ts` pins. This module still never names Bun.
 */
// SAFETY: every RequestInit property is optional, so the object is a valid init; `proxy` is a key the DOM type lacks and Bun reads.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the DOM RequestInit has no proxy key (probe SP5c)
export const directRoute: DirectRoute = { proxy: false } as RequestInit;

/**
 * The per-hop client-certificate decision (design 6.5 `mutualTLS` row and Origin binding): the
 * certificate init for the hop's URL, or none. `send` binds `certificateInitFor` to the
 * operation's bound origins; a hop decided none is sent without the certificate, never refused.
 */
export type CertificateDecision = (url: string) => Effect.Effect<Option.Option<CertificateInit>>;

/**
 * The decision that sends no hop with a client certificate, for callers that mean none.
 */
export const noCertificate: CertificateDecision = () => Effect.succeedNone;

/**
 * The statuses the loop follows. Any other 3xx, and a 3xx without a usable `Location`, is the
 * final response.
 */
const redirectStatuses: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * A body the next hop cannot send again: a chunked stream with no known length. Stdin is one
 * (and so is a streamed multipart body); `HttpBody.file` carries its length and re-opens the file,
 * and in-memory bodies re-send their bytes.
 */
const isOneShot = (body: HttpBody.HttpBody): boolean =>
  body._tag === "Stream" && body.contentLength === undefined;

/**
 * A 301 or 302 `POST` and a 303 of anything but `GET` or `HEAD` continue as a body-less `GET`.
 */
const becomesGet = (status: number, method: string): boolean =>
  ((status === 301 || status === 302) && method === "POST") ||
  (status === 303 && method !== "GET" && method !== "HEAD");

/**
 * The init a hop executes with. A loopback hop takes the direct-route init; a hop the certificate
 * decision binds takes the certificate init; a bound loopback hop takes one init holding both
 * sets of keys, which share none (design 6.5 Merge with the client certificate). Any other hop is
 * sent with no added init, so the platform routes it from the proxy environment and presents no
 * certificate. Both decisions read the hop's own URL and are made on every hop, never cached; no
 * `tls` key is ever set client-wide.
 */
const routeHop = <A, E, R>(
  attached: HttpClientRequest.HttpClientRequest,
  direct: DirectRoute,
  certificate: CertificateDecision,
  send: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const url = Url.make(attached.url, attached.urlParams, Option.getOrUndefined(attached.hash));
  if (Result.isFailure(url)) {
    return send;
  }

  const loopback = isLoopbackHost(url.success.hostname);

  return Effect.flatMap(certificate(url.success.href), (init) => {
    if (Option.isSome(init)) {
      const merged = loopback ? { ...init.value, ...direct } : init.value;

      return Effect.provideService(send, FetchHttpClient.RequestInit, merged);
    }

    return loopback ? Effect.provideService(send, FetchHttpClient.RequestInit, direct) : send;
  });
};

const asGet = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest =>
  request.pipe(
    HttpClientRequest.setMethod("GET"),
    HttpClientRequest.setBody(HttpBody.empty),
    HttpClientRequest.removeHeader("content-encoding"),
    HttpClientRequest.removeHeader("content-language"),
    HttpClientRequest.removeHeader("content-location"),
  );

/**
 * The next hop's request, or `None` when the response is final. `request` is the hop as it was
 * before the attach step, so the next hop starts from the caller's headers and never inherits an
 * attached credential. Every refusal is decided here, before the next hop is sent. An origin change
 * drops every `Auth.credentialHeaders` name; `Auth.attach` re-adds managed credentials for bound
 * origins only.
 */
const nextHop = (
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse,
  followed: number,
): Effect.Effect<Option.Option<HttpClientRequest.HttpClientRequest>, RedirectRefused> => {
  const location = Headers.get(response.headers, "location");
  const current = Url.make(request.url, request.urlParams, Option.getOrUndefined(request.hash));
  if (
    !redirectStatuses.has(response.status) ||
    Option.isNone(location) ||
    Result.isFailure(current)
  ) {
    return Effect.succeedNone;
  }

  const resolved = Url.fromString(location.value, current.success.href);
  if (Result.isFailure(resolved)) {
    return Effect.succeedNone;
  }

  const from = current.success;
  const target = resolved.success;
  const refuse = (reason: RedirectRefused["reason"]) =>
    Effect.fail(new RedirectRefused({ from: from.origin, reason, to: target.origin }));
  if (followed >= maxRedirects) {
    return refuse("hopLimit");
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return refuse("scheme");
  }

  if (target.username !== "" || target.password !== "") {
    return refuse("userinfo");
  }

  if (from.protocol === "https:" && target.protocol === "http:") {
    return refuse("downgrade");
  }

  const next = becomesGet(response.status, request.method) ? asGet(request) : request;
  if (next.body._tag !== "Empty" && target.origin !== from.origin) {
    return refuse("crossOriginBody");
  }

  if (isOneShot(next.body)) {
    return refuse("unreplayableBody");
  }

  const hash = target.hash === "" ? Option.none() : Option.some(target.hash.slice(1));

  return Effect.succeedSome(
    HttpClientRequest.makeWith(
      next.method,
      Url.setHash(target, "").href,
      UrlParams.empty,
      hash,
      target.origin === from.origin
        ? next.headers
        : Headers.removeMany(next.headers, credentialHeaders),
      next.body,
    ),
  );
};

/**
 * The final hop's response. `release` closes its scope, and runs when the body ends, fails or is
 * cancelled; the scope is a child of the caller's, so a response dropped unread is aborted when
 * the caller's scope closes. `upgrade` hands the connection over, so it leaves the scope to the
 * caller's.
 */
class OwnedResponse implements HttpClientResponse.HttpClientResponse {
  readonly [HttpClientResponse.TypeId] = HttpClientResponse.TypeId;
  readonly [HttpIncomingMessage.TypeId] = HttpIncomingMessage.TypeId;
  readonly #original: HttpClientResponse.HttpClientResponse;
  readonly #release: Effect.Effect<void>;

  constructor(original: HttpClientResponse.HttpClientResponse, release: Effect.Effect<void>) {
    this.#original = original;
    this.#release = release;
  }

  get request() {
    return this.#original.request;
  }

  get url() {
    return this.#original.url;
  }

  get status() {
    return this.#original.status;
  }

  get headers() {
    return this.#original.headers;
  }

  get cookies() {
    return this.#original.cookies;
  }

  get remoteAddress() {
    return this.#original.remoteAddress;
  }

  get arrayBuffer() {
    return Effect.ensuring(this.#original.arrayBuffer, this.#release);
  }

  get formData() {
    return Effect.ensuring(this.#original.formData, this.#release);
  }

  get json() {
    return Effect.ensuring(this.#original.json, this.#release);
  }

  get text() {
    return Effect.ensuring(this.#original.text, this.#release);
  }

  get urlParamsBody() {
    return Effect.ensuring(this.#original.urlParamsBody, this.#release);
  }

  get stream() {
    return Stream.ensuring(this.#original.stream, this.#release);
  }

  get upgrade() {
    return this.#original.upgrade;
  }

  toJSON() {
    return this.#original.toJSON();
  }

  toString() {
    return this.#original.toString();
  }

  [Inspectable.NodeInspectSymbol]() {
    return this.#original[Inspectable.NodeInspectSymbol]();
  }

  pipe() {
    // oxlint-disable-next-line prefer-rest-params
    return Pipeable.pipeArguments(this, arguments);
  }
}

const assertMethod = (
  allowed: ReadonlySet<string>,
  request: HttpClientRequest.HttpClientRequest,
) =>
  allowed.has(request.method)
    ? Effect.void
    : Effect.die(
        new Error(`request method ${JSON.stringify(request.method)} is not in the allowlist`),
      );

export const querySeparator = (url: string): string => {
  if (/[?&]$/u.test(url)) {
    return "";
  }

  return url.includes("?") ? "&" : "?";
};

/**
 * Fold `urlParams` into the request target. Effect builds the final URL with
 * `URLSearchParams.append`, which re-serializes the whole query and rewrites the serialized
 * `%20` as `+`. The target keeps its query bytes exactly as `Serialize` produced them; a param
 * added after serialization (an `apiKey` query credential) is appended in its `queryWireForm`,
 * the bytes redaction scrubs.
 */
const foldUrlParams = (
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  const pairs = UrlParams.fromInput(request.urlParams).params.flatMap(([name, value]) =>
    value === undefined
      ? []
      : [
          `${queryWireForm(name)}=${queryWireForm(
            Redacted.isRedacted(value) ? Redacted.value(value) : value,
          )}`,
        ],
  );
  if (pairs.length === 0) {
    return HttpClientRequest.makeWith(
      request.method,
      request.url,
      UrlParams.empty,
      request.hash,
      request.headers,
      request.body,
    );
  }

  const joined = `${request.url}${querySeparator(request.url)}${pairs.join("&")}`;

  return HttpClientRequest.makeWith(
    request.method,
    joined,
    UrlParams.empty,
    request.hash,
    request.headers,
    request.body,
  );
};

/**
 * The runtime-owned redirect loop (design 6.5 Redirect loop; settled: spike S2), an
 * `HttpClient.transform` over the provided client. Each hop runs the attach step, then is sent
 * (with `direct` as its request init when the hop's host is loopback, design 6.5 Loopback hosts) in
 * its own scope, a child of the caller's `Scope`; a followed or refused 3xx closes that scope,
 * which aborts the response instead of reading its body. The final response owns its scope (see
 * `OwnedResponse`), so it stays readable and is aborted when its body ends or when the caller's
 * scope closes, whichever comes first. The send and the decision are one uninterruptible step
 * around the interruptible attach and send, so a discarded 3xx cannot escape its scope. Native
 * `followRedirects` is used nowhere.
 *
 * `certificate` is the per-hop client-certificate decision (design 6.5 `mutualTLS` row): asked
 * with each hop's URL, so on every hop of every retry attempt, its init is the hop's request init,
 * merged with `direct` on a loopback hop. It is required like `allowed`: a caller that means no
 * certificate passes `noCertificate`.
 *
 * `allowed` is the method allowlist `bin.ts` provides with the client layer (design 6.7), required
 * like `direct`. It is asserted on every attached hop before it is sent, including one a redirect
 * turned into `GET`: a miss is a defect (exit 70) and nothing is sent, because Bun's `fetch` sends
 * any token outside its own table as `GET`. The token is compared as given, with no case folding,
 * and the defect carries only the JSON-quoted token, never the URL.
 *
 * One run of the loop is one attempt, and `HttpClient.timeout` bounds it by the effective
 * `--timeout` (design D-AD7): the bound ends when the final hop's headers arrive, so the body is
 * the idle timeout's. `HttpClient.timeout` fixes its duration when the client is built, and the
 * setting is read per request, so the timed client is built per request; 0 leaves it untimed. An
 * invalid `<PREFIX>_TIMEOUT` fails the request with a `UsageError` before anything is sent.
 * Expiry is an `HttpClientError` with a `TimeoutError` cause, which `mapClientError` reports as
 * `TransportError` `timeout`.
 */
export const redirectLoop =
  (
    attach: Attach,
    direct: DirectRoute,
    allowed: ReadonlySet<string>,
    certificate: CertificateDecision,
  ) =>
  <E, R>(
    client: HttpClient.HttpClient.With<E, R>,
  ): HttpClient.HttpClient.With<
    E | HttpClientError.HttpClientError | RedirectRefused | UsageError,
    R | Scope.Scope
  > => {
    const scoped = HttpClient.withScope(client);
    const hop = (request: HttpClientRequest.HttpClientRequest, followed: number) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* sendHop() {
          const attached = foldUrlParams(yield* restore(attach(request)));
          yield* assertMethod(allowed, attached);

          const scope = yield* Scope.fork(yield* Scope.Scope);
          const response = yield* restore(
            routeHop(attached, direct, certificate, scoped.postprocess(Effect.succeed(attached))),
          ).pipe(
            Scope.provide(scope),
            Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
          );
          const next = yield* nextHop(request, response, followed).pipe(
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          if (Option.isNone(next)) {
            return { next, response: new OwnedResponse(response, Scope.close(scope, Exit.void)) };
          }

          yield* Scope.close(scope, Exit.void);

          return { next, response };
        }),
      );
    const loop = (
      request: HttpClientRequest.HttpClientRequest,
      followed: number,
    ): Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      E | RedirectRefused | UsageError,
      R | Scope.Scope
    > =>
      Effect.flatMap(hop(request, followed), ({ next, response }) =>
        Option.isNone(next) ? Effect.succeed(response) : loop(next.value, followed + 1),
      );

    const attempt = HttpClient.transform(client, (_unsent, request) => loop(request, 0));

    const timed = (seconds: number) =>
      seconds === 0 ? attempt : HttpClient.timeout(attempt, Duration.seconds(seconds));

    return HttpClient.transform(client, (_unsent, request) =>
      requestTimeoutSeconds.pipe(
        Effect.flatMap((value) => timed(value).postprocess(Effect.succeed(request))),
      ),
    );
  };

/**
 * Sets `User-Agent: <binName>/<version>` (design 6.2) on one request, replacing a caller-set
 * value. `withUserAgent` and the `--dry-run` preview both use it, so they print the same value.
 */
export const setUserAgent = (
  binName: string,
  version: string,
): ((request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest) =>
  HttpClientRequest.setHeader("user-agent", `${binName}/${version}`);

/**
 * Sets `User-Agent` (`setUserAgent`) in place of Bun's implicit `Bun/<v>`. Apply it outermost:
 * every redirect hop starts from the caller's headers, so the value reaches each hop.
 */
export const withUserAgent =
  (binName: string, version: string) =>
  <E, R>(client: HttpClient.HttpClient.With<E, R>): HttpClient.HttpClient.With<E, R> =>
    HttpClient.mapRequestInput(client, setUserAgent(binName, version));

/**
 * The methods retried without `--retry-unsafe` (design D-AD7): RFC 9110 9.2.2's idempotent
 * methods and `QUERY`.
 */
const idempotentMethods: ReadonlySet<string> = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PUT",
  "QUERY",
  "TRACE",
]);

/**
 * The final statuses retried (design D-AD7). The status is the redirect loop's final response.
 */
const retriedStatuses: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/**
 * The `TransportError` reasons retried (design D-AD7, m3 P13). `tls` repeats and `aborted` is
 * an interrupt or a closed pipe, so neither is retried.
 */
const retriedReasons: ReadonlySet<TransportError["reason"]> = new Set([
  "connect",
  "dns",
  "timeout",
]);

/**
 * Whether a method is retried without `--retry-unsafe`: an idempotent method, or any method when
 * the request carries an `Idempotency-Key` header (design D-AD7). The table the retry hints of
 * design 7.4 read.
 */
export const wouldRetry = (method: string, idempotencyKeyPresent: boolean): boolean =>
  idempotencyKeyPresent || idempotentMethods.has(method);

/**
 * The built-in `--retries` (design D-AD7), used when no flag, environment value or author default
 * sets one.
 */
export const defaultRetries = 2;

const maxRetries = 10;

const invalidRetries = (): UsageError =>
  new UsageError({
    flag: "--retries",
    message: `--retries must be a whole number from 0 to ${maxRetries}`,
  });

// A whole number from 0 to `maxRetries`. The failure names `--retries` only, never the value.
const parseRetries = (raw: string): Effect.Effect<number, UsageError> =>
  decodeWholeNumber(raw).pipe(
    Effect.mapError(invalidRetries),
    Effect.filterOrFail((retries) => retries <= maxRetries, invalidRetries),
  );

/**
 * `--retries <n>`: how many times a transient failure is retried (design D-AD7). The flag holds
 * only the operator's value; `effectiveRetries` applies the fallbacks.
 */
export const retriesSetting = GlobalFlag.Setting("retries")({
  flag: Flag.String("retries").pipe(
    Flag.withMetavar("n"),
    Flag.withDescription(`Times to retry a transient failure, 0 to ${maxRetries}`),
    Flag.mapEffect((raw) => parseRetries(raw).pipe(Effect.mapError(asCliError))),
    Flag.optional,
  ),
});

/**
 * `--retry-unsafe` retries any method, `POST` and `PATCH` included (design D-AD7). A one-shot
 * body is still never retried.
 */
export const retryUnsafeSetting = GlobalFlag.Setting("retry-unsafe")({
  flag: Flag.Boolean("retry-unsafe").pipe(
    Flag.withDescription("Retry methods that are not idempotent, such as POST and PATCH"),
    Flag.withDefault(false),
  ),
});

const flagRetries = Effect.map(Effect.serviceOption(retriesSetting), Option.flatten);

/**
 * The effective `--retries`: the flag, then `<envPrefix>_RETRIES` read by that explicit name (as
 * `effectiveTimeoutSeconds` reads `<PREFIX>_TIMEOUT`), then `defaultRetries`. The author default
 * reaches the env read through the `ConfigProvider` `main.ts` provides. An unprefixed `RETRIES` is
 * never read.
 */
export const effectiveRetries = (envPrefix: string): Effect.Effect<number, UsageError> =>
  Effect.gen(function* resolveRetries() {
    const flag = yield* flagRetries;
    if (Option.isSome(flag)) {
      return flag.value;
    }

    const env = yield* Config.option(Config.String(`${envPrefix}_RETRIES`)).pipe(
      Effect.mapError(invalidRetries),
    );

    return Option.isSome(env) ? yield* parseRetries(env.value) : defaultRetries;
  });

// Exponential from 500 ms, jittered (design D-AD7). Used when the response names no `Retry-After`.
const backoff = Schedule.jittered(Schedule.exponential("500 millis"));

/**
 * The run's record of a `Retry-After` cap (design D-AD7): when retrying stops because the server
 * asked for a longer wait than the effective `--timeout`, `retryTransform` writes the server's
 * delay here, in whole seconds rounded up, and `send` passes it to
 * `ApiResponseError.retryAfterSeconds` (m3 P14). `send` creates the `Ref` and provides it around
 * the request. `retryTransform` reads it with `Effect.serviceOption`, so it has no requirement
 * and a caller that provides none simply records nothing.
 */
export class RetryAfterCap extends Context.Service<RetryAfterCap, Ref.Ref<Option.Option<number>>>()(
  "openapi-cli/runtime/client/RetryAfterCap",
) {}

/**
 * The response's `Retry-After` as a delay from `nowMillis`: whole seconds, or an HTTP date (a past
 * date is no delay). `None` when it is absent or does not parse, which RFC 9110 10.2.3 treats as
 * absent, so the backoff applies.
 */
const retryAfterDelay = (
  response: HttpClientResponse.HttpClientResponse,
  nowMillis: number,
): Option.Option<Duration.Duration> =>
  Option.flatMap(Headers.get(response.headers, "retry-after"), (value) => {
    const parsed = Headers.parseRetryAfter(value);

    return Result.isSuccess(parsed)
      ? Option.some(Headers.retryAfterDelay(parsed.success, nowMillis))
      : Option.none();
  });

/**
 * Whether a server delay exceeds the cap: the effective `--timeout` in seconds, where 0 removes
 * the cap with the timeout (design 13.1 R6). A delay equal to the cap is waited.
 */
const exceedsCap = (delay: Duration.Duration, timeoutSeconds: number): boolean =>
  timeoutSeconds !== 0 && Duration.isGreaterThan(delay, Duration.seconds(timeoutSeconds));

/**
 * Why an attempt's outcome is retried: the final status, or the `TransportError` reason as
 * `mapClientError` classifies it. `None` for every other outcome, interrupts and defects included.
 */
const retryCause = <E>(
  exit: Exit.Exit<HttpClientResponse.HttpClientResponse, E>,
): Effect.Effect<Option.Option<string>> => {
  if (Exit.isSuccess(exit)) {
    const { status } = exit.value;

    return Effect.succeed(
      retriedStatuses.has(status) ? Option.some(String(status)) : Option.none(),
    );
  }

  const error = Exit.findErrorOption(exit);
  if (
    Exit.hasInterrupts(exit) ||
    Option.isNone(error) ||
    !HttpClientError.isHttpClientError(error.value) ||
    error.value.reason._tag !== "TransportError"
  ) {
    return Effect.succeedNone;
  }

  return Effect.flip(mapClientError(error.value)).pipe(
    Effect.map(({ reason }) => (retriedReasons.has(reason) ? Option.some(reason) : Option.none())),
  );
};

/**
 * The retry policy (design D-AD7, 5 Retries row), an `HttpClient.transform` applied outside the
 * redirect loop, so one attempt is one run of the loop with its hops, and the loop's replay rule
 * is the retry's. An attempt is retried when its method is retried (`wouldRetry`, or any method
 * with `--retry-unsafe`), its outcome is a retried status or `TransportError` reason, and attempts
 * remain (`effectiveRetries` + 1 in all). A one-shot body (stdin, `isOneShot`) is never retried:
 * one stderr line names `unreplayableBody` and the outcome stands. File and in-memory bodies
 * re-run from the start.
 *
 * Each attempt runs in its own scope, a child of the caller's, so a discarded response is aborted
 * by closing that scope, not drained; the final response's scope closes with the caller's. Before
 * each retry one stderr note names the method, the URL through `scrub` (the RT-6 scrubber `send`
 * passes), the cause, the attempt and the delay: the response's `Retry-After` (seconds or an HTTP
 * date) when it carries one that parses, else exponential from 500 ms, jittered. A `Retry-After`
 * longer than the effective `--timeout` is not waited (design D-AD7): retrying stops and the last
 * response is returned unchanged and the server's delay is recorded in `RetryAfterCap`. Every other
 * last outcome is returned or failed unchanged. An invalid `<PREFIX>_RETRIES` or `<PREFIX>_TIMEOUT`
 * fails with a `UsageError` before anything is sent.
 */
export const retryTransform =
  (scrub: (text: string) => string) =>
  <E, R>(
    client: HttpClient.HttpClient.With<E, R>,
  ): HttpClient.HttpClient.With<E | UsageError, R | Scope.Scope | Stdio.Stdio> =>
    HttpClient.transform(client, (attempt, request) =>
      Effect.gen(function* retrying() {
        // The prefix comes with the root's servers table; without it only the flag and the
        // built-in value apply, as for the timeout.
        const retries = yield* Effect.serviceOption(Servers).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => flagRetries.pipe(Effect.map(Option.getOrElse(() => defaultRetries))),
              onSome: ({ envPrefix }) => effectiveRetries(envPrefix),
            }),
          ),
        );
        const unsafe = Option.getOrElse(
          yield* Effect.serviceOption(retryUnsafeSetting),
          () => false,
        );
        const retried =
          unsafe || wouldRetry(request.method, Headers.has(request.headers, "idempotency-key"));
        const timeout = yield* requestTimeoutSeconds;
        const total = retries + 1;
        const label = `${request.method} ${scrub(UrlParams.redactUrl(request.url))}`;
        const caller = yield* Scope.Scope;
        const step = yield* Schedule.toStep(backoff);

        for (let made = 1; ; made += 1) {
          const scope = yield* Scope.fork(caller);
          const exit = yield* Effect.exit(attempt.pipe(Scope.provide(scope)));
          const cause = yield* retryCause(exit);
          if (retried && made < total && Option.isSome(cause)) {
            if (!isOneShot(request.body)) {
              const now = yield* Clock.currentTimeMillis;
              const server = Exit.isSuccess(exit)
                ? retryAfterDelay(exit.value, now)
                : Option.none<Duration.Duration>();
              if (
                Exit.isSuccess(exit) &&
                Option.isSome(server) &&
                exceedsCap(server.value, timeout)
              ) {
                const record = yield* Effect.serviceOption(RetryAfterCap);
                if (Option.isSome(record)) {
                  yield* Ref.set(
                    record.value,
                    Option.some(Math.ceil(Duration.toSeconds(server.value))),
                  );
                }

                return exit.value;
              }

              yield* Scope.close(scope, Exit.void);

              const delay = Option.isSome(server)
                ? server.value
                : yield* step(now, cause.value).pipe(
                    Effect.map(([, next]) => next),
                    Pull.catchDone((leftover) => Effect.succeed(leftover)),
                  );
              yield* printStderr(
                `Notice: retrying ${label} after ${cause.value} ` +
                  `(attempt ${made + 1} of ${total}) in ${Math.round(Duration.toMillis(delay))} ms`,
              );
              yield* Effect.sleep(delay);
              continue;
            }

            yield* printStderr(
              `Notice: not retrying ${label} after ${cause.value}: unreplayableBody, ` +
                "the request body was read once and cannot be sent again",
            );
          }

          if (Exit.isFailure(exit)) {
            yield* Scope.close(scope, exit);
          }

          return yield* exit;
        }
      }),
    );

/**
 * `--verbose` prints each attempt's and each redirect hop's request and response summary to
 * stderr, redacted (design 4.6, DM3-8). `verboseTransform` reads it per request.
 */
export const verboseSetting = GlobalFlag.Setting("verbose")({
  flag: Flag.Boolean("verbose").pipe(
    Flag.withDescription("Print each request's and response's status line and headers to stderr"),
    Flag.withDefault(false),
  ),
});

// A name-redacted value, from `Headers.CurrentRedactedNames` or `UrlParams.CurrentRedactedNames`.
const redactedValue = redactedPlaceholder();

// A query name as a server decodes it. `URLSearchParams` decodes leniently and never throws.
export const decodedQueryName = (raw: string): string =>
  new URLSearchParams(`${raw}=`).keys().next().value ?? raw;

/**
 * A URI reference, absolute or relative, with userinfo redacted (`UrlParams.redactUrl`) and each
 * query value whose decoded name `names` lists replaced by `<redacted>`. Every other byte, the
 * fragment included, stays as given.
 */
const redactUriText = (text: string, names: readonly (string | RegExp)[]): string => {
  const reference = UrlParams.redactUrl(text, []);
  const hash = reference.indexOf("#");
  const end = hash === -1 ? reference.length : hash;
  const at = reference.slice(0, end).indexOf("?");
  if (at === -1) {
    return reference;
  }

  const query = reference
    .slice(at + 1, end)
    .split("&")
    .map((part) => {
      const equals = part.indexOf("=");

      return equals !== -1 &&
        UrlParams.isRedactedName(decodedQueryName(part.slice(0, equals)), names)
        ? `${part.slice(0, equals + 1)}${redactedValue}`
        : part;
    });

  return `${reference.slice(0, at + 1)}${query.join("&")}${reference.slice(end)}`;
};

/**
 * The URL a hop is sent to, without its fragment, redacted as `redactUriText` redacts.
 */
const verboseUrl = (
  request: HttpClientRequest.HttpClientRequest,
  names: readonly (string | RegExp)[],
): string => {
  const url = Url.make(request.url, request.urlParams, Option.getOrUndefined(request.hash));

  return redactUriText(
    Result.isSuccess(url) ? Url.setHash(url.success, "").href : request.url,
    names,
  );
};

// Each `<URI-reference>` of a `Link` value (RFC 8288).
const linkTarget = /<(?<uri>[^>]*)>/gu;

// The `url=` part of a `Refresh` value, unquoted or in matching quotes.
const refreshTarget = /^(?<lead>.*?\burl\s*=\s*)(?<quote>["']?)(?<uri>.*?)\k<quote>$/isu;

/**
 * A header value with each URL it carries redacted by `redactUriText`: the whole value of
 * `Location` and `Content-Location`, each `<URI>` of `Link`, and the `url=` part of `Refresh`.
 * Any other header's value is returned as given.
 */
const redactHeaderUrls = (
  name: string,
  value: string,
  names: readonly (string | RegExp)[],
): string => {
  const header = name.toLowerCase();
  if (header === "location" || header === "content-location") {
    return redactUriText(value, names);
  }

  if (header === "link") {
    return value.replaceAll(linkTarget, (_match, uri: string) => `<${redactUriText(uri, names)}>`);
  }

  const refresh = header === "refresh" ? refreshTarget.exec(value)?.groups : undefined;
  if (refresh === undefined) {
    return value;
  }

  const { lead = "", quote = "", uri = "" } = refresh;

  return `${lead}${quote}${redactUriText(uri, names)}${quote}`;
};

/**
 * A request's headers in send order (design 4.6): the iteration order of the WHATWG `Headers`
 * fetch builds from the record, sorted by name, not the order the builder set them. `--verbose`
 * and `--dry-run` both print this order. A record that `Headers` rejects (a value with a control
 * character) is never sent, so it keeps the record's order rather than failing the print.
 */
export const sendOrder = (headers: Headers.Headers): readonly (readonly [string, string])[] =>
  Result.getOrElse(
    Result.try(() => [...new globalThis.Headers(headers)]),
    () => Object.entries(headers),
  );

/**
 * One block's header lines, in the order `entries` lists them. A value whose name `names` lists is
 * `<redacted>`; a URL a header carries is redacted by `redactHeaderUrls` with `queryNames`; the
 * caller scrubs each whole line.
 */
const headerLines = (
  prefix: "<" | ">",
  entries: readonly (readonly [string, string])[],
  names: readonly (string | RegExp)[],
  queryNames: readonly (string | RegExp)[],
): readonly string[] =>
  entries.map(
    ([name, value]) =>
      `${prefix} ${name}: ${
        Headers.isRedactedName(name, names)
          ? redactedValue
          : redactHeaderUrls(name, value, queryNames)
      }`,
  );

// One block on stderr, each whole line through the RT-6 value scrubber.
const printBlock = (scrub: (text: string) => string, lines: readonly string[]) =>
  printStderr(lines.map(scrub).join("\n"));

/**
 * The `--verbose` transform (design 4.6, DM3-8; 7.5). With `verboseSetting` on, each request it
 * sends writes a `> ` block (`> METHOD <URL> HTTP/1.1`, then the headers in `sendOrder`) before
 * the send, and each response a `< ` block (`< <status>`, then the headers) when its headers
 * arrive; no bodies. A send that fails writes only its request block. Header and query values
 * pass through `Headers.CurrentRedactedNames` and `UrlParams.CurrentRedactedNames`, a request
 * header also through `sensitive` (`Auth.sensitiveHeaderNames`), then the RT-6
 * value scrubber `send` passes as `scrub`, so a credential prints as `<redacted>` or
 * `<redacted:<scheme>>`. A URL a header carries (`Location`, `Content-Location`, `Link`,
 * `Refresh`) is redacted as the request URL is. The scrubber runs over each whole line.
 *
 * It wraps the inner client `redirectLoop` receives, inside the loop and inside `retryTransform`,
 * because only there does it see each hop as sent, after the attach step, of every attempt.
 */
export const verboseTransform =
  (scrub: (text: string) => string, sensitive: readonly (string | RegExp)[]) =>
  <E, R>(
    client: HttpClient.HttpClient.With<E, R>,
  ): HttpClient.HttpClient.With<E, R | Stdio.Stdio> =>
    HttpClient.transform(client, (send, request) =>
      Effect.gen(function* verbose() {
        const on = Option.getOrElse(yield* Effect.serviceOption(verboseSetting), () => false);
        if (!on) {
          return yield* send;
        }

        const headerNames = yield* Effect.service(Headers.CurrentRedactedNames);
        const queryNames = yield* Effect.service(UrlParams.CurrentRedactedNames);
        yield* printBlock(scrub, [
          `> ${request.method} ${verboseUrl(request, queryNames)} HTTP/1.1`,
          ...headerLines(
            ">",
            sendOrder(request.headers),
            [...headerNames, ...sensitive],
            queryNames,
          ),
        ]);

        const response = yield* send;
        yield* printBlock(scrub, [
          `< ${response.status}`,
          ...headerLines("<", Object.entries(response.headers), headerNames, queryNames),
        ]);

        return response;
      }),
    );
