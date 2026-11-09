import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Scope } from "effect";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The AUTH help rows through a generated CLI (design 4.8 help layout, 6.5, D-SEC1; inventory SSC-08
// to SSC-10, OAF-01, OAF-12, SEC-11 and SEC-13), on one 3.2 fixture: `users get --help` lists the
// oauth2 flows with their URLs and scopes and says the token is operator-supplied, shows the
// openIdConnectUrl, oauth2MetadataUrl and deviceAuthorizationUrl without fetching them, and lists
// the required scopes and the apiKey roles, which are never sent. Every URL the fixture names points
// at the capture server, so a fetch of any of them would be recorded.

const placeholder = "http://capture.invalid";

const capture = startCaptureServer();

const A = capture.origins["127.0.0.1"];

const work = mkdtempSync(nodePath.join(tmpdir(), "ws3b-auth-help-"));

const file = (name: string) => nodePath.join(work, name);

// The fixture with its help-only URLs pointed at the capture server's bound origin.
const specPath = file("token-auth-help.json");

writeFileSync(
  specPath,
  readFileSync(
    nodePath.resolve(import.meta.dir, "../fixtures/specs/token-auth-help.json"),
    "utf-8",
  ).replaceAll(placeholder, A),
);

const configPath = file("author-config.json");

writeFileSync(
  configPath,
  `${JSON.stringify({
    acceptedOrigins: [A],
    allowInsecure: true,
    binName: "tah",
    envPrefix: "TAH",
    package: { name: "token-auth-help-cli", version: "0.1.0" },
  })}\n`,
);

// The paths of every URL the fixture's schemes name: none may ever be requested.
const helpOnlyPaths = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/oauth/authorize",
  "/oauth/device",
  "/oauth/refresh",
  "/oauth/token",
] as const;

// Every scope and role value the fixture names: in a flow or in the operation's requirement.
const scopes = {
  flows: ["users:admin", "users:audit", "users:device", "users:read"],
  oidc: ["openid", "users:profile"],
  roles: ["role-auditor", "role-operator"],
} as const;

const token = "ws3b-oauth-token";

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

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
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(work, { force: true, recursive: true });
});

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

interface CliRun {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const run = async (args: readonly string[], env: Record<string, string> = {}): Promise<CliRun> => {
  const generated = await ready.promise;
  const result = await Effect.runPromise(
    runBin(generated, { args, env, timeoutMs: 30_000 }).pipe(Effect.provide(layer)),
  );

  return {
    exitCode: result.exitCode,
    stderr: latin1(result.stderr),
    stdout: latin1(result.stdout),
  };
};

// `users get --help`, run once; every help test reads its AUTH line.
const help = (async () => {
  const before = capture.requests().length;
  const cli = await run(["--base-url", A, "users", "get", "--help"]);

  return { ...cli, requests: capture.requests().length - before };
})();

const authLine = async () => {
  const { stdout } = await help;

  const found = stdout.split("\n").find((candidate) => candidate.startsWith("AUTH ")) ?? "";

  return found.replace(/^AUTH +/u, "");
};

// The AUTH line's three alternatives, without the AUTH label, in document order (" or " joins them).
const alternative = async (index: number) => {
  const auth = await authLine();

  return auth.split(" or ")[index] ?? "";
};

const requestText = (request: RecordedRequest) =>
  [request.target, ...request.headers.flat(), latin1(request.body)].join("\n");

const helpOnlyHits = () =>
  capture
    .requests()
    .map((request) => request.target.split("?")[0] ?? "")
    .filter((path) => helpOnlyPaths.some((helpPath) => path === helpPath));

describe("help: users get --help", () => {
  test("SSC-08: --help exits 0, sends no request, and prints one AUTH line", async () => {
    const { exitCode, requests, stdout } = await help;
    const lines = stdout.split("\n").filter((candidate) => candidate.startsWith("AUTH "));

    expect({ exitCode, lines: lines.length, requests }).toEqual({
      exitCode: 0,
      lines: 1,
      requests: 0,
    });
  }, 600_000);

  test("SSC-08: the oauth2 scheme lists its flows and says the token is operator-supplied", async () => {
    const oauth = await alternative(0);

    expect(oauth.startsWith("oauth (")).toBe(true);
    expect(oauth).toContain("--oauth-file <path|->, env TAH_OAUTH");
    expect(oauth).toContain("authorizationCode flow ");
    expect(oauth).toContain("clientCredentials flow ");
    expect(oauth).toContain("deviceAuthorization flow ");
    expect(oauth).toContain("token acquisition is not supported; supply an access token");
  }, 600_000);

  test("OAF-01: each flow shows its URLs and scopes, in fixed flow order", async () => {
    const oauth = await alternative(0);

    expect(oauth).toContain(
      `authorizationCode flow authorizationUrl ${A}/oauth/authorize, tokenUrl ${A}/oauth/token, refreshUrl ${A}/oauth/refresh, scopes `,
    );
    expect(oauth).toContain(`clientCredentials flow tokenUrl ${A}/oauth/token, scopes `);
    expect(oauth).toContain(
      `deviceAuthorization flow deviceAuthorizationUrl ${A}/oauth/device, tokenUrl ${A}/oauth/token, scopes `,
    );
    expect(oauth.indexOf("authorizationCode flow")).toBeLessThan(
      oauth.indexOf("clientCredentials flow"),
    );
    expect(oauth.indexOf("clientCredentials flow")).toBeLessThan(
      oauth.indexOf("deviceAuthorization flow"),
    );
  }, 600_000);

  test("OAF-12: each flow lists its scope names with their descriptions", async () => {
    const oauth = await alternative(0);

    expect(oauth).toContain("scopes users:read (Read users), users:audit (Audit users)");
    expect(oauth).toContain("scopes users:admin (Administer users)");
    expect(oauth).toContain("scopes users:device (Use a device)");
  }, 600_000);

  test("SSC-09: the openIdConnectUrl is shown and marked never fetched", async () => {
    const oidc = await alternative(1);

    expect(oidc.startsWith("oidc (")).toBe(true);
    expect(oidc).toContain("--oidc-file <path|->, env TAH_OIDC");
    expect(oidc).toContain(
      `openIdConnectUrl ${A}/.well-known/openid-configuration (never fetched)`,
    );
    expect(oidc).toContain("token acquisition is not supported; supply an access token");
  }, 600_000);

  test("SSC-10: the oauth2MetadataUrl is shown and marked never fetched", async () => {
    const oauth = await alternative(0);

    expect(oauth).toContain(
      `oauth2MetadataUrl ${A}/.well-known/oauth-authorization-server (never fetched)`,
    );
  }, 600_000);

  test("SEC-11: the required scopes of each token alternative are listed and never sent", async () => {
    expect(await alternative(0)).toContain("required scopes users:read, users:audit (never sent)");
    expect(await alternative(1)).toContain("required scopes openid, users:profile (never sent)");
  }, 600_000);

  test("SEC-13: the apiKey alternative lists its role names and never sends them", async () => {
    const key = await alternative(2);

    expect(key.startsWith("key (")).toBe(true);
    expect(key).toContain("roles role-auditor, role-operator (never sent)");
    expect(key).not.toContain("required scopes");
  }, 600_000);
});

describe("never fetched, never sent", () => {
  test("SSC-10: after --help and one request with a token, no help-only URL was requested and no scope or role was sent", async () => {
    await help;
    capture.script("/users/u1", {
      body: "{}",
      headers: [["Content-Type", "application/json"]],
      status: 200,
    });

    const before = capture.requests().length;
    const cli = await run(["--base-url", A, "users", "get", "u1"], { TAH_OAUTH: token });
    const sent = capture.requests().slice(before);
    const values = [...scopes.flows, ...scopes.oidc, ...scopes.roles, "scope"];
    const leaked = sent.flatMap((request) =>
      values.filter((value) => requestText(request).toLowerCase().includes(value)),
    );

    expect({
      authorization: sent.map((request) =>
        request.headers
          .filter(([name]) => name.toLowerCase() === "authorization")
          .map(([, value]) => value),
      ),
      exitCode: cli.exitCode,
      helpOnly: helpOnlyHits(),
      leaked,
      targets: sent.map((request) => request.target),
    }).toEqual({
      authorization: [[`Bearer ${token}`]],
      exitCode: 0,
      helpOnly: [],
      leaked: [],
      targets: ["/users/u1"],
    });
  }, 600_000);

  test("SSC-09: the openIdConnectUrl and the deviceAuthorizationUrl were never requested", async () => {
    await help;

    expect(
      helpOnlyHits().filter(
        (path) => path === "/.well-known/openid-configuration" || path === "/oauth/device",
      ),
    ).toEqual([]);
    expect(capture.count("/.well-known/openid-configuration")).toBe(0);
  }, 600_000);
});
