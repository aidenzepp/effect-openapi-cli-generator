import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Schema } from "effect";
import type { HelpInput } from "../../src/emit/help.ts";
import { operationHelp } from "../../src/emit/help.ts";
import { Operation, SecurityScheme } from "../../src/model/entities.ts";
import type { Json } from "../../src/model/pointer.ts";

// The AUTH line for the token pass-through kinds, mutualTLS and the TTY prompt source (design 4.6
// help safety, 4.8 golden AUTH line, 6.5): structure and sanitized values, not prose.

const root = nodePath.resolve(import.meta.dir, "../..");

const goldenAuth = nodeFs
  .readFileSync(
    nodePath.join(root, "tests/fixtures/golden/users-update/expected/help.txt"),
    "utf-8",
  )
  .split("\n")
  .find((entry) => entry.startsWith("AUTH "))
  ?.replace(/^AUTH\s+/u, "");

const origin = { document: "file:///spec.json", pointer: "/paths/~1x/get" };

const rows = ["SEC-01"];

const tokenSources = ["file", "env", "prompt"];

const scheme = (name: string, kind: Json, credentialSources: readonly string[] = tokenSources) =>
  Schema.decodeUnknownSync(SecurityScheme)({
    credentialSources,
    deprecated: false,
    kind,
    name,
    origin,
    rows,
    source: "spec",
  });

const credential = (name: string, stem: string) => ({
  env: `ACME_${stem}`,
  flag: `${name}-file`,
  scheme: name,
});

const authFor = (
  uses: readonly { readonly scheme: string; readonly scopes: readonly string[] }[],
  schemes: readonly SecurityScheme[],
  extra: Pick<HelpInput, "certificates" | "credentials">,
): string => {
  const input: HelpInput = {
    ...extra,
    diagnostics: [],
    flags: [],
    operation: Schema.decodeUnknownSync(Operation)({
      deprecated: false,
      docs: {},
      key: { method: "GET", path: "/x" },
      origin,
      parameters: [],
      responses: [],
      rows: ["OPR-01"],
      security: { alternatives: [{ uses }], declared: true, origin, rows },
      servers: [],
      tags: [],
    }),
    schemes,
  };

  return operationHelp(input).sections.find(([title]) => title === "AUTH")?.[1] ?? "";
};

const flows = {
  authorizationCode: {
    authorizationUrl: "https://auth.example/authorize",
    refreshUrl: "https://auth.example/refresh",
    scopes: [{ description: "Read access", name: "read" }],
    tokenUrl: "https://auth.example/token",
  },
  clientCredentials: {
    scopes: [{ description: "Write access", name: "write" }],
    tokenUrl: "https://auth.example/cc-token",
  },
};

const oauth = scheme("oauth", { flows, type: "oauth2Token" });

const oauthCredential = credential("oauth", "OAUTH");

describe("AUTH help for oauth2, openIdConnect, mutualTLS and the TTY prompt", () => {
  test("a token scheme whose sources include the prompt lists the file flag, env and TTY prompt", () => {
    const bearer = scheme("bearerAuth", { scheme: "bearer", type: "http" });
    const line = authFor([{ scheme: "bearerAuth", scopes: [] }], [bearer], {
      credentials: [credential("bearer-auth", "BEARER_AUTH")].map((entry) => ({
        ...entry,
        scheme: "bearerAuth",
      })),
    });

    expect(line).toBe(
      "bearerAuth (http bearer): --bearer-auth-file <path|->, env ACME_BEARER_AUTH, TTY prompt",
    );
  });

  test("a scheme whose sources lack the prompt lists no TTY prompt", () => {
    const bearer = scheme("bearerAuth", { scheme: "bearer", type: "http" }, ["file", "env"]);
    const line = authFor([{ scheme: "bearerAuth", scopes: [] }], [bearer], {
      credentials: [{ env: "ACME_BEARER_AUTH", flag: "bearer-auth-file", scheme: "bearerAuth" }],
    });

    expect(line.includes("TTY prompt")).toBe(false);
  });

  test("the golden users update AUTH line renders equal to expected/help.txt", () => {
    const bearer = scheme("bearerAuth", { scheme: "bearer", type: "http" });
    const line = authFor([{ scheme: "bearerAuth", scopes: [] }], [bearer], {
      credentials: [{ env: "EXAMPLE_BEARER_AUTH", flag: "bearer-auth-file", scheme: "bearerAuth" }],
    });

    expect(goldenAuth).toBeDefined();
    expect(line).toBe(goldenAuth ?? "");
  });

  test("an oauth2 scheme lists its flows and that acquisition is not supported (SSC-08)", () => {
    const line = authFor([{ scheme: "oauth", scopes: [] }], [oauth], {
      credentials: [oauthCredential],
    });

    expect(
      line.startsWith("oauth (oauth2 token): --oauth-file <path|->, env ACME_OAUTH, TTY prompt"),
    ).toBe(true);
    expect(line).toContain("authorizationCode flow");
    expect(line).toContain("clientCredentials flow");
    expect(line).toContain("token acquisition is not supported; supply an access token");
  });

  test("each flow carries its sanitized URLs (OAF-01)", () => {
    const line = authFor([{ scheme: "oauth", scopes: [] }], [oauth], {
      credentials: [oauthCredential],
    });

    expect(line).toContain("authorizationUrl https://auth.example/authorize");
    expect(line).toContain("tokenUrl https://auth.example/token");
    expect(line).toContain("refreshUrl https://auth.example/refresh");
    expect(line).toContain("tokenUrl https://auth.example/cc-token");
    expect(line.indexOf("authorizationCode flow")).toBeLessThan(
      line.indexOf("clientCredentials flow"),
    );
  });

  test("a 3.2 deviceAuthorization flow shows its deviceAuthorizationUrl folded, beside tokenUrl", () => {
    const device = scheme("oauth", {
      flows: {
        deviceAuthorization: {
          deviceAuthorizationUrl: "https://auth.example/\n\tdevice",
          scopes: [],
          tokenUrl: "https://auth.example/device-token",
        },
      },
      type: "oauth2Token",
    });
    const line = authFor([{ scheme: "oauth", scopes: [] }], [device], {
      credentials: [oauthCredential],
    });

    expect(line).toContain(
      "deviceAuthorization flow deviceAuthorizationUrl https://auth.example/ device, tokenUrl https://auth.example/device-token",
    );
  });

  test("a flow without deviceAuthorizationUrl prints no deviceAuthorizationUrl", () => {
    const line = authFor([{ scheme: "oauth", scopes: [] }], [oauth], {
      credentials: [oauthCredential],
    });

    expect(line.includes("deviceAuthorizationUrl")).toBe(false);
  });

  test("each flow lists its scope names and descriptions (OAF-12)", () => {
    const line = authFor([{ scheme: "oauth", scopes: [] }], [oauth], {
      credentials: [oauthCredential],
    });

    expect(line).toContain("read (Read access)");
    expect(line).toContain("write (Write access)");
  });

  test("a hostile scope description is folded to one line (OAF-12)", () => {
    const hostile = scheme("oauth", {
      flows: {
        clientCredentials: {
          scopes: [{ description: "line one\n\tline two", name: "read" }],
          tokenUrl: "https://auth.example/token",
        },
      },
      type: "oauth2Token",
    });
    const line = authFor([{ scheme: "oauth", scopes: [] }], [hostile], {
      credentials: [oauthCredential],
    });

    expect(line).toContain("read (line one line two)");
    expect(/[\n\t]/u.test(line)).toBe(false);
  });

  test("the oauth2 metadata URL is shown and marked never fetched (SSC-10)", () => {
    const withMetadata = scheme("oauth", {
      flows,
      oauth2MetadataUrl: "https://auth.example/.well-known/oauth-authorization-server",
      type: "oauth2Token",
    });
    const line = authFor([{ scheme: "oauth", scopes: [] }], [withMetadata], {
      credentials: [oauthCredential],
    });

    expect(line).toContain(
      "oauth2MetadataUrl https://auth.example/.well-known/oauth-authorization-server (never fetched)",
    );
  });

  test("an openIdConnect scheme shows its discovery URL, marked never fetched (SSC-09)", () => {
    const oidc = scheme("oidc", {
      openIdConnectUrl: "https://id.example/.well-known/openid-configuration",
      type: "oidcToken",
    });
    const line = authFor([{ scheme: "oidc", scopes: [] }], [oidc], {
      credentials: [credential("oidc", "OIDC")],
    });

    expect(
      line.startsWith("oidc (oidc token): --oidc-file <path|->, env ACME_OIDC, TTY prompt"),
    ).toBe(true);
    expect(line).toContain(
      "openIdConnectUrl https://id.example/.well-known/openid-configuration (never fetched)",
    );
  });

  test("required scopes are listed per alternative and marked never sent (SEC-11)", () => {
    const line = authFor([{ scheme: "oauth", scopes: ["read", "write"] }], [oauth], {
      credentials: [oauthCredential],
    });

    expect(line).toContain("required scopes read, write (never sent)");
  });

  test("a hostile required scope is sanitized (SEC-11)", () => {
    const line = authFor([{ scheme: "oauth", scopes: ["read‮evil\u0007"] }], [oauth], {
      credentials: [oauthCredential],
    });

    expect(line).toContain("required scopes readevil (never sent)");
  });

  test("roles of another scheme type are listed and marked never sent (SEC-13)", () => {
    const key = scheme("key", { in: "header", name: "X-Key", type: "apiKey" });
    const line = authFor([{ scheme: "key", scopes: ["admin", "auditor"] }], [key], {
      credentials: [credential("key", "KEY")],
    });

    expect(line).toContain("roles admin, auditor (never sent)");
  });

  test("mutualTLS lists its three env names, no flag and no prompt", () => {
    const client = scheme("client", { type: "mutualTls" }, ["env"]);
    const line = authFor([{ scheme: "client", scopes: [] }], [client], {
      certificates: [
        {
          caEnv: "ACME_CLIENT_CA",
          certEnv: "ACME_CLIENT_CERT",
          keyEnv: "ACME_CLIENT_KEY",
          scheme: "client",
        },
      ],
      credentials: [],
    });

    expect(line.startsWith("client (mutualTls): ")).toBe(true);
    expect(line).toContain("ACME_CLIENT_CERT");
    expect(line).toContain("ACME_CLIENT_KEY");
    expect(line).toContain("ACME_CLIENT_CA");
    expect(line).toContain("presented only to accepted origins");
    expect(line.includes("--")).toBe(false);
    expect(line.includes("TTY prompt")).toBe(false);
  });

  test("an author-supplied scheme keeps its marker", () => {
    const supplied = Schema.decodeUnknownSync(SecurityScheme)({
      credentialSources: tokenSources,
      deprecated: false,
      kind: { flows, type: "oauth2Token" },
      name: "oauth",
      origin,
      rows,
      source: "author-supplied",
    });
    const line = authFor([{ scheme: "oauth", scopes: [] }], [supplied], {
      credentials: [oauthCredential],
    });

    expect(line.startsWith("oauth (oauth2 token) [author-supplied]: --oauth-file")).toBe(true);
  });
});
