import { describe, expect, test } from "bun:test";
import {
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Runtime,
  Schedule,
  Stdio,
  Stream,
  Terminal,
} from "effect";
import type { Duration } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import * as Client from "../../src/runtime-src/runtime/client.ts";
import { mapClientError } from "../../src/runtime-src/runtime/response.ts";

const origin = "http://127.0.0.1:1";

// The direct-route init the entry hands the policy. Opaque to the runtime, so any object serves.
const sentinel: Client.DirectRoute = { cache: "no-store" };

const allowed: ReadonlySet<string> = new Set(["GET"]);

const noAttach: Client.Attach = Effect.succeed;

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (!Exit.isFailure(exit)) {
    throw new Error("expected a failure");
  }

  const [error] = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" ? [reason.error] : [],
  );
  if (error === undefined) {
    throw new Error("expected a typed failure");
  }

  return error;
};

// A scripted client: the headers arrive after `headersAfter` of virtual time; the body sends one
// chunk every `chunkEvery`, so a trickling body outlasts the bound while the headers do not.
const scripted = (headersAfter: Duration.Input, chunkEvery: Duration.Input = "1 second") =>
  HttpClient.make((request) =>
    Effect.gen(function* answer() {
      yield* Effect.sleep(headersAfter);

      const body = yield* Stream.toReadableStreamEffect(
        Stream.make("a", "b", "c").pipe(
          Stream.schedule(Schedule.spaced(chunkEvery)),
          Stream.encodeText,
        ),
      );

      return HttpClientResponse.fromWeb(request, new Response(body));
    }),
  );

const prefix = "ACME";

// The provider `main.ts` supplies: the environment, then the author defaults keyed by the same
// prefixed names (design D-AD7). Nothing is nested or remapped.
const provider = (env: Record<string, string>, defaults: Readonly<Record<string, number>> = {}) =>
  ConfigProvider.orElse(ConfigProvider.fromEnv({ env }), ConfigProvider.fromUnknown(defaults));

// The servers layer the root provides; only its env prefix matters here.
const servers = BaseUrl.layer({ boundOrigins: [], servers: [] }, prefix);

// One request through the policy transform, then the whole body. The clock moves in steps so
// both the headers wait and the body reads are driven by virtual time.
const send = (
  headersAfter: Duration.Input,
  options: {
    readonly chunkEvery?: Duration.Input;
    readonly env?: Record<string, string>;
    readonly timeout?: number;
  } = {},
) => {
  const client = scripted(headersAfter, options.chunkEvery).pipe(
    Client.redirectLoop(noAttach, sentinel, allowed),
  );
  const exchange = Effect.scoped(
    client.execute(HttpClientRequest.get(`${origin}/slow`)).pipe(
      Effect.flatMap((response) => response.text),
      Effect.catchTag("HttpClientError", mapClientError),
    ),
  );
  const flagged =
    options.timeout === undefined
      ? exchange
      : Effect.provideService(exchange, Client.timeoutSetting, Option.some(options.timeout));
  const configured =
    options.env === undefined
      ? flagged
      : flagged.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, provider(options.env)),
          Effect.provide(servers),
        );

  return Effect.runPromiseExit(
    Effect.gen(function* drive() {
      const fiber = yield* Effect.forkChild(configured);
      for (let step = 0; step < 200; step += 1) {
        yield* TestClock.adjust("30 seconds");
      }

      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
};

describe("per-attempt --timeout to response headers", () => {
  test("headers past the default bound fail with TransportError timeout, exit 4", async () => {
    const error = failure(await send("31 seconds"));
    expect(error).toMatchObject({
      _tag: "TransportError",
      reason: "timeout",
      url: `${origin}/slow`,
    });
    expect(error[Runtime.errorExitCode]).toBe(4);
  });

  test("headers inside the bound succeed although the body trickles past it", async () => {
    const exit = await send("29 seconds", { chunkEvery: "20 seconds" });
    expect(exit).toEqual(Exit.succeed("abc"));
  });

  test("the setting's value is the bound", async () => {
    expect(failure(await send("6 seconds", { timeout: 5 }))).toMatchObject({
      _tag: "TransportError",
      reason: "timeout",
    });
    expect(await send("4 seconds", { timeout: 5 })).toEqual(Exit.succeed("abc"));
  });

  test("<PREFIX>_TIMEOUT from the root's prefix is the bound", async () => {
    expect(failure(await send("6 seconds", { env: { ACME_TIMEOUT: "5" } }))).toMatchObject({
      _tag: "TransportError",
      reason: "timeout",
    });
    expect(await send("4 seconds", { env: { ACME_TIMEOUT: "5" } })).toEqual(Exit.succeed("abc"));
  });

  test("an unprefixed TIMEOUT is never read", async () => {
    expect(await send("6 seconds", { env: { TIMEOUT: "5" } })).toEqual(Exit.succeed("abc"));
  });

  test("an invalid <PREFIX>_TIMEOUT fails with a UsageError naming --timeout only", async () => {
    const error = failure(await send("1 second", { env: { ACME_TIMEOUT: "1.5" } }));
    expect(error).toMatchObject({ _tag: "UsageError", flag: "--timeout" });
    expect(JSON.stringify(error)).not.toContain("1.5");
    expect(error[Runtime.errorExitCode]).toBe(2);
  });

  test("--timeout 0 never fails", async () => {
    expect(await send("90 minutes", { timeout: 0 })).toEqual(Exit.succeed("abc"));
  });
});

const flagEnvironment = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      display: () => Effect.void,
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      rows: Effect.succeed(24),
      size: Effect.die("unused"),
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused")),
  ),
);

const parse = (flags: Record<string, readonly string[]>) =>
  Effect.runPromiseExit(
    Client.timeoutSetting.flag.parse({ arguments: [], flags }).pipe(
      Effect.map(([, value]) => value),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        provider({ ACME_TIMEOUT: "9", TIMEOUT: "9" }),
      ),
      Effect.provide(flagEnvironment),
    ),
  );

const resolve = (
  flag: Option.Option<number>,
  env: Record<string, string>,
  defaults: Readonly<Record<string, number>> = {},
) =>
  Effect.runPromiseExit(
    Client.effectiveTimeoutSeconds(prefix).pipe(
      Effect.provideService(Client.timeoutSetting, flag),
      Effect.provideService(ConfigProvider.ConfigProvider, provider(env, defaults)),
    ),
  );

describe("--timeout resolution", () => {
  test("is exported as the timeout setting", () => {
    expect(Client.timeoutSetting.id).toBe("timeout");
  });

  test("the flag holds only the operator's value", async () => {
    expect(await parse({ timeout: ["3"] })).toEqual(Exit.succeed(Option.some(3)));
    expect(await parse({ timeout: ["0"] })).toEqual(Exit.succeed(Option.some(0)));
    expect(await parse({})).toEqual(Exit.succeed(Option.none()));
  });

  test("flag over env over author default over 30", async () => {
    const env = { ACME_TIMEOUT: "9" };
    const defaults = { ACME_TIMEOUT: 7 };
    expect(await resolve(Option.some(3), env, defaults)).toEqual(Exit.succeed(3));
    expect(await resolve(Option.some(0), env, defaults)).toEqual(Exit.succeed(0));
    expect(await resolve(Option.none(), env, defaults)).toEqual(Exit.succeed(9));
    expect(await resolve(Option.none(), {}, defaults)).toEqual(Exit.succeed(7));
    expect(await resolve(Option.none(), {})).toEqual(Exit.succeed(30));
  });

  test("an unprefixed TIMEOUT is never read, from the env or the defaults", async () => {
    expect(await resolve(Option.none(), { TIMEOUT: "9" }, { TIMEOUT: 7 })).toEqual(
      Exit.succeed(30),
    );
  });

  test.each(["-1", "1.5", "abc", ""])(
    "--timeout %p is a UsageError naming the flag only",
    async (raw) => {
      const error = failure(await parse({ timeout: [raw] }));
      expect(error).toMatchObject({
        _tag: "UserError",
        cause: { _tag: "UsageError", flag: "--timeout" },
      });
      if (raw !== "") {
        expect(JSON.stringify(error)).not.toContain(raw);
        expect(JSON.stringify(error.cause)).not.toContain(raw);
      }
    },
  );

  test.each(["-1", "1.5", "abc"])(
    "ACME_TIMEOUT %p is a UsageError naming --timeout only",
    async (raw) => {
      const error = failure(await resolve(Option.none(), { ACME_TIMEOUT: raw }));
      expect(error).toMatchObject({ _tag: "UsageError", flag: "--timeout" });
      expect(JSON.stringify(error)).not.toContain(raw);
    },
  );

  test("an empty ACME_TIMEOUT counts as unset", async () => {
    expect(await resolve(Option.none(), { ACME_TIMEOUT: "" })).toEqual(Exit.succeed(30));
  });
});
