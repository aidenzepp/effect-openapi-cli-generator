/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
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
  Sink,
  Stdio,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import * as Client from "../../src/runtime-src/runtime/client.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import { runCredentialsLayer } from "../../src/runtime-src/runtime/redact.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

// Output.send composes the Milestone 3 client policy (m3-wire): retries outermost, the redirect
// loop, `--verbose` on each hop, the `Retry-After` cap, and the run's notices.

const SECRET = "tok-WIRE-SECRET";

const servers: BaseUrl.ServersTable = {
  boundOrigins: ["https://api.example.com"],
  defaultServer: 0,
  servers: [{ url: "https://api.example.com/v1", variables: {} }],
};

const bearer: Auth.SecurityTable = {
  schemes: { bearerAuth: { kind: "http", scheme: "bearer" } },
};

// An apiKey header scheme whose header name is `Idempotency-Key`: a credential, not the
// operator-supplied declared header, so it never makes a POST retried.
const keyScheme: Auth.SecurityTable = {
  schemes: { idemKey: { in: "header", kind: "apiKey", name: "Idempotency-Key" } },
};

const getMeta: Output.OperationMeta = {
  media: { request: [], responses: { "200": ["application/json"], "5XX": [] } },
  method: "GET",
  operationId: "items-get",
  pathTemplate: "/items",
  security: [["bearerAuth"]],
};

const postMeta: Output.OperationMeta = {
  ...getMeta,
  method: "POST",
  operationId: "items-create",
};

const getRequest = Serialize.request("GET", {
  headers: [],
  path: Serialize.path("/items", []),
  query: [],
});

// A POST whose operation declares an `Idempotency-Key` header parameter the operator supplied.
const keyedPost = Serialize.request("POST", {
  headers: [Serialize.header("Idempotency-Key", "k-1", { explode: false, required: false })],
  path: Serialize.path("/items", []),
  query: [],
});

const plainPost = Serialize.request("POST", {
  headers: [],
  path: Serialize.path("/items", []),
  query: [],
});

interface Answer {
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status: number;
}

interface Seen {
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly url: string;
}

interface World {
  readonly allowUnbound?: boolean;
  readonly answers: readonly Answer[];
  readonly baseUrl?: string;
  readonly env?: Record<string, string>;
  readonly operation?: Output.OperationMeta;
  readonly request?: Serialize.Request;
  // How many times the request is sent in the one run.
  readonly requests?: number;
  readonly security?: Auth.SecurityTable;
  readonly verbose?: boolean;
}

const decode = (chunks: readonly Buffer[]): string => Buffer.concat(chunks).toString("utf-8");

const capture = (into: Buffer[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(Buffer.from(chunk));
    }),
  );

/**
 * Run `send` through the final catch against a scripted client (call k gets `answers[k]`, a call
 * past the script gets 200 with `[]`), under the test clock, which the driver advances until it
 * ends.
 */
const run = async (world: World) => {
  const seen: Seen[] = [];
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const client = HttpClient.make((sent, url) =>
    Effect.sync(() => {
      const answer = world.answers[seen.length] ?? { body: "[]", status: 200 };
      seen.push({ headers: sent.headers, method: sent.method, url: url.href });

      return HttpClientResponse.fromWeb(
        sent,
        new Response(answer.body ?? null, {
          headers: new Headers(answer.headers),
          status: answer.status,
        }),
      );
    }),
  );
  const environment = Layer.mergeAll(
    BaseUrl.layer(servers, "EXAMPLE"),
    Auth.layer(world.security ?? bearer, "EXAMPLE"),
    ConfigProvider.layer(
      ConfigProvider.fromEnvRecord(world.env ?? { EXAMPLE_BEARER_AUTH: SECRET }),
    ),
    FileSystem.layerNoop({}),
    Path.layer,
    Stdio.layerTest({
      stderr: capture(stderr),
      stdout: capture(stdout),
      stdoutIsTerminal: Effect.succeed(false),
    }),
    Input.stdinClaimLayer,
    runCredentialsLayer,
    Output.runWarningsLayer,
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Output.ClientPolicy, {
      allowed: new Set(["GET", "POST"]),
      binName: "example",
      direct: { cache: "no-store" },
      version: "1.2.3",
    }),
    Layer.succeed(Output.OutputPath, Option.none()),
    Layer.succeed(Output.Force, false),
    Layer.succeed(Output.MaxErrorBytes, Output.defaultMaxErrorBytes),
    Layer.succeed(BaseUrl.baseUrlSetting, Option.fromNullishOr(world.baseUrl)),
    Layer.succeed(BaseUrl.serverSetting, Option.none()),
    Layer.succeed(BaseUrl.serverVariableSetting, []),
    Layer.succeed(Auth.allowCredentialsForBaseUrl, world.allowUnbound ?? false),
    Layer.succeed(Client.verboseSetting, world.verbose ?? false),
  );
  const once = (world.request ?? getRequest).pipe(
    Effect.flatMap(Output.send(world.operation ?? getMeta)),
  );
  const program = Output.finalCatch([])(Effect.repeat(once, { times: (world.requests ?? 1) - 1 }));
  const exit = await Effect.runPromise(
    Effect.gen(function* drive() {
      const fiber = yield* Effect.forkChild(program);
      for (let step = 0; step < 400 && fiber.pollUnsafe() === undefined; step += 1) {
        yield* TestClock.adjust("10 seconds");
        yield* TestClock.withLive(Effect.sleep("1 millis"));
      }

      return yield* Fiber.await(fiber);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), environment))),
  );
  const failure = Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined;

  return { exit, failure, seen, stderr: decode(stderr), stdout: decode(stdout) };
};

const lines = (text: string, prefix: string): readonly string[] =>
  text.split("\n").filter((line) => line.startsWith(prefix));

describe("Output.send retries", () => {
  test("a GET answered 503 then 200 succeeds on attempt 2", async () => {
    const result = await run({ answers: [{ status: 503 }, { body: "[]", status: 200 }] });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.seen).toHaveLength(2);
    expect(result.stdout).toBe("[]");
  });

  test("a 503 whose Retry-After exceeds --timeout fails with retryAfterSeconds and no retry", async () => {
    const result = await run({
      answers: [{ headers: { "retry-after": "120" }, status: 503 }],
    });

    expect(result.seen).toHaveLength(1);
    expect(result.failure).toMatchObject({
      _tag: "ApiResponseError",
      retryAfterSeconds: 120,
      status: 503,
    });
  });

  test("a 503 whose retries run out carries no retryAfterSeconds", async () => {
    const result = await run({
      answers: [{ status: 503 }, { status: 503 }, { status: 503 }],
    });

    expect(result.seen).toHaveLength(3);
    expect(result.failure).toMatchObject({ _tag: "ApiResponseError", status: 503 });
    expect(result.failure).not.toHaveProperty("retryAfterSeconds");
  });

  test("a POST with its declared Idempotency-Key supplied is retried", async () => {
    const result = await run({
      answers: [{ status: 503 }, { body: "[]", status: 200 }],
      operation: postMeta,
      request: keyedPost,
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.seen.map((seen) => seen.headers["idempotency-key"])).toEqual(["k-1", "k-1"]);
  });

  test("a POST whose only Idempotency-Key is an attached credential is not retried", async () => {
    const result = await run({
      answers: [{ status: 503 }, { body: "[]", status: 200 }],
      env: { EXAMPLE_IDEM_KEY: SECRET },
      operation: { ...postMeta, security: [["idemKey"]] },
      request: plainPost,
      security: keyScheme,
    });

    expect(result.seen).toHaveLength(1);
    expect(result.seen[0]?.headers["idempotency-key"]).toBe(SECRET);
    expect(result.failure).toMatchObject({ _tag: "ApiResponseError", status: 503 });
  });
});

describe("Output.send --verbose", () => {
  const redirected: readonly Answer[] = [
    { headers: { location: "/v1/moved" }, status: 307 },
    { body: "raw", headers: { "content-type": "application/octet-stream" }, status: 200 },
  ];

  test("a same-origin 307 writes request and response blocks for both hops on stderr", async () => {
    const result = await run({ answers: redirected, verbose: true });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.stdout).toBe("raw");
    expect(lines(result.stderr, "> GET ")).toEqual([
      "> GET https://api.example.com/v1/items HTTP/1.1",
      "> GET https://api.example.com/v1/moved HTTP/1.1",
    ]);

    const received = lines(result.stderr, "< ");
    expect(received).toContain("< 307");
    expect(received).toContain("< location: /v1/moved");
    expect(received).toContain("< 200");
    expect(result.stderr).not.toContain(SECRET);
  });

  test("an undeclared response media type gets one notice naming it under --verbose", async () => {
    const result = await run({ answers: redirected, verbose: true });
    const notices = lines(result.stderr, "Notice:");

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("application/octet-stream");
  });

  test("without --verbose nothing is written to stderr", async () => {
    const result = await run({ answers: redirected });

    expect(result.stdout).toBe("raw");
    expect(result.stderr).toBe("");
  });

  test("a declared response media type gets no notice", async () => {
    const result = await run({
      answers: [{ body: "[]", headers: { "content-type": "application/json" }, status: 200 }],
      verbose: true,
    });

    expect(lines(result.stderr, "Notice:")).toEqual([]);
  });
});

describe("Output.send plaintext warning", () => {
  test("an unbound http base with the flag warns once in a run of two requests", async () => {
    const result = await run({
      allowUnbound: true,
      answers: [
        { body: "[]", status: 200 },
        { body: "[]", status: 200 },
      ],
      baseUrl: "http://plain.example.test/v1",
      requests: 2,
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.seen).toHaveLength(2);
    expect(result.seen.map((seen) => seen.headers.authorization)).toEqual([
      `Bearer ${SECRET}`,
      `Bearer ${SECRET}`,
    ]);

    const warnings = lines(result.stderr, "Warning:");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("plain.example.test");
    expect(result.stderr).not.toContain(SECRET);
  });

  test.each([
    ["a loopback http base", "http://127.0.0.1:9/v1", true],
    ["an https base", "https://plain.example.test/v1", true],
    ["an unbound http base without the flag", "http://plain.example.test/v1", false],
  ])("%s gets no warning", async (_name, baseUrl, allowUnbound) => {
    const result = await run({ allowUnbound, answers: [{ body: "[]", status: 200 }], baseUrl });

    expect(lines(result.stderr, "Warning:")).toEqual([]);
  });
});
