import { Effect, Exit, Inspectable, Option, Pipeable, Result, Scope, Stream } from "effect";
import {
  FetchHttpClient,
  Headers,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpIncomingMessage,
  Url,
  UrlParams,
} from "effect/http";
import { RedirectRefused } from "../domain/errors.ts";
import type { UsageError } from "../domain/errors.ts";
import { isLoopbackHost } from "./auth.ts";

/**
 * The most redirects one request follows (design 6.5 Redirect loop). The response to the last
 * followed hop may not redirect again: an eleventh `Location` is refused with `hopLimit`.
 */
export const maxRedirects = 10;

/**
 * The per-hop attach step: `Auth.attach` with the run's table and attachment. It strips every
 * managed credential and re-attaches only for a bound origin.
 */
export type Attach = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientRequest.HttpClientRequest, UsageError>;

/**
 * The request init a loopback hop executes with, supplied by the entry (design 6.5 Loopback hosts).
 * It is opaque here: the runtime never names its keys, and `bin.ts` decides what routes a hop
 * direct.
 */
export type DirectRoute = FetchHttpClient.RequestInit["Service"];

/**
 * Dropped on an origin change; `Auth.attach` re-adds managed credentials for bound origins only.
 */
const credentialHeaders = ["authorization", "proxy-authorization", "cookie"] as const;

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
 * A hop to a loopback host executes with the direct-route init; every other hop is sent with no
 * added init, so the platform routes it from the proxy environment. The decision reads the hop's
 * own URL and is made on every hop.
 */
const routeHop = <A, E, R>(
  attached: HttpClientRequest.HttpClientRequest,
  direct: DirectRoute,
  send: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const url = Url.make(attached.url, attached.urlParams, Option.getOrUndefined(attached.hash));

  return Result.isSuccess(url) && isLoopbackHost(url.success.hostname)
    ? Effect.provideService(send, FetchHttpClient.RequestInit, direct)
    : send;
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
 * attached credential. Every refusal is decided here, before the next hop is sent.
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
  target.hash = "";

  return Effect.succeedSome(
    HttpClientRequest.makeWith(
      next.method,
      target.href,
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
 * The final hop's response. Its scope closes when the body ends, fails or is cancelled; the scope
 * is a child of the caller's, so a response dropped unread is aborted when the caller's scope
 * closes. `upgrade` hands the connection over, so it leaves the scope to the caller's.
 */
class OwnedResponse implements HttpClientResponse.HttpClientResponse {
  readonly [HttpClientResponse.TypeId] = HttpClientResponse.TypeId;
  readonly [HttpIncomingMessage.TypeId] = HttpIncomingMessage.TypeId;
  readonly #original: HttpClientResponse.HttpClientResponse;
  readonly #release: Effect.Effect<void>;

  constructor(original: HttpClientResponse.HttpClientResponse, scope: Scope.Closeable) {
    this.#original = original;
    this.#release = Scope.close(scope, Exit.void);
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
 * `allowed` is the method allowlist `bin.ts` provides with the client layer (design 6.7), required
 * like `direct`. It is asserted on every attached hop before it is sent, including one a redirect
 * turned into `GET`: a miss is a defect (exit 70) and nothing is sent, because Bun's `fetch` sends
 * any token outside its own table as `GET`. The token is compared as given, with no case folding,
 * and the defect carries only the JSON-quoted token, never the URL.
 */
export const redirectLoop =
  (attach: Attach, direct: DirectRoute, allowed: ReadonlySet<string>) =>
  <E, R>(
    client: HttpClient.HttpClient.With<E, R>,
  ): HttpClient.HttpClient.With<E | RedirectRefused | UsageError, R | Scope.Scope> => {
    const scoped = HttpClient.withScope(client);
    const hop = (request: HttpClientRequest.HttpClientRequest, followed: number) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* sendHop() {
          const attached = yield* restore(attach(request));
          yield* assertMethod(allowed, attached);

          const scope = yield* Scope.fork(yield* Scope.Scope);
          const response = yield* restore(
            routeHop(attached, direct, scoped.postprocess(Effect.succeed(attached))),
          ).pipe(
            Scope.provide(scope),
            Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
          );
          const next = yield* nextHop(request, response, followed).pipe(
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          if (Option.isNone(next)) {
            return { next, response: new OwnedResponse(response, scope) };
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

    return HttpClient.transform(client, (_unsent, request) => loop(request, 0));
  };

/**
 * Sets `User-Agent: <binName>/<version>` (design 6.2) in place of Bun's implicit `Bun/<v>`. It
 * replaces a caller-set value. Apply it outermost: every redirect hop starts from the caller's
 * headers, so the value reaches each hop.
 */
export const withUserAgent =
  (binName: string, version: string) =>
  <E, R>(client: HttpClient.HttpClient.With<E, R>): HttpClient.HttpClient.With<E, R> =>
    HttpClient.mapRequestInput(
      client,
      HttpClientRequest.setHeader("user-agent", `${binName}/${version}`),
    );
