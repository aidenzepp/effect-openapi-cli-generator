import type { Certificate } from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Scope } from "effect";
import { startTlsCaptureServer, tlsOriginAddresses } from "../fixtures/capture-server.ts";
import type { TlsCaptureServer, TlsOriginName } from "../fixtures/capture-server.ts";
import { startRecordingProxy } from "../fixtures/recording-proxy.ts";
import type { RecordingProxy } from "../fixtures/recording-proxy.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The mutualTLS client certificate through a proxy (design 6.5 Proxy environment, Loopback hosts,
// the `mutualTLS` row and Origin binding, 9 I3, 13.3 SP5 and SP12). The author config binds
// origin A under its loopback name (https://127.0.0.1:<A>) and its TEST-NET-1 name
// (https://192.0.2.10:<A>), and neither name of origin B. The child's environment is built from
// scratch: no proxy variable of the runner reaches it, and HTTPS_PROXY names the recording proxy,
// whose target map sends 192.0.2.10:<A> to A and 192.0.2.11:<B> to B.
//
// Tunnel row: a TEST-NET-1 hop is routed through the proxy as a CONNECT, so the TLS handshake with
// the origin runs inside the tunnel and carries the certificate there; the proxy sees only host
// and port. A's 307 to B is a second CONNECT, and B sees no certificate.
//
// Loopback row (MIND-LB:d): a loopback hop goes direct whatever HTTPS_PROXY says, and on the bound
// origin the direct-route init and the certificate init merge into one, so the proxy accepts no
// connection and A records the certificate; the 307 to B on loopback is direct and B sees none.

const specPath = nodePath.resolve(import.meta.dir, "../fixtures/specs/proxy-mtls.json");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "px4-proxy-mtls-"));

const configPath = nodePath.join(work, "author-config.json");

const scope = Effect.runSync(Scope.make());

interface Ready {
  readonly generated: GeneratedPackage;
  readonly proxy: RecordingProxy;
  readonly server: TlsCaptureServer;
  readonly tunnel: Readonly<Record<TlsOriginName, string>>;
}

const ready = Promise.withResolvers<Ready>();

const portOf = (origin: string) => new URL(origin).port;

beforeAll(async () => {
  const prepare = Effect.gen(function* prepareGen() {
    const server = yield* startTlsCaptureServer();
    const ports = { A: portOf(server.origins.A), B: portOf(server.origins.B) };
    const tunnel = {
      A: `https://${tlsOriginAddresses.A}:${ports.A}`,
      B: `https://${tlsOriginAddresses.B}:${ports.B}`,
    };
    const proxy = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startRecordingProxy({
          label: "px4",
          targets: {
            [`${tlsOriginAddresses.A}:${ports.A}`]: {
              hostname: "127.0.0.1",
              port: Number(ports.A),
            },
            [`${tlsOriginAddresses.B}:${ports.B}`]: {
              hostname: "127.0.0.1",
              port: Number(ports.B),
            },
          },
        }),
      ),
      (started) => Effect.sync(started.stop),
    );
    writeFileSync(
      configPath,
      `${JSON.stringify({
        acceptedOrigins: [server.origins.A, tunnel.A],
        binName: "pxm",
        envPrefix: "PXM",
        package: { name: "proxy-mtls-cli", version: "0.1.0" },
      })}\n`,
    );

    const generated = yield* generateFixture({ configPath, specPath });
    yield* preparePackage(generated);

    return { generated, proxy, server, tunnel };
  }).pipe(Scope.provide(scope), Effect.provide(layer));
  ready.resolve(await Effect.runPromise(prepare));
}, 600_000);

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(work, { force: true, recursive: true });
});

const json = { body: "{}", headers: [["Content-Type", "application/json"]] as const, status: 200 };

// The child's whole environment: the CA trust, the certificate settings and the proxy; no other
// variable, so no proxy setting of the runner reaches it.
const environment = (server: TlsCaptureServer, proxy: RecordingProxy) => ({
  HTTPS_PROXY: proxy.url,
  NODE_EXTRA_CA_CERTS: server.caPath,
  PXM_CLIENT_CA: server.caPath,
  PXM_CLIENT_CERT: server.clientCertificate.cert,
  PXM_CLIENT_KEY: server.clientCertificate.key,
});

interface Hop {
  readonly origin: TlsOriginName;
  readonly path: string;
  readonly presented: boolean;
  readonly subject: Readonly<Certificate> | null;
}

interface ProxyHop {
  readonly kind: "connect" | "forward";
  readonly requestLine: string;
  readonly target: string;
}

interface Observed {
  readonly exitCode: number | null;
  readonly hops: readonly Hop[];
  readonly proxied: readonly ProxyHop[];
}

// Runs one command with `--timeout 5` against `base` and returns each request it made under
// `prefix`, with whether that request's connection presented the client certificate, and every
// connection the proxy accepted meanwhile.
const observe = async (prefix: string, base: string, id: string): Promise<Observed> => {
  const { generated, proxy, server } = await ready.promise;
  const before = server.requests().length;
  proxy.reset();

  const result = await Effect.runPromise(
    runBin(generated, {
      args: ["--timeout", "5", "--base-url", base, "pets", "get", id],
      env: environment(server, proxy),
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );
  const hops = server
    .requests()
    .slice(before)
    .filter((request) => request.target.startsWith(prefix))
    .map((request) => {
      const record = server
        .clientCertificates()
        .find((candidate) => candidate.connection === request.connection);

      return {
        origin: request.origin,
        path: request.target,
        presented: record?.presented ?? false,
        subject: record?.subject ?? null,
      };
    });

  return {
    exitCode: result.exitCode,
    hops,
    proxied: proxy
      .records()
      .map(({ kind, requestLine, target }) => ({ kind, requestLine, target })),
  };
};

const presented = (origin: TlsOriginName, path: string): Hop => ({
  origin,
  path,
  presented: true,
  subject: { CN: "capture-server client" },
});

const withheld = (origin: TlsOriginName, path: string): Hop => ({
  origin,
  path,
  presented: false,
  subject: null,
});

// The proxy sees only the authority: the CONNECT line, never a path or the certificate.
const connect = (authority: string): ProxyHop => ({
  kind: "connect",
  requestLine: `CONNECT ${authority} HTTP/1.1`,
  target: authority,
});

describe("mutualTLS through a proxy: the certificate reaches only the bound origin", () => {
  test("the certificate inside a CONNECT tunnel: A's 307 to B is a second CONNECT and B sees no certificate", async () => {
    const { server, tunnel } = await ready.promise;
    server.script("/pets/tunnel", { location: `${tunnel.B}/pets/tunnel-landed`, status: 307 });
    server.script("/pets/tunnel-landed", json);

    const observed = await observe("/pets/tunnel", tunnel.A, "tunnel");

    expect(observed).toEqual({
      exitCode: 0,
      hops: [presented("A", "/pets/tunnel"), withheld("B", "/pets/tunnel-landed")],
      proxied: [connect(new URL(tunnel.A).host), connect(new URL(tunnel.B).host)],
    });
  }, 60_000);

  test("certificate and direct route on a loopback hop: the proxy accepts no connection and only A sees the certificate", async () => {
    const { server } = await ready.promise;
    server.script("/pets/loopback", {
      location: `${server.origins.B}/pets/loopback-landed`,
      status: 307,
    });
    server.script("/pets/loopback-landed", json);

    const observed = await observe("/pets/loopback", server.origins.A, "loopback");

    expect(observed).toEqual({
      exitCode: 0,
      hops: [presented("A", "/pets/loopback"), withheld("B", "/pets/loopback-landed")],
      proxied: [],
    });
  }, 60_000);
});
