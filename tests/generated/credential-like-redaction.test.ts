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
  {
    flag: "--x-pins",
    name: "x-pins",
    rule: "an array of format password strings",
    value: "pins-d8a24f13",
  },
  {
    flag: "--x-shield",
    name: "x-shield",
    rule: "x-sensitive: true on the schema",
    value: "shd-6b0e93c7",
  },
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
  {
    flag: "--note-x-part-shield",
    name: "X-Part-Shield",
    rule: "x-sensitive: true on the schema",
    value: "pshd-2f71e0b8",
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

// Every word of the policy's name list, each in mixed case inside a longer header name, with the
// flag the generator folds it to and a value no other row uses. Deleting any one word from
// `Auth.credentialLikeName` turns its row red.
const policyWords = [
  { flag: "--x-hdr-to-ke-n-value", name: "X-Hdr-ToKeN-Value", value: "w01-5c9e", word: "token" },
  { flag: "--x-hdr-se-cr-et-value", name: "X-Hdr-SeCrEt-Value", value: "w02-a7d1", word: "secret" },
  {
    flag: "--x-hdr-pa-ss-wo-rd-value",
    name: "X-Hdr-PaSsWoRd-Value",
    value: "w03-3f8b",
    word: "password",
  },
  { flag: "--x-hdr-pa-ss-wd-value", name: "X-Hdr-PaSsWd-Value", value: "w04-e214", word: "passwd" },
  {
    flag: "--x-hdr-ap-i-ke-y-value",
    name: "X-Hdr-ApI-KeY-Value",
    value: "w05-60ca",
    word: "api-key",
  },
  { flag: "--x-hdr-ap-ik-ey-value", name: "X-Hdr-ApIkEy-Value", value: "w06-b93f", word: "apikey" },
  {
    flag: "--x-hdr-ap-i-k-ey-value",
    name: "X-Hdr-ApI_kEy-Value",
    value: "w07-1d47",
    word: "api_key",
  },
  { flag: "--x-hdr-au-th-value", name: "X-Hdr-AuTh-Value", value: "w08-8e05", word: "auth" },
  {
    flag: "--x-hdr-se-ss-io-n-value",
    name: "X-Hdr-SeSsIoN-Value",
    value: "w09-c2a6",
    word: "session",
  },
  {
    flag: "--x-hdr-cr-ed-en-ti-al-value",
    name: "X-Hdr-CrEdEnTiAl-Value",
    value: "w10-47fd",
    word: "credential",
  },
  {
    flag: "--x-hdr-si-gn-at-ur-e-value",
    name: "X-Hdr-SiGnAtUrE-Value",
    value: "w11-9b30",
    word: "signature",
  },
] as const;

// Names that come close to the list without containing a word: their values still print.
const nearMisses = [
  { flag: "--x-request-id", name: "X-Request-Id", value: "nm1-2a6e" },
  { flag: "--r2-access-key-id", name: "R2-Access-Key-Id", value: "nm2-f0c4" },
] as const;

const wordArgs = [
  "words-get",
  "--base-url",
  base,
  ...[...policyWords, ...nearMisses].flatMap(({ flag, value }) => [flag, value]),
];

describe("every policy word redacts a header parameter that contains it", () => {
  for (const { name, value, word } of policyWords) {
    test(`${word} in ${name}: dry-run and verbose print <redacted>, the wire carries the value`, async () => {
      const dry = await run([...wordArgs, "--dry-run"]);
      capture.script("/words", ok);

      const verbose = await run([...wordArgs, "--verbose"]);
      const header = name.toLowerCase();

      expect(dry.exitCode).toBe(0);
      expect(lines(dry.stdout)).toContain(`${header}: <redacted>`);
      expect(verbose.exitCode).toBe(0);
      expect(lines(verbose.stderr)).toContain(`> ${header}: <redacted>`);
      expect(`${dry.stdout}${dry.stderr}${verbose.stdout}${verbose.stderr}`).not.toContain(value);
      expect(sent(verbose.requests[0], name)).toEqual([value]);
    }, 30_000);
  }

  for (const { name, value } of nearMisses) {
    test(`near miss ${name}: dry-run and verbose still print its value`, async () => {
      const dry = await run([...wordArgs, "--dry-run"]);
      capture.script("/words", ok);

      const verbose = await run([...wordArgs, "--verbose"]);
      const header = name.toLowerCase();

      expect(lines(dry.stdout)).toContain(`${header}: ${value}`);
      expect(lines(verbose.stderr)).toContain(`> ${header}: ${value}`);
      expect(sent(verbose.requests[0], name)).toEqual([value]);
    }, 30_000);
  }
});

// Response headers under --verbose (operator rulings 57f4ca85): a credential-like name is redacted,
// the WWW-Authenticate and Proxy-Authenticate challenges still print, Set-Cookie stays redacted.
const sessionToken = "rsp-4c19e7a2";

const challenges = [
  { name: "www-authenticate", value: 'Bearer realm="wwwx-81d3"' },
  { name: "proxy-authenticate", value: 'Basic realm="prxx-5e60"' },
] as const;

const cookie = "ck-0a9f37d5";

const challenged = {
  ...ok,
  headers: [
    ["Content-Type", "application/json"],
    ["X-Session-Token", sessionToken],
    ["WWW-Authenticate", challenges[0].value],
    ["Proxy-Authenticate", challenges[1].value],
    ["Set-Cookie", `sid=${cookie}`],
  ] as const,
};

describe("response headers under --verbose", () => {
  test("a credential-like response header prints < x-session-token: <redacted> and its value appears in neither stream", async () => {
    capture.script("/params", challenged);

    const cli = await run([...parameterArgs, "--verbose"]);

    expect(cli.exitCode).toBe(0);
    expect(lines(cli.stderr)).toContain("< x-session-token: <redacted>");
    expect(`${cli.stdout}${cli.stderr}`).not.toContain(sessionToken);
    expect(`${cli.stdout}${cli.stderr}`).not.toContain(cookie);
  }, 30_000);

  for (const { name, value } of challenges) {
    test(`the ${name} challenge still prints its value`, async () => {
      capture.script("/params", challenged);

      const cli = await run([...parameterArgs, "--verbose"]);

      expect(cli.exitCode).toBe(0);
      expect(lines(cli.stderr)).toContain(`< ${name}: ${value}`);
    }, 30_000);
  }
});
