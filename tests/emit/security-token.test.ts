import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { emitApi } from "../../src/emit/api.ts";
import { runtimeFiles } from "../../src/emit/runtime-files.generated.ts";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Server } from "../../src/model/entities.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { Line } from "../../src/validate/index.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { resolve } from "../../src/resolve/index.ts";

// One `oauth2` and one `openIdConnect` scheme, each used by an operation, carried from the spec to
// the emitted `api/security.ts` (design 6.5, D-SEC1): the runtime kinds, the planned names, and the
// flows, URLs, scopes and discovery URL as help-only data.

const root = nodePath.resolve(import.meta.dir, "../..");

const document = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///spec/author-config.json");

const config = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "example",
  package: { name: "example-cli", version: "1.0.0" },
});

const ok: Json = { responses: { "200": { description: "ok" } } };

const spec: Json = {
  components: {
    securitySchemes: {
      oidcAuth: {
        openIdConnectUrl: "https://a.example/.well-known/openid-configuration",
        type: "openIdConnect",
      },
      petAuth: {
        flows: {
          authorizationCode: {
            authorizationUrl: "https://a.example/authorize",
            refreshUrl: "https://a.example/refresh",
            scopes: { "pets:read": "Read pets", "pets:write": "Write pets" },
            tokenUrl: "https://a.example/token",
          },
          clientCredentials: {
            scopes: { admin: "Administer the store" },
            tokenUrl: "https://a.example/token",
          },
        },
        type: "oauth2",
      },
    },
  },
  info: { title: "t", version: "1" },
  openapi: "3.1.1",
  paths: {
    "/me": { get: { ...ok, operationId: "me", security: [{ petAuth: ["pets:read"] }] } },
    "/who": { get: { ...ok, operationId: "who", security: [{ oidcAuth: [] }] } },
  },
  servers: [{ url: "https://api.example" }],
};

// A 3.2 `deviceAuthorization` flow: its `deviceAuthorizationUrl` is help-only data like the other
// flow URLs (OAF-09, design 9 I3).
const deviceSpec: Json = {
  components: {
    securitySchemes: {
      deviceAuth: {
        flows: {
          deviceAuthorization: {
            deviceAuthorizationUrl: "https://a.example/device",
            scopes: { "pets:read": "Read pets" },
            tokenUrl: "https://a.example/token",
          },
        },
        type: "oauth2",
      },
    },
  },
  info: { title: "t", version: "1" },
  openapi: "3.2.0",
  paths: {
    "/me": { get: { ...ok, operationId: "me", security: [{ deviceAuth: ["pets:read"] }] } },
  },
  servers: [{ url: "https://api.example" }],
};

const emitSecurity = (value: Json, line: Line) =>
  Effect.gen(function* generate() {
    const resolution = yield* resolve({ document, line, value });
    const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument });
    const plan = yield* planNames(api, { config, configDocument, strict: false });
    const context = { config, configDocument, document, openapi: api.openapi };
    const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;
    const files = yield* emitApi({ api, boundOrigins: bound, plan });

    return { content: files.find((file) => file.path === "src/api/security.ts")?.content, plan };
  });

const emitted = await Effect.runPromise(emitSecurity(spec, "3.1"));

const emittedDevice = await Effect.runPromise(emitSecurity(deviceSpec, "3.2"));

const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "security-token-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

// The emitted package's runtime sources and its security tables, in a scratch directory.
const writePackage = (tables: Readonly<Record<string, string>>): string => {
  const dir = nodePath.join(work, "package");
  for (const [path, text] of Object.entries(runtimeFiles)) {
    nodeFs.mkdirSync(nodePath.dirname(nodePath.join(dir, "src", path)), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, "src", path), text);
  }

  nodeFs.mkdirSync(nodePath.join(dir, "src/api"), { recursive: true });
  for (const [path, content] of Object.entries(tables)) {
    nodeFs.writeFileSync(nodePath.join(dir, "src/api", path), content);
  }

  nodeFs.writeFileSync(
    nodePath.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: generatorTsconfig.compilerOptions, include: ["src"] }),
  );
  nodeFs.symlinkSync(nodePath.join(root, "node_modules"), nodePath.join(dir, "node_modules"));

  return dir;
};

// One package holding both tables, type-checked once for every test that reads it.
let checked:
  | { readonly dir: string; readonly exitCode: number; readonly stdout: string }
  | undefined;

const typecheckedPackage = () => {
  if (checked === undefined) {
    const dir = writePackage({
      "security-device.ts": emittedDevice.content ?? "",
      "security.ts": emitted.content ?? "",
    });
    const typecheck = Bun.spawnSync(
      [nodePath.join(root, "node_modules/.bin/tsc"), "--noEmit", "-p", "tsconfig.json"],
      { cwd: dir },
    );
    checked = {
      dir,
      exitCode: typecheck.exitCode,
      stdout: new TextDecoder().decode(typecheck.stdout),
    };
  }

  return checked;
};

describe("api/security.ts: oauth2 and openIdConnect token schemes", () => {
  test("the plan names <scheme>-file and <PREFIX>_<SCHEME> for each scheme", () => {
    expect(emitted.plan.credentials).toEqual([
      { env: "EXAMPLE_OIDC_AUTH", flag: "oidc-auth-file", scheme: "oidcAuth" },
      { env: "EXAMPLE_PET_AUTH", flag: "pet-auth-file", scheme: "petAuth" },
    ]);
  });

  test("the table carries the kinds, names and help-only data, and satisfies SecurityTable", async () => {
    expect(emitted.content).toBeString();

    const { dir, exitCode, stdout } = typecheckedPackage();

    expect(stdout).toBe("");
    expect(exitCode).toBe(0);

    const loaded: unknown = await import(nodePath.join(dir, "src/api/security.ts"));

    expect(loaded).toHaveProperty("security", {
      schemes: {
        oidcAuth: {
          env: "EXAMPLE_OIDC_AUTH",
          kind: "openIdConnect",
          openIdConnectUrl: "https://a.example/.well-known/openid-configuration",
        },
        petAuth: {
          env: "EXAMPLE_PET_AUTH",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://a.example/authorize",
              refreshUrl: "https://a.example/refresh",
              scopes: [
                { description: "Read pets", name: "pets:read" },
                { description: "Write pets", name: "pets:write" },
              ],
              tokenUrl: "https://a.example/token",
            },
            clientCredentials: {
              scopes: [{ description: "Administer the store", name: "admin" }],
              tokenUrl: "https://a.example/token",
            },
          },
          kind: "oauth2",
        },
      },
    });
  }, 120_000);

  test("a 3.2 deviceAuthorization flow carries its deviceAuthorizationUrl and type-checks", async () => {
    expect(emittedDevice.content).toBeString();

    const { dir, exitCode, stdout } = typecheckedPackage();

    expect(stdout).toBe("");
    expect(exitCode).toBe(0);

    const loaded: unknown = await import(nodePath.join(dir, "src/api/security-device.ts"));

    expect(loaded).toHaveProperty("security", {
      schemes: {
        deviceAuth: {
          env: "EXAMPLE_DEVICE_AUTH",
          flows: {
            deviceAuthorization: {
              deviceAuthorizationUrl: "https://a.example/device",
              scopes: [{ description: "Read pets", name: "pets:read" }],
              tokenUrl: "https://a.example/token",
            },
          },
          kind: "oauth2",
        },
      },
    });
  }, 120_000);
});
