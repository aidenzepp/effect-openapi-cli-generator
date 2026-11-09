import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { HeaderList, RecordedRequest, ScriptedResponse } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// Milestone 3 retry witness (design D-AD7, 7.4, 13.3 SP1; spike S3): one generated package from
// `retry.json`, run against the capture server's per-path response sequences. Retried methods and
// statuses, the Retry-After wait and its cap at the effective --timeout, --retries, --retry-unsafe,
// a declared Idempotency-Key, the one-shot stdin body, the file body re-sent byte-equal, the
// header timeout and <PREFIX>_RETRIES, each read from the attempts the server recorded and the
// bin's exit code, stdout and stderr.

const specPath = nodePath.resolve(import.meta.dir, "../fixtures/specs/retry.json");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "ws2-retry-"));

const configPath = nodePath.join(work, "author-config.json");

writeFileSync(
  configPath,
  `${JSON.stringify({
    binName: "retry",
    envPrefix: "RETRY",
    package: { name: "retry-cli", version: "0.1.0" },
  })}\n`,
);

// 256 KiB of a fixed, non-repeating-per-line byte pattern (spike S3's size).
const blob = Uint8Array.from({ length: 256 * 1024 }, (_, index) => (index * 31 + 7) % 251);

const blobPath = nodePath.join(work, "blob.bin");

writeFileSync(blobPath, blob);

const capture = startCaptureServer();

const base = capture.origins["127.0.0.1"];

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

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// The global flags first, then the group's operation and its arguments.
const command = (...rest: readonly string[]) => [
  "--base-url",
  base,
  "--error-format",
  "json",
  ...rest,
];

// The `--error-format json` object (design 7.4); `retryAfter` and `status` only on an
// ApiResponseError.
const ErrorLine = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      kind: Schema.String,
      message: Schema.String,
      retryAfter: Schema.optionalKey(Schema.Number),
      status: Schema.optionalKey(Schema.Number),
    }),
  }),
);

type ErrorObject = (typeof ErrorLine.Type)["error"];

// The TransportError reason is the literal its message names (design 7.1); a retry hint may follow.
const transportReason = /: (?<reason>aborted|connect|dns|timeout|tls)\b/u;

interface Exchange {
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly error: ErrorObject | undefined;
  readonly exitCode: number | null;
  readonly reason: string | undefined;
  readonly retryNotes: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

const errorOf = (stderr: string): ErrorObject | undefined => {
  const parsed = Schema.decodeUnknownOption(ErrorLine)(stderr.trim().split("\n").at(-1) ?? "");

  return parsed._tag === "Some" ? parsed.value.error : undefined;
};

// Runs the bin once against `path`'s scripted sequence and counts the attempts the server saw.
const exchange = async (
  path: string,
  args: readonly string[],
  options: { readonly env?: Readonly<Record<string, string>>; readonly stdin?: Uint8Array } = {},
): Promise<Exchange> => {
  const generated = await ready.promise;
  const before = capture.count(path);
  const started = performance.now();
  const run = await Effect.runPromise(
    runBin(generated, {
      args,
      env: options.env ?? {},
      stdin: options.stdin ?? new Uint8Array(),
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );
  const elapsedMs = performance.now() - started;
  const stderr = decode(run.stderr);
  const error = errorOf(stderr);

  return {
    attempts: capture.count(path) - before,
    elapsedMs,
    error,
    exitCode: run.exitCode,
    reason:
      error?.kind === "TransportError"
        ? transportReason.exec(error.message)?.groups?.reason
        : undefined,
    retryNotes: stderr.split("\n").filter((line) => line.startsWith("Notice: retrying ")).length,
    stderr,
    stdout: decode(run.stdout),
    timedOut: run.timedOut,
  };
};

// A JSON object body of scalar fields, as every fixture operation answers.
type JsonBody = Readonly<Record<string, number | string>>;

const json = (body: JsonBody, headers: HeaderList = []): ScriptedResponse => ({
  body: JSON.stringify(body),
  headers: [["Content-Type", "application/json"], ...headers],
  status: 200,
});

const unavailable = (headers: HeaderList = []): ScriptedResponse => ({
  body: "",
  headers,
  status: 503,
});

const headerOf = (request: RecordedRequest, name: string) =>
  request.headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1];

const recordedFor = (path: string) =>
  capture.requests().filter((request) => request.target.split("?")[0] === path);

describe("retry policy through a generated CLI", () => {
  test("retry: GET after a 503 with Retry-After: 1 waits the second and succeeds on attempt 2 with one retry note", async () => {
    capture.sequence("/items/after-one", [
      unavailable([["Retry-After", "1"]]),
      json({ id: "after-one" }),
    ]);

    const observed = await exchange("/items/after-one", command("items", "get", "after-one"));

    expect(observed.exitCode).toBe(0);
    expect(observed.attempts).toBe(2);
    expect(observed.retryNotes).toBe(1);
    expect(JSON.parse(observed.stdout)).toEqual({ id: "after-one" });
    expect(observed.elapsedMs).toBeGreaterThanOrEqual(1000);
  }, 30_000);

  test("retry: GET after a 503 with Retry-After: 2 and --timeout 1 is attempted once, exits 1 and the error names the server's 2 seconds", async () => {
    capture.sequence("/items/capped", [
      unavailable([["Retry-After", "2"]]),
      json({ id: "capped" }),
    ]);

    const observed = await exchange(
      "/items/capped",
      command("--timeout", "1", "items", "get", "capped"),
    );

    expect(observed.exitCode).toBe(1);
    expect(observed.attempts).toBe(1);
    expect(observed.retryNotes).toBe(0);
    expect(observed.error).toMatchObject({ kind: "ApiResponseError", retryAfter: 2, status: 503 });
  }, 30_000);

  test("retry: GET after a 503 with Retry-After: 2 and --timeout 0 waits and succeeds on attempt 2", async () => {
    capture.sequence("/items/uncapped", [
      unavailable([["Retry-After", "2"]]),
      json({ id: "uncapped" }),
    ]);

    const observed = await exchange(
      "/items/uncapped",
      command("--timeout", "0", "items", "get", "uncapped"),
    );

    expect(observed.exitCode).toBe(0);
    expect(observed.attempts).toBe(2);
    expect(observed.retryNotes).toBe(1);
    expect(JSON.parse(observed.stdout)).toEqual({ id: "uncapped" });
    expect(observed.elapsedMs).toBeGreaterThanOrEqual(2000);
  }, 30_000);

  test("retry: GET after three 503s with --retries 2 exits 1 after three attempts", async () => {
    capture.sequence("/items/exhausted", [unavailable()]);

    const observed = await exchange(
      "/items/exhausted",
      command("--retries", "2", "items", "get", "exhausted"),
    );

    expect(observed.exitCode).toBe(1);
    expect(observed.attempts).toBe(3);
    expect(observed.retryNotes).toBe(2);
    expect(observed.error).toMatchObject({ kind: "ApiResponseError", status: 503 });
  }, 30_000);

  test("retry: POST after a 503 is not retried", async () => {
    capture.sequence("/orders/plain", [unavailable(), json({ id: "plain" })]);

    const observed = await exchange(
      "/orders/plain",
      command("orders", "create", "plain", "--note", "once"),
    );

    expect(observed.exitCode).toBe(1);
    expect(observed.attempts).toBe(1);
    expect(observed.retryNotes).toBe(0);
    expect(observed.error).toMatchObject({ kind: "ApiResponseError", status: 503 });
  }, 30_000);

  test("retry: POST after a 503 with --retry-unsafe is retried and succeeds on attempt 2", async () => {
    capture.sequence("/orders/unsafe", [unavailable(), json({ id: "unsafe" })]);

    const observed = await exchange(
      "/orders/unsafe",
      command("--retry-unsafe", "orders", "create", "unsafe", "--note", "again"),
    );

    expect(observed.exitCode).toBe(0);
    expect(observed.attempts).toBe(2);
    expect(observed.retryNotes).toBe(1);
    expect(JSON.parse(observed.stdout)).toEqual({ id: "unsafe" });
  }, 30_000);

  test("retry: POST with an operator-supplied declared Idempotency-Key is retried with the same key and body", async () => {
    capture.sequence("/orders/keyed", [unavailable(), json({ id: "keyed" })]);

    const observed = await exchange(
      "/orders/keyed",
      command("orders", "create", "keyed", "--idempotency-key", "key-1", "--note", "keyed"),
    );
    const sent = recordedFor("/orders/keyed").map((request) => ({
      body: decode(request.body),
      key: headerOf(request, "idempotency-key"),
    }));

    expect(observed.exitCode).toBe(0);
    expect(observed.attempts).toBe(2);
    expect(observed.retryNotes).toBe(1);
    expect(sent).toEqual([
      { body: '{"note":"keyed"}', key: "key-1" },
      { body: '{"note":"keyed"}', key: "key-1" },
    ]);
  }, 30_000);

  test("retry: POST --body-file - (stdin) with --retry-unsafe is not retried after a 503 and stderr names unreplayableBody", async () => {
    capture.sequence("/uploads/stdin", [unavailable(), json({ id: "stdin" })]);

    const observed = await exchange(
      "/uploads/stdin",
      command("--retry-unsafe", "uploads", "create", "stdin", "--body-file", "-"),
      { stdin: new TextEncoder().encode("one-shot bytes") },
    );

    expect(observed.exitCode).toBe(1);
    expect(observed.attempts).toBe(1);
    expect(observed.retryNotes).toBe(0);
    expect(observed.stderr).toContain("unreplayableBody");
    expect(observed.error).toMatchObject({ kind: "ApiResponseError", status: 503 });
  }, 30_000);

  test("retry: PUT --body-file <256 KiB file> after an early 503 is re-sent byte-equal with Content-Length on attempt 2", async () => {
    capture.sequence("/blobs/large", [unavailable(), json({ id: "large" })]);

    const observed = await exchange(
      "/blobs/large",
      command("blobs", "replace", "large", "--body-file", blobPath),
    );
    const sent = recordedFor("/blobs/large").map((request) => ({
      chunked: headerOf(request, "transfer-encoding") !== undefined,
      equal: Buffer.from(request.body).equals(blob),
      length: headerOf(request, "content-length"),
    }));

    expect(observed.exitCode).toBe(0);
    expect(observed.attempts).toBe(2);
    expect(observed.retryNotes).toBe(1);
    expect(sent).toEqual([
      { chunked: false, equal: true, length: String(blob.length) },
      { chunked: false, equal: true, length: String(blob.length) },
    ]);
  }, 30_000);

  test("retry: response headers delayed past --timeout 1 exit 4 with reason timeout", async () => {
    capture.sequence("/items/slow", [{ ...json({ id: "slow" }), headerDelayMs: 3000 }]);

    const observed = await exchange(
      "/items/slow",
      command("--timeout", "1", "--retries", "0", "items", "get", "slow"),
    );

    expect(observed.exitCode).toBe(4);
    expect(observed.timedOut).toBe(false);
    expect(observed.attempts).toBe(1);
    expect(observed.error?.kind).toBe("TransportError");
    expect(observed.reason).toBe("timeout");
  }, 30_000);

  test("retry: RETRY_RETRIES=0 disables retry", async () => {
    capture.sequence("/items/disabled", [unavailable(), json({ id: "disabled" })]);

    const observed = await exchange("/items/disabled", command("items", "get", "disabled"), {
      env: { RETRY_RETRIES: "0" },
    });

    expect(observed.exitCode).toBe(1);
    expect(observed.attempts).toBe(1);
    expect(observed.retryNotes).toBe(0);
    expect(observed.error).toMatchObject({ kind: "ApiResponseError", status: 503 });
  }, 30_000);

  test("RSP-04 (retry-after): a 200 declaring X-RateLimit-Remaining and Retry-After prints only the body on stdout and is not retried", async () => {
    capture.sequence("/quota", [
      json({ used: 3 }, [
        ["X-RateLimit-Remaining", "7"],
        ["Retry-After", "30"],
      ]),
    ]);

    const observed = await exchange("/quota", command("quota", "get"));

    expect(observed.exitCode).toBe(0);
    expect(observed.attempts).toBe(1);
    expect(observed.retryNotes).toBe(0);
    expect(JSON.parse(observed.stdout)).toEqual({ used: 3 });
    expect(observed.stdout).not.toContain("RateLimit");
    expect(observed.stdout).not.toContain("Retry-After");
  }, 30_000);
});
