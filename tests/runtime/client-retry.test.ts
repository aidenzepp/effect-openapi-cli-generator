/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Exit, Fiber, Option, Sink, Stdio, Stream } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { TestClock } from "effect/testing";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import * as Client from "../../src/runtime-src/runtime/client.ts";
import { mapClientError } from "../../src/runtime-src/runtime/response.ts";

const origin = "http://127.0.0.1:1";

const BODY = "request-body-bytes";

const SECRET = "s3cret-value";

const bytes = (text: string) => new TextEncoder().encode(text);

const decode = (chunks: readonly Uint8Array[]): string => Buffer.concat(chunks).toString("utf-8");

type Reason = "aborted" | "connect" | "dns" | "timeout" | "tls";

// What the scripted server does on one call: answer a status (a redirect when it has a
// location), or fail in transport with a reason.
type Answer = { readonly reason: Reason } | { readonly location?: string; readonly status: number };

const status = (code: number): Answer => ({ status: code });

const failing = (reason: Reason): Answer => ({ reason });

const statuses = (...codes: readonly number[]): readonly Answer[] => codes.map(status);

// Platform errors carrying the fields the transport classifier reads (`mapClientError`).
const causes: Record<Reason, Error> = {
  aborted: Object.assign(new Error("aborted"), { name: "AbortError" }),
  connect: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
  dns: Object.assign(new Error("not found"), { code: "ENOTFOUND" }),
  timeout: Object.assign(new Error("expired"), { name: "TimeoutError" }),
  tls: Object.assign(new Error("expired"), { code: "CERT_HAS_EXPIRED" }),
};

interface Seen {
  // Whether each earlier call's signal was already aborted when this call arrived.
  readonly abortedBefore: readonly boolean[];
  readonly body: string;
  readonly method: string;
  readonly path: string;
  readonly signal: AbortSignal;
}

// The bytes a call sends. A stream body is run here, as the transport would run it.
const bodyText = (body: HttpBody.HttpBody): Effect.Effect<string> => {
  if (body._tag === "Stream") {
    return body.stream.pipe(Stream.runCollect, Effect.map(decode), Effect.orDie);
  }

  return Effect.succeed(body._tag === "Uint8Array" ? decode([body.body]) : "");
};

// A scripted client: call k gets `answers[k]`, and a call past the script gets 200.
const scripted = (answers: readonly Answer[], seen: Seen[]) =>
  HttpClient.make((request, url, signal) =>
    Effect.gen(function* answer() {
      const body = yield* bodyText(request.body);
      const next = answers[seen.length] ?? status(200);
      const abortedBefore = seen.map((call) => call.signal.aborted);
      seen.push({ abortedBefore, body, method: request.method, path: url.pathname, signal });
      if ("reason" in next) {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ cause: causes[next.reason], request }),
        });
      }

      const init =
        next.location === undefined
          ? { status: next.status }
          : { headers: { location: next.location }, status: next.status };

      return HttpClientResponse.fromWeb(request, new Response(`status ${next.status}`, init));
    }),
  );

const allowed: ReadonlySet<string> = new Set(["DELETE", "GET", "PATCH", "POST", "PUT"]);

const sentinel: Client.DirectRoute = { cache: "no-store" };

const capture = (into: Buffer[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(Buffer.from(chunk));
    }),
  );

// The note's URL goes through the caller's scrubber (the RT-6 one in `send`).
const scrub = (text: string): string => text.replaceAll(SECRET, "<redacted:key>");

interface Run {
  readonly env?: Record<string, string>;
  readonly retries?: number;
  readonly unsafe?: boolean;
}

// One request through the redirect loop wrapped by the retry transform, under a caller scope,
// with the clock driven in steps so every backoff sleep elapses in virtual time.
const run = async (
  request: HttpClientRequest.HttpClientRequest,
  answers: readonly Answer[],
  options: Run = {},
) => {
  const seen: Seen[] = [];
  const stderr: Buffer[] = [];
  const client = scripted(answers, seen).pipe(
    Client.redirectLoop(Effect.succeed, sentinel, allowed, Client.noCertificate),
    Client.retryTransform(scrub),
  );
  const exchange = Effect.scoped(
    client.execute(request).pipe(
      Effect.flatMap((response) => Effect.as(response.text, response.status)),
      Effect.catchTag("HttpClientError", mapClientError),
    ),
  );
  const flagged = exchange.pipe(
    Effect.provideService(Client.retriesSetting, Option.fromUndefinedOr(options.retries)),
    Effect.provideService(Client.retryUnsafeSetting, options.unsafe ?? false),
  );
  const configured =
    options.env === undefined
      ? flagged
      : flagged.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: options.env }),
          ),
          Effect.provide(BaseUrl.layer({ boundOrigins: [], servers: [] }, "ACME")),
        );
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* drive() {
      const fiber = yield* Effect.forkChild(configured);
      for (let step = 0; step < 100; step += 1) {
        yield* TestClock.adjust("1 second");
      }

      return yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(Stdio.layerTest({ stderr: capture(stderr) })),
    ),
  );
  const notes = decode(stderr)
    .split("\n")
    .filter((line) => line !== "");

  return { exit, notes, seen };
};

const get = (path = "/r") => HttpClientRequest.get(`${origin}${path}?key=${SECRET}`);

const withBody = (method: "POST" | "PUT", body: HttpBody.HttpBody) =>
  HttpClientRequest.make(method)(`${origin}/r`).pipe(HttpClientRequest.setBody(body));

// A stdin body: a chunked stream with no length that a second run finds drained.
const stdinBody = () => {
  let drained = false;

  return HttpBody.stream(
    Stream.suspend(() => {
      const chunk = drained ? new Uint8Array() : bytes(BODY);
      drained = true;

      return Stream.make(chunk);
    }),
  );
};

// A file body: `HttpBody.file` is a stream that re-opens the file and carries its length.
const fileBody = () =>
  HttpBody.stream(
    Stream.suspend(() => Stream.make(bytes(BODY))),
    "application/octet-stream",
    BODY.length,
  );

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

describe("idempotency-aware retries", () => {
  test("GET 503 then 200 succeeds on attempt 2 with one note", async () => {
    const { exit, notes, seen } = await run(get(), statuses(503, 200));
    expect(exit).toEqual(Exit.succeed(200));
    expect(seen).toHaveLength(2);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("503");
  });

  test("the retry note is one exact line", async () => {
    const { notes } = await run(get(), statuses(503, 200));

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(
      /^Notice: retrying GET http:\/\/127\.0\.0\.1:1\/r\?key=<redacted:key> after 503 \(attempt 2 of 3\) in \d+ ms$/u,
    );
  });

  test("the note's URL passes through the scrubber", async () => {
    const { notes } = await run(get(), statuses(503, 200));
    expect(notes.join("\n")).not.toContain(SECRET);
  });

  test("the discarded 503 is aborted before the next attempt, not drained", async () => {
    const { seen } = await run(get(), statuses(503, 200));
    expect(seen[1]?.abortedBefore).toEqual([true]);
  });

  test("POST 503 is attempted once", async () => {
    const { exit, notes, seen } = await run(withBody("POST", fileBody()), statuses(503, 200));
    expect(exit).toEqual(Exit.succeed(503));
    expect(seen).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  test("POST is retried with --retry-unsafe", async () => {
    const { exit, seen } = await run(withBody("POST", fileBody()), statuses(503, 200), {
      unsafe: true,
    });
    expect(exit).toEqual(Exit.succeed(200));
    expect(seen).toHaveLength(2);
  });

  test("POST carrying an Idempotency-Key header is retried", async () => {
    const request = withBody("POST", fileBody()).pipe(
      HttpClientRequest.setHeader("Idempotency-Key", "k-1"),
    );
    const { exit, seen } = await run(request, statuses(503, 200));
    expect(exit).toEqual(Exit.succeed(200));
    expect(seen).toHaveLength(2);
  });

  test("a stdin body with --retry-unsafe is attempted once and names unreplayableBody", async () => {
    const { exit, notes, seen } = await run(withBody("POST", stdinBody()), statuses(503, 200), {
      unsafe: true,
    });
    expect(exit).toEqual(Exit.succeed(503));
    expect(seen).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("unreplayableBody");
  });

  test("a file body is re-sent byte-equal", async () => {
    const { exit, seen } = await run(withBody("PUT", fileBody()), statuses(503, 200));
    expect(exit).toEqual(Exit.succeed(200));
    expect(seen.map((call) => call.body)).toEqual([BODY, BODY]);
  });

  test("an in-memory body is re-sent byte-equal", async () => {
    const body = HttpBody.uint8Array(bytes(BODY), "text/plain");
    const { seen } = await run(withBody("PUT", body), statuses(502, 200));
    expect(seen.map((call) => call.body)).toEqual([BODY, BODY]);
  });

  test.each([408, 429, 500, 502, 503, 504])("final status %d is retried", async (code) => {
    const { exit, seen } = await run(get(), statuses(code, 200));
    expect(exit).toEqual(Exit.succeed(200));
    expect(seen).toHaveLength(2);
  });

  test.each([400, 404, 501])("final status %d is not retried", async (code) => {
    const { exit, seen } = await run(get(), statuses(code, 200));
    expect(exit).toEqual(Exit.succeed(code));
    expect(seen).toHaveLength(1);
  });

  test.each(["connect", "dns", "timeout"] as const)(
    "TransportError %s is retried",
    async (reason) => {
      const { exit, seen } = await run(get(), [failing(reason), status(200)]);
      expect(exit).toEqual(Exit.succeed(200));
      expect(seen).toHaveLength(2);
    },
  );

  test.each(["tls", "aborted"] as const)("TransportError %s is not retried", async (reason) => {
    const { exit, seen } = await run(get(), [failing(reason), status(200)]);
    expect(failureOf(exit)).toMatchObject({ _tag: "TransportError", reason });
    expect(seen).toHaveLength(1);
  });

  test("three 503s with --retries 2 make three attempts", async () => {
    const { exit, notes, seen } = await run(get(), statuses(503, 503, 503, 200), { retries: 2 });
    expect(exit).toEqual(Exit.succeed(503));
    expect(seen).toHaveLength(3);
    expect(notes).toHaveLength(2);
  });

  test("the built-in default is 2 retries", async () => {
    const { seen } = await run(get(), statuses(503, 503, 503, 200));
    expect(seen).toHaveLength(3);
  });

  test("exhausted transport retries fail with the last TransportError", async () => {
    const { exit, seen } = await run(get(), [
      failing("connect"),
      failing("dns"),
      failing("timeout"),
      status(200),
    ]);
    expect(failureOf(exit)).toMatchObject({ _tag: "TransportError", reason: "timeout" });
    expect(seen).toHaveLength(3);
  });

  test("<PREFIX>_RETRIES=0 disables retry", async () => {
    const { exit, notes, seen } = await run(get(), statuses(503, 200), {
      env: { ACME_RETRIES: "0" },
    });
    expect(exit).toEqual(Exit.succeed(503));
    expect(seen).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  test("--retries beats <PREFIX>_RETRIES", async () => {
    const { seen } = await run(get(), statuses(503, 200), {
      env: { ACME_RETRIES: "0" },
      retries: 1,
    });
    expect(seen).toHaveLength(2);
  });

  test("an unprefixed RETRIES is never read", async () => {
    const { seen } = await run(get(), statuses(503, 200), { env: { RETRIES: "0" } });
    expect(seen).toHaveLength(2);
  });

  test("an invalid <PREFIX>_RETRIES fails with a UsageError before anything is sent", async () => {
    const { exit, seen } = await run(get(), statuses(200), { env: { ACME_RETRIES: "11" } });
    expect(failureOf(exit)).toMatchObject({ _tag: "UsageError", flag: "--retries" });
    expect(seen).toEqual([]);
  });

  test("a 307 then 503 then 200 replays as one attempt per loop run", async () => {
    const { exit, notes, seen } = await run(get("/start"), [
      { location: `${origin}/final`, status: 307 },
      status(503),
      status(200),
    ]);
    expect(exit).toEqual(Exit.succeed(200));
    expect(seen.map((call) => call.path)).toEqual(["/start", "/final", "/start"]);
    expect(notes).toHaveLength(1);
  });
});

describe("wouldRetry", () => {
  test("the method table without a key", () => {
    const methods = ["GET", "HEAD", "OPTIONS", "TRACE", "PUT", "DELETE", "QUERY", "POST", "PATCH"];
    expect(methods.map((method) => [method, Client.wouldRetry(method, false)])).toEqual([
      ["GET", true],
      ["HEAD", true],
      ["OPTIONS", true],
      ["TRACE", true],
      ["PUT", true],
      ["DELETE", true],
      ["QUERY", true],
      ["POST", false],
      ["PATCH", false],
    ]);
  });

  test("an Idempotency-Key makes any method retried", () => {
    expect(Client.wouldRetry("POST", true)).toBe(true);
    expect(Client.wouldRetry("PATCH", true)).toBe(true);
  });
});
