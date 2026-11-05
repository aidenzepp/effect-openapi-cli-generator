/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Runtime,
  Sink,
  Stdio,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import type * as Client from "../../src/runtime-src/runtime/client.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

const SECRET = "tok-S12-SECRET";

const servers: BaseUrl.ServersTable = {
  boundOrigins: ["https://api.example.com"],
  defaultServer: 0,
  servers: [
    { url: "https://api.example.com/{version}", variables: { version: { default: "v1" } } },
  ],
};

const security: Auth.SecurityTable = {
  schemes: { bearerAuth: { kind: "http", scheme: "bearer" } },
};

const meta: Output.OperationMeta = {
  media: {
    request: ["application/merge-patch+json"],
    responses: {
      "200": ["application/json", "text/plain"],
      "404": [],
      "4XX": ["application/json"],
      default: [],
    },
  },
  method: "PATCH",
  operationId: "users-update",
  pathTemplate: "/users/{id}",
  security: [["bearerAuth"]],
};

// No range and no `default`: a 500 matches nothing.
const bare: Output.OperationMeta = { ...meta, media: { ...meta.media, responses: { "200": [] } } };

// The direct-route init the entry hands the policy. Opaque to the runtime, so any object serves.
const sentinel: Client.DirectRoute = { cache: "no-store" };

const request = Serialize.request("PATCH", {
  body: Serialize.body("application/merge-patch+json", { name: "Ada" }),
  headers: [],
  path: Serialize.path("/users/{id}", [
    Serialize.simple("id", "42", { allowReserved: false, explode: false }),
  ]),
  query: [Serialize.form("notify", true, { allowReserved: false, explode: true, required: false })],
});

interface Seen {
  readonly headers: Readonly<Record<string, string>>;
  readonly init: Client.DirectRoute | undefined;
  readonly method: string;
  readonly url: string;
}

interface Answer {
  readonly body?: string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  // The body yields `body` (if any) and then errors, as a connection dropped mid-read would.
  readonly streamFails?: boolean;
  readonly status: number;
}

interface World {
  readonly accept?: string;
  readonly allowUnbound?: boolean;
  readonly answer?: Answer | "transport";
  readonly baseUrl?: string;
  // The client dies with a message carrying the credential, after `send` evaluated it.
  readonly defect?: boolean;
  readonly env?: Record<string, string>;
  readonly operation?: Output.OperationMeta;
}

const failingBody = (text: string | undefined): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      if (text !== undefined) {
        controller.enqueue(new TextEncoder().encode(text));
      }

      controller.error(new Error("connection reset"));
    },
  });

const decode = (chunks: readonly Buffer[]): string => Buffer.concat(chunks).toString("utf-8");

const capture = (into: Buffer[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(Buffer.from(chunk));
    }),
  );

/**
 * Run `send` once against a recording client (no sockets), through the final catch, as `main.ts`
 * composes them.
 */
const run = async (world: World = {}) => {
  const seen: Seen[] = [];
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const answer = world.answer ?? {
    body: '{"id":"42"}',
    contentType: "application/json",
    status: 200,
  };
  const client = HttpClient.make((sent, url) =>
    Effect.gen(function* record() {
      const init = Option.getOrUndefined(yield* Effect.serviceOption(FetchHttpClient.RequestInit));
      seen.push({ headers: sent.headers, init, method: sent.method, url: url.href });

      if (world.defect === true) {
        return yield* Effect.die(new Error(`boom ${SECRET}`));
      }

      if (answer === "transport") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            cause: new Error("refused"),
            request: sent,
          }),
        });
      }

      const headers = new Headers(answer.headers);

      if (answer.contentType !== undefined) {
        headers.set("content-type", answer.contentType);
      }

      return HttpClientResponse.fromWeb(
        sent,
        new Response(
          answer.streamFails === true ? failingBody(answer.body) : (answer.body ?? null),
          { headers, status: answer.status },
        ),
      );
    }),
  );
  const environment = Layer.mergeAll(
    BaseUrl.layer(servers, "EXAMPLE"),
    Auth.layer(security, "EXAMPLE"),
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
    Output.runCredentialsLayer,
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Output.ClientPolicy, {
      allowed: new Set(["PATCH"]),
      binName: "example",
      direct: sentinel,
      version: "1.2.3",
    }),
    Layer.succeed(Output.OutputPath, Option.none()),
    Layer.succeed(Output.Force, false),
    Layer.succeed(Output.MaxErrorBytes, Output.defaultMaxErrorBytes),
    Layer.succeed(BaseUrl.baseUrlSetting, Option.fromNullishOr(world.baseUrl)),
    Layer.succeed(BaseUrl.serverSetting, Option.none()),
    Layer.succeed(BaseUrl.serverVariableSetting, []),
    Layer.succeed(Auth.allowCredentialsForBaseUrl, world.allowUnbound ?? false),
  );
  const program = Output.finalCatch([])(
    request.pipe(
      Effect.flatMap(Output.send(world.operation ?? meta, Option.fromNullishOr(world.accept))),
    ),
  );
  const exit = await Effect.runPromise(Effect.exit(program).pipe(Effect.provide(environment)));
  const failure = Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined;

  return {
    exit,
    exitCode: failure?.[Runtime.errorExitCode],
    matched: failure?._tag === "ApiResponseError" ? failure.matched : undefined,
    seen,
    stderr: decode(stderr),
    stdout: decode(stdout),
    tag: failure?._tag,
  };
};

describe("Output.send success", () => {
  test("a 2xx streams its body to stdout and succeeds", async () => {
    const result = await run();

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.stdout).toBe('{"id":"42"}');
    expect(result.stderr).toBe("");
  });

  test("the request goes to the default server with the credential, Accept and User-Agent", async () => {
    const { seen } = await run();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("PATCH");
    expect(seen[0]?.url).toBe("https://api.example.com/v1/users/42?notify=true");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen[0]?.headers.accept).toBe("application/json");
    expect(seen[0]?.headers["user-agent"]).toBe("example/1.2.3");
  });

  test("Content-Type is sent as Serialize.body set it", async () => {
    const { seen } = await run();

    expect(seen[0]?.headers["content-type"]).toBe("application/merge-patch+json");
  });

  test("--accept names the Accept value", async () => {
    const { seen } = await run({ accept: "text/plain" });

    expect(seen[0]?.headers.accept).toBe("text/plain");
  });

  test("an undeclared --accept is a usage error and sends nothing", async () => {
    const result = await run({ accept: "image/png" });

    expect([result.tag, result.exitCode]).toEqual(["UsageError", 2]);
    expect(result.seen).toHaveLength(0);
  });
});

describe("Output.send errors", () => {
  test("404 renders with matched 404 and exits 1", async () => {
    const result = await run({ answer: { body: "no such user", status: 404 } });

    expect(result.tag).toBe("ApiResponseError");
    expect(result.matched).toBe("404");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no such user");
    expect(result.stdout).toBe("");
  });

  test("a 4XX range, default and undeclared each render with their literal and exit 1", async () => {
    const range = await run({ answer: { status: 409 } });
    const fallback = await run({ answer: { status: 500 } });
    const undeclared = await run({ answer: { status: 500 }, operation: bare });

    expect([range.matched, range.exitCode]).toEqual(["4XX", 1]);
    expect([fallback.matched, fallback.exitCode]).toEqual(["default", 1]);
    expect([undeclared.matched, undeclared.exitCode]).toEqual(["undeclared", 1]);
  });

  test("401 exits 3", async () => {
    const result = await run({ answer: { status: 401 } });

    expect(result.tag).toBe("ApiResponseError");
    expect(result.exitCode).toBe(3);
  });

  test("an error body echoing the credential is scrubbed on stderr", async () => {
    const result = await run({ answer: { body: `bad token ${SECRET}`, status: 403 } });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("<redacted:bearerAuth>");
    expect(result.stderr).not.toContain(SECRET);
  });

  test("the literal that matched is named on stderr", async () => {
    const result = await run({ answer: { status: 409 } });

    expect(result.stderr).toContain("(matched 4XX)");
  });

  test("a 2xx body that fails mid-stream exits 5", async () => {
    const result = await run({
      answer: { body: "{", contentType: "application/json", status: 200, streamFails: true },
    });

    expect(result.tag).toBe("ResponseStreamError");
    expect(result.exitCode).toBe(5);
  });

  test("an error body that cannot be read leaves the ApiResponseError with an empty excerpt", async () => {
    const result = await run({ answer: { status: 404, streamFails: true } });

    expect(result.tag).toBe("ApiResponseError");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("(matched 404)");
    expect(result.stderr).not.toContain("connection reset");
  });

  test("a redirect from https to http is refused and exits 4", async () => {
    const result = await run({
      answer: { headers: { location: "http://api.example.com/users/42" }, status: 302 },
    });

    expect(result.tag).toBe("RedirectRefused");
    expect(result.exitCode).toBe(4);
    expect(result.seen).toHaveLength(1);
  });

  test("a defect after the credential is evaluated prints no credential and exits 70", async () => {
    const result = await run({ defect: true });

    expect(result.tag).toBe("InternalError");
    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("boom");
    expect(result.stderr).toContain("<redacted:bearerAuth>");
    expect(result.stderr).not.toContain(SECRET);
  });

  test("a transport failure exits 4", async () => {
    const result = await run({ answer: "transport" });

    expect(result.tag).toBe("TransportError");
    expect(result.exitCode).toBe(4);
  });

  test("a missing credential exits 3 and sends no request", async () => {
    const result = await run({ env: {} });

    expect(result.tag).toBe("CredentialMissing");
    expect(result.exitCode).toBe(3);
    expect(result.seen).toHaveLength(0);
  });
});

describe("Output.send operator base URL", () => {
  test("an unbound --base-url without the flag sends the request with no credential", async () => {
    const result = await run({ baseUrl: "https://other.example.net/api" });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.seen).toHaveLength(1);
    expect(result.seen[0]?.url).toBe("https://other.example.net/api/users/42?notify=true");
    expect(result.seen[0]?.headers.authorization).toBeUndefined();
    expect(result.stderr).toContain("bearerAuth");
    expect(result.stderr).toContain("--allow-credentials-for-base-url");
    expect(result.stderr).not.toContain(SECRET);
  });

  test("--allow-credentials-for-base-url sends the credential to the unbound base", async () => {
    const result = await run({ allowUnbound: true, baseUrl: "https://other.example.net/api" });

    expect(result.seen[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(result.stderr).toBe("");
  });

  test("a loopback base executes with the direct-route init", async () => {
    const result = await run({ baseUrl: "http://127.0.0.1:8080" });

    expect(result.seen[0]?.url).toBe("http://127.0.0.1:8080/users/42?notify=true");
    expect(result.seen[0]?.init).toBe(sentinel);
    expect(result.seen[0]?.headers.authorization).toBeUndefined();
  });
});
