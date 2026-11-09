import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { BinRun, GeneratedPackage } from "../support/generated-cli.ts";
import { setEnv } from "../support/env.ts";

// Design 7.4 through the built CLI: the emitted `bin.ts` provides the run-scoped `RunRecord`, so
// the format `recordRun` records is the one `finalCatch` renders in, and the emitted `main.ts`
// passes the env prefix to `finalCatch`, so a parse-time error reads `<PREFIX>_ERROR_FORMAT`.
// Both are read with `Effect.serviceOption` and a text default, so a missing layer or prefix
// compiles and renders text; these cases are the guard (memo 36fb61b3, audit ad9f808b F2). The
// emitted `bin.ts` also provides `RunWarnings`, so the plaintext warning prints once in a run, and
// its client-certificate check renders through a `finalCatch` given the same prefix (audit of
// m3/wi1b, F2 and F3).

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

// Generated packages live under the worktree's git-ignored `work/`, never the system temp directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "run-scoped-program-"));

const restoreTmpdir = setEnv("TMPDIR", work);

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const scope = Effect.runSync(Scope.make());

// One operation with a required query flag and a required JSON body, secured by a header
// credential or a `mutualTLS` client certificate, so `bin.ts` has its client-certificate part.
const spec = {
  components: {
    securitySchemes: {
      client: { type: "mutualTLS" },
      headerKey: { in: "header", name: "X-Key", type: "apiKey" },
    },
  },
  info: { title: "Run scoped", version: "1.0.0" },
  openapi: "3.1.0",
  paths: {
    "/items": {
      post: {
        operationId: "createItem",
        parameters: [{ in: "query", name: "owner", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: { properties: { title: { type: "string" } }, type: "object" },
            },
          },
          required: true,
        },
        responses: { "204": { description: "Created" } },
        security: [{ headerKey: [] }, { client: [] }],
        tags: ["items"],
      },
    },
  },
  servers: [{ url: "https://api.example.com" }],
};

const authorConfig = {
  binName: "runs",
  envPrefix: "RUNS",
  package: { name: "runs-cli", version: "0.1.0" },
  servers: { accepted: ["https://api.example.com"] },
};

const specPath = nodePath.join(work, "openapi.json");

const configPath = nodePath.join(work, "author-config.json");

let generated: GeneratedPackage | undefined;

beforeAll(async () => {
  nodeFs.writeFileSync(specPath, JSON.stringify(spec));
  nodeFs.writeFileSync(configPath, JSON.stringify(authorConfig));
  generated = await Effect.runPromise(
    generateFixture({ configPath, specPath }).pipe(
      Effect.tap(preparePackage),
      Scope.provide(scope),
      Effect.provide(layer),
    ),
  );
}, 900_000);

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  nodeFs.rmSync(work, { force: true, recursive: true });
  restoreTmpdir();
});

const built = (): GeneratedPackage => {
  if (generated === undefined) {
    throw new Error("the run-scoped package was not built");
  }

  return generated;
};

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const run = (
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<BinRun> =>
  Effect.runPromise(
    runBin(built(), { args: ["items", "create-item", ...args], env, timeoutMs: 30_000 }).pipe(
      Effect.provide(layer),
    ),
  );

const ErrorLine = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ kind: Schema.String }) }),
);

// The `kind` of each stderr line that is one `{"error":{...}}` object.
const jsonErrorKinds = (stderr: Uint8Array): readonly string[] =>
  decode(stderr)
    .split("\n")
    .flatMap((line) =>
      Option.match(Schema.decodeUnknownOption(ErrorLine)(line), {
        onNone: () => [],
        onSome: (value) => [value.error.kind],
      }),
    );

// A text error is the `Error:` line or the help's `ERROR` section (design 7.1).
const hasTextError = (stderr: Uint8Array): boolean =>
  decode(stderr)
    .split("\n")
    .some((line) => line.startsWith("Error:") || line === "ERROR");

describe("run-scoped layers: the built CLI", () => {
  test("--error-format json and an invalid --body render one JSON object and no text", async () => {
    const result = await run(["--owner", "o", "--body", "not json", "--error-format", "json"]);

    expect(result.exitCode).toBe(2);
    expect(jsonErrorKinds(result.stderr)).toEqual(["UsageError"]);
    expect(hasTextError(result.stderr)).toBe(false);
  });

  test("without a format an invalid --body renders text", async () => {
    const result = await run(["--owner", "o", "--body", "not json"]);

    expect(result.exitCode).toBe(2);
    expect(jsonErrorKinds(result.stderr)).toEqual([]);
    expect(hasTextError(result.stderr)).toBe(true);
  });

  test("RUNS_ERROR_FORMAT=json and a missing required flag render one JSON object", async () => {
    const result = await run(["--body", "{}"], { RUNS_ERROR_FORMAT: "json" });

    expect(result.exitCode).toBe(2);
    expect(jsonErrorKinds(result.stderr)).toEqual(["MissingOption"]);
    expect(hasTextError(result.stderr)).toBe(false);
  });

  // Each command sends once, so the two sends are the two attempts of a retried 503 in one run.
  // The base is plaintext and not loopback, so the requests reach it through `HTTP_PROXY`.
  test("an http base with a header credential warns once across a retried 503", async () => {
    const seen: string[] = [];
    const proxy = Bun.serve({
      fetch: (request) => {
        seen.push(request.headers.get("x-key") ?? "");

        return new Response("busy", { headers: { "retry-after": "0" }, status: 503 });
      },
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const result = await run(
        [
          "--owner",
          "o",
          "--body",
          "{}",
          "--base-url",
          "http://plain.example.test",
          "--allow-credentials-for-base-url",
          "--retry-unsafe",
          "--retries",
          "1",
        ],
        { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, RUNS_HEADER_KEY: "run-scoped-key" },
      );
      const warnings = decode(result.stderr)
        .split("\n")
        .filter((line) => line.startsWith("Warning:"));

      expect(seen).toEqual(["run-scoped-key", "run-scoped-key"]);
      expect(result.exitCode).not.toBe(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("plain.example.test");
    } finally {
      await proxy.stop(true);
    }
  });

  test("RUNS_ERROR_FORMAT=json and an unreadable certificate path render one JSON object", async () => {
    const missing = nodePath.join(work, "missing.pem");
    const result = await run(["--owner", "o", "--body", "{}"], {
      RUNS_CLIENT_CERT: missing,
      RUNS_CLIENT_KEY: missing,
      RUNS_ERROR_FORMAT: "json",
    });

    expect(result.exitCode).toBe(2);
    expect(jsonErrorKinds(result.stderr)).toEqual(["UsageError"]);
    expect(hasTextError(result.stderr)).toBe(false);
  });
});
