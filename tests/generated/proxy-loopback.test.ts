import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Scope } from "effect";
import {
  startCaptureServer,
  startTlsCaptureServer,
  tlsOriginAddresses,
} from "../fixtures/capture-server.ts";
import type { HeaderList, TlsCaptureServer } from "../fixtures/capture-server.ts";
import { startRecordingProxy } from "../fixtures/recording-proxy.ts";
import type { ProxyRecord, RecordingProxy } from "../fixtures/recording-proxy.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// A configured proxy never receives a loopback request (operator ruling 71514c79; design 6.5
// Proxy environment and Loopback hosts, 9 I3, D-SEC8; M3-PX5). Through a generated CLI, with every
// proxy variable set to one recording proxy, a hop to a loopback host goes direct, on a single
// request or as a redirect hop, and every other hop goes through the proxy.
//
// Origins: A is the capture server's 127.0.0.1 listener and B its localhost listener; C is the TLS
// capture server's origin A. N (http) and P (https) name A and C under the TEST-NET-1 address
// 192.0.2.10, which no host answers: the proxy's target map sends N to A and P to C, so a hop to
// N or P can only arrive through the proxy. The author config binds A, N, C and P, so the canary
// credentials go to each of them and to no other origin. A listener tells a direct hop from a
// proxied one by its Host header. 127.0.0.2 and other 127.x addresses are not run here: macOS
// answers only 127.0.0.1 (design 6.5 Cost), and RT-4's unit table covers them.

const specPath = nodePath.resolve(import.meta.dir, "../fixtures/specs/proxy-loopback.json");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "px5-loopback-"));

const configPath = nodePath.join(work, "author-config.json");

const canary = { bearer: "px5-canary-bearer-7f3c", key: "px5-canary-key-91d2" } as const;

const capture = startCaptureServer();

const testNet = tlsOriginAddresses.A;

const portOf = (origin: string) => new URL(origin).port;

const scope = Effect.runSync(Scope.make());

interface Fixture {
  readonly generated: GeneratedPackage;
  readonly origins: Readonly<Record<OriginKey, string>>;
  readonly proxy: RecordingProxy;
  readonly tls: TlsCaptureServer;
}

// Every origin a hop names. `loopback` is the witness's own truth table, not the product's
// predicate: A, B, B written `LOCALHOST.`, A written as an IPv4-mapped address, and C.
type OriginKey = "A" | "Amapped" | "B" | "Bdot" | "C" | "N" | "P";

const loopback: Readonly<Record<OriginKey, boolean>> = {
  A: true,
  Amapped: true,
  B: true,
  Bdot: true,
  C: true,
  N: false,
  P: false,
};

const originKeys: readonly OriginKey[] = ["A", "Amapped", "B", "Bdot", "C", "N", "P"];

const ready = Promise.withResolvers<Fixture>();

beforeAll(async () => {
  const prepare = Effect.gen(function* prepareGen() {
    const tls = yield* startTlsCaptureServer();
    const a = capture.origins["127.0.0.1"];
    const aPort = portOf(a);
    const bPort = portOf(capture.origins.localhost);
    const cPort = portOf(tls.origins.A);
    const origins: Record<OriginKey, string> = {
      A: a,
      Amapped: `http://[::ffff:127.0.0.1]:${aPort}`,
      B: capture.origins.localhost,
      Bdot: `http://LOCALHOST.:${bPort}`,
      C: tls.origins.A,
      N: `http://${testNet}:${aPort}`,
      P: `https://${testNet}:${cPort}`,
    };
    const proxy = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startRecordingProxy({
          label: "px5",
          targets: {
            [`${testNet}:${aPort}`]: { hostname: "127.0.0.1", port: Number(aPort) },
            [`${testNet}:${cPort}`]: { hostname: "127.0.0.1", port: Number(cPort) },
          },
        }),
      ),
      (started) => Effect.sync(started.stop),
    );
    writeFileSync(
      configPath,
      `${JSON.stringify({
        acceptedOrigins: [origins.A, origins.N, origins.C, origins.P],
        allowInsecure: true,
        binName: "pxl",
        envPrefix: "PXL",
        package: { name: "proxy-loopback-cli", version: "0.1.0" },
      })}\n`,
    );

    const generated = yield* generateFixture({ configPath, specPath });
    yield* preparePackage(generated);

    return { generated, origins, proxy, tls };
  }).pipe(Scope.provide(scope), Effect.provide(layer));
  ready.resolve(await Effect.runPromise(prepare));
}, 600_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(work, { force: true, recursive: true });
});

const json = { body: "{}", headers: [["Content-Type", "application/json"]] as const, status: 200 };

const header = (headers: HeaderList, name: string) =>
  headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1];

// The two environment rows. The environment is built from scratch, so no proxy variable of the
// runner reaches the child; `192.0.2.99` names no fixture host, so the NO_PROXY list names no
// loopback host.
const proxyNames = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

interface Environment {
  readonly extra: Readonly<Record<string, string>>;
  readonly name: string;
  readonly tag: string;
}

const environments: readonly Environment[] = [
  { extra: {}, name: "all six proxy variables", tag: "pv" },
  {
    extra: { NO_PROXY: "192.0.2.99", no_proxy: "192.0.2.99" },
    name: "all six proxy variables with NO_PROXY and no_proxy naming 192.0.2.99",
    tag: "np",
  },
];

const environmentFor = (proxyUrl: string, environment: Environment, caPath: string) => ({
  ...Object.fromEntries(proxyNames.map((name) => [name, proxyUrl])),
  ...environment.extra,
  NODE_EXTRA_CA_CERTS: caPath,
  PXL_BEARER: canary.bearer,
  PXL_KEY: canary.key,
});

interface Hop {
  readonly origin: OriginKey;
  readonly path: string;
}

// A run: the origin it starts at and its hops in order. Each hop but the last is a redirect
// scripted on its path to the next hop's origin.
interface Case {
  readonly hops: readonly Hop[];
  readonly name: string;
  readonly status?: 302 | 307;
}

const cases = (tag: string): readonly Case[] => [
  { hops: [{ origin: "A", path: `/hops/${tag}-a` }], name: "http: to 127.0.0.1" },
  { hops: [{ origin: "B", path: `/hops/${tag}-b` }], name: "http: to localhost" },
  { hops: [{ origin: "Bdot", path: `/hops/${tag}-bdot` }], name: "http: to LOCALHOST." },
  {
    hops: [{ origin: "Amapped", path: `/hops/${tag}-mapped` }],
    name: "http: to [::ffff:127.0.0.1]",
  },
  { hops: [{ origin: "C", path: `/hops/${tag}-c` }], name: "https: to 127.0.0.1" },
  {
    hops: [
      { origin: "N", path: `/hops/${tag}-n1` },
      { origin: "A", path: `/hops/${tag}-n1-a` },
    ],
    name: "N 302 to A, a redirect into loopback",
    status: 302,
  },
  {
    hops: [
      { origin: "A", path: `/hops/${tag}-a2` },
      { origin: "N", path: `/hops/${tag}-a2-n` },
      { origin: "B", path: `/hops/${tag}-a2-n-b` },
    ],
    name: "A 302 to N 302 to localhost, out of loopback and back",
    status: 302,
  },
  {
    hops: [
      { origin: "P", path: `/hops/${tag}-p3` },
      { origin: "C", path: `/hops/${tag}-p3-c` },
    ],
    name: "P 307 to C, https: into loopback",
    status: 307,
  },
];

// A request as a listener recorded it: which server, the Host it was sent to, and its path.
interface Arrival {
  readonly authorization: string | undefined;
  readonly host: string | undefined;
  readonly key: string | undefined;
  readonly path: string;
  readonly tls: boolean;
}

const carriesCanary = (record: ProxyRecord) =>
  record.headerLines.some((line) => line.includes(canary.bearer) || line.includes(canary.key));

const run = async (environment: Environment, current: Case) => {
  const { generated, origins, proxy, tls } = await ready.promise;
  const [first] = current.hops;
  if (first === undefined) {
    return expect.unreachable("a case has at least one hop");
  }

  for (const [index, hop] of current.hops.entries()) {
    const next = current.hops[index + 1];
    const server = hop.origin === "C" || hop.origin === "P" ? tls : capture;
    server.script(
      hop.path,
      next === undefined
        ? json
        : { location: `${origins[next.origin]}${next.path}`, status: current.status ?? 302 },
    );
  }

  proxy.reset();

  const plainBefore = capture.requests().length;
  const tlsBefore = tls.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, {
      args: [
        "--base-url",
        origins[first.origin],
        "--timeout",
        "5",
        "hops",
        "get",
        first.path.slice("/hops/".length),
      ],
      env: environmentFor(proxy.urlWithUserinfo("px5-user", "px5-pass"), environment, tls.caPath),
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );
  const ours = new Set(current.hops.map((hop) => hop.path));
  const arrivals: Arrival[] = [
    ...capture
      .requests()
      .slice(plainBefore)
      .map((request) => ({ headers: request.headers, path: request.target, tls: false })),
    ...tls
      .requests()
      .slice(tlsBefore)
      .map((request) => ({ headers: request.headers, path: request.target, tls: true })),
  ]
    .filter((request) => ours.has(request.path))
    .map((request) => ({
      authorization: header(request.headers, "authorization"),
      host: header(request.headers, "host"),
      key: header(request.headers, "x-api-key"),
      path: request.path,
      tls: request.tls,
    }));

  return { arrivals, origins, records: proxy.records(), result };
};

const hostOf = (origin: string) => new URL(origin).host;

for (const environment of environments) {
  describe(`a configured proxy never receives a loopback request: ${environment.name}`, () => {
    for (const current of cases(environment.tag)) {
      test(`a configured proxy never receives a loopback request: ${environment.name}, ${current.name}`, async () => {
        const { arrivals, origins, records, result } = await run(environment, current);
        const mapped = current.hops.some((hop) => hop.origin === "Amapped");
        const proxied = current.hops.filter((hop) => !loopback[hop.origin]);
        const direct = current.hops.filter(
          (hop) => loopback[hop.origin] && hop.origin !== "Amapped",
        );
        // Every loopback authority the run could name to the proxy, in either case; each origin
        // names its port, so `host` is the authority a proxy record holds.
        const loopbackAuthorities = new Set(
          originKeys.flatMap((key) =>
            loopback[key] ? [hostOf(origins[key]), hostOf(origins[key]).toUpperCase()] : [],
          ),
        );
        const canaryHops = current.hops.filter((hop) => hop.origin === "A");

        expect({
          // The canary credentials reach A over plain http:, directly.
          canaryAtA: arrivals
            .filter((arrival) => canaryHops.some((hop) => hop.path === arrival.path))
            .map((arrival) => [arrival.host, arrival.authorization, arrival.key]),
          // No CONNECT head and no record of a loopback hop carries them; the only proxy records
          // that do are plain-http hops to the bound non-loopback N, the exposure design 6.5
          // states for a plain-http origin.
          canaryInProxy: records
            .filter(carriesCanary)
            .map((record) => `${record.kind} ${record.target}`),
          // Each loopback hop reached its origin under its own Host, so not through the proxy.
          direct: arrivals
            .filter((arrival) => direct.some((hop) => hop.path === arrival.path))
            .map((arrival) => `${arrival.host} ${arrival.path}`),
          // A run's exit status, except where the platform decides whether A answers the
          // IPv4-mapped address (the receipt records it).
          exitCode: mapped ? 0 : result.exitCode,
          loopbackTargets: records.filter((record) => loopbackAuthorities.has(record.target)),
          // Each non-loopback hop reached its origin under its own Host, through the proxy.
          proxiedArrivals: arrivals
            .filter((arrival) => proxied.some((hop) => hop.path === arrival.path))
            .map((arrival) => `${arrival.host} ${arrival.path}`),
          // One proxy connection per non-loopback hop, each naming that hop's authority.
          proxyConnections: records.map((record) => `${record.kind} ${record.target}`),
        }).toEqual({
          canaryAtA: canaryHops.map(() => [
            hostOf(origins.A),
            `Bearer ${canary.bearer}`,
            canary.key,
          ]),
          canaryInProxy: proxied
            .filter((hop) => hop.origin === "N")
            .map((hop) => `forward ${hostOf(origins[hop.origin])}`),
          direct: direct.map((hop) => `${hostOf(origins[hop.origin])} ${hop.path}`),
          exitCode: 0,
          loopbackTargets: [],
          proxiedArrivals: proxied.map((hop) => `${hostOf(origins[hop.origin])} ${hop.path}`),
          proxyConnections: proxied.map(
            (hop) => `${hop.origin === "P" ? "connect" : "forward"} ${hostOf(origins[hop.origin])}`,
          ),
        });
      }, 60_000);
    }
  });
}
