/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Option, Path, Sink, Stdio } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import * as Client from "../../src/runtime-src/runtime/client.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

// Output.send decides the client certificate per request from the operation's bound origins
// (m3-wirec): `--allow-credentials-for-base-url` never extends it to an unbound base URL, and the
// one withheld notice of the run names the certificate when it is withheld.

const SECRET = "tok-WIREC-SECRET";

const UNBOUND = "https://other.example.test/v1";

const servers: BaseUrl.ServersTable = {
  boundOrigins: ["https://api.example.com"],
  defaultServer: 0,
  servers: [{ url: "https://api.example.com/v1", variables: {} }],
};

const security: Auth.SecurityTable = {
  schemes: {
    bearerAuth: { kind: "http", scheme: "bearer" },
    clientCert: {
      caEnv: "EXAMPLE_CLIENT_CA",
      certEnv: "EXAMPLE_CLIENT_CERT",
      keyEnv: "EXAMPLE_CLIENT_KEY",
      kind: "mutualTLS",
    },
  },
};

const env = {
  EXAMPLE_BEARER_AUTH: SECRET,
  EXAMPLE_CLIENT_CERT: "/certs/client.pem",
  EXAMPLE_CLIENT_KEY: "/certs/client.key",
};

// Opaque to the runtime: any object stands for the init `bin.ts` builds.
const certificate: Auth.CertificateInit = { integrity: "client-certificate" };

const meta = (alternative: readonly string[]): Output.OperationMeta => ({
  media: { request: [], responses: { "200": ["application/json"] } },
  method: "GET",
  operationId: "items-get",
  pathTemplate: "/items",
  security: [alternative],
});

const getRequest = Serialize.request("GET", {
  headers: [],
  path: Serialize.path("/items", []),
  query: [],
});

interface Seen {
  readonly authorization: string | undefined;
  readonly init: FetchHttpClient.RequestInit["Service"] | undefined;
  readonly url: string;
}

interface World {
  readonly allowUnbound?: boolean;
  readonly alternative?: readonly string[];
  readonly baseUrl?: string;
}

const capture = (into: Buffer[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(Buffer.from(chunk));
    }),
  );

// Run `send` once against a client that records each request's `RequestInit` and answers 200.
const run = async (world: World) => {
  const seen: Seen[] = [];
  const stderr: Buffer[] = [];
  const client = HttpClient.make((sent, url) =>
    Effect.gen(function* record() {
      const init = Option.getOrUndefined(yield* Effect.serviceOption(FetchHttpClient.RequestInit));
      seen.push({ authorization: sent.headers.authorization, init, url: url.href });

      return HttpClientResponse.fromWeb(sent, new Response("[]", { status: 200 }));
    }),
  );
  const environment = Layer.mergeAll(
    BaseUrl.layer(servers, "EXAMPLE"),
    Auth.layer(security, "EXAMPLE"),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
    FileSystem.layerNoop({}),
    Path.layer,
    Stdio.layerTest({
      stderr: capture(stderr),
      stdout: capture([]),
      stdoutIsTerminal: Effect.succeed(false),
    }),
    Input.stdinClaimLayer,
    Output.runCredentialsLayer,
    Output.runWarningsLayer,
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Output.ClientPolicy, {
      allowed: new Set(["GET"]),
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
    Layer.succeed(Client.verboseSetting, false),
    Layer.succeed(Auth.ClientCertificate, Option.some(certificate)),
  );
  const exit = await Effect.runPromiseExit(
    getRequest.pipe(
      Effect.flatMap(Output.send(meta(world.alternative ?? ["bearerAuth", "clientCert"]))),
      Effect.provide(environment),
    ),
  );
  const notices = Buffer.concat(stderr)
    .toString("utf-8")
    .split("\n")
    .filter((line) => line.startsWith("Notice:"));

  return { exit, notices, seen };
};

describe("Output.send client certificate", () => {
  test("a request to a bound origin carries the certificate init and no notice", async () => {
    const result = await run({});

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.seen).toEqual([
      {
        authorization: `Bearer ${SECRET}`,
        init: certificate,
        url: "https://api.example.com/v1/items",
      },
    ]);
    expect(result.notices).toEqual([]);
  });

  test("a request to an unbound --base-url carries no certificate init", async () => {
    const result = await run({ baseUrl: UNBOUND });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.seen).toEqual([
      { authorization: undefined, init: undefined, url: `${UNBOUND}/items` },
    ]);
  });

  test("--allow-credentials-for-base-url sends the header credential but not the certificate", async () => {
    const result = await run({ allowUnbound: true, baseUrl: UNBOUND });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.seen).toEqual([
      { authorization: `Bearer ${SECRET}`, init: undefined, url: `${UNBOUND}/items` },
    ]);
  });

  test.each([
    ["without the flag", false],
    ["with the flag", true],
  ])("the one withheld notice names the certificate %s", async (_name, allowUnbound) => {
    const result = await run({ allowUnbound, baseUrl: UNBOUND });

    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain(Auth.withheldCertificateClause);
    expect(result.notices[0]).not.toContain("/certs/");
  });

  test("a certificate-only alternative withheld from an unbound base gets the certificate notice", async () => {
    const result = await run({ alternative: ["clientCert"], baseUrl: UNBOUND });

    expect(result.seen.map((seen) => seen.init)).toEqual([undefined]);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain(Auth.withheldCertificateClause);
  });

  test("an alternative without mutualTLS never names the certificate", async () => {
    const result = await run({ alternative: ["bearerAuth"], baseUrl: UNBOUND });

    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).not.toContain(Auth.withheldCertificateClause);
  });
});
