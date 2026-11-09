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
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { resolve } from "../../src/resolve/index.ts";

// A `mutualTLS` scheme carried from the spec to the emitted `api/security.ts` (design 4.4, 6.5,
// D-SEC3): the name plan derives `<PREFIX>_<SCHEME>_CERT`, `_KEY` and `_CA` once, holds them in an
// env-only entry with no `<scheme>-file` flag, and the descriptor carries them as `certEnv`,
// `keyEnv` and `caEnv`. A token scheme beside it keeps its flag-shaped entry.

const root = nodePath.resolve(import.meta.dir, "../..");

const document = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///spec/author-config.json");

const config = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "acme",
  envPrefix: "ACME",
  package: { name: "acme-cli", version: "1.0.0" },
});

const ok: Json = { responses: { "200": { description: "ok" } } };

const spec: Json = {
  components: {
    securitySchemes: {
      bearerAuth: { scheme: "bearer", type: "http" },
      client: { type: "mutualTLS" },
    },
  },
  info: { title: "t", version: "1" },
  openapi: "3.1.1",
  paths: {
    "/me": { get: { ...ok, operationId: "me", security: [{ bearerAuth: [], client: [] }] } },
  },
  servers: [{ url: "https://api.example" }],
};

const emitted = await Effect.runPromise(
  Effect.gen(function* generate() {
    const resolution = yield* resolve({ document, line: "3.1", value: spec });
    const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument });
    const plan = yield* planNames(api, { config, configDocument, strict: false });
    const context = { config, configDocument, document, openapi: api.openapi };
    const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;
    const files = yield* emitApi({ api, boundOrigins: bound, plan });

    return {
      api: files.find((file) => file.path === "src/api/root.ts")?.content,
      content: files.find((file) => file.path === "src/api/security.ts")?.content,
      plan,
    };
  }),
);

const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "security-mtls-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

// The emitted package's runtime sources and `api/security.ts`, in a scratch directory.
const writePackage = (content: string): string => {
  const dir = nodePath.join(work, "package");
  for (const [path, text] of Object.entries(runtimeFiles)) {
    nodeFs.mkdirSync(nodePath.dirname(nodePath.join(dir, "src", path)), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, "src", path), text);
  }

  nodeFs.mkdirSync(nodePath.join(dir, "src/api"), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "src/api/security.ts"), content);
  nodeFs.writeFileSync(
    nodePath.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: generatorTsconfig.compilerOptions, include: ["src"] }),
  );
  nodeFs.symlinkSync(nodePath.join(root, "node_modules"), nodePath.join(dir, "node_modules"));

  return dir;
};

describe("api/security.ts: a mutualTLS scheme", () => {
  test("the plan holds an env-only entry for the scheme and no <scheme>-file flag", () => {
    expect(emitted.plan.diagnostics).toEqual([]);
    expect(emitted.plan.certificates).toEqual([
      {
        caEnv: "ACME_CLIENT_CA",
        certEnv: "ACME_CLIENT_CERT",
        keyEnv: "ACME_CLIENT_KEY",
        scheme: "client",
      },
    ]);
    expect(emitted.plan.credentials).toEqual([
      { env: "ACME_BEARER_AUTH", flag: "bearer-auth-file", scheme: "bearerAuth" },
    ]);
    expect(emitted.plan.credentials.map((credential) => credential.flag)).not.toContain(
      "client-file",
    );
  });

  test("the operation's requirement names the mutualTLS scheme", () => {
    expect(emitted.api).toContain(
      'const meSecurity: SecurityRequirement = [["bearerAuth", "client"]];',
    );
  });

  test("the descriptor carries certEnv, keyEnv and caEnv and satisfies SecurityTable", async () => {
    expect(emitted.content).toBeString();

    const dir = writePackage(emitted.content ?? "");
    const typecheck = Bun.spawnSync(
      [nodePath.join(root, "node_modules/.bin/tsc"), "--noEmit", "-p", "tsconfig.json"],
      { cwd: dir },
    );

    expect(new TextDecoder().decode(typecheck.stdout)).toBe("");
    expect(typecheck.exitCode).toBe(0);

    const loaded: unknown = await import(nodePath.join(dir, "src/api/security.ts"));

    expect(loaded).toHaveProperty("security", {
      schemes: {
        bearerAuth: { env: "ACME_BEARER_AUTH", kind: "http", scheme: "bearer" },
        client: {
          caEnv: "ACME_CLIENT_CA",
          certEnv: "ACME_CLIENT_CERT",
          keyEnv: "ACME_CLIENT_KEY",
          kind: "mutualTLS",
        },
      },
    });
  }, 120_000);
});
