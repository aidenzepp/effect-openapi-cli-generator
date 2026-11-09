/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import {
  Cause,
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
  Sink,
  Stdio,
  Stream,
} from "effect";
import type { Duration } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import type * as Client from "../../src/runtime-src/runtime/client.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import { runCredentialsLayer } from "../../src/runtime-src/runtime/redact.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

const prefix = "ACME";

const servers: BaseUrl.ServersTable = {
  boundOrigins: ["https://api.example.com"],
  defaultServer: 0,
  servers: [{ url: "https://api.example.com" }],
};

const meta: Output.OperationMeta = {
  media: { request: [], responses: { "200": ["application/json"], default: [] } },
  method: "GET",
  operationId: "items-get",
  pathTemplate: "/items",
  security: [],
};

const request = Serialize.request("GET", {
  headers: [],
  path: Serialize.path("/items", []),
  query: [],
});

// The direct-route init the entry hands the policy. Opaque to the runtime, so any object serves.
const sentinel: Client.DirectRoute = { cache: "no-store" };

const head = "0123456789";

/**
 * A body that sends `head` and then nothing more, never ending: the stalled server of design 9 I5.
 */
const stalled = (): Stream.Stream<Uint8Array> =>
  Stream.concat(Stream.make(head), Stream.never).pipe(Stream.encodeText);

/**
 * A body that sends one chunk every `every` of virtual time, `count` chunks, then ends.
 */
const trickle = (every: Duration.Input, count = 5): Stream.Stream<Uint8Array> =>
  Stream.range(1, count).pipe(
    Stream.map(String),
    Stream.schedule(Schedule.spaced(every)),
    Stream.encodeText,
  );

interface World {
  readonly body: () => Stream.Stream<Uint8Array>;
  readonly defaults?: Readonly<Record<string, number>>;
  readonly env?: Record<string, string>;
  readonly output?: string;
  readonly status?: number;
}

const capture = (into: Buffer[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(Buffer.from(chunk));
    }),
  );

const decode = (chunks: readonly Buffer[]): string => Buffer.concat(chunks).toString("utf-8");

/**
 * Run `send` once against a scripted client, through the final catch, as `main.ts` composes them.
 * Virtual time advances in steps with a real yield between them, so real file work interleaves;
 * a run still going after the last step is reported as `stalled` and interrupted.
 */
const run = async (world: World) => {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let sent = 0;
  const client = HttpClient.make((sentRequest) =>
    Effect.gen(function* answer() {
      sent += 1;
      const body = yield* Stream.toReadableStreamEffect(world.body());

      return HttpClientResponse.fromWeb(
        sentRequest,
        new Response(body, {
          headers: { "content-type": "application/json" },
          status: world.status ?? 200,
        }),
      );
    }),
  );
  const environment = Layer.mergeAll(
    BaseUrl.layer(servers, prefix),
    Auth.layer({ schemes: {} }, prefix),
    ConfigProvider.layer(
      ConfigProvider.orElse(
        ConfigProvider.fromEnv({ env: world.env ?? {} }),
        ConfigProvider.fromUnknown(world.defaults ?? {}),
      ),
    ),
    BunFileSystem.layer,
    BunPath.layer,
    Stdio.layerTest({
      stderr: capture(stderr),
      stdout: capture(stdout),
      stdoutIsTerminal: Effect.succeed(false),
    }),
    Input.stdinClaimLayer,
    runCredentialsLayer,
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Output.ClientPolicy, {
      allowed: new Set(["GET"]),
      binName: "acme",
      direct: sentinel,
      version: "1.0.0",
    }),
    Layer.succeed(Output.OutputPath, Option.fromNullishOr(world.output)),
    Layer.succeed(Output.Force, false),
    Layer.succeed(Output.MaxErrorBytes, Output.defaultMaxErrorBytes),
    Layer.succeed(BaseUrl.baseUrlSetting, Option.none()),
    Layer.succeed(BaseUrl.serverSetting, Option.none()),
    Layer.succeed(BaseUrl.serverVariableSetting, []),
    Layer.succeed(Auth.allowCredentialsForBaseUrl, false),
  );
  const program = Output.finalCatch([])(request.pipe(Effect.flatMap(Output.send(meta))));
  const exit = await Effect.runPromise(
    Effect.gen(function* drive() {
      const fiber = yield* Effect.forkChild(program);
      for (let step = 0; step < 400 && fiber.pollUnsafe() === undefined; step += 1) {
        yield* TestClock.adjust("10 seconds");
        yield* TestClock.withLive(Effect.sleep("1 millis"));
      }

      if (fiber.pollUnsafe() === undefined) {
        yield* Fiber.interrupt(fiber);

        return "stalled" as const;
      }

      return yield* Fiber.await(fiber);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), environment))),
  );
  const failure =
    exit !== "stalled" && Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;

  return {
    exitCode: failure?.[Runtime.errorExitCode],
    failure,
    sent,
    stderr: decode(stderr),
    stdout: decode(stdout),
    succeeded: exit !== "stalled" && Exit.isSuccess(exit),
  };
};

const idleTimeout = { _tag: "ResponseStreamError", reason: "idleTimeout" };

const inDir = <A>(use: (dir: string, fs: FileSystem.FileSystem, path: Path.Path) => Promise<A>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* step() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "to2-" });

        return yield* Effect.promise(() => use(dir, fs, path));
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  );

const listing = (fs: FileSystem.FileSystem, dir: string) =>
  Effect.runPromise(fs.readDirectory(dir).pipe(Effect.provide(BunFileSystem.layer)));

describe("stream idle timeout on response bodies", () => {
  test("a stalled raw body to stdout fails idleTimeout, exit 5, keeping the bytes written", async () => {
    const result = await run({ body: stalled });

    expect(result.failure).toMatchObject(idleTimeout);
    expect(result.failure).not.toHaveProperty("itemIndex");
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe(head);
  });

  test("a stalled --output body leaves neither the target nor a temp file", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.json");
      const result = await run({ body: stalled, output: target });

      expect(result.failure).toMatchObject(idleTimeout);
      expect(result.exitCode).toBe(5);
      expect(await listing(fs, dir)).toEqual([]);
    });
  });

  test("a stalled 500 error body fails idleTimeout during the excerpt read", async () => {
    const result = await run({ body: stalled, status: 500 });

    expect(result.failure).toMatchObject(idleTimeout);
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe("");
  });

  test("a body that keeps sending within the bound completes past it in total", async () => {
    const result = await run({ body: () => trickle("200 seconds") });

    expect(result.succeeded).toBe(true);
    expect(result.stdout).toBe("12345");
  });

  test("the built-in bound is 300 seconds: a 290 second gap completes", async () => {
    const result = await run({ body: () => trickle("290 seconds", 2) });

    expect(result.succeeded).toBe(true);
  });

  test("the built-in bound is 300 seconds: a 310 second gap fails", async () => {
    const result = await run({ body: () => trickle("310 seconds", 2) });

    expect(result.failure).toMatchObject(idleTimeout);
  });

  test("the author default replaces the built-in bound", async () => {
    const result = await run({
      body: () => trickle("20 seconds", 2),
      defaults: { [`${prefix}_IDLE_TIMEOUT`]: 10 },
    });

    expect(result.failure).toMatchObject(idleTimeout);
  });

  test("the environment beats the author default", async () => {
    const result = await run({
      body: () => trickle("20 seconds", 2),
      defaults: { [`${prefix}_IDLE_TIMEOUT`]: 10 },
      env: { [`${prefix}_IDLE_TIMEOUT`]: "30" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.stdout).toBe("12");
  });

  test("an unprefixed IDLE_TIMEOUT is not read", async () => {
    const result = await run({ body: () => trickle("20 seconds", 2), env: { IDLE_TIMEOUT: "10" } });

    expect(result.succeeded).toBe(true);
  });

  test.each(["0", "-1", "1.5", "soon"])(
    "an invalid bound %p is a usage error naming the variable, never the value; nothing is sent",
    async (raw) => {
      const result = await run({ body: stalled, env: { [`${prefix}_IDLE_TIMEOUT`]: raw } });

      expect(result.failure).toMatchObject({ _tag: "UsageError", flag: `${prefix}_IDLE_TIMEOUT` });
      expect(result.exitCode).toBe(2);
      expect(result.sent).toBe(0);
      expect(JSON.stringify(result.failure)).not.toContain(`"${raw}"`);
    },
  );
});
