/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import {
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Result,
  Sink,
  Stdio,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import type * as Client from "../../src/runtime-src/runtime/client.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import { runCredentialsLayer } from "../../src/runtime-src/runtime/redact.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

const API = "https://api.example.com";

const UNBOUND = "https://elsewhere.example.net";

const CERT_PATH = "/secrets/client-MT1-CERT.pem";

const KEY_PATH = "/secrets/client-MT1-KEY.pem";

const CA_PATH = "/secrets/client-MT1-CA.pem";

const TOKEN = "tok-MT1-BEARER";

// Names unlike the default fold (`ACME_CLIENT_CERT`, `_KEY`, `_CA`), so a runtime that derived the
// names a second time would read the wrong variables.
const client = {
  caEnv: "ACME_TLS_AUTHORITY",
  certEnv: "ACME_TLS_CERTIFICATE",
  keyEnv: "ACME_TLS_PRIVATE_KEY",
  kind: "mutualTLS",
} as const satisfies Auth.SecurityScheme;

const table: Auth.SecurityTable = {
  schemes: { bearerAuth: { kind: "http", scheme: "bearer" }, client },
};

const named = { [client.certEnv]: CERT_PATH, [client.keyEnv]: KEY_PATH };

const folded = { ACME_CLIENT_CA: CA_PATH, ACME_CLIENT_CERT: CERT_PATH, ACME_CLIENT_KEY: KEY_PATH };

// The certificate init `bin.ts` provides. Opaque to the runtime, so any object serves.
const init: Auth.CertificateInit = { cache: "no-store" };

const evaluate = (requirement: Auth.SecurityRequirement, env: Record<string, string>) =>
  Effect.runPromise(
    Auth.evaluate("users-read", requirement).pipe(
      Effect.provide(
        Layer.mergeAll(
          Auth.layer(table, "ACME"),
          FileSystem.layerNoop({}),
          Stdio.layerTest({}),
          Input.stdinClaimLayer,
        ),
      ),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.result,
    ),
  );

const chosen = (result: Result.Result<readonly Auth.Credential[], unknown>) =>
  Result.isSuccess(result) ? result.success.map((credential) => credential.scheme) : ["failed"];

describe("a mutualTLS alternative is satisfied by the descriptor's certEnv and keyEnv", () => {
  test("the named cert and key satisfy it", async () => {
    expect(chosen(await evaluate([["client"], ["bearerAuth"]], named))).toEqual(["client"]);
  });

  test("the CA is optional", async () => {
    const result = await evaluate([["client"]], { ...named, [client.caEnv]: CA_PATH });

    expect(chosen(result)).toEqual(["client"]);
    expect(chosen(await evaluate([["client"]], named))).toEqual(["client"]);
  });

  test("the default-fold names are never read", async () => {
    const result = await evaluate([["client"], ["bearerAuth"]], {
      ...folded,
      ACME_BEARER_AUTH: TOKEN,
    });

    expect(chosen(result)).toEqual(["bearerAuth"]);
  });

  test("with no paths configured the next alternative is chosen", async () => {
    const result = await evaluate([["client"], ["bearerAuth"]], { ACME_BEARER_AUTH: TOKEN });

    expect(chosen(result)).toEqual(["bearerAuth"]);
  });

  test("a cert without a key leaves it unsatisfied", async () => {
    const result = await evaluate([["client"], ["bearerAuth"]], {
      [client.certEnv]: CERT_PATH,
      ACME_BEARER_AUTH: TOKEN,
    });

    expect(chosen(result)).toEqual(["bearerAuth"]);
  });

  test("an unsatisfied mutualTLS requirement is CredentialMissing naming its env names", async () => {
    const result = await evaluate([["client"]], {});
    const failure = Result.isFailure(result) ? result.failure : undefined;
    const described = failure?._tag === "CredentialMissing" ? failure.alternatives.join("\n") : "";

    expect(failure).toMatchObject({ _tag: "CredentialMissing", operation: "users-read" });
    expect(described).toContain(client.certEnv);
    expect(described).toContain(client.keyEnv);
    expect(described).not.toContain("--client-file");
  });
});

const read = (env: Record<string, string>) =>
  Effect.runPromise(
    Auth.clientCertificatePaths(client).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    ),
  );

describe("clientCertificatePaths: the Config descriptor bin.ts reads", () => {
  test("reads the three named paths", async () => {
    expect(await read({ ...named, [client.caEnv]: CA_PATH })).toEqual(
      Option.some({ ca: Option.some(CA_PATH), cert: CERT_PATH, key: KEY_PATH }),
    );
  });

  test("a missing CA is none, a missing cert or key is no certificate", async () => {
    expect(await read(named)).toEqual(
      Option.some({ ca: Option.none(), cert: CERT_PATH, key: KEY_PATH }),
    );
    expect(await read({ [client.certEnv]: CERT_PATH })).toEqual(Option.none());
    expect(await read(folded)).toEqual(Option.none());
  });
});

const decide = (url: string, provided: boolean, allowUnbound = false) => {
  const decision = Auth.certificateInitFor(url, [API]).pipe(
    Effect.provideService(Auth.allowCredentialsForBaseUrl, allowUnbound),
  );

  return Effect.runSync(
    provided
      ? Effect.provideService(decision, Auth.ClientCertificate, Option.some(init))
      : decision,
  );
};

describe("certificateInitFor: the init only for a bound origin", () => {
  test("a bound origin gets the init", () => {
    expect(decide(`${API}/users/42?verbose=1`, true)).toEqual(Option.some(init));
  });

  test("an unbound origin gets none", () => {
    expect(decide(`${UNBOUND}/users/42`, true)).toEqual(Option.none());
  });

  test("a cross-origin URL on the bound host gets none", () => {
    expect(decide("http://api.example.com/users/42", true)).toEqual(Option.none());
    expect(decide("https://api.example.com:8443/users/42", true)).toEqual(Option.none());
  });

  test("--allow-credentials-for-base-url never extends to the certificate", () => {
    expect(decide(`${UNBOUND}/users/42`, true, true)).toEqual(Option.none());
  });

  test("no ClientCertificate provided is none on every origin", () => {
    expect(decide(`${API}/users/42`, false)).toEqual(Option.none());
  });

  test("an unparsable URL gets none", () => {
    expect(decide("not a url", true)).toEqual(Option.none());
  });
});

test("the R1 certificate clause names the flag only to say it does not extend", () => {
  expect(Auth.withheldCertificateClause).toContain("--allow-credentials-for-base-url");
  expect(Auth.withheldCertificateClause).not.toContain(CERT_PATH);
});

describe("the certificate never becomes a header", () => {
  test("attach leaves a request carrying only a mutualTLS credential unchanged", async () => {
    const credential: Auth.Credential = {
      definition: client,
      scheme: "client",
      value: Redacted.make(CERT_PATH),
    };
    const request = HttpClientRequest.get(`${API}/users/42`).pipe(
      HttpClientRequest.setHeader("authorization", "Bearer operator"),
    );
    const attached = await Effect.runPromise(
      Auth.attach({ schemes: { client } }, { credentials: [credential], origins: [API] })(request),
    );

    expect(attached.headers).toEqual(request.headers);
    expect(attached.url).toBe(request.url);
  });
});

const capture = (into: Buffer[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(Buffer.from(chunk));
    }),
  );

describe("through send", () => {
  interface Seen {
    readonly headers: Readonly<Record<string, string>>;
    readonly url: string;
  }

  const servers: BaseUrl.ServersTable = {
    boundOrigins: [API],
    defaultServer: 0,
    servers: [{ url: API, variables: {} }],
  };

  const sentinel: Client.DirectRoute = { cache: "no-cache" };

  const run = async (baseUrl: string | undefined, env: Record<string, string>) => {
    const seen: Seen[] = [];
    const stderr: Buffer[] = [];
    const recording = HttpClient.make((sent, url) =>
      Effect.sync(() => {
        seen.push({ headers: sent.headers, url: url.href });

        return HttpClientResponse.fromWeb(sent, new Response("", { status: 200 }));
      }),
    );
    const meta: Output.OperationMeta = {
      media: { request: [], responses: { "200": [] } },
      method: "GET",
      operationId: "users-read",
      pathTemplate: "/users/{id}",
      security: [["client"], ["bearerAuth"]],
    };
    const program = Output.finalCatch([])(
      Serialize.request("GET", {
        headers: [],
        path: Serialize.path("/users/{id}", [
          Serialize.simple("id", "42", { allowReserved: false, explode: false }),
        ]),
        query: [],
      }).pipe(Effect.flatMap(Output.send(meta))),
    );
    const environment = Layer.mergeAll(
      BaseUrl.layer(servers, "ACME"),
      Auth.layer(table, "ACME"),
      ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
      FileSystem.layerNoop({}),
      Path.layer,
      Stdio.layerTest({ stderr: capture(stderr), stdout: capture([]) }),
      Input.stdinClaimLayer,
      runCredentialsLayer,
      Layer.succeed(HttpClient.HttpClient, recording),
      Layer.succeed(Output.ClientPolicy, {
        allowed: new Set(["GET"]),
        binName: "acme",
        direct: sentinel,
        version: "1.2.3",
      }),
      Layer.succeed(Output.OutputPath, Option.none()),
      Layer.succeed(Output.Force, false),
      Layer.succeed(Output.MaxErrorBytes, Output.defaultMaxErrorBytes),
      Layer.succeed(BaseUrl.baseUrlSetting, Option.fromNullishOr(baseUrl)),
      Layer.succeed(BaseUrl.serverSetting, Option.none()),
      Layer.succeed(BaseUrl.serverVariableSetting, []),
      Layer.succeed(Auth.allowCredentialsForBaseUrl, false),
    );
    const exit = await Effect.runPromise(Effect.exit(program).pipe(Effect.provide(environment)));

    return { exit, seen };
  };

  test("a satisfied mutualTLS alternative with an unbound base URL is chosen and sent", async () => {
    const result = await run(UNBOUND, named);

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.seen.map((hop) => [hop.url, hop.headers.authorization])).toEqual([
      [`${UNBOUND}/users/42`, undefined],
    ]);
  });

  test("no header carries certificate material on a bound origin", async () => {
    const result = await run(undefined, named);

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.seen).toHaveLength(1);

    const values = result.seen.flatMap((hop) => [hop.url, ...Object.values(hop.headers)]);
    expect(values.some((value) => value.includes("MT1"))).toBe(false);
  });
});
