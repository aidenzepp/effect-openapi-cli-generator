import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// Design 9 I2 and I4, and the additional fixture-server rows (SIGINT, 2^53+1), through a generated
// CLI. I2: hostile header and cookie values and lone surrogates are refused with exit 2 before any
// connection. I4: a canary credential never reaches stdout, stderr or help, while the canary server
// echoes the Authorization header in its 401 and 500 bodies (C5).

const specPath = nodePath.resolve(import.meta.dir, "../fixtures/specs/canary.json");

// The query canary holds characters the URL serializer percent-encodes, so its encoded wire forms
// are leak candidates as well as its raw text.
const canary = { bearer: "ts9-canary-bearer-7f3a", query: "ts9 canary/query+key&9c" } as const;

const canaryForms = [
  canary.bearer,
  canary.query,
  new URLSearchParams([["", canary.query]]).toString().slice(1),
  encodeURIComponent(canary.query),
];

const canaryEnv = { CANARY_CANARY_AUTH: canary.bearer, CANARY_CANARY_QUERY: canary.query };

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "ts9-values-"));

const file = (name: string) => nodePath.join(work, name);

const capture = startCaptureServer({ canary: true });

const A = capture.origins["127.0.0.1"];

// A port that was listening and is now closed: the transport-failure origin. It is bound in the
// author config so the credentials are attached on the way to it.
const closedOrigin = (() => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  const origin = `http://127.0.0.1:${listener.port}`;
  listener.stop(true);

  return origin;
})();

const configPath = file("author-config.json");

writeFileSync(
  configPath,
  `${JSON.stringify({
    acceptedOrigins: [A, closedOrigin],
    allowInsecure: true,
    binName: "canary",
    envPrefix: "CANARY",
    package: { name: "canary-cli", version: "0.1.0" },
  })}\n`,
);

const scope = Effect.runSync(Scope.make());

const ready = Promise.withResolvers<GeneratedPackage>();

beforeAll(async () => {
  const prepare = generateFixture({ configPath, specPath }).pipe(
    Effect.tap(preparePackage),
    Scope.provide(scope),
    Effect.provide(layer),
  );
  ready.resolve(await Effect.runPromise(prepare));
}, 600_000);

// The same server with one cookie parameter that stays refused: style form, explode false, on 3.2.
const refusedCookie = Promise.withResolvers<GeneratedPackage>();

const refusedCookieSpec = file("cookie-refused.json");

writeFileSync(
  refusedCookieSpec,
  `${JSON.stringify({
    info: { title: "Refused cookie fixture", version: "1.0.0" },
    openapi: "3.2.0",
    paths: {
      "/cookie": {
        get: {
          operationId: "values-cookie",
          parameters: [
            {
              explode: false,
              in: "cookie",
              name: "flavor",
              schema: { type: "string" },
              style: "form",
            },
          ],
          responses: { "200": { description: "Recorded." } },
          tags: ["values"],
        },
      },
    },
    servers: [{ url: "http://127.0.0.1:80" }],
  })}\n`,
);

beforeAll(async () => {
  const prepare = generateFixture({ configPath, specPath: refusedCookieSpec }).pipe(
    Effect.tap(preparePackage),
    Scope.provide(scope),
    Effect.provide(layer),
  );
  refusedCookie.resolve(await Effect.runPromise(prepare));
}, 600_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(work, { force: true, recursive: true });
});

const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

interface CliRun {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

const run = async (args: readonly string[], env: Record<string, string> = canaryEnv) => {
  const generated = await ready.promise;
  const result = await Effect.runPromise(
    runBin(generated, { args, env, timeoutMs: 30_000 }).pipe(Effect.provide(layer)),
  );
  const cli: CliRun = {
    exitCode: result.exitCode,
    stderr: utf8(result.stderr),
    stdout: utf8(result.stdout),
    timedOut: result.timedOut,
  };

  return cli;
};

// One invocation against the capture server: its run, the connections it opened and the requests
// it sent.
const exchange = async (args: readonly string[], env?: Record<string, string>) => {
  const requests = capture.requests().length;
  const connections = capture.connections();
  const cli = await run(["--base-url", A, ...args], env);

  return {
    cli,
    connections: capture.connections() - connections,
    requests: capture.requests().slice(requests),
  };
};

const refusedBeforeConnecting = async (args: readonly string[], env?: Record<string, string>) => {
  const observed = await exchange(args, env);

  return {
    connections: observed.connections,
    exitCode: observed.cli.exitCode,
    requests: observed.requests.length,
  };
};

const refused = { connections: 0, exitCode: 2, requests: 0 };

const leaked = (cli: CliRun) =>
  canaryForms.filter((form) => cli.stdout.includes(form) || cli.stderr.includes(form));

// A credential file; its bytes are exactly what the CLI reads (argv and the environment cannot
// carry NUL, and argv cannot carry a lone surrogate).
const credentialFile = (name: string, bytes: Uint8Array) => {
  const path = file(name);
  writeFileSync(path, bytes);

  return path;
};

const ascii = (text: string) => Buffer.from(text, "latin1");

// WTF-8 for U+D800: the bytes a lone surrogate would have if it had a UTF-8 form.
const loneSurrogateBytes = Buffer.from([0xed, 0xa0, 0x80]);

const hostileCredentials = {
  CR: ascii("ts9-a\rb"),
  LF: ascii("ts9-a\nb"),
  NUL: ascii("ts9-a\u0000b"),
  "lone surrogate": Buffer.concat([ascii("ts9-a"), loneSurrogateBytes, ascii("b")]),
} as const;

const hostileHeaderArguments = {
  CR: "ts9-a\rb",
  CRLF: "ts9-a\r\nX-Injected: 1",
  LF: "ts9-a\nb",
} as const;

describe("I2 header and cookie values are refused before any connection", () => {
  // The control: the same commands with clean values send one request, so each refusal below is
  // the value's, not the command line's.
  test("clean header, apiKey header and apiKey cookie values are sent", async () => {
    const header = credentialFile("header-clean", ascii("ts9-clean"));
    const cookie = credentialFile("cookie-clean", ascii("ts9-clean"));
    const runs = [
      await exchange(["values", "simple", "ok", "--x-trace", "ts9-clean"]),
      await exchange(["--header-key-file", header, "values", "simple", "ok"], {}),
      await exchange(["--cookie-key-file", cookie, "values", "simple", "ok"], {}),
    ];

    expect(runs.map((observed) => [observed.cli.exitCode, observed.requests.length])).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
  }, 60_000);

  for (const [label, value] of Object.entries(hostileHeaderArguments)) {
    test(`a header parameter value with ${label} exits 2 with zero connections`, async () => {
      expect(await refusedBeforeConnecting(["values", "simple", "ok", "--x-trace", value])).toEqual(
        refused,
      );
    }, 60_000);
  }

  // argv cannot carry a lone surrogate: it arrives as U+FFFD, which a header refuses as a code
  // point above U+00FF.
  test("a header parameter value with a lone surrogate exits 2 with zero connections", async () => {
    expect(
      await refusedBeforeConnecting(["values", "simple", "ok", "--x-trace", "ts9-a\uD800b"]),
    ).toEqual(refused);
  }, 60_000);

  for (const [label, bytes] of Object.entries(hostileCredentials)) {
    test(`an apiKey header credential with ${label} exits 2 with zero connections`, async () => {
      const path = credentialFile(`header-${label.replace(" ", "-")}`, bytes);

      expect(
        await refusedBeforeConnecting(["--header-key-file", path, "values", "simple", "ok"], {}),
      ).toEqual(refused);
    }, 60_000);

    test(`an apiKey cookie credential with ${label} exits 2 with zero connections`, async () => {
      const path = credentialFile(`cookie-${label.replace(" ", "-")}`, bytes);

      expect(
        await refusedBeforeConnecting(["--cookie-key-file", path, "values", "simple", "ok"], {}),
      ).toEqual(refused);
    }, 60_000);
  }

  // A cookie parameter with style form and explode false stays refused (STY-35 on 3.2), so it has
  // no flag and no value of it is ever sent.
  test("a refused cookie parameter (form, explode false) has no flag and is never sent", async () => {
    const generated = await refusedCookie.promise;
    const report = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          refusals: Schema.Array(
            Schema.Struct({ code: Schema.String, pointer: Schema.String, wire: Schema.String }),
          ),
        }),
      ),
    )(readFileSync(nodePath.join(generated.dir, "generation-report.json"), "utf-8"));
    const result = await Effect.runPromise(
      runBin(generated, {
        args: ["--base-url", A, "values", "cookie", "--flavor", "ts9-a\rb"],
        env: canaryEnv,
        timeoutMs: 30_000,
      }).pipe(Effect.provide(layer)),
    );

    expect({
      cookieRefusals: report.refusals.filter((refusal) => refusal.wire === "flavor"),
      exitCode: result.exitCode,
    }).toEqual({
      cookieRefusals: [
        {
          code: "STY-35/cookie-explode-false",
          pointer: "/paths/~1cookie/get/parameters/0",
          wire: "flavor",
        },
      ],
      exitCode: 2,
    });
  }, 600_000);

  // The credential cookie belongs to the security scheme, so no cookie parameter flag carries it.
  test("the apiKey cookie credential is not a flag of a generated cookie parameter", async () => {
    const help = await run(["values", "cookie", "--help"]);

    expect({
      credential: help.stdout.includes("--session"),
      flavor: help.stdout.includes("--flavor"),
    }).toEqual({
      credential: false,
      flavor: true,
    });
  }, 60_000);
});

// argv cannot carry a lone surrogate: Bun's spawn and the bin's argv decoding both turn it into
// U+FFFD before the CLI sees it (raw bytes ED A0 80 arrive as three U+FFFD), so the parameter
// percent-encoding paths cannot be handed one from outside. The inputs that carry a lone surrogate
// are a credential file (as WTF-8 bytes) and a JSON field flag (as a JSON escape).
describe("I2 a lone surrogate never reaches the wire", () => {
  test("in an apiKey query credential it exits 2 with zero connections", async () => {
    const path = credentialFile("query-lone-surrogate", hostileCredentials["lone surrogate"]);

    expect(
      await refusedBeforeConnecting(["--canary-query-file", path, "values", "simple", "ok"], {
        CANARY_CANARY_AUTH: canary.bearer,
      }),
    ).toEqual(refused);
  }, 60_000);

  // JSON is not a percent-encoding path: the escape is sent as the same escape, never as U+FFFD.
  test("in a JSON body field it is sent as its JSON escape", async () => {
    const observed = await exchange(["values", "note", "--meta", String.raw`{"k":"a\ud800b"}`]);

    expect({
      body: latin1(observed.requests[0]?.body ?? new Uint8Array()),
      exitCode: observed.cli.exitCode,
    }).toEqual({ body: String.raw`{"meta":{"k":"a\ud800b"}}`, exitCode: 0 });
  }, 60_000);
});

// The request carried both canaries, so the 401 and 500 bodies echo the bearer token.
const carried = (request: RecordedRequest | undefined) => {
  const target = request?.target ?? "";
  const authorization = request?.headers.find(([name]) => name.toLowerCase() === "authorization");

  return {
    bearer: authorization?.[1] === `Bearer ${canary.bearer}`,
    query: new URL(target, A).searchParams.get("api_key") === canary.query,
  };
};

describe("I4 the canary credential never reaches output", () => {
  test("a 2xx response leaves stdout and stderr without the canary", async () => {
    const observed = await exchange(["status", "get", "ok"]);

    expect({
      carried: carried(observed.requests[0]),
      exitCode: observed.cli.exitCode,
      leaked: leaked(observed.cli),
    }).toEqual({ carried: { bearer: true, query: true }, exitCode: 0, leaked: [] });
  }, 60_000);

  const echoes = [
    { exitCode: 3, path: "unauthorized", status: 401 },
    { exitCode: 1, path: "failed", status: 500 },
  ] as const;

  for (const echo of echoes) {
    test(`a ${echo.status} body that echoes the canary is scrubbed from the output`, async () => {
      capture.script(`/status/${echo.path}`, { status: echo.status });

      const observed = await exchange(["status", "get", echo.path]);

      expect({
        carried: carried(observed.requests[0]),
        exitCode: observed.cli.exitCode,
        leaked: leaked(observed.cli),
        placeholder: observed.cli.stderr.includes("<redacted:canaryAuth>"),
      }).toEqual({
        carried: { bearer: true, query: true },
        exitCode: echo.exitCode,
        leaked: [],
        placeholder: true,
      });
    }, 60_000);
  }

  test("help at every level leaves the canary out", async () => {
    const pages = await Promise.all(
      [["--help"], ["status", "--help"], ["status", "get", "--help"]].map((args) => run(args)),
    );

    expect(pages.map((page) => ({ exitCode: page.exitCode, leaked: leaked(page) }))).toEqual([
      { exitCode: 0, leaked: [] },
      { exitCode: 0, leaked: [] },
      { exitCode: 0, leaked: [] },
    ]);
  }, 60_000);

  test("a transport failure to a closed port exits 4 without the canary", async () => {
    const cli = await run(["--base-url", closedOrigin, "status", "get", "closed"]);
    const lines = cli.stderr.trim().split("\n");

    // The transport error line ends with the reason; the GET is idempotent, so the retry hint
    // follows on its own line (SM-16).
    expect({
      exitCode: cli.exitCode,
      hint: lines.includes(Output.retryHint),
      leaked: leaked(cli),
      reason: lines
        .find((line) => line.startsWith("Error: "))
        ?.split(" ")
        .at(-1),
    }).toEqual({ exitCode: 4, hint: true, leaked: [], reason: "connect" });
  }, 60_000);
});

const PackageBin = Schema.Struct({ bin: Schema.Record(Schema.String, Schema.String) });

const poll = (condition: () => boolean, deadline: number): Promise<boolean> =>
  condition() || Date.now() >= deadline
    ? Promise.resolve(condition())
    : Bun.sleep(10).then(() => poll(condition, deadline));

// Whether `condition` holds within `deadlineMs`, checked every 10 ms.
const until = (condition: () => boolean, deadlineMs: number) =>
  poll(condition, Date.now() + deadlineMs);

describe("SIGINT during an in-flight request", () => {
  // `runBin` exposes no child to signal, so this row spawns the bin itself, with the same argv
  // shape and an empty environment apart from the canary.
  test("closes the connection and exits 130", async () => {
    const generated = await ready.promise;
    const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageBin))(
      readFileSync(nodePath.join(generated.dir, "package.json"), "utf-8"),
    );
    const entry = Object.values(manifest.bin)[0] ?? "";
    capture.script("/status/stream", { endless: true, status: 200 });

    const before = capture.requests().length;
    const child = Bun.spawn(
      [
        process.execPath,
        nodePath.join(generated.dir, ...entry.split("/")),
        "--base-url",
        A,
        "status",
        "get",
        "stream",
      ],
      {
        cwd: generated.dir,
        env: { ...canaryEnv },
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      },
    );

    try {
      const sent = () =>
        capture
          .requests()
          .slice(before)
          .find((request) => request.target.startsWith("/status/stream"));
      const inFlight = await until(() => sent() !== undefined, 15_000);
      child.kill("SIGINT");

      const exited = await Promise.race([child.exited, Bun.sleep(15_000).then(() => "timeout")]);
      const connection = sent()?.connection;
      const closed = await until(
        () =>
          capture
            .events()
            .some((event) => event.kind === "close" && event.connection === connection),
        5000,
      );

      expect({ closed, exited, inFlight, signal: child.signalCode }).toEqual({
        closed: true,
        exited: 130,
        inFlight: true,
        signal: null,
      });
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 60_000);
});

describe("2^53+1 arrives as the same digits", () => {
  const digits = "9007199254740993";

  test("in a path parameter, a query parameter and an int64 body field", async () => {
    const observed = await exchange([
      "numbers",
      "send",
      digits,
      "--limit",
      digits,
      "--count",
      digits,
    ]);
    const [request] = observed.requests;
    const url = new URL(request?.target ?? "", A);

    expect({
      body: latin1(request?.body ?? new Uint8Array()),
      exitCode: observed.cli.exitCode,
      limit: url.searchParams.get("limit"),
      path: url.pathname,
    }).toEqual({
      body: `{"count":${digits}}`,
      exitCode: 0,
      limit: digits,
      path: `/numbers/${digits}`,
    });
  }, 60_000);

  test("in a --body sent verbatim", async () => {
    const body = `{"count":${digits}}`;
    const observed = await exchange(["numbers", "send", digits, "--body", body]);

    expect({
      body: latin1(observed.requests[0]?.body ?? new Uint8Array()),
      exitCode: observed.cli.exitCode,
    }).toEqual({ body, exitCode: 0 });
  }, 60_000);
});
