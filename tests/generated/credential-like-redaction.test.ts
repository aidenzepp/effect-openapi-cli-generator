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

// Operator policy 03389f18: `--dry-run` and `--verbose` redact the value of a header parameter or a
// multipart part header whose name contains a credential-like word, whose schema is `format:
// password`, or that carries `x-sensitive: true`. An ordinary header still prints its value, and
// the wire carries every value unchanged.

const specPath = nodePath.resolve(
  import.meta.dir,
  "../fixtures/specs/credential-like-headers.json",
);

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "credential-like-redaction-"));

const capture = startCaptureServer();

const base = capture.origins["127.0.0.1"];

const configPath = nodePath.join(work, "author-config.json");

writeFileSync(
  configPath,
  `${JSON.stringify({
    acceptedOrigins: [base],
    allowInsecure: true,
    binName: "lr",
    envPrefix: "LR",
    package: { name: "credential-like-redaction-cli", version: "0.1.0" },
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

const lines = (text: string) => text.split(/\r?\n/u).filter((line) => line !== "");

const ok = { body: "{}", headers: [["Content-Type", "application/json"]] as const, status: 200 };

// The values one header carried on the wire, by case-insensitive name.
const sent = (request: RecordedRequest | undefined, name: string): readonly string[] =>
  (request?.headers ?? [])
    .filter(([header]) => header.toLowerCase() === name.toLowerCase())
    .map(([, value]) => value);

// One redacted header parameter case: its flag, its wire name and a value no other case uses.
const redactedParameters = [
  {
    flag: "--x-auth-token",
    name: "x-auth-token",
    rule: "a credential-like name",
    value: "tok-7f3a91c2",
  },
  { flag: "--x-pin", name: "x-pin", rule: "a format password schema", value: "pin-58d0e4b6" },
  { flag: "--x-hidden", name: "x-hidden", rule: "x-sensitive: true", value: "hid-c41b9a07" },
] as const;

const ordinary = { flag: "--x-request-id", name: "x-request-id", value: "req-2e6d8f15" };

const parameterArgs = [
  "params-get",
  "--base-url",
  base,
  ...redactedParameters.flatMap(({ flag, value }) => [flag, value]),
  ordinary.flag,
  ordinary.value,
];

describe("header parameters the policy marks sensitive through a generated CLI", () => {
  for (const { name, rule, value } of redactedParameters) {
    test(`${rule}: dry-run prints ${name}: <redacted> and the value appears in neither stream`, async () => {
      const cli = await run([...parameterArgs, "--dry-run"]);

      expect(cli.exitCode).toBe(0);
      expect(cli.requests).toHaveLength(0);
      expect(lines(cli.stdout)).toContain(`${name}: <redacted>`);
      expect(`${cli.stdout}${cli.stderr}`).not.toContain(value);
    }, 30_000);

    test(`${rule}: verbose prints > ${name}: <redacted>, the value appears in neither stream, and the wire carries it`, async () => {
      capture.script("/params", ok);

      const cli = await run([...parameterArgs, "--verbose"]);

      expect(cli.exitCode).toBe(0);
      expect(lines(cli.stderr)).toContain(`> ${name}: <redacted>`);
      expect(`${cli.stdout}${cli.stderr}`).not.toContain(value);
      expect(cli.requests).toHaveLength(1);
      expect(sent(cli.requests[0], name)).toEqual([value]);
    }, 30_000);
  }

  test("an ordinary header parameter still prints its value on dry-run and verbose", async () => {
    const dry = await run([...parameterArgs, "--dry-run"]);
    capture.script("/params", ok);

    const verbose = await run([...parameterArgs, "--verbose"]);

    expect(lines(dry.stdout)).toContain(`${ordinary.name}: ${ordinary.value}`);
    expect(lines(verbose.stderr)).toContain(`> ${ordinary.name}: ${ordinary.value}`);
    expect(sent(verbose.requests[0], ordinary.name)).toEqual([ordinary.value]);
  }, 30_000);
});

// One multipart part header case: its flag, its declared name and a value no other case uses.
const redactedPartHeaders = [
  {
    flag: "--note-x-part-token",
    name: "X-Part-Token",
    rule: "a credential-like name",
    value: "ptok-91ac3e57",
  },
  {
    flag: "--note-x-part-pin",
    name: "X-Part-Pin",
    rule: "a format password schema",
    value: "ppin-06f2b8d4",
  },
  {
    flag: "--note-x-part-hidden",
    name: "X-Part-Hidden",
    rule: "x-sensitive: true",
    value: "phid-7d15c3a9",
  },
] as const;

const ordinaryPart = { flag: "--note-x-part-trace", name: "X-Part-Trace", value: "ptrc-3b8e0f62" };

const uploadArgs = [
  "upload-post",
  "--base-url",
  base,
  "--note",
  "hello",
  ...redactedPartHeaders.flatMap(({ flag, value }) => [flag, value]),
  ordinaryPart.flag,
  ordinaryPart.value,
];

describe("multipart part headers the policy marks sensitive through a generated CLI", () => {
  for (const { name, rule, value } of redactedPartHeaders) {
    test(`${rule}: dry-run prints the part head ${name}: <redacted> and the value appears in neither stream`, async () => {
      const cli = await run([...uploadArgs, "--dry-run"]);

      expect(cli.exitCode).toBe(0);
      expect(cli.requests).toHaveLength(0);
      expect(lines(cli.stdout)).toContain(`${name}: <redacted>`);
      expect(`${cli.stdout}${cli.stderr}`).not.toContain(value);
    }, 30_000);

    test(`${rule}: verbose prints no part value and the wire carries it`, async () => {
      capture.script("/upload", ok);

      const cli = await run([...uploadArgs, "--verbose"]);
      const body = decode(cli.requests[0]?.body ?? new Uint8Array());

      expect(cli.exitCode).toBe(0);
      expect(`${cli.stdout}${cli.stderr}`).not.toContain(value);
      expect(cli.requests).toHaveLength(1);
      expect(body).toContain(`${name}: ${value}`);
    }, 30_000);
  }

  test("an ordinary part header still prints its value on dry-run", async () => {
    const cli = await run([...uploadArgs, "--dry-run"]);

    expect(lines(cli.stdout)).toContain(`${ordinaryPart.name}: ${ordinaryPart.value}`);
  }, 30_000);
});
