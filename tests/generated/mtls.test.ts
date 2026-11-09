import type { Certificate } from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import { startTlsCaptureServer } from "../fixtures/capture-server.ts";
import type { TlsCaptureServer, TlsOriginName } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The mutualTLS client certificate through a generated CLI (design D-SEC3, 6.5 `mutualTLS` row and
// Origin binding, 9 I3; inventory SSC-20). The certificate's paths come from MTLS_CLIENT_CERT,
// MTLS_CLIENT_KEY and MTLS_CLIENT_CA. It is presented on every hop to the bound origin A and to no
// other: not on A's 307 to B, and not to B chosen by --base-url or MTLS_BASE_URL, even with
// --allow-credentials-for-base-url. Such a request is still sent, with one notice that names no
// path. A and B are the TLS capture server's two origins; the child trusts its CA through
// NODE_EXTRA_CA_CERTS (P18).

const specPath = nodePath.resolve(import.meta.dir, "../fixtures/specs/mtls.json");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "ws4-mtls-"));

const configPath = nodePath.join(work, "author-config.json");

const scope = Effect.runSync(Scope.make());

const ready = Promise.withResolvers<{
  readonly generated: GeneratedPackage;
  readonly server: TlsCaptureServer;
}>();

beforeAll(async () => {
  const prepare = Effect.gen(function* prepareGen() {
    const server = yield* startTlsCaptureServer();
    writeFileSync(
      configPath,
      `${JSON.stringify({
        acceptedOrigins: [server.origins.A],
        binName: "mtls",
        envPrefix: "MTLS",
        package: { name: "mtls-cli", version: "0.1.0" },
      })}\n`,
    );

    const generated = yield* generateFixture({ configPath, specPath });
    yield* preparePackage(generated);

    return { generated, server };
  }).pipe(Scope.provide(scope), Effect.provide(layer));
  ready.resolve(await Effect.runPromise(prepare));
}, 600_000);

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(work, { force: true, recursive: true });
});

const json = { body: "{}", headers: [["Content-Type", "application/json"]] as const, status: 200 };

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

// The certificate settings, and the CA trust the child needs to verify either origin.
const certificateEnv = (server: TlsCaptureServer) => ({
  MTLS_CLIENT_CA: server.caPath,
  MTLS_CLIENT_CERT: server.clientCertificate.cert,
  MTLS_CLIENT_KEY: server.clientCertificate.key,
});

const trust = (server: TlsCaptureServer) => ({ NODE_EXTRA_CA_CERTS: server.caPath });

// Every path a run could leak: the certificate, its key, the CA bundle and their directory.
const paths = (server: TlsCaptureServer) => [
  server.clientCertificate.cert,
  server.clientCertificate.key,
  server.caPath,
  nodePath.dirname(server.caPath),
];

interface Hop {
  readonly origin: TlsOriginName;
  readonly path: string;
  readonly presented: boolean;
  readonly subject: Readonly<Certificate> | null;
}

interface Observed {
  readonly exitCode: number | null;
  readonly hops: readonly Hop[];
  readonly leakedPaths: readonly string[];
  readonly notices: number;
}

const notices = (stderr: string) =>
  stderr.split("\n").filter((line) => line.startsWith("Notice:")).length;

// Runs one command and returns each request it made under `prefix`, with whether that request's
// connection presented the client certificate and the certificate's common name.
const observe = async (
  prefix: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<Observed> => {
  const { generated, server } = await ready.promise;
  const before = server.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, { args, env: { ...trust(server), ...env }, timeoutMs: 30_000 }).pipe(
      Effect.provide(layer),
    ),
  );
  const stderr = latin1(result.stderr);
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
    leakedPaths: paths(server).filter(
      (path) => stderr.includes(path) || latin1(result.stdout).includes(path),
    ),
    notices: notices(stderr),
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

describe("SSC-20 mutualTLS: the certificate reaches only the bound origin", () => {
  test("SSC-20: a request to the bound origin A presents the client certificate", async () => {
    const { server } = await ready.promise;
    server.script("/pets/bound", json);

    const observed = await observe(
      "/pets/bound",
      ["--base-url", server.origins.A, "pets", "get", "bound"],
      certificateEnv(server),
    );

    expect(observed).toEqual({
      exitCode: 0,
      hops: [presented("A", "/pets/bound")],
      leakedPaths: [],
      notices: 0,
    });
  }, 60_000);

  test("SSC-20: A's 307 to B is sent to B without the client certificate", async () => {
    const { server } = await ready.promise;
    server.script("/pets/hop", { location: `${server.origins.B}/pets/hop-landed`, status: 307 });
    server.script("/pets/hop-landed", json);

    const observed = await observe(
      "/pets/hop",
      ["--base-url", server.origins.A, "pets", "get", "hop"],
      certificateEnv(server),
    );

    expect(observed).toEqual({
      exitCode: 0,
      hops: [presented("A", "/pets/hop"), withheld("B", "/pets/hop-landed")],
      leakedPaths: [],
      notices: 0,
    });
  }, 60_000);

  const unbound = [
    { allow: false, name: "--base-url", via: "flag" },
    { allow: true, name: "--base-url with --allow-credentials-for-base-url", via: "flag" },
    { allow: false, name: "MTLS_BASE_URL", via: "env" },
    { allow: true, name: "MTLS_BASE_URL with --allow-credentials-for-base-url", via: "env" },
  ] as const;

  for (const [index, { allow, name, via }] of unbound.entries()) {
    test(`SSC-20: ${name} naming B sends the request to B without the client certificate`, async () => {
      const { server } = await ready.promise;
      const path = `/pets/unbound-${index}`;
      server.script(path, json);

      const allowFlag = allow ? ["--allow-credentials-for-base-url"] : [];
      const args =
        via === "flag"
          ? ["--base-url", server.origins.B, ...allowFlag, "pets", "get", `unbound-${index}`]
          : [...allowFlag, "pets", "get", `unbound-${index}`];
      const env =
        via === "flag"
          ? certificateEnv(server)
          : { ...certificateEnv(server), MTLS_BASE_URL: server.origins.B };
      const observed = await observe(path, args, env);

      expect(observed).toEqual({
        exitCode: 0,
        hops: [withheld("B", path)],
        leakedPaths: [],
        notices: 1,
      });
    }, 60_000);
  }

  test("SSC-20: --dry-run never presents the client certificate and sends nothing", async () => {
    const { server } = await ready.promise;
    server.script("/pets/dry", json);

    const connections = server.connections();
    const observed = await observe(
      "/pets/dry",
      ["--base-url", server.origins.A, "--dry-run", "pets", "get", "dry"],
      certificateEnv(server),
    );

    expect({ ...observed, connections: server.connections() - connections }).toEqual({
      connections: 0,
      exitCode: 0,
      hops: [],
      leakedPaths: [],
      notices: 0,
    });
  }, 60_000);
});

const ErrorLine = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ kind: Schema.String, message: Schema.String }) }),
);

const errorLines = (stderr: string) =>
  stderr.split("\n").flatMap((line) =>
    Option.match(Schema.decodeUnknownOption(ErrorLine)(line), {
      onNone: () => [],
      onSome: (value) => [value.error],
    }),
  );

// The env names an error names, out of the three a scheme carries; values, not message text.
const namedSettings = (message: string) =>
  ["MTLS_CLIENT_CA", "MTLS_CLIENT_CERT", "MTLS_CLIENT_KEY"].filter((name) =>
    message.includes(name),
  );

describe("SSC-20 mutualTLS: a missing or unreadable certificate", () => {
  test("SSC-20: without the certificate env names the command exits 3 and sends nothing", async () => {
    const { generated, server } = await ready.promise;
    server.script("/pets/missing", json);

    const before = server.requests().length;
    const result = await Effect.runPromise(
      runBin(generated, {
        args: ["--base-url", server.origins.A, "pets", "get", "missing"],
        env: { ...trust(server), MTLS_ERROR_FORMAT: "json" },
        timeoutMs: 30_000,
      }).pipe(Effect.provide(layer)),
    );
    const errors = errorLines(latin1(result.stderr));

    expect({
      exitCode: result.exitCode,
      kinds: errors.map((error) => error.kind),
      namesScheme: errors.map((error) => error.message.includes("client")),
      requests: server.requests().length - before,
      settings: errors.map((error) => namedSettings(error.message)),
    }).toEqual({
      exitCode: 3,
      kinds: ["CredentialMissing"],
      namesScheme: [true],
      requests: 0,
      settings: [["MTLS_CLIENT_CERT", "MTLS_CLIENT_KEY"]],
    });
  }, 60_000);

  test("SSC-20: an unreadable certificate path exits 2 with one JSON error naming the variable", async () => {
    const { generated, server } = await ready.promise;
    server.script("/pets/unreadable", json);

    const missing = nodePath.join(work, "absent-client.pem");
    const before = server.requests().length;
    const result = await Effect.runPromise(
      runBin(generated, {
        args: ["--base-url", server.origins.A, "pets", "get", "unreadable"],
        env: {
          ...trust(server),
          ...certificateEnv(server),
          MTLS_CLIENT_CERT: missing,
          MTLS_ERROR_FORMAT: "json",
        },
        timeoutMs: 30_000,
      }).pipe(Effect.provide(layer)),
    );
    const stderr = latin1(result.stderr);
    const errors = errorLines(stderr);

    expect({
      exitCode: result.exitCode,
      kinds: errors.map((error) => error.kind),
      leaksPath: stderr.includes(missing),
      lines: stderr.split("\n").filter((line) => line.length > 0).length,
      requests: server.requests().length - before,
      settings: errors.map((error) => namedSettings(error.message)),
    }).toEqual({
      exitCode: 2,
      kinds: ["UsageError"],
      leaksPath: false,
      lines: 1,
      requests: 0,
      settings: [["MTLS_CLIENT_CERT"]],
    });
  }, 60_000);
});
