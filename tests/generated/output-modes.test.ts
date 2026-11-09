import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, Exit, Layer, Order, Schema, Scope } from "effect";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { HeaderList, RecordedRequest, ScriptedResponse } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// Milestone 3 output-mode witness (design 4.6 DM3-8, 7.1, 7.4 revision 9, 7.5, D-OUT3, D-AD7):
// one generated package from `output-modes.json`, run against the capture server. `--dry-run`
// prints the request without connecting, `--verbose` adds request and response summaries to
// stderr only, and `--error-format json` writes one object with the documented keys and exit code
// for an API error (with and without the declared request-id header), a transport failure, a
// missing credential, a usage error and a 503 whose Retry-After exceeds --timeout.

const specPath = nodePath.resolve(import.meta.dir, "../fixtures/specs/output-modes.json");

const token = "ws5-bearer-token-value";

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "ws5-output-modes-"));

const capture = startCaptureServer();

const base = capture.origins["127.0.0.1"];

const configPath = nodePath.join(work, "author-config.json");

writeFileSync(
  configPath,
  `${JSON.stringify({
    acceptedOrigins: [base],
    allowInsecure: true,
    binName: "om",
    envPrefix: "OM",
    package: { name: "output-modes-cli", version: "0.1.0" },
  })}\n`,
);

// A loopback port nothing listens on: a listener is opened for a free port and stopped at once.
const deadBase = (() => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  const { port } = listener;
  listener.stop(true);

  return `http://127.0.0.1:${port}`;
})();

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

const credential = { OM_TOKEN: token } as const;

interface CliRun {
  readonly connections: number;
  readonly exitCode: number | null;
  readonly requests: readonly RecordedRequest[];
  readonly stderr: string;
  readonly stdout: string;
}

// Runs the bin once and reports the connections opened and the requests recorded during the run.
const run = async (
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<CliRun> => {
  const generated = await ready.promise;
  const connectionsBefore = capture.connections();
  const requestsBefore = capture.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, { args, env, timeoutMs: 30_000 }).pipe(Effect.provide(layer)),
  );

  return {
    connections: capture.connections() - connectionsBefore,
    exitCode: result.exitCode,
    requests: capture.requests().slice(requestsBefore),
    stderr: decode(result.stderr),
    stdout: decode(result.stdout),
  };
};

// A JSON object body of string fields, as every fixture response answers.
type JsonBody = Readonly<Record<string, string>>;

const json = (status: number, body: JsonBody, headers: HeaderList = []): ScriptedResponse => ({
  body: JSON.stringify(body),
  headers: [["Content-Type", "application/json"], ...headers],
  status,
});

// The `--error-format json` object (design 7.4): every key optional but `kind` and `message`.
const ErrorLine = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      body: Schema.optionalKey(Schema.String),
      kind: Schema.String,
      matched: Schema.optionalKey(Schema.String),
      message: Schema.String,
      operation: Schema.optionalKey(Schema.String),
      requestId: Schema.optionalKey(Schema.String),
      retryAfter: Schema.optionalKey(Schema.Number),
      status: Schema.optionalKey(Schema.Number),
    }),
  }),
);

const decodeErrorLine = Schema.decodeUnknownSync(ErrorLine);

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

// The JSON object a run wrote: exactly one stderr line is an object, and it is the last line.
const errorObject = (stderr: string) => {
  const written = lines(stderr);
  const objects = written.filter((line) => line.startsWith("{"));
  expect(objects).toHaveLength(1);
  expect(written.at(-1)).toBe(objects[0]);

  return decodeErrorLine(objects[0]).error;
};

type ErrorObject = (typeof ErrorLine.Type)["error"];

const keysOf = (error: ErrorObject) => Arr.sort(Object.keys(error), Order.String);

// A `--dry-run` print: the request line, the header lines in order, and the body after the blank.
const dryRunParts = (stdout: string) => {
  const blank = stdout.indexOf("\n\n");
  const head = blank === -1 ? stdout : stdout.slice(0, blank);
  const [requestLine = "", ...headerLines] = head.split("\n");

  return { body: blank === -1 ? "" : stdout.slice(blank + 2), headerLines, requestLine };
};

const headerName = (line: string) => line.slice(0, line.indexOf(":")).toLowerCase();

// `--verbose` request blocks: the `> ` lines after each `> METHOD` line, prefix removed.
const verboseRequestHeaders = (stderr: string) =>
  lines(stderr)
    .filter((line) => line.startsWith("> "))
    .map((line) => line.slice(2))
    .filter((line) => !/^[A-Z]+ \S+ HTTP\/1\.1$/u.test(line));

describe("--dry-run through a generated CLI", () => {
  test("dry-run: GET with no credential configured prints the request with <redacted:token>, exits 0 and opens no connection", async () => {
    capture.script("/widgets/w1", json(200, { id: "w1" }));

    const cli = await run([
      "--base-url",
      base,
      "--dry-run",
      "widgets",
      "get",
      "w1",
      "--x-trace",
      "trace-1",
    ]);
    const printed = dryRunParts(cli.stdout);

    expect(cli.exitCode).toBe(0);
    expect(cli.connections).toBe(0);
    expect(cli.requests).toHaveLength(0);
    expect(printed.requestLine).toBe(`GET ${base}/widgets/w1 HTTP/1.1`);
    expect(printed.headerLines).toContain("authorization: Bearer <redacted:token>");
    expect(printed.headerLines).toContain("x-trace: trace-1");
    expect(printed.body).toBe("");
    expect(cli.stderr).toBe("");
  }, 30_000);

  test("dry-run: GET with the credential configured prints only the placeholder, never the token, and opens no connection", async () => {
    capture.script("/widgets/w2", json(200, { id: "w2" }));

    const cli = await run(["--base-url", base, "--dry-run", "widgets", "get", "w2"], credential);
    const printed = dryRunParts(cli.stdout);

    expect(cli.exitCode).toBe(0);
    expect(cli.connections).toBe(0);
    expect(cli.requests).toHaveLength(0);
    expect(printed.headerLines).toContain("authorization: Bearer <redacted:token>");
    expect(`${cli.stdout}${cli.stderr}`).not.toContain(token);
  }, 30_000);

  test("dry-run: the printed headers are the ones a real send carries, in the order --verbose prints them", async () => {
    capture.script("/widgets/w3", json(200, { id: "w3" }));

    const args = ["--base-url", base, "widgets", "get", "w3", "--x-trace", "trace-3"];
    const dry = await run(["--dry-run", ...args], credential);
    const sent = await run(["--verbose", ...args], credential);
    const printedNames = dryRunParts(dry.stdout).headerLines.map(headerName);
    const verboseNames = verboseRequestHeaders(sent.stderr).map(headerName);
    const [request] = sent.requests;
    const receivedNames = new Set((request?.headers ?? []).map(([name]) => name.toLowerCase()));

    expect(dry.connections).toBe(0);
    expect(sent.exitCode).toBe(0);
    expect(sent.requests).toHaveLength(1);
    expect(printedNames).toEqual(verboseNames);
    expect(printedNames.filter((name) => !receivedNames.has(name))).toEqual([]);
  }, 30_000);

  // Product defect, kept as found (C14): the server records the headers sorted by name.
  test.todo("dry-run: headers in send order on the wire: the server received accept, authorization, user-agent, x-trace (sorted) vs the printed and --verbose order x-trace, accept, user-agent, authorization", () => {});

  test("dry-run: POST with a required JSON body and no body input prints {} as the body", async () => {
    const cli = await run(["--base-url", base, "--dry-run", "widgets", "create"]);
    const printed = dryRunParts(cli.stdout);

    expect(cli.exitCode).toBe(0);
    expect(cli.connections).toBe(0);
    expect(printed.requestLine).toBe(`POST ${base}/widgets HTTP/1.1`);
    expect(printed.headerLines.map(headerName)).toContain("content-type");
    expect(printed.body.trim()).toBe("{}");
  }, 30_000);

  test("dry-run: POST with flattened body flags prints the JSON body verbatim", async () => {
    const cli = await run([
      "--base-url",
      base,
      "--dry-run",
      "widgets",
      "create",
      "--name",
      "gear",
      "--size",
      "3",
    ]);
    const printed = dryRunParts(cli.stdout);

    expect(cli.exitCode).toBe(0);
    expect(cli.connections).toBe(0);
    expect(JSON.parse(printed.body)).toEqual({ name: "gear", size: 3 });
  }, 30_000);
});

describe("--verbose through a generated CLI", () => {
  test("verbose: GET writes > request and < response summaries to stderr, redacted, and stdout is the body alone", async () => {
    capture.script("/widgets/w4", json(200, { id: "w4" }));

    const args = ["--base-url", base, "widgets", "get", "w4"];
    const quiet = await run(args, credential);
    const loud = await run(["--verbose", ...args], credential);
    const stderr = lines(loud.stderr);

    expect(quiet.exitCode).toBe(0);
    expect(loud.exitCode).toBe(0);
    expect(loud.stdout).toBe(quiet.stdout);
    expect(JSON.parse(loud.stdout)).toEqual({ id: "w4" });
    expect(stderr).toContain(`> GET ${base}/widgets/w4 HTTP/1.1`);
    expect(stderr).toContain("< 200");
    expect(stderr.some((line) => line.toLowerCase() === "< content-type: application/json")).toBe(
      true,
    );
    expect(stderr.every((line) => line.startsWith("> ") || line.startsWith("< "))).toBe(true);
    expect(loud.stderr).not.toContain(token);
    expect(loud.stderr).not.toContain('"id"');
  }, 30_000);
});

describe("--error-format json through a generated CLI", () => {
  test("error-format json: a 404 carrying the declared X-Request-Id writes one object with requestId equal to the sent value and exits 1", async () => {
    capture.script(
      "/widgets/missing",
      json(404, { error: "no such widget" }, [["X-Request-Id", "req-ws5-404"]]),
    );

    const cli = await run(
      ["--base-url", base, "--error-format", "json", "widgets", "get", "missing"],
      credential,
    );
    const error = errorObject(cli.stderr);

    expect(cli.exitCode).toBe(1);
    expect(lines(cli.stderr)).toHaveLength(1);
    expect(cli.stdout).toBe("");
    expect(keysOf(error)).toEqual([
      "body",
      "kind",
      "matched",
      "message",
      "operation",
      "requestId",
      "status",
    ]);
    expect(error).toMatchObject({
      kind: "ApiResponseError",
      matched: "404",
      requestId: "req-ws5-404",
      status: 404,
    });
    expect(JSON.parse(error.body ?? "")).toEqual({ error: "no such widget" });
  }, 30_000);

  test("error-format json: a 404 sent without X-Request-Id writes one object with no requestId key", async () => {
    capture.script("/widgets/anonymous-404", json(404, { error: "no such widget" }));

    const cli = await run(
      ["--base-url", base, "--error-format", "json", "widgets", "get", "anonymous-404"],
      credential,
    );
    const error = errorObject(cli.stderr);

    expect(cli.exitCode).toBe(1);
    expect(keysOf(error)).toEqual(["body", "kind", "matched", "message", "operation", "status"]);
    expect(error).toMatchObject({ kind: "ApiResponseError", matched: "404", status: 404 });
  }, 30_000);

  test("error-format json: a transport failure (connect refused, --retries 0) writes one object with kind and message only and exits 4", async () => {
    const cli = await run([
      "--base-url",
      deadBase,
      "--error-format",
      "json",
      "--retries",
      "0",
      "status",
      "get",
    ]);
    const error = errorObject(cli.stderr);

    expect(cli.exitCode).toBe(4);
    expect(lines(cli.stderr)).toHaveLength(1);
    expect(cli.stdout).toBe("");
    expect(keysOf(error)).toEqual(["kind", "message"]);
    expect(error.kind).toBe("TransportError");
  }, 30_000);

  test("error-format json: CredentialMissing writes one object with kind, message and operation, exits 3 and sends nothing", async () => {
    capture.script("/widgets/w5", json(200, { id: "w5" }));

    const cli = await run(["--base-url", base, "--error-format", "json", "widgets", "get", "w5"]);
    const error = errorObject(cli.stderr);

    expect(cli.exitCode).toBe(3);
    expect(lines(cli.stderr)).toHaveLength(1);
    expect(cli.connections).toBe(0);
    expect(keysOf(error)).toEqual(["kind", "message", "operation"]);
    expect(error.kind).toBe("CredentialMissing");
  }, 30_000);

  test("error-format json: a post-parse usage error (invalid --body) writes one object with kind and message only and exits 2", async () => {
    const cli = await run(
      ["--base-url", base, "--error-format", "json", "widgets", "create", "--body", "{not json"],
      credential,
    );
    const error = errorObject(cli.stderr);

    expect(cli.exitCode).toBe(2);
    expect(lines(cli.stderr)).toHaveLength(1);
    expect(cli.connections).toBe(0);
    expect(keysOf(error)).toEqual(["kind", "message"]);
    expect(error.kind).toBe("UsageError");
  }, 30_000);

  // A parse-time error fails before --error-format exists, so OM_ERROR_FORMAT carries json (design
  // 7.4); the object is all stderr holds, with no help before it (ws5 finding 2).
  test("error-format json: a parse-time usage error (unknown flag) with OM_ERROR_FORMAT=json writes exactly one JSON line with kind and message only and exits 2", async () => {
    const cli = await run(["--base-url", base, "widgets", "get", "w6", "--no-such-flag"], {
      ...credential,
      OM_ERROR_FORMAT: "json",
    });
    const error = errorObject(cli.stderr);

    expect(cli.exitCode).toBe(2);
    expect(cli.connections).toBe(0);
    expect(cli.stderr.endsWith("\n")).toBe(true);
    expect(lines(cli.stderr)).toHaveLength(1);
    expect(keysOf(error)).toEqual(["kind", "message"]);
  }, 30_000);

  test("error-format json: a 503 whose Retry-After exceeds --timeout writes one object with retryAfter equal to the server's value and exits 1 after one attempt", async () => {
    capture.sequence("/widgets/busy", [
      { body: "", headers: [["Retry-After", "5"]], status: 503 },
      json(200, { id: "busy" }),
    ]);

    const cli = await run(
      ["--base-url", base, "--error-format", "json", "--timeout", "1", "widgets", "get", "busy"],
      credential,
    );
    const error = errorObject(cli.stderr);

    expect(cli.exitCode).toBe(1);
    expect(cli.requests).toHaveLength(1);
    expect(error).toMatchObject({ kind: "ApiResponseError", retryAfter: 5, status: 503 });
    expect(keysOf(error)).toEqual([
      "kind",
      "matched",
      "message",
      "operation",
      "retryAfter",
      "status",
    ]);
  }, 30_000);
});
