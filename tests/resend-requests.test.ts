import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Layer, Schema, Scope } from "effect";
import { startCaptureServer } from "./fixtures/capture-server.ts";
import type { HeaderList } from "./fixtures/capture-server.ts";
import { generateFixture, preparePackage } from "./support/generated-cli.ts";
import type { GeneratedPackage } from "./support/generated-cli.ts";

// The Milestone 1 witness (CP-4), request half: the generated Resend CLI, pointed at the capture
// server with `--base-url`, puts exactly these bytes on the wire (method, raw target, headers in
// order, body), one request per invocation.

const root = nodePath.resolve(import.meta.dir, "..");

const specPath = nodePath.join(
  homedir(),
  ".cache/effect-openapi-cli-generator/corpus/resend/0b2a456/resend.json",
);

const configPath = nodePath.join(root, "corpus/config/resend.json");

const token = "re_witness_token";

// Operator bytes the CLI must send verbatim: key order and whitespace are not its own.
const bodyFileBytes =
  '{ "to": ["b@example.test"],\n  "from": "a@example.test", "subject": "Hi" }\n';

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const PackageBin = Schema.Struct({ bin: Schema.Record(Schema.String, Schema.String) });

interface Prepared {
  readonly bin: string;
  readonly bodyFile: string;
  readonly generated: GeneratedPackage;
}

interface CliRun {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface WireRequest {
  readonly body: string;
  readonly headers: HeaderList;
  readonly method: string;
  readonly target: string;
}

const scope = Effect.runSync(Scope.make());

const server = startCaptureServer();

const origin = server.origins["127.0.0.1"];

const { host } = new URL(origin);

const ready = Promise.withResolvers<Prepared>();

const prepare = Effect.gen(function* prepareGen() {
  const fs = yield* FileSystem.FileSystem;
  const generated = yield* generateFixture({ configPath, specPath });
  yield* preparePackage(generated);

  const manifest = yield* fs.readFileString(nodePath.join(generated.dir, "package.json"));
  const { bin } = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageBin))(manifest);
  const bodyFile = nodePath.join(generated.root, "email.json");
  yield* fs.writeFileString(bodyFile, bodyFileBytes);

  return {
    bin: nodePath.join(generated.dir, ...(bin.resend ?? "").split("/")),
    bodyFile,
    generated,
  };
});

beforeAll(async () => {
  ready.resolve(await Effect.runPromise(prepare.pipe(Scope.provide(scope), Effect.provide(layer))));
}, 600_000);

afterAll(async () => {
  server.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

// `runBin` spawns synchronously, which blocks this process's event loop and so the in-process
// capture server; the bin runs as a child process here and the server keeps answering.
const runCli = (args: readonly string[]): Promise<CliRun> =>
  ready.promise.then(async (prepared) => {
    const child = Bun.spawn(
      [
        process.execPath,
        prepared.bin,
        "--base-url",
        origin,
        "--allow-credentials-for-base-url",
        ...args,
      ],
      {
        cwd: prepared.generated.dir,
        env: { RESEND_BEARER_AUTH: token },
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
        timeout: 30_000,
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).bytes(),
      new Response(child.stderr).bytes(),
    ]);

    return { exitCode, stderr: latin1(stderr), stdout: latin1(stdout) };
  });

// One invocation and the requests the server recorded during it.
const exchange = async (args: readonly string[]) => {
  const before = server.requests().length;
  const run = await runCli(args);
  const requests: readonly WireRequest[] = server
    .requests()
    .slice(before)
    .map((request) => ({
      body: latin1(request.body),
      headers: request.headers,
      method: request.method,
      target: request.target,
    }));

  return { requests, run };
};

const json = (body: string) => ({
  body,
  headers: [["Content-Type", "application/json"]] as const,
});

// Bun's own headers (Connection, Host, Accept-Encoding) are the design's allowlist (§6.2).
const getHeaders: HeaderList = [
  ["Accept", "application/json"],
  ["Authorization", `Bearer ${token}`],
  ["User-Agent", "resend/0.1.0"],
  ["Connection", "keep-alive"],
  ["Host", host],
  ["Accept-Encoding", "gzip, deflate, br, zstd"],
];

const postHeaders = (idempotencyKey: string, body: string): HeaderList => [
  ["Accept", "application/json"],
  ["Authorization", `Bearer ${token}`],
  ["Content-Type", "application/json"],
  ["User-Agent", "resend/0.1.0"],
  ["idempotency-key", idempotencyKey],
  ["Connection", "keep-alive"],
  ["Host", host],
  ["Accept-Encoding", "gzip, deflate, br, zstd"],
  ["Content-Length", String(Buffer.byteLength(body, "latin1"))],
];

describe("Resend witness: requests on the wire", () => {
  test("a path-parameter GET percent-encodes the id and prints the 2xx body", async () => {
    server.script("/emails/em_1%2Fa%20b", { status: 200, ...json('{"id":"em_1/a b"}') });

    const observed = await exchange(["emails", "get", "em_1/a b"]);

    expect(observed).toEqual({
      requests: [{ body: "", headers: getHeaders, method: "GET", target: "/emails/em_1%2Fa%20b" }],
      run: { exitCode: 0, stderr: "", stdout: '{"id":"em_1/a b"}' },
    });
  }, 60_000);

  // Known gap: the emitter types an array query parameter as one string flag (`Flag.String`,
  // `Flag.optional`), so a repeated `--metrics` is a usage error (exit 2) and no request is sent.
  // `test.failing` passes while that holds and fails once the gap closes; then drop `.failing`.
  test.failing(
    "a list call joins an explode:false form array with unencoded commas",
    async () => {
      const observed = await exchange([
        "emails",
        "metrics",
        "--metrics",
        "sent",
        "--metrics",
        "opened",
      ]);

      expect(observed.run.exitCode).toBe(0);
      expect(observed.requests).toEqual([
        {
          body: "",
          headers: getHeaders,
          method: "GET",
          target: "/emails/metrics?metrics=sent,opened",
        },
      ]);
    },
    60_000,
  );

  test("a POST sends Idempotency-Key and a JSON body built from field flags", async () => {
    const body = '{"from":"a@example.test","subject":"Hi","text":"Hello","to":["b@example.test"]}';
    const observed = await exchange([
      "emails",
      "send",
      "--idempotency-key",
      "idem-flags-1",
      "--from",
      "a@example.test",
      "--to",
      '["b@example.test"]',
      "--subject",
      "Hi",
      "--text",
      "Hello",
    ]);

    expect(observed.requests).toEqual([
      { body, headers: postHeaders("idem-flags-1", body), method: "POST", target: "/emails" },
    ]);
    expect(observed.run.exitCode).toBe(0);
  }, 60_000);

  test("a POST sends the --body-file bytes verbatim with Idempotency-Key", async () => {
    const prepared = await ready.promise;
    const observed = await exchange([
      "emails",
      "send",
      "--idempotency-key",
      "idem-file-1",
      "--body-file",
      prepared.bodyFile,
    ]);

    expect(observed.requests).toEqual([
      {
        body: bodyFileBytes,
        headers: postHeaders("idem-file-1", bodyFileBytes),
        method: "POST",
        target: "/emails",
      },
    ]);
    expect(observed.run.exitCode).toBe(0);
  }, 60_000);

  // Known gap: `contacts/create-import` is refused at generation (`EMT-1/unsupported-body`,
  // multipart request bodies are not emitted yet), so there is no command to send it.
  test.todo("the multipart POST /contacts/imports streams its parts", async () => {
    const observed = await exchange(["contacts", "create-import", "--help"]);

    expect(observed.run.exitCode).toBe(0);
  });

  test("an undeclared 4xx is rendered on stderr with exit 1 after one request", async () => {
    server.script("/emails/em_missing", { status: 422, ...json('{"name":"validation_error"}') });

    const observed = await exchange(["emails", "get", "em_missing"]);

    expect(observed.requests).toEqual([
      { body: "", headers: getHeaders, method: "GET", target: "/emails/em_missing" },
    ]);
    expect({ exitCode: observed.run.exitCode, stdout: observed.run.stdout }).toEqual({
      exitCode: 1,
      stdout: "",
    });
    expect(observed.run.stderr).not.toBe("");
  }, 60_000);
});
