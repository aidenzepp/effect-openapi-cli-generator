import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Scope } from "effect";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// Probe 0ff001da: a `Proxy-Authorization` value set through an operation header parameter, with no
// apiKey scheme naming it, printed unredacted on `--dry-run` and `--verbose`. Every credential
// header name is redacted in output whatever route set it; the wire still carries the value.

const specPath = nodePath.resolve(
  import.meta.dir,
  "../fixtures/specs/proxy-authorization-param.json",
);

const secret = "c2VjcmV0OnNlY3JldA==";

const value = `Basic ${secret}`;

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "credential-redaction-"));

const capture = startCaptureServer();

const base = capture.origins["127.0.0.1"];

const configPath = nodePath.join(work, "author-config.json");

writeFileSync(
  configPath,
  `${JSON.stringify({
    acceptedOrigins: [base],
    allowInsecure: true,
    binName: "lp",
    envPrefix: "LP",
    package: { name: "credential-redaction-cli", version: "0.1.0" },
  })}\n`,
);

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

interface CliRun {
  readonly exitCode: number | null;
  readonly requests: readonly RecordedRequest[];
  readonly stderr: string;
  readonly stdout: string;
}

const run = async (args: readonly string[]): Promise<CliRun> => {
  const generated = await ready.promise;
  const requestsBefore = capture.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, { args, timeoutMs: 30_000 }).pipe(Effect.provide(layer)),
  );

  return {
    exitCode: result.exitCode,
    requests: capture.requests().slice(requestsBefore),
    stderr: decode(result.stderr),
    stdout: decode(result.stdout),
  };
};

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

const args = ["params-get", "--base-url", base, "--proxy-authorization", value];

describe("a Proxy-Authorization header parameter through a generated CLI", () => {
  test("dry-run prints proxy-authorization: <redacted> and the value appears in neither stream", async () => {
    const cli = await run([...args, "--dry-run"]);

    expect(cli.exitCode).toBe(0);
    expect(cli.requests).toHaveLength(0);
    expect(lines(cli.stdout)).toContain("proxy-authorization: <redacted>");
    expect(`${cli.stdout}${cli.stderr}`).not.toContain(secret);
  }, 30_000);

  test("verbose prints > proxy-authorization: <redacted>, the value appears in neither stream, and the wire carries it", async () => {
    capture.script("/params", {
      body: "{}",
      headers: [["Content-Type", "application/json"]],
      status: 200,
    });

    const cli = await run([...args, "--verbose"]);
    const [request] = cli.requests;
    const sent = (request?.headers ?? []).filter(
      ([name]) => name.toLowerCase() === "proxy-authorization",
    );

    expect(cli.exitCode).toBe(0);
    expect(lines(cli.stderr)).toContain("> proxy-authorization: <redacted>");
    expect(`${cli.stdout}${cli.stderr}`).not.toContain(secret);
    expect(cli.requests).toHaveLength(1);
    expect(sent.map(([, header]) => header)).toEqual([value]);
  }, 30_000);
});
