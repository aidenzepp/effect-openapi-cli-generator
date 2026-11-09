/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import {
  Cause,
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
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import type * as Client from "../../src/runtime-src/runtime/client.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import { runCredentialsLayer } from "../../src/runtime-src/runtime/redact.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

const TOKEN = "tok-AU1-SECRET";

const BEARER = "tok-AU1-BEARER";

const API = "https://api.example.com";

const UNBOUND = "https://elsewhere.example.net";

const servers: BaseUrl.ServersTable = {
  boundOrigins: [API],
  defaultServer: 0,
  servers: [{ url: API, variables: {} }],
};

const security: Auth.SecurityTable = {
  schemes: {
    bearerAuth: { kind: "http", scheme: "bearer" },
    oauthAuth: { kind: "oauth2" },
    oidcAuth: { kind: "openIdConnect" },
  },
};

const meta = (requirement: Auth.SecurityRequirement): Output.OperationMeta => ({
  media: { request: [], responses: { "200": [] } },
  method: "GET",
  operationId: "users-read",
  pathTemplate: "/users/{id}",
  security: requirement,
});

const request = (id: string) =>
  Serialize.request("GET", {
    headers: [],
    path: Serialize.path("/users/{id}", [
      Serialize.simple("id", id, { allowReserved: false, explode: false }),
    ]),
    query: [],
  });

// The direct-route init the entry hands the policy. Opaque to the runtime, so any object serves.
const sentinel: Client.DirectRoute = { cache: "no-store" };

interface Seen {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

interface World {
  readonly allowUnbound?: boolean;
  readonly baseUrl?: string;
  readonly env?: Record<string, string>;
  readonly files?: Record<string, string>;
  readonly given?: Record<string, string>;
  // The path to request: `/users/same` answers a 307 to the API origin, `/users/away` a 307 to
  // the unbound origin, anything else 200.
  readonly id?: string;
  readonly requirement?: Auth.SecurityRequirement;
}

const decode = (chunks: readonly Buffer[]): string => Buffer.concat(chunks).toString("utf-8");

const capture = (into: Buffer[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(Buffer.from(chunk));
    }),
  );

const locations = new Map([
  [`${API}/users/away`, `${UNBOUND}/landed`],
  [`${API}/users/same`, `${API}/landed`],
]);

/**
 * Run `send` once against a recording client (no sockets), through the final catch, as `main.ts`
 * composes them.
 */
const run = async (world: World = {}) => {
  const seen: Seen[] = [];
  const stderr: Buffer[] = [];
  const client = HttpClient.make((sent, url) =>
    Effect.sync(() => {
      seen.push({ headers: sent.headers, url: url.href });

      const location = locations.get(url.href);

      return HttpClientResponse.fromWeb(
        sent,
        location === undefined
          ? new Response("", { status: 200 })
          : new Response(null, { headers: { location }, status: 307 }),
      );
    }),
  );
  const files = world.files ?? {};
  let program = Output.finalCatch([])(
    request(world.id ?? "42").pipe(
      Effect.flatMap(Output.send(meta(world.requirement ?? [["oauthAuth"]]))),
    ),
  );
  for (const [scheme, path] of Object.entries(world.given ?? {})) {
    program = program.pipe(
      Effect.provideService(Auth.credentialFileSetting(scheme), Option.some(path)),
    );
  }

  const environment = Layer.mergeAll(
    BaseUrl.layer(servers, "EXAMPLE"),
    Auth.layer(security, "EXAMPLE"),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(world.env ?? {})),
    FileSystem.layerNoop({
      stream: (path) => Stream.make(new TextEncoder().encode(files[path] ?? "")),
    }),
    Path.layer,
    Stdio.layerTest({ stderr: capture(stderr), stdout: capture([]) }),
    Input.stdinClaimLayer,
    runCredentialsLayer,
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Output.ClientPolicy, {
      allowed: new Set(["GET"]),
      binName: "example",
      direct: sentinel,
      version: "1.2.3",
    }),
    Layer.succeed(Output.OutputPath, Option.none()),
    Layer.succeed(Output.Force, false),
    Layer.succeed(Output.MaxErrorBytes, Output.defaultMaxErrorBytes),
    Layer.succeed(BaseUrl.baseUrlSetting, Option.fromNullishOr(world.baseUrl)),
    Layer.succeed(BaseUrl.serverSetting, Option.none()),
    Layer.succeed(BaseUrl.serverVariableSetting, []),
    Layer.succeed(Auth.allowCredentialsForBaseUrl, world.allowUnbound ?? false),
  );
  const exit = await Effect.runPromise(Effect.exit(program).pipe(Effect.provide(environment)));
  const failure = Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined;

  return { exit, seen, stderr: decode(stderr), tag: failure?._tag };
};

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe("oauth2 and openIdConnect tokens reach the request as Authorization: Bearer", () => {
  test("an oauth2 token from env EXAMPLE_<SCHEME>", async () => {
    const result = await run({ env: { EXAMPLE_OAUTH_AUTH: TOKEN } });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.seen.map((hop) => hop.headers.authorization)).toEqual([`Bearer ${TOKEN}`]);
  });

  test("an oauth2 token from --<scheme>-file beats env", async () => {
    const result = await run({
      env: { EXAMPLE_OAUTH_AUTH: "from-env" },
      files: { "/run/token": `${TOKEN}\n` },
      given: { oauthAuth: "/run/token" },
    });

    expect(result.seen.map((hop) => hop.headers.authorization)).toEqual([`Bearer ${TOKEN}`]);
  });

  test("an openIdConnect token from env and from --<scheme>-file", async () => {
    const fromEnv = await run({
      env: { EXAMPLE_OIDC_AUTH: TOKEN },
      requirement: [["oidcAuth"]],
    });
    const fromFile = await run({
      files: { "/run/oidc": TOKEN },
      given: { oidcAuth: "/run/oidc" },
      requirement: [["oidcAuth"]],
    });

    expect(fromEnv.seen.map((hop) => hop.headers.authorization)).toEqual([`Bearer ${TOKEN}`]);
    expect(fromFile.seen.map((hop) => hop.headers.authorization)).toEqual([`Bearer ${TOKEN}`]);
  });

  test("a same-origin 307 keeps the token", async () => {
    const result = await run({ env: { EXAMPLE_OAUTH_AUTH: TOKEN }, id: "same" });

    expect(result.seen.map((hop) => [hop.url, hop.headers.authorization])).toEqual([
      [`${API}/users/same`, `Bearer ${TOKEN}`],
      [`${API}/landed`, `Bearer ${TOKEN}`],
    ]);
  });

  test("a 307 to an unbound origin strips the token", async () => {
    const result = await run({
      env: { EXAMPLE_OIDC_AUTH: TOKEN },
      id: "away",
      requirement: [["oidcAuth"]],
    });

    expect(result.seen.map((hop) => [hop.url, hop.headers.authorization])).toEqual([
      [`${API}/users/away`, `Bearer ${TOKEN}`],
      [`${UNBOUND}/landed`, undefined],
    ]);
  });

  test("no header or query carries a scope or a role", async () => {
    const result = await run({ env: { EXAMPLE_OAUTH_AUTH: TOKEN } });
    const [hop] = result.seen;

    expect(Object.keys(hop?.headers ?? {}).filter((name) => /scope|role/iu.test(name))).toEqual([]);
    expect(new URL(hop?.url ?? API).search).toBe("");
    expect(
      Object.entries(hop?.headers ?? {})
        .filter(([, value]) => value.includes(TOKEN))
        .map(([name]) => name),
    ).toEqual(["authorization"]);
  });
});

describe("a malformed token is a UsageError naming the scheme, never the value", () => {
  const malformed = [
    ["CR", `${TOKEN}\rX`],
    ["LF", `${TOKEN}\nX`],
    ["NUL", `${TOKEN}\u0000X`],
    ["leading whitespace", ` ${TOKEN}`],
    ["trailing whitespace", `${TOKEN}\t`],
  ] as const;

  for (const [label, value] of malformed) {
    for (const scheme of ["oauthAuth", "oidcAuth"] as const) {
      test(`${scheme}: ${label}`, async () => {
        const credential: Auth.Credential = {
          definition: security.schemes[scheme] ?? { kind: "oauth2" },
          scheme,
          value: Redacted.make(value),
        };
        const result = await Effect.runPromise(
          Auth.attach(security, { credentials: [credential], origins: [API] })(
            HttpClientRequest.get(`${API}/users/42`),
          ).pipe(Effect.result),
        );
        const failure = Result.isFailure(result) ? result.failure : undefined;

        expect(failure?._tag).toBe("UsageError");
        expect(failure?.flag).toBe(`${Auth.schemeSlug(scheme)}-file`);
        expect(failure?.message).toContain(scheme);
        expect(JSON.stringify(failure)).not.toContain(TOKEN);
        expect(Object.values(failure ?? {}).some((field) => String(field).includes(TOKEN))).toBe(
          false,
        );
      });
    }
  }
});

describe("requirement evaluation treats oauth2 and openIdConnect like bearer", () => {
  test("an alternative with no token falls through to the next", async () => {
    const result = await run({
      env: { EXAMPLE_OIDC_AUTH: TOKEN },
      requirement: [["oauthAuth"], ["oidcAuth"]],
    });

    expect(result.seen.map((hop) => hop.headers.authorization)).toEqual([`Bearer ${TOKEN}`]);
  });

  test("CredentialMissing when no alternative has a token", async () => {
    const result = await run({ requirement: [["oauthAuth"], ["oidcAuth"]] });

    expect(result.tag).toBe("CredentialMissing");
    expect(result.seen).toHaveLength(0);
  });
});

describe("R1: one notice when the gate withholds a token from an unbound --base-url", () => {
  const flag = "--allow-credentials-for-base-url";

  test("a configured token and an unbound --base-url: one notice naming the flag and scheme", async () => {
    const result = await run({ baseUrl: UNBOUND, env: { EXAMPLE_OAUTH_AUTH: TOKEN } });

    expect(result.seen.map((hop) => hop.headers.authorization)).toEqual([undefined]);
    expect(occurrences(result.stderr, flag)).toBe(1);
    expect(result.stderr).toContain("oauthAuth");
    expect(result.stderr).not.toContain(TOKEN);
  });

  test("no notice with the allow flag", async () => {
    const result = await run({
      allowUnbound: true,
      baseUrl: UNBOUND,
      env: { EXAMPLE_OAUTH_AUTH: TOKEN },
    });

    expect(result.seen.map((hop) => hop.headers.authorization)).toEqual([`Bearer ${TOKEN}`]);
    expect(result.stderr).not.toContain(flag);
  });

  test("no notice with no credential configured", async () => {
    const result = await run({ baseUrl: UNBOUND, requirement: [["oauthAuth"], []] });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.stderr).not.toContain(flag);
  });
});

describe("m3.md open question 7: one alternative holding oauth2 and http bearer", () => {
  // Recorded, not ruled: Milestone 3 keeps Milestone 1's behavior and the Mind decides later.
  // The attach transform applies the alternative in order, so the last scheme's token wins.
  test("records what Milestone 1's attach transform sends", async () => {
    const result = await run({
      env: { EXAMPLE_BEARER_AUTH: BEARER, EXAMPLE_OAUTH_AUTH: TOKEN },
      requirement: [["oauthAuth", "bearerAuth"]],
    });

    expect(result.seen.map((hop) => hop.headers.authorization)).toEqual([`Bearer ${BEARER}`]);
  });
});
