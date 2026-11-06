import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Scope } from "effect";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { HeaderList } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { BinRun, GeneratedPackage } from "../support/generated-cli.ts";

// Design 9 I3 through a generated CLI: credentials reach only bound origins, on every hop of the
// runtime redirect loop, and the refused hops never connect. The matrix is spike S2's (301, 302,
// 303, 307 and 308 × same-origin, cross-origin and https→http × GET and POST with a body), with
// all four credential kinds configured on every run. A is the bound plain origin, B the unbound
// one, C a bound https origin whose certificate comes from a private CA made here with openssl and
// trusted only through NODE_EXTRA_CA_CERTS (the S2 fixture).

const specPath = nodePath.resolve(import.meta.dir, "../fixtures/specs/two-origin.json");

const secrets = {
  bearer: "ts8-bearer-secret",
  cookie: "ts8-cookie-secret",
  header: "ts8-header-secret",
  query: "ts8-query-secret",
} as const;

type Kind = keyof typeof secrets;

const kinds: readonly Kind[] = ["bearer", "cookie", "header", "query"];

const credentialEnv = {
  TWO_BEARER_AUTH: secrets.bearer,
  TWO_COOKIE_KEY: secrets.cookie,
  TWO_HEADER_KEY: secrets.header,
  TWO_QUERY_KEY: secrets.query,
};

const note = "ts8-body";

const postBody = `{"note":"${note}"}`;

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "ts8-redirects-"));

const file = (name: string) => nodePath.join(work, name);

const openssl = Bun.which("openssl");

// A private CA and a leaf for 127.0.0.1, made offline. Null when openssl is absent or fails.
const makeCertificates = (): { readonly cert: string; readonly key: string } | null => {
  if (openssl === null) {
    return null;
  }

  writeFileSync(
    file("leaf.ext"),
    "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n",
  );

  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  const steps = [
    [
      "req",
      "-x509",
      ...ec,
      "-keyout",
      file("ca.key"),
      "-out",
      file("ca.pem"),
      "-days",
      "2",
      "-subj",
      "/CN=ts8 test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign",
    ],
    ["req", ...ec, "-keyout", file("leaf.key"), "-out", file("leaf.csr"), "-subj", "/CN=127.0.0.1"],
    [
      "x509",
      "-req",
      "-in",
      file("leaf.csr"),
      "-CA",
      file("ca.pem"),
      "-CAkey",
      file("ca.key"),
      "-set_serial",
      "1",
      "-days",
      "2",
      "-extfile",
      file("leaf.ext"),
      "-out",
      file("leaf.pem"),
    ],
  ];
  const failed = steps.some(
    (args) => Bun.spawnSync([openssl, ...args], { stderr: "pipe", stdout: "pipe" }).exitCode !== 0,
  );

  return failed ? null : { cert: file("leaf.pem"), key: file("leaf.key") };
};

const certificates = makeCertificates();

interface TlsRequest {
  readonly body: string;
  readonly headers: HeaderList;
  readonly method: string;
  readonly target: string;
}

interface TlsScript {
  readonly location: string;
  readonly status: number;
}

// C: Bun.serve over TLS. It only has to show whether hop 1 carried the credentials, so parsed
// headers are enough here; the plain origins use the byte-recording capture server.
const startTlsOrigin = (tls: { readonly cert: string; readonly key: string }) => {
  const requests: TlsRequest[] = [];
  const scripts = new Map<string, TlsScript>();
  const server = Bun.serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      requests.push({
        body: Buffer.from(await request.arrayBuffer()).toString("latin1"),
        headers: [...request.headers.entries()],
        method: request.method,
        target: `${url.pathname}${url.search}`,
      });

      const scripted = scripts.get(url.pathname);

      return scripted === undefined
        ? Response.json({})
        : new Response(null, { headers: { location: scripted.location }, status: scripted.status });
    },
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(tls.cert), key: Bun.file(tls.key) },
  });

  return {
    origin: `https://127.0.0.1:${server.port}`,
    requests: () => requests,
    script: (path: string, script: TlsScript) => {
      scripts.set(path, script);
    },
    stop: () => server.stop(true),
  };
};

const capture = startCaptureServer();

const tlsOrigin = certificates === null ? null : startTlsOrigin(certificates);

const A = capture.origins["127.0.0.1"];

const B = capture.origins.localhost;

const portOf = (origin: string) => new URL(origin).port;

// The author config binds A and, when TLS is available, C. It is written per run because the
// ports are only known once the servers listen.
const configPath = file("author-config.json");

writeFileSync(
  configPath,
  `${JSON.stringify({
    acceptedOrigins: tlsOrigin === null ? [A] : [A, tlsOrigin.origin],
    allowInsecure: true,
    binName: "two",
    envPrefix: "TWO",
    package: { name: "two-origin-cli", version: "0.1.0" },
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

afterAll(async () => {
  capture.stop();
  await tlsOrigin?.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(work, { force: true, recursive: true });
});

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

interface CliRun {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
}

const run = async (args: readonly string[], env: Record<string, string> = credentialEnv) => {
  const generated = await ready.promise;
  const extra: Record<string, string> =
    certificates === null ? {} : { NODE_EXTRA_CA_CERTS: file("ca.pem") };
  const result: BinRun = await Effect.runPromise(
    runBin(generated, { args, env: { ...env, ...extra }, timeoutMs: 30_000 }).pipe(
      Effect.provide(layer),
    ),
  );
  const cli: CliRun = {
    exitCode: result.exitCode,
    stderr: latin1(result.stderr),
    timedOut: result.timedOut,
  };

  return cli;
};

type OriginLabel = "A" | "B" | "C";

interface Hop {
  readonly body: string;
  readonly credentials: readonly Kind[];
  readonly method: string;
  readonly origin: OriginLabel;
  readonly path: string;
}

// Which credential kinds a recorded request carries: its secret anywhere in the target, any header
// value or the body counts, as in spike S2.
const carried = (request: TlsRequest): readonly Kind[] => {
  const text = [request.target, request.body, ...request.headers.map(([, value]) => value)].join(
    "\n",
  );

  return kinds.filter((kind) => text.includes(secrets[kind]));
};

const hopOf = (origin: OriginLabel, request: TlsRequest): Hop => ({
  body: request.body,
  credentials: carried(request),
  method: request.method,
  origin,
  path: request.target.split("?")[0] ?? "",
});

const plainRequests = (origin: OriginLabel, from: number): readonly Hop[] =>
  capture
    .requests()
    .slice(from)
    .filter((request) =>
      origin === "A" ? request.origin === "127.0.0.1" : request.origin === "localhost",
    )
    .map((request) =>
      hopOf(origin, {
        body: latin1(request.body),
        headers: request.headers,
        method: request.method,
        target: request.target,
      }),
    );

const tlsRequests = (from: number): readonly Hop[] =>
  (tlsOrigin?.requests() ?? []).slice(from).map((request) => hopOf("C", request));

// The reason token is the last word of the RedirectRefused line (design 7.4 renders the error's
// fields; the reason is one of its literal values).
const refusal = (cli: CliRun) =>
  cli.exitCode === 4 ? cli.stderr.trim().split(" ").at(-1) : undefined;

type Pair = "cross" | "down" | "same";

type Method = "GET" | "POST";

const statuses = [301, 302, 303, 307, 308] as const;

const pairs: readonly Pair[] = ["same", "cross", "down"];

const methods: readonly Method[] = ["GET", "POST"];

interface Outcome {
  readonly exitCode: number | null;
  readonly hops: readonly Hop[];
  readonly reason: string | undefined;
  // New connections to the redirect target's listener; null when the target is the start origin.
  readonly targetConnections: "none" | "some" | null;
}

const all: readonly Kind[] = kinds;

const none: readonly Kind[] = [];

// The S2 expectation, written from design 6.5 before the run.
const expected = (status: number, pair: Pair, method: Method, id: string): Outcome => {
  const start: OriginLabel = pair === "down" ? "C" : "A";
  const hop1: Hop = {
    body: method === "POST" ? postBody : "",
    credentials: all,
    method,
    origin: start,
    path: `/hop/${id}`,
  };
  const becomesGet = method === "POST" && status !== 307 && status !== 308;
  const keepsBody = method === "POST" && !becomesGet;

  if (pair === "down") {
    return { exitCode: 4, hops: [hop1], reason: "downgrade", targetConnections: "none" };
  }

  if (pair === "cross" && keepsBody) {
    return { exitCode: 4, hops: [hop1], reason: "crossOriginBody", targetConnections: "none" };
  }

  const hop2: Hop = {
    body: keepsBody ? postBody : "",
    credentials: pair === "same" ? all : none,
    method: becomesGet ? "GET" : method,
    origin: pair === "same" ? "A" : "B",
    path: `/landed/${id}`,
  };

  return pair === "same"
    ? { exitCode: 0, hops: [hop1, hop2], reason: undefined, targetConnections: null }
    : { exitCode: 0, hops: [hop1, hop2], reason: undefined, targetConnections: "some" };
};

const landing = { body: "{}", headers: [["Content-Type", "application/json"]] as const };

const command = (method: Method, id: string) =>
  method === "GET" ? ["hops", "get", id] : ["hops", "send", id, "--note", note];

const reached = (before: number, after: number) => (after > before ? "some" : "none");

const observe = async (status: number, pair: Pair, method: Method, id: string) => {
  const target = pair === "cross" ? B : A;
  const location = pair === "same" ? `/landed/${id}` : `${target}/landed/${id}`;
  capture.script(`/landed/${id}`, { status: 200, ...landing });
  if (pair === "down") {
    tlsOrigin?.script(`/hop/${id}`, { location, status });
  } else {
    capture.script(`/hop/${id}`, { location, status });
  }

  const base = pair === "down" ? (tlsOrigin?.origin ?? "") : A;
  const before = { plain: capture.requests().length, tls: tlsOrigin?.requests().length ?? 0 };
  const listener = pair === "cross" ? "localhost" : "127.0.0.1";
  const opened = () =>
    capture.events().filter((event) => event.kind === "open" && event.origin === listener).length;
  const connectionsBefore = opened();
  const cli = await run(["--base-url", base, ...command(method, id)]);
  const connectionsAfter = opened();
  const startHops = pair === "down" ? tlsRequests(before.tls) : plainRequests("A", before.plain);
  const targetHops =
    pair === "same" ? [] : plainRequests(pair === "cross" ? "B" : "A", before.plain);
  const hops = [...startHops, ...targetHops].filter((hop) => hop.path.endsWith(`/${id}`));
  const outcome: Outcome = {
    exitCode: cli.exitCode,
    hops,
    reason: refusal(cli),
    targetConnections: pair === "same" ? null : reached(connectionsBefore, connectionsAfter),
  };

  return outcome;
};

describe("I3 host pinning: the S2 redirect matrix through the generated CLI", () => {
  for (const pair of pairs) {
    for (const status of statuses) {
      for (const method of methods) {
        const id = `${status}-${pair}-${method.toLowerCase()}`;
        const row = test.skipIf(pair === "down" && tlsOrigin === null);

        row(
          `${status} ${pair} ${method}`,
          async () => {
            expect(await observe(status, pair, method, id)).toEqual(
              expected(status, pair, method, id),
            );
          },
          60_000,
        );
      }
    }
  }
});

// Requests one invocation made to the plain origins, by origin label.
const exchange = async (args: readonly string[], env?: Record<string, string>) => {
  const before = capture.requests().length;
  const connections = capture.connections();
  const cli = await run(args, env);

  return {
    cli,
    connections: capture.connections() - connections,
    hops: [...plainRequests("A", before), ...plainRequests("B", before)],
  };
};

describe("I3 host pinning: base URL and server selection", () => {
  test("--base-url to the unbound origin sends no credentials", async () => {
    const observed = await exchange(["--base-url", B, "hops", "get", "base-unbound"]);

    expect({ exitCode: observed.cli.exitCode, hops: observed.hops }).toEqual({
      exitCode: 0,
      hops: [
        { body: "", credentials: none, method: "GET", origin: "B", path: "/hop/base-unbound" },
      ],
    });
    expect(kinds.filter((kind) => observed.cli.stderr.includes(secrets[kind]))).toEqual([]);
  }, 60_000);

  test("--allow-credentials-for-base-url extends the credentials to the unbound base", async () => {
    const observed = await exchange([
      "--base-url",
      B,
      "--allow-credentials-for-base-url",
      "hops",
      "get",
      "base-allowed",
    ]);

    expect({ exitCode: observed.cli.exitCode, hops: observed.hops }).toEqual({
      exitCode: 0,
      hops: [{ body: "", credentials: all, method: "GET", origin: "B", path: "/hop/base-allowed" }],
    });
  }, 60_000);

  test("a --server-variable expansion to the bound origin carries the credentials", async () => {
    const observed = await exchange([
      "--server",
      "0",
      "--server-variable",
      `port=${portOf(A)}`,
      "hops",
      "get",
      "server-bound",
    ]);

    expect({ exitCode: observed.cli.exitCode, hops: observed.hops }).toEqual({
      exitCode: 0,
      hops: [{ body: "", credentials: all, method: "GET", origin: "A", path: "/hop/server-bound" }],
    });
  }, 60_000);

  // The expansion names 127.0.0.1 at B's port, a listening but unbound origin.
  test("a --server-variable expansion to an unbound origin exits 2 with zero connections", async () => {
    const observed = await exchange([
      "--server",
      "0",
      "--server-variable",
      `port=${portOf(B)}`,
      "hops",
      "get",
      "server-unbound",
    ]);

    expect({
      connections: observed.connections,
      exitCode: observed.cli.exitCode,
      hops: observed.hops,
    }).toEqual({ connections: 0, exitCode: 2, hops: [] });
  }, 60_000);

  test("a --base-url with userinfo exits 2, connects nowhere and stderr omits the value", async () => {
    const userinfo = "ts8-user:ts8-pass";
    const observed = await exchange([
      "--base-url",
      `http://${userinfo}@127.0.0.1:${portOf(A)}`,
      "hops",
      "get",
      "base-userinfo",
    ]);

    expect({
      connections: observed.connections,
      exitCode: observed.cli.exitCode,
      hops: observed.hops,
      leaked: ["ts8-user", "ts8-pass"].filter((part) => observed.cli.stderr.includes(part)),
    }).toEqual({ connections: 0, exitCode: 2, hops: [], leaked: [] });
  }, 60_000);
});

describe("I3 host pinning: the other RedirectRefused reasons", () => {
  test("a Location with userinfo is refused before it is sent", async () => {
    capture.script("/hop/loc-userinfo", {
      location: `http://ts8-user:ts8-pass@127.0.0.1:${portOf(A)}/landed/loc-userinfo`,
      status: 307,
    });

    const observed = await exchange(["--base-url", A, "hops", "get", "loc-userinfo"]);

    expect({
      exitCode: observed.cli.exitCode,
      paths: observed.hops.map((hop) => hop.path),
      reason: refusal(observed.cli),
    }).toEqual({ exitCode: 4, paths: ["/hop/loc-userinfo"], reason: "userinfo" });
  }, 60_000);

  test("a non-http(s) Location is refused before it is read", async () => {
    capture.script("/hop/loc-scheme", { location: `file://${configPath}`, status: 302 });

    const observed = await exchange(["--base-url", A, "hops", "get", "loc-scheme"]);

    expect({
      exitCode: observed.cli.exitCode,
      paths: observed.hops.map((hop) => hop.path),
      reason: refusal(observed.cli),
    }).toEqual({ exitCode: 4, paths: ["/hop/loc-scheme"], reason: "scheme" });
  }, 60_000);

  test("a redirect loop is refused after ten followed hops", async () => {
    capture.script("/hop/loop", { location: "/hop/loop", status: 302 });

    const observed = await exchange(["--base-url", A, "hops", "get", "loop"]);

    expect({
      credentials: [...new Set(observed.hops.map((hop) => hop.credentials.join(",")))],
      exitCode: observed.cli.exitCode,
      reason: refusal(observed.cli),
      requests: observed.hops.length,
    }).toEqual({ credentials: [all.join(",")], exitCode: 4, reason: "hopLimit", requests: 11 });
  }, 60_000);
});
