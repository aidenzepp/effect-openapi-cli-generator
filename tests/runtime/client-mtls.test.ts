import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunHttpClient, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as Client from "../../src/runtime-src/runtime/client.ts";
import { startTlsCaptureServer } from "../fixtures/capture-server.ts";

// Bound and unbound origins off loopback (TEST-NET-1) and on loopback.
const BOUND = "https://192.0.2.10:1";

const UNBOUND = "https://192.0.2.11:1";

const BOUND_LOOPBACK = "https://127.0.0.1:1";

const UNBOUND_LOOPBACK = "https://localhost:2";

// Opaque inits: the runtime never reads their keys, so any two disjoint objects serve.
const certificate: Auth.CertificateInit = { integrity: "client-certificate" };

const direct: Client.DirectRoute = { cache: "no-store" };

const everyMethod: ReadonlySet<string> = new Set(["GET", "POST"]);

interface Hop {
  readonly init: FetchHttpClient.RequestInit["Service"] | undefined;
  readonly url: string;
}

// A recording client: `/to?url=<target>` answers 307 to the target, anything else 200.
const recording = () => {
  const hops: Hop[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* answer() {
      const init = Option.getOrUndefined(yield* Effect.serviceOption(FetchHttpClient.RequestInit));
      hops.push({ init, url: url.href });

      const target = url.searchParams.get("url");
      const response =
        url.pathname === "/to" && target !== null
          ? new Response(null, { headers: { location: target }, status: 307 })
          : new Response("final", { status: 200 });

      return HttpClientResponse.fromWeb(request, response);
    }),
  );

  return { client, hops };
};

const none: Client.CertificateDecision = () => Effect.succeedNone;

// The bound-origin decision m3-wirec passes: the certificate only on `bound`.
const boundTo =
  (...bound: readonly string[]): Client.CertificateDecision =>
  (url) =>
    Auth.certificateInitFor(url, bound);

const initsOf = async (url: string, decide: Client.CertificateDecision) => {
  const { client, hops } = recording();
  await Effect.runPromise(
    client
      .pipe(Client.redirectLoop(Effect.succeed, direct, everyMethod, decide))
      .execute(HttpClientRequest.get(url))
      .pipe(
        Effect.flatMap((response) => response.text),
        Effect.scoped,
        Effect.provideService(Auth.ClientCertificate, Option.some(certificate)),
      ),
  );

  return hops.map((hop) => hop.init);
};

const redirect = (from: string, to: string) =>
  `${from}/to?url=${encodeURIComponent(`${to}/final`)}`;

describe("the client certificate per hop", () => {
  test("a bound origin executes with the certificate init", async () => {
    expect(await initsOf(`${BOUND}/final`, boundTo(BOUND))).toEqual([certificate]);
  });

  test("a same-origin 307 carries the certificate init on both hops", async () => {
    expect(await initsOf(redirect(BOUND, BOUND), boundTo(BOUND))).toEqual([
      certificate,
      certificate,
    ]);
  });

  test("a 307 from a bound to an unbound origin sends the second hop with no init", async () => {
    expect(await initsOf(redirect(BOUND, UNBOUND), boundTo(BOUND))).toEqual([
      certificate,
      undefined,
    ]);
  });

  test("an unbound origin is sent without the certificate, not refused", async () => {
    expect(await initsOf(redirect(UNBOUND, BOUND), boundTo())).toEqual([undefined, undefined]);
  });

  test("a decision that returns none leaves every hop without an init", async () => {
    expect(await initsOf(redirect(BOUND, BOUND), none)).toEqual([undefined, undefined]);
  });

  test("the decision is asked on every hop, with that hop's URL", async () => {
    const asked: string[] = [];
    const decide: Client.CertificateDecision = (url) => {
      asked.push(new URL(url).origin);

      return Auth.certificateInitFor(url, [BOUND]);
    };
    await initsOf(redirect(BOUND, UNBOUND), decide);

    expect(asked).toEqual([BOUND, UNBOUND]);
  });

  test("merge on a loopback hop", async () => {
    const inits = await initsOf(
      redirect(BOUND_LOOPBACK, UNBOUND_LOOPBACK),
      boundTo(BOUND_LOOPBACK),
    );

    expect(inits).toEqual([{ ...certificate, ...direct }, direct]);
  });

  test("without a decision a loopback hop keeps the direct-route init alone", async () => {
    const { client, hops } = recording();
    await Effect.runPromise(
      client
        .pipe(Client.redirectLoop(Effect.succeed, direct, everyMethod))
        .execute(HttpClientRequest.get(`${BOUND_LOOPBACK}/final`))
        .pipe(
          Effect.flatMap((response) => response.text),
          Effect.scoped,
          Effect.provideService(Auth.ClientCertificate, Option.some(certificate)),
        ),
    );

    expect(hops.map((hop) => hop.init)).toEqual([direct]);
  });
});

// Bun's fetch (1.4.3) keys its keep-alive pool by the request's tls options, so a request with a
// different per-request init never rides a connection opened with the certificate, and the
// reverse (measured here; probe SP12 sent `connection: close` and could not). The trust-only init
// stands for "no certificate": NODE_EXTRA_CA_CERTS is read at start-up, so this process cannot
// trust the fixture CA any other way.
// A request init with Bun's `tls` key, which the DOM RequestInit lacks; every key is optional.
const bunTls = (tls: Bun.TLSOptions): RequestInit => {
  const init: RequestInit & { readonly tls: Bun.TLSOptions } = { tls };

  return init;
};

describe("Bun keep-alive and per-request tls inits", () => {
  test("each distinct tls init opens its own connection; an equal init reuses it", async () => {
    const layer = Layer.mergeAll(
      BunFileSystem.layer,
      BunPath.layer,
      BunHttpClient.layerOptions({ redirect: "manual", timeout: 0 }),
    );
    const recorded = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* run() {
          const server = yield* startTlsCaptureServer();
          const client = yield* HttpClient.HttpClient;
          const ca = Bun.file(server.caPath);
          const { cert, key } = server.clientCertificate;
          const withCertificate = bunTls({ ca, cert: Bun.file(cert), key: Bun.file(key) });
          const trustOnly = bunTls({ ca });
          const send = (path: string, init: RequestInit) =>
            client.get(`${server.origins.A}${path}`).pipe(
              Effect.flatMap((response) => response.text),
              Effect.provideService(FetchHttpClient.RequestInit, init),
            );
          yield* send("/1", withCertificate);
          yield* send("/2", trustOnly);
          yield* send("/3", withCertificate);
          yield* send("/4", trustOnly);

          return {
            certificates: server
              .clientCertificates()
              .map(({ connection, presented }) => ({ connection, presented })),
            connections: server.requests().map((request) => request.connection),
          };
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(recorded).toEqual({
      certificates: [
        { connection: 1, presented: true },
        { connection: 2, presented: false },
      ],
      connections: [1, 2, 1, 2],
    });
  });
});
