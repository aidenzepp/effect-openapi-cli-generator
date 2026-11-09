import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { startTlsCaptureServer, tlsOriginAddresses } from "./capture-server.ts";
import type { TlsCaptureServer } from "./capture-server.ts";

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// Starts the two TLS origins for one test and closes the scope (listeners, temp files) after it.
const withTlsServer = <A>(use: (server: TlsCaptureServer) => A | Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* withTlsServerGen() {
        const server = yield* startTlsCaptureServer();

        return yield* Effect.promise(() => Promise.resolve(use(server)));
      }),
    ).pipe(Effect.provide(layer)),
  );

// One request per connection, so each connection's certificate record belongs to one request.
const send = async (url: string, server: TlsCaptureServer, withCertificate: boolean) => {
  const { cert, key } = server.clientCertificate;
  const ca = Bun.file(server.caPath);
  const tls = withCertificate ? { ca, cert: Bun.file(cert), key: Bun.file(key) } : { ca };
  const response = await fetch(url, { headers: { connection: "close" }, redirect: "manual", tls });
  await response.arrayBuffer();

  return response;
};

const subjectAltName = (certificate: string) =>
  new TextDecoder().decode(
    Bun.spawnSync(["openssl", "x509", "-in", certificate, "-noout", "-ext", "subjectAltName"], {
      stderr: "pipe",
      stdout: "pipe",
    }).stdout,
  );

test("a request to A with a client certificate is recorded as presented with its subject", async () => {
  const recorded = await withTlsServer(async (server) => {
    const response = await send(`${server.origins.A}/with`, server, true);
    const [request] = server.requests();

    return {
      certificates: server
        .clientCertificates()
        .filter((record) => record.connection === request?.connection),
      origin: request?.origin,
      status: response.status,
    };
  });

  expect(recorded).toEqual({
    certificates: [
      { connection: 1, origin: "A", presented: true, subject: { CN: "capture-server client" } },
    ],
    origin: "A",
    status: 200,
  });
});

test("a request to A without a client certificate is recorded as absent", async () => {
  const recorded = await withTlsServer(async (server) => {
    await send(`${server.origins.A}/with`, server, true);
    await send(`${server.origins.A}/without`, server, false);

    return server.clientCertificates().map(({ presented, subject }) => ({ presented, subject }));
  });

  expect(recorded).toEqual([
    { presented: true, subject: { CN: "capture-server client" } },
    { presented: false, subject: null },
  ]);
});

test("each origin's certificate names loopback and its TEST-NET-1 literal", async () => {
  const names = await withTlsServer((server) => ({
    A: subjectAltName(server.serverCertificates.A.cert),
    B: subjectAltName(server.serverCertificates.B.cert),
  }));

  expect(tlsOriginAddresses).toEqual({ A: "192.0.2.10", B: "192.0.2.11" });
  expect(names.A).toContain("IP Address:127.0.0.1, DNS:localhost, IP Address:192.0.2.10");
  expect(names.B).toContain("IP Address:127.0.0.1, DNS:localhost, IP Address:192.0.2.11");
});

test("A and B are distinct origins and A's scripted 307 names B", async () => {
  const recorded = await withTlsServer(async (server) => {
    const target = `${server.origins.B}/landing`;
    server.script("/hop", { location: target, status: 307 });

    const response = await send(`${server.origins.A}/hop`, server, false);

    return {
      distinct: server.origins.A !== server.origins.B,
      location: response.headers.get("location"),
      origins: server.requests().map((request) => request.origin),
      status: response.status,
      target,
    };
  });

  expect(recorded.distinct).toBe(true);
  expect(recorded.status).toBe(307);
  expect(recorded.location).toBe(recorded.target);
  expect(recorded.target).toStartWith("https://127.0.0.1:");
  expect(recorded.origins).toEqual(["A"]);
});

test("the certificate directory is gone once the scope closes", async () => {
  const directory = await withTlsServer((server) => {
    expect(existsSync(server.caPath)).toBe(true);

    return nodePath.dirname(server.caPath);
  });

  expect(existsSync(directory)).toBe(false);
});
