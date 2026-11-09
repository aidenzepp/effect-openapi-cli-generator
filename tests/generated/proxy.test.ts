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
import type {
  CaptureServer,
  RecordedRequest,
  TlsCaptureServer,
} from "../fixtures/capture-server.ts";
import { startRecordingProxy } from "../fixtures/recording-proxy.ts";
import type { ProxyRecord, RecordingProxy } from "../fixtures/recording-proxy.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// Proxy routing through a generated CLI (design 6.5 Proxy environment, Origin binding and Trace
// headers; 9 I3; D-SEC6; D-SEC8). The hops use TEST-NET-1 literals, never loopback, so every hop
// reaches a proxy (a loopback hop goes direct; that is the loopback witness's). N and M are the
// plain capture server's two listeners, P and Q the TLS capture server's origins A and B, each
// reached through recording proxies P1 and P2 that map the literal to the local listener. The
// author config binds N and P. Per hop the test checks the proxy and kind the routing rule selects,
// the proxy userinfo at the proxy and never at the origin, the four managed credentials at a bound
// origin and nowhere on an unbound hop, and no `b3` or `traceparent` header anywhere: only the
// emitted `bin.ts` turns trace propagation off, so only a generated CLI can show it.

const specPath = nodePath.resolve(import.meta.dir, "../fixtures/specs/proxy.json");

const canaries = {
  bearer: "px3-bearer-canary",
  cookie: "px3-cookie-canary",
  header: "px3-header-canary",
  query: "px3-query-canary",
} as const;

type Kind = keyof typeof canaries;

const kinds: readonly Kind[] = ["bearer", "cookie", "header", "query"];

const credentialEnv = {
  PXW_BEARER_AUTH: canaries.bearer,
  PXW_COOKIE_KEY: canaries.cookie,
  PXW_HEADER_KEY: canaries.header,
  PXW_QUERY_KEY: canaries.query,
};

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "px3-proxy-"));

const configPath = nodePath.join(work, "author-config.json");

const scope = Effect.runSync(Scope.make());

type Host = "M" | "N" | "P" | "Q";

interface Fixture {
  readonly generated: GeneratedPackage;
  readonly origins: Readonly<Record<Host, string>>;
  readonly plain: CaptureServer;
  readonly proxies: { readonly P1: RecordingProxy; readonly P2: RecordingProxy };
  readonly tls: TlsCaptureServer;
}

const ready = Promise.withResolvers<Fixture>();

const portOf = (origin: string) => Number(new URL(origin).port);

const authorityOf = (origin: string) => new URL(origin).host;

const proxyFor = (label: string, targets: Parameters<typeof startRecordingProxy>[0]["targets"]) =>
  Effect.acquireRelease(
    Effect.promise(() => startRecordingProxy({ label, targets })),
    (proxy) => Effect.sync(proxy.stop),
  );

beforeAll(async () => {
  const prepare = Effect.gen(function* prepareGen() {
    const tls = yield* startTlsCaptureServer();
    const plain = yield* Effect.acquireRelease(
      Effect.sync(() => startCaptureServer()),
      (server) => Effect.sync(server.stop),
    );
    const listeners = {
      M: portOf(plain.origins.localhost),
      N: portOf(plain.origins["127.0.0.1"]),
      P: portOf(tls.origins.A),
      Q: portOf(tls.origins.B),
    };
    const origins = {
      M: `http://${tlsOriginAddresses.B}:${listeners.M}`,
      N: `http://${tlsOriginAddresses.A}:${listeners.N}`,
      P: `https://${tlsOriginAddresses.A}:${listeners.P}`,
      Q: `https://${tlsOriginAddresses.B}:${listeners.Q}`,
    };
    const hosts: readonly Host[] = ["M", "N", "P", "Q"];
    const targets = Object.fromEntries(
      hosts.map((host) => [
        authorityOf(origins[host]),
        { hostname: "127.0.0.1", port: listeners[host] },
      ]),
    );
    const proxies = { P1: yield* proxyFor("P1", targets), P2: yield* proxyFor("P2", targets) };

    writeFileSync(
      configPath,
      `${JSON.stringify({
        acceptedOrigins: [origins.N, origins.P],
        allowInsecure: true,
        binName: "pxw",
        envPrefix: "PXW",
        package: { name: "proxy-witness-cli", version: "0.1.0" },
      })}\n`,
    );

    const generated = yield* generateFixture({ configPath, specPath });
    yield* preparePackage(generated);

    return { generated, origins, plain, proxies, tls };
  }).pipe(Scope.provide(scope), Effect.provide(layer));
  ready.resolve(await Effect.runPromise(prepare));
}, 600_000);

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(work, { force: true, recursive: true });
});

const json = { body: "{}", headers: [["Content-Type", "application/json"]] as const, status: 200 };

const userinfo = { P1: ["u1", "p1"], P2: ["u2", "p2"] } as const;

type ProxyLabel = keyof typeof userinfo;

// The rows' proxy variables, each URL carrying its proxy's userinfo.
const rows = {
  allProxy: (proxies: Fixture["proxies"]) => ({
    ALL_PROXY: proxies.P1.urlWithUserinfo(...userinfo.P1),
  }),
  casePair: (proxies: Fixture["proxies"]) => ({
    HTTPS_PROXY: proxies.P1.urlWithUserinfo(...userinfo.P1),
    HTTP_PROXY: proxies.P1.urlWithUserinfo(...userinfo.P1),
    http_proxy: proxies.P2.urlWithUserinfo(...userinfo.P2),
    https_proxy: proxies.P2.urlWithUserinfo(...userinfo.P2),
  }),
  upper: (proxies: Fixture["proxies"]) => ({
    HTTPS_PROXY: proxies.P1.urlWithUserinfo(...userinfo.P1),
    HTTP_PROXY: proxies.P1.urlWithUserinfo(...userinfo.P1),
  }),
} as const;

type Row = keyof typeof rows;

// The proxy design 6.5 selects for a hop of each scheme under each row: the scheme's pair, the
// lowercase name winning, else ALL_PROXY for both schemes.
const selected: Readonly<Record<Row, Readonly<Record<"http" | "https", ProxyLabel>>>> = {
  allProxy: { http: "P1", https: "P1" },
  casePair: { http: "P2", https: "P2" },
  upper: { http: "P1", https: "P1" },
};

interface Hop {
  readonly host: Host;
  readonly path: string;
}

// The chains, as the hops each sends: N 302 to M; N 302 to M 302 to N; P 307 to Q.
const chains = {
  nm: (id: string): readonly Hop[] => [
    { host: "N", path: `/pets/${id}` },
    { host: "M", path: `/pets/${id}-m` },
  ],
  nmn: (id: string): readonly Hop[] => [
    { host: "N", path: `/pets/${id}` },
    { host: "M", path: `/pets/${id}-m` },
    { host: "N", path: `/pets/${id}-n` },
  ],
  pq: (id: string): readonly Hop[] => [
    { host: "P", path: `/pets/${id}` },
    { host: "Q", path: `/pets/${id}-q` },
  ],
} as const;

type Chain = keyof typeof chains;

const bound: Readonly<Record<Host, boolean>> = { M: false, N: true, P: true, Q: false };

const secure = (host: Host) => host === "P" || host === "Q";

const originNames = { M: "localhost", N: "127.0.0.1", P: "A", Q: "B" } as const;

// Scripts each hop but the last as a redirect to the next hop, and the last as a 200.
const script = (fixture: Fixture, hops: readonly Hop[]) => {
  for (const [index, hop] of hops.entries()) {
    const server = secure(hop.host) ? fixture.tls : fixture.plain;
    const next = hops[index + 1];
    server.script(
      hop.path,
      next === undefined
        ? json
        : {
            location: `${fixture.origins[next.host]}${next.path}`,
            status: secure(hop.host) ? 307 : 302,
          },
    );
  }
};

const valuesOf = (lines: readonly (readonly [string, string])[], name: string) =>
  lines.filter(([candidate]) => candidate.toLowerCase() === name).map(([, value]) => value);

const splitLine = (line: string) => {
  const colon = line.indexOf(":");

  return [line.slice(0, colon), line.slice(colon + 1).trim()] as const;
};

const traceNames = new Set(["b3", "traceparent"]);

const traceHeaders = (headers: readonly (readonly [string, string])[]) =>
  headers.map(([name]) => name.toLowerCase()).filter((name) => traceNames.has(name));

const canariesIn = (text: string) => kinds.filter((kind) => text.includes(canaries[kind]));

const proxyText = (record: ProxyRecord) => [record.requestLine, ...record.headerLines].join("\n");

const originText = (request: RecordedRequest<string>) =>
  [request.target, ...request.headers.flat(), Buffer.from(request.body).toString("latin1")].join(
    "\n",
  );

const basic = (label: ProxyLabel) =>
  `Basic ${Buffer.from(userinfo[label].join(":")).toString("base64")}`;

// The proxy record of a hop: a CONNECT names the hop's authority, a forward request its URL.
const isHopRecord = (fixture: Fixture, hop: Hop) => (record: ProxyRecord) => {
  const authority = authorityOf(fixture.origins[hop.host]);
  if (record.kind === "connect") {
    return record.target === authority;
  }

  const url = URL.parse(record.requestLine.split(" ")[1] ?? "");

  return record.target === authority && url?.pathname === hop.path;
};

// The environment built from scratch: the runner's variables without any proxy variable, the test
// CA, the four canaries, then the row's proxy variables.
const environment = (fixture: Fixture, row: Row) => {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/proxy/iu.test(name)) {
      inherited[name] = value;
    }
  }

  return {
    ...inherited,
    ...credentialEnv,
    NODE_EXTRA_CA_CERTS: fixture.tls.caPath,
    ...rows[row](fixture.proxies),
  };
};

// Runs the chain under the row and returns, per hop, what the proxies and the origin recorded.
const witness = async (row: Row, chain: Chain) => {
  const fixture = await ready.promise;
  const id = `${row}-${chain}`;
  const hops = chains[chain](id);
  script(fixture, hops);

  const labels: readonly ProxyLabel[] = ["P1", "P2"];
  const before = {
    P1: fixture.proxies.P1.records().length,
    P2: fixture.proxies.P2.records().length,
    plain: fixture.plain.requests().length,
    tls: fixture.tls.requests().length,
  };
  const base = fixture.origins[hops[0]?.host ?? "N"];
  const result = await Effect.runPromise(
    runBin(fixture.generated, {
      args: ["--timeout", "5", "--base-url", base, "pets", "get", id],
      env: environment(fixture, row),
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );

  const records = labels.flatMap((label) => fixture.proxies[label].records().slice(before[label]));
  const requests: readonly RecordedRequest<string>[] = [
    ...fixture.plain.requests().slice(before.plain),
    ...fixture.tls.requests().slice(before.tls),
  ];

  const observed = hops.map((hop) => {
    const hopRecords = records.filter(isHopRecord(fixture, hop));
    const hopRequests = requests.filter(
      (request) =>
        request.origin === originNames[hop.host] && request.target.split("?")[0] === hop.path,
    );
    const proxyHeaders = hopRecords.flatMap((record) => record.headerLines.map(splitLine));

    return {
      canariesAtOrigin: [
        ...new Set(hopRequests.flatMap((request) => canariesIn(originText(request)))),
      ],
      canariesAtProxy: [...new Set(hopRecords.flatMap((record) => canariesIn(proxyText(record))))],
      hop: `${hop.host} ${hop.path}`,
      originProxyAuthorization: hopRequests.flatMap((request) =>
        valuesOf(request.headers, "proxy-authorization"),
      ),
      originRequests: hopRequests.length,
      proxyAuthorization: valuesOf(proxyHeaders, "proxy-authorization"),
      routes: hopRecords.map((record) => [record.proxy, record.kind]),
    };
  });

  return {
    exitCode: result.exitCode,
    hops: observed,
    proxyRecords: records.length,
    traceHeaders: [
      ...records.flatMap((record) => traceHeaders(record.headerLines.map(splitLine))),
      ...requests.flatMap((request) => traceHeaders(request.headers)),
    ],
  };
};

// What design 6.5 and I3 require of each hop under the row.
const expected = (row: Row, chain: Chain) => {
  const hops = chains[chain](`${row}-${chain}`);

  return {
    exitCode: 0,
    hops: hops.map((hop) => {
      const proxy = selected[row][secure(hop.host) ? "https" : "http"];
      const forwardedBound = bound[hop.host] && !secure(hop.host);

      return {
        canariesAtOrigin: bound[hop.host] ? [...kinds] : [],
        // A plain bound hop is forwarded whole, so its proxy sees its credentials (design 6.5);
        // a CONNECT head carries none, and an unbound hop has none to show.
        canariesAtProxy: forwardedBound ? [...kinds] : [],
        hop: `${hop.host} ${hop.path}`,
        originProxyAuthorization: [],
        originRequests: 1,
        proxyAuthorization: [basic(proxy)],
        routes: [[proxy, secure(hop.host) ? "connect" : "forward"]],
      };
    }),
    proxyRecords: hops.length,
    traceHeaders: [],
  };
};

const timeout = 60_000;

describe("proxy: HTTP_PROXY and HTTPS_PROXY set to P1 with userinfo", () => {
  test(
    "proxy: HTTP_PROXY and HTTPS_PROXY set to P1, N 302 to M",
    async () => {
      expect(await witness("upper", "nm")).toEqual(expected("upper", "nm"));
    },
    timeout,
  );

  test(
    "proxy: HTTP_PROXY and HTTPS_PROXY set to P1, N 302 to M 302 to N",
    async () => {
      expect(await witness("upper", "nmn")).toEqual(expected("upper", "nmn"));
    },
    timeout,
  );

  test(
    "proxy: HTTP_PROXY and HTTPS_PROXY set to P1, P 307 to Q",
    async () => {
      expect(await witness("upper", "pq")).toEqual(expected("upper", "pq"));
    },
    timeout,
  );
});

describe("proxy: HTTP_PROXY and HTTPS_PROXY set to P1 with http_proxy and https_proxy set to P2", () => {
  test(
    "proxy: lowercase http_proxy and https_proxy win, N 302 to M",
    async () => {
      expect(await witness("casePair", "nm")).toEqual(expected("casePair", "nm"));
    },
    timeout,
  );

  test(
    "proxy: lowercase http_proxy and https_proxy win, N 302 to M 302 to N",
    async () => {
      expect(await witness("casePair", "nmn")).toEqual(expected("casePair", "nmn"));
    },
    timeout,
  );

  test(
    "proxy: lowercase http_proxy and https_proxy win, P 307 to Q",
    async () => {
      expect(await witness("casePair", "pq")).toEqual(expected("casePair", "pq"));
    },
    timeout,
  );
});

describe("proxy: ALL_PROXY alone set to P1", () => {
  test(
    "proxy: ALL_PROXY alone proxies http, N 302 to M",
    async () => {
      expect(await witness("allProxy", "nm")).toEqual(expected("allProxy", "nm"));
    },
    timeout,
  );

  test(
    "proxy: ALL_PROXY alone proxies http, N 302 to M 302 to N",
    async () => {
      expect(await witness("allProxy", "nmn")).toEqual(expected("allProxy", "nmn"));
    },
    timeout,
  );

  test(
    "proxy: ALL_PROXY alone proxies https, P 307 to Q",
    async () => {
      expect(await witness("allProxy", "pq")).toEqual(expected("allProxy", "pq"));
    },
    timeout,
  );
});
