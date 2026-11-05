import { Effect, Exit, Option, Result, Scope } from "effect";
import { Headers, HttpBody, HttpClient, HttpClientRequest, Url, UrlParams } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { RedirectRefused } from "../domain/errors.ts";
import type { UsageError } from "../domain/errors.ts";

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
 * The statuses the loop follows. Any other 3xx, and a 3xx without a usable `Location`, is the
 * final response.
 */
/**
 * Dropped on an origin change; `Auth.attach` re-adds managed credentials for bound origins only.
 */
const credentialHeaders = ["authorization", "proxy-authorization", "cookie"] as const;

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
 * The runtime-owned redirect loop (design 6.5 Redirect loop; settled: spike S2), an
 * `HttpClient.transform` over the provided client. Each hop runs the attach step, then is sent in
 * its own scope; a followed or refused 3xx closes that scope, which aborts the response instead
 * of reading its body. The final response's scope is left open so its body stays readable. The
 * send and the decision are one uninterruptible step around the interruptible attach and send, so
 * a discarded 3xx cannot escape its scope. Native `followRedirects` is used nowhere.
 */
export const redirectLoop =
  (attach: Attach) =>
  <E, R>(
    client: HttpClient.HttpClient.With<E, R>,
  ): HttpClient.HttpClient.With<E | RedirectRefused | UsageError, R> => {
    const scoped = HttpClient.withScope(client);
    const hop = (request: HttpClientRequest.HttpClientRequest, followed: number) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* sendHop() {
          const attached = yield* restore(attach(request));
          const scope = yield* Scope.make();
          const response = yield* restore(scoped.postprocess(Effect.succeed(attached))).pipe(
            Scope.provide(scope),
            Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
          );
          const next = yield* nextHop(request, response, followed).pipe(
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          if (Option.isSome(next)) {
            yield* Scope.close(scope, Exit.void);
          }

          return { next, response };
        }),
      );
    const loop = (
      request: HttpClientRequest.HttpClientRequest,
      followed: number,
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, E | RedirectRefused | UsageError, R> =>
      Effect.flatMap(hop(request, followed), ({ next, response }) =>
        Option.isNone(next) ? Effect.succeed(response) : loop(next.value, followed + 1),
      );

    return HttpClient.transform(client, (_unsent, request) => loop(request, 0));
  };
