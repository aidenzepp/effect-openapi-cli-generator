import { describe, expect, test } from "bun:test";
import { Clock, DateTime, Effect, Exit, Fiber, Option, Sink, Stdio } from "effect";
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import * as Client from "../../src/runtime-src/runtime/client.ts";

const url = "http://127.0.0.1:1/r";

// One scripted answer: a status, and the `Retry-After` value it carries, if any. The value may
// depend on the virtual time the call arrives at (an HTTP date).
interface Answer {
  readonly retryAfter?: (nowMillis: number) => string;
  readonly status: number;
}

const answer = (status: number, retryAfter?: string): Answer =>
  retryAfter === undefined ? { status } : { retryAfter: () => retryAfter, status };

// A scripted client: call k gets `answers[k]`, a call past the script gets 200, and each call's
// virtual arrival time is recorded.
const scripted = (answers: readonly Answer[], arrivals: number[]) =>
  HttpClient.make((request) =>
    Effect.gen(function* respond() {
      const now = yield* Clock.currentTimeMillis;
      const next = answers[arrivals.length] ?? answer(200);
      arrivals.push(now);

      const headers: Record<string, string> =
        next.retryAfter === undefined ? {} : { "retry-after": next.retryAfter(now) };

      return HttpClientResponse.fromWeb(
        request,
        new Response(`status ${next.status}`, { headers, status: next.status }),
      );
    }),
  );

interface Outcome {
  readonly arrivals: readonly number[];
  readonly capped: Option.Option<number>;
  readonly status: number;
}

// The retry transform alone over the scripted client, with `--timeout` given as a flag and the
// clock driven in one-second steps for six minutes, so every wait elapses in virtual time.
const run = async (answers: readonly Answer[], timeout: number): Promise<Outcome> => {
  const arrivals: number[] = [];
  const client = scripted(answers, arrivals).pipe(Client.retryTransform((text) => text));
  const exchange = Effect.scoped(
    client.execute(HttpClientRequest.get(url)).pipe(
      Effect.map((response) => ({
        capped: Client.retryAfterCapSeconds(response),
        status: response.status,
      })),
    ),
  ).pipe(Effect.provideService(Client.timeoutSetting, Option.some(timeout)));
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* drive() {
      const fiber = yield* Effect.forkChild(exchange);
      for (let step = 0; step < 360; step += 1) {
        yield* TestClock.adjust("1 second");
      }

      return yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(Stdio.layerTest({ stderr: () => Sink.drain })),
    ),
  );
  if (Exit.isFailure(exit)) {
    throw new Error("the exchange failed");
  }

  return { ...exit.value, arrivals };
};

// An HTTP date `seconds` after the call's arrival.
const dateAhead =
  (seconds: number) =>
  (nowMillis: number): string =>
    Headers.formatHttpDate(DateTime.makeUnsafe(nowMillis + seconds * 1000));

describe("Retry-After capped by the effective --timeout", () => {
  test("Retry-After: 1 with --timeout 30 waits 1 s and succeeds", async () => {
    const outcome = await run([answer(503, "1")], 30);
    expect(outcome.status).toBe(200);
    expect(outcome.arrivals).toEqual([0, 1000]);
    expect(outcome.capped).toEqual(Option.none());
  });

  test("a delay equal to the timeout is waited", async () => {
    const outcome = await run([answer(503, "30")], 30);
    expect(outcome.status).toBe(200);
    expect(outcome.arrivals).toEqual([0, 30_000]);
    expect(outcome.capped).toEqual(Option.none());
  });

  test("Retry-After: 2 with --timeout 1 makes one attempt and reports 2", async () => {
    const outcome = await run([answer(503, "2")], 1);
    expect(outcome.status).toBe(503);
    expect(outcome.arrivals).toEqual([0]);
    expect(outcome.capped).toEqual(Option.some(2));
  });

  test("an HTTP date 2 s ahead behaves like 2", async () => {
    const above = await run([{ retryAfter: dateAhead(2), status: 503 }], 1);
    expect(above.status).toBe(503);
    expect(above.arrivals).toEqual([0]);
    expect(above.capped).toEqual(Option.some(2));

    const within = await run([{ retryAfter: dateAhead(2), status: 503 }], 30);
    expect(within.status).toBe(200);
    expect(within.arrivals).toEqual([0, 2000]);
  });

  test("--timeout 0 removes the cap: Retry-After: 120 is waited", async () => {
    const outcome = await run([answer(503, "120")], 0);
    expect(outcome.status).toBe(200);
    expect(outcome.arrivals).toEqual([0, 120_000]);
    expect(outcome.capped).toEqual(Option.none());
  });

  test("retries that run out report nothing", async () => {
    const outcome = await run([answer(503, "1"), answer(503, "1"), answer(503, "1")], 30);
    expect(outcome.status).toBe(503);
    expect(outcome.arrivals).toEqual([0, 1000, 2000]);
    expect(outcome.capped).toEqual(Option.none());
  });

  test("a status that is not retried reports nothing, even with a long Retry-After", async () => {
    const outcome = await run([answer(404, "120")], 1);
    expect(outcome.status).toBe(404);
    expect(outcome.arrivals).toEqual([0]);
    expect(outcome.capped).toEqual(Option.none());
  });

  test("an invalid Retry-After falls back to the backoff", async () => {
    const outcome = await run([answer(503, "soon")], 1);
    expect(outcome.status).toBe(200);
    expect(outcome.arrivals).toHaveLength(2);
    expect(outcome.capped).toEqual(Option.none());
  });
});
