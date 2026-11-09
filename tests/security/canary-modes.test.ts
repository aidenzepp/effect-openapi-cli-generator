import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest, ScriptedResponse } from "../fixtures/capture-server.ts";
import { startRecordingProxy } from "../fixtures/recording-proxy.ts";
import type { RecordingProxy } from "../fixtures/recording-proxy.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// Design 9 I4 for every Milestone 3 output path (design 7.5, 13.2 CSO-1 and CSO-2, 13.1 R4;
// inventory FMT-05), through one generated CLI from `canary-modes.json` run against the capture
// server in canary mode, which echoes the request's Authorization and body in its 401, 500 and 503
// bodies and the Authorization in every redirect's Location. A canary token for the oauth2 scheme
// and the query apiKey, and a canary password read through `--secret-file`, never appear in stdout
// or stderr of --dry-run (headers and every body kind), --verbose (both header blocks, every
// redirect and retry hop), --error-format json (401, 500, transport failure), retry notes, the
// exit-70 defect line, the withheld notice, the plaintext warning, help, --describe or the README.
// The M1 canary rows stay in values.test.ts (TS-9).

const specPath = nodePath.resolve(import.meta.dir, "../fixtures/specs/canary-modes.json");

// Plain characters, so each value's percent-encoded form is the value itself.
const canary = {
  key: "ws6-canary-key-9b27",
  oauth: "ws6-canary-oauth-5e1d",
  password: "ws6-canary-password-c4a0",
} as const;

const canaryValues = Object.values(canary);

const canaryEnv = { CM_KEY: canary.key, CM_OAUTH: canary.oauth };

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "ws6-canary-modes-"));

const file = (name: string) => nodePath.join(work, name);

const passwordFile = file("password");

writeFileSync(passwordFile, canary.password);

const capture = startCaptureServer({ canary: true });

// A is bound by the author config; B, the second listener, is not.
const A = capture.origins["127.0.0.1"];

const B = capture.origins.localhost;

const portOf = (origin: string) => new URL(origin).port;

// A non-loopback name no resolver knows: the recording proxy maps it to B's listener, so the
// plaintext warning's run needs no network.
const plainHost = `plain.example.test:${portOf(B)}`;

// A port that was listening and is now closed: the transport-failure origin, bound so the
// credentials are attached on the way to it.
const closedOrigin = (() => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  const origin = `http://127.0.0.1:${listener.port}`;
  listener.stop(true);

  return origin;
})();

// The exit-70 route a generated CLI exposes: an author command that sends `accounts create` with
// the canary password, so the run records every credential and the secret-file value, and then
// dies with a message holding all three canaries. No specification input reaches a defect: the
// method allowlist is every token the generator emits, and a bad Location is an API error.
const authorCommands = `import { readFileSync } from "node:fs";
import { Effect, Option } from "effect";
import { Command } from "effect/cli";
import * as Accounts from "../src/api/accounts.ts";
import { Paths1accountsPostRequestBodyContentApplication1jsonSchema } from "../src/domain/schemas.ts";
import * as Input from "../src/runtime/input.ts";
import * as Output from "../src/runtime/output.ts";

export const boom = Command.make("boom", { secretFile: Input.secretFileFlag("secret-file") }, (flags) =>
  Input.mergeBody({
    body: Option.none(),
    bodyFile: Option.none(),
    fields: {
      "/secret": Option.map(flags.secretFile, (path) => new Input.SecretField({ flag: "secret-file", path })),
    },
    required: true,
    schema: Paths1accountsPostRequestBodyContentApplication1jsonSchema,
  }).pipe(
    Effect.flatMap((merged) => Accounts.create({ body: merged })),
    Effect.flatMap(Output.send(Accounts.createMeta)),
    Effect.andThen(
      Effect.sync(() => {
        const password = Option.match(flags.secretFile, {
          onNone: () => "",
          onSome: (path) => readFileSync(path, "utf-8"),
        });

        return \`author defect \${process.env.CM_OAUTH ?? ""} \${process.env.CM_KEY ?? ""} \${password}\`;
      }),
    ),
    Effect.flatMap((message) => Effect.die(new Error(message))),
  ),
).pipe(Command.provideEffectDiscard(Output.recordRun("CM")));
`;

const configPath = file("author-config.json");

writeFileSync(
  configPath,
  `${JSON.stringify({
    acceptedOrigins: [A, closedOrigin],
    allowInsecure: true,
    binName: "cm",
    commands: { module: "./custom/commands.ts", names: ["boom"] },
    envPrefix: "CM",
    package: { name: "canary-modes-cli", version: "0.1.0" },
  })}\n`,
);

const scope = Effect.runSync(Scope.make());

const ready = Promise.withResolvers<GeneratedPackage>();

const proxyReady = Promise.withResolvers<RecordingProxy>();

beforeAll(async () => {
  proxyReady.resolve(
    await startRecordingProxy({
      label: "ws6",
      targets: { [plainHost]: { hostname: "127.0.0.1", port: Number(portOf(B)) } },
    }),
  );

  const prepare = generateFixture({
    authorFiles: [{ content: authorCommands, path: "custom/commands.ts" }],
    configPath,
    specPath,
  }).pipe(Effect.tap(preparePackage), Scope.provide(scope), Effect.provide(layer));
  ready.resolve(await Effect.runPromise(prepare));
}, 600_000);

afterAll(async () => {
  capture.stop();

  const proxy = await proxyReady.promise;
  proxy.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(work, { force: true, recursive: true });
});

const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

interface CliRun {
  readonly connections: number;
  readonly exitCode: number | null;
  readonly requests: readonly RecordedRequest[];
  readonly stderr: string;
  readonly stdout: string;
}

// Runs the bin once and reports the connections it opened and the requests the server recorded.
const run = async (
  args: readonly string[],
  env: Readonly<Record<string, string>> = canaryEnv,
  stdin = "",
): Promise<CliRun> => {
  const generated = await ready.promise;
  const connections = capture.connections();
  const requests = capture.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, {
      args,
      env,
      stdin: new TextEncoder().encode(stdin),
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );

  return {
    connections: capture.connections() - connections,
    exitCode: result.exitCode,
    requests: capture.requests().slice(requests),
    stderr: utf8(result.stderr),
    stdout: utf8(result.stdout),
  };
};

const onA = (args: readonly string[], env?: Readonly<Record<string, string>>, stdin?: string) =>
  run(["--base-url", A, ...args], env, stdin);

// Every canary value either stream holds.
const leaked = (cli: Pick<CliRun, "stderr" | "stdout">) =>
  canaryValues.filter((value) => cli.stdout.includes(value) || cli.stderr.includes(value));

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

const header = (request: RecordedRequest | undefined, name: string) =>
  (request?.headers ?? [])
    .filter(([candidate]) => candidate.toLowerCase() === name)
    .map(([, value]) => value);

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

// Whether the request carried the oauth2 token and the query apiKey on the wire.
const carried = (request: RecordedRequest | undefined) => ({
  bearer: header(request, "authorization").includes(`Bearer ${canary.oauth}`),
  key: new URL(request?.target ?? "/", A).searchParams.get("api_key") === canary.key,
});

const ErrorLine = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      body: Schema.optionalKey(Schema.String),
      kind: Schema.String,
      message: Schema.String,
      status: Schema.optionalKey(Schema.Number),
    }),
  }),
);

const decodeErrorLine = Schema.decodeUnknownSync(ErrorLine);

// The one JSON object a `--error-format json` run wrote: stderr's only line.
const errorObject = (stderr: string) => {
  const written = lines(stderr);
  expect(written).toHaveLength(1);

  return decodeErrorLine(written[0]).error;
};

const unavailable = (headers: ScriptedResponse["headers"] = []): ScriptedResponse => ({
  headers: [["Retry-After", "0"], ...headers],
  status: 503,
});

describe("I4 --dry-run prints no canary in its headers or any body kind", () => {
  test("dry-run: a GET prints the oauth2 and apiKey placeholders and opens no connection", async () => {
    const cli = await onA(["--dry-run", "items", "get", "dry"]);

    expect({
      connections: cli.connections,
      exitCode: cli.exitCode,
      leaked: leaked(cli),
      placeholders: [
        cli.stdout.includes("authorization: Bearer <redacted:oauth>"),
        cli.stdout.includes("api_key=<redacted:key>"),
      ],
    }).toEqual({ connections: 0, exitCode: 0, leaked: [], placeholders: [true, true] });
  }, 60_000);

  test("FMT-05: --dry-run echoes a --secret-file password in a JSON body as its placeholder", async () => {
    const cli = await onA([
      "--dry-run",
      "accounts",
      "create",
      "--name",
      "ws6",
      "--secret-file",
      passwordFile,
    ]);
    expect({
      body: cli.stdout.slice(cli.stdout.indexOf("\n\n") + 2),
      connections: cli.connections,
      exitCode: cli.exitCode,
      leaked: leaked(cli),
    }).toEqual({
      body: '{"name":"ws6","secret":"<redacted:secret-file>"}\n',
      connections: 0,
      exitCode: 0,
      leaked: [],
    });
  }, 60_000);

  // The run holds the configured credentials, so a body that repeats them is scrubbed by value.
  test("dry-run: a text body holding the configured credentials prints their placeholders", async () => {
    const cli = await onA([
      "--dry-run",
      "notes",
      "create",
      "--body",
      `note ${canary.oauth} and ${canary.key}`,
    ]);

    expect({
      body: cli.stdout.slice(cli.stdout.indexOf("\n\n") + 2),
      exitCode: cli.exitCode,
      leaked: leaked(cli),
    }).toEqual({
      body: "note <redacted:oauth> and <redacted:key>\n",
      exitCode: 0,
      leaked: [],
    });
  }, 60_000);

  test("dry-run: a streamed text body from stdin is named, not read", async () => {
    const cli = await onA(
      ["--dry-run", "notes", "create", "--body-file", "-"],
      canaryEnv,
      `note ${canary.oauth}\n`,
    );

    expect({
      body: cli.stdout.slice(cli.stdout.indexOf("\n\n") + 2),
      connections: cli.connections,
      exitCode: cli.exitCode,
      leaked: leaked(cli),
    }).toEqual({ body: "<body from stdin>\n", connections: 0, exitCode: 0, leaked: [] });
  }, 60_000);

  test("dry-run: a sequential (application/jsonl) body holding the credentials prints their placeholders", async () => {
    const cli = await onA([
      "--dry-run",
      "events",
      "send",
      "--body",
      `{"t":"${canary.oauth}"}\n{"k":"${canary.key}"}\n`,
    ]);

    expect({
      body: cli.stdout.slice(cli.stdout.indexOf("\n\n") + 2),
      exitCode: cli.exitCode,
      leaked: leaked(cli),
    }).toEqual({
      body: '{"t":"<redacted:oauth>"}\n{"k":"<redacted:key>"}\n',
      exitCode: 0,
      leaked: [],
    });
  }, 60_000);

  // A multipart `format: password` part is a file part (design 4.5): its content is summarized,
  // and a text part that repeats a credential is scrubbed.
  test("FMT-05: --dry-run summarizes a multipart password part and scrubs a text part", async () => {
    const cli = await onA([
      "--dry-run",
      "uploads",
      "create",
      "--note",
      `note ${canary.oauth}`,
      "--secret",
      passwordFile,
    ]);

    expect({
      exitCode: cli.exitCode,
      leaked: leaked(cli),
      summarized: cli.stdout.includes(`<file ${nodePath.basename(passwordFile)}, `),
      text: cli.stdout.includes("note <redacted:oauth>"),
    }).toEqual({ exitCode: 0, leaked: [], summarized: true, text: true });
  }, 60_000);
});

describe("I4 --verbose prints no canary on any hop", () => {
  // The canary server appends the request's Authorization to every Location it sends.
  test("verbose: both header blocks of every redirect hop are free of the canary", async () => {
    capture.script("/items/hop", { location: "/items/final", status: 307 });
    capture.script("/items/final", { body: "ok", status: 200 });

    const cli = await onA(["--verbose", "items", "get", "hop"]);
    const stderr = lines(cli.stderr);

    expect({
      carried: cli.requests.map(carried),
      exitCode: cli.exitCode,
      leaked: leaked(cli),
      location: stderr.filter((line) => line.startsWith("< location: ")),
      requestLines: stderr.filter((line) => line.startsWith("> GET ")).length,
    }).toEqual({
      carried: [
        { bearer: true, key: true },
        { bearer: true, key: true },
      ],
      exitCode: 0,
      leaked: [],
      location: ["< location: /items/final?authorization=Bearer <redacted:oauth>"],
      requestLines: 2,
    });
  }, 60_000);

  test("FMT-05: --verbose and the error for a 500 echoing the token and the password print neither", async () => {
    capture.script("/accounts", { status: 500 });

    const cli = await onA(["--verbose", "accounts", "create", "--secret-file", passwordFile]);

    expect({
      echoed: latin1(cli.requests[0]?.body ?? new Uint8Array()),
      exitCode: cli.exitCode,
      leaked: leaked(cli),
      placeholders: [
        cli.stderr.includes("<redacted:oauth>"),
        cli.stderr.includes("<redacted:secret-file>"),
      ],
      verbose: [
        lines(cli.stderr).some((line) => line.startsWith("> POST ")),
        lines(cli.stderr).includes("< 500"),
      ],
    }).toEqual({
      echoed: `{"secret":"${canary.password}"}`,
      exitCode: 1,
      leaked: [],
      placeholders: [true, true],
      verbose: [true, true],
    });
  }, 60_000);
});

describe("I4 --error-format json prints no canary", () => {
  test("FMT-05: a 401 echoing the token and the password writes one scrubbed object and exits 3", async () => {
    capture.script("/accounts", { status: 401 });

    const cli = await onA([
      "--error-format",
      "json",
      "accounts",
      "create",
      "--secret-file",
      passwordFile,
    ]);
    const error = errorObject(cli.stderr);

    expect({
      body: error.body,
      exitCode: cli.exitCode,
      kind: error.kind,
      leaked: leaked(cli),
      status: error.status,
    }).toEqual({
      body: 'Bearer <redacted:oauth>\n{"secret":"<redacted:secret-file>"}',
      exitCode: 3,
      kind: "ApiResponseError",
      leaked: [],
      status: 401,
    });
  }, 60_000);

  test("error-format json: a 500 echoing the token writes one scrubbed object and exits 1", async () => {
    capture.script("/items/failed", { status: 500 });

    const cli = await onA(["--error-format", "json", "--retries", "0", "items", "get", "failed"]);
    const error = errorObject(cli.stderr);

    expect({
      carried: carried(cli.requests[0]),
      exitCode: cli.exitCode,
      kind: error.kind,
      leaked: leaked(cli),
      status: error.status,
    }).toEqual({
      carried: { bearer: true, key: true },
      exitCode: 1,
      kind: "ApiResponseError",
      leaked: [],
      status: 500,
    });
  }, 60_000);

  test("error-format json: a transport failure to a bound closed port writes one object and exits 4", async () => {
    const cli = await run([
      "--base-url",
      closedOrigin,
      "--error-format",
      "json",
      "--retries",
      "0",
      "items",
      "get",
      "closed",
    ]);
    const error = errorObject(cli.stderr);

    expect({ exitCode: cli.exitCode, kind: error.kind, leaked: leaked(cli) }).toEqual({
      exitCode: 4,
      kind: "TransportError",
      leaked: [],
    });
  }, 60_000);

  // A redirect to a closed port fails in transport with the Location's query, which holds the
  // echoed Authorization, in the URL the error names.
  test("error-format json: a transport failure after a redirect names a scrubbed URL", async () => {
    capture.script("/items/away", { location: `${closedOrigin}/items/gone`, status: 307 });

    const cli = await onA(["--error-format", "json", "--retries", "0", "items", "get", "away"]);
    const error = errorObject(cli.stderr);

    expect({
      exitCode: cli.exitCode,
      kind: error.kind,
      leaked: leaked(cli),
      scrubbed: error.message.includes("<redacted:oauth>"),
    }).toEqual({ exitCode: 4, kind: "TransportError", leaked: [], scrubbed: true });
  }, 60_000);
});

describe("I4 retry notes print no canary", () => {
  test("retry: a GET answered 503 three times prints two notes and a scrubbed error", async () => {
    capture.sequence("/items/busy", [unavailable(), unavailable(), unavailable()]);

    const cli = await onA(["items", "get", "busy"]);

    expect({
      attempts: cli.requests.length,
      exitCode: cli.exitCode,
      leaked: leaked(cli),
      notes: lines(cli.stderr).filter((line) => line.startsWith("Notice: retrying ")).length,
    }).toEqual({ attempts: 3, exitCode: 1, leaked: [], notes: 2 });
  }, 60_000);

  test("FMT-05: a retried POST whose 503 echoes the token and the password prints neither", async () => {
    capture.sequence("/accounts", [unavailable()]);

    const cli = await onA([
      "--retry-unsafe",
      "--retries",
      "1",
      "--verbose",
      "accounts",
      "create",
      "--secret-file",
      passwordFile,
    ]);

    expect({
      attempts: cli.requests.length,
      exitCode: cli.exitCode,
      leaked: leaked(cli),
      notes: lines(cli.stderr).filter((line) => line.startsWith("Notice: retrying ")).length,
      requestBlocks: lines(cli.stderr).filter((line) => line.startsWith("> POST ")).length,
    }).toEqual({ attempts: 2, exitCode: 1, leaked: [], notes: 1, requestBlocks: 2 });
  }, 60_000);
});

describe("I4 the exit-70 defect line prints no canary", () => {
  test("FMT-05: a defect whose message holds the token, the key and the password prints placeholders and exits 70", async () => {
    capture.script("/accounts", { body: "{}", status: 201 });

    const cli = await onA(["boom", "--secret-file", passwordFile]);

    expect({
      defect: lines(cli.stderr),
      exitCode: cli.exitCode,
      leaked: leaked(cli),
    }).toEqual({
      defect: [
        "Error: author defect <redacted:oauth> <redacted:key> <redacted:secret-file>",
        "internal error, please report",
      ],
      exitCode: 70,
      leaked: [],
    });
  }, 60_000);

  test("FMT-05: the same defect under --error-format json is one Internal object without a canary", async () => {
    capture.script("/accounts", { body: "{}", status: 201 });

    const cli = await onA(["--error-format", "json", "boom", "--secret-file", passwordFile]);
    const error = errorObject(cli.stderr);

    expect({ exitCode: cli.exitCode, kind: error.kind, leaked: leaked(cli) }).toEqual({
      exitCode: 70,
      kind: "Internal",
      leaked: [],
    });
  }, 60_000);
});

describe("I4 notices and warnings print no canary", () => {
  test("withheld: an unbound --base-url prints the notice, sends no credential and no canary", async () => {
    capture.script("/items/unbound", { body: "ok", status: 200 });

    const cli = await run(["--base-url", B, "items", "get", "unbound"]);

    expect({
      carried: cli.requests.map(carried),
      exitCode: cli.exitCode,
      leaked: leaked(cli),
      notices: lines(cli.stderr).filter((line) => line.startsWith("Notice: not sending ")).length,
    }).toEqual({
      carried: [{ bearer: false, key: false }],
      exitCode: 0,
      leaked: [],
      notices: 1,
    });
  }, 60_000);

  test("plaintext: --allow-credentials-for-base-url to a non-loopback http base warns once without a canary", async () => {
    const proxy = await proxyReady.promise;
    proxy.reset();
    capture.script("/items/plain", { body: "ok", status: 200 });

    const cli = await run(
      [
        "--base-url",
        `http://${plainHost}`,
        "--allow-credentials-for-base-url",
        "items",
        "get",
        "plain",
      ],
      { ...canaryEnv, HTTP_PROXY: proxy.url },
    );

    expect({
      carried: cli.requests.map(carried),
      exitCode: cli.exitCode,
      leaked: leaked(cli),
      proxied: proxy.records().map((record) => record.target),
      warnings: lines(cli.stderr).filter((line) => line.startsWith("Warning:")).length,
    }).toEqual({
      carried: [{ bearer: true, key: true }],
      exitCode: 0,
      leaked: [],
      proxied: [plainHost],
      warnings: 1,
    });
  }, 60_000);
});

describe("I4 help, --describe and the README hold no canary", () => {
  const pages = [
    ["--help"],
    ...["accounts", "events", "items", "notes", "uploads"].map((group) => [group, "--help"]),
    ["accounts", "create", "--help"],
    ["events", "send", "--help"],
    ["items", "get", "--help"],
    ["notes", "create", "--help"],
    ["uploads", "create", "--help"],
    ["boom", "--help"],
  ];

  test("help: every page, with the canaries configured, exits 0 without one", async () => {
    const observed = await Promise.all(
      pages.map(async (args) => {
        const cli = await run(args);

        return { args, exitCode: cli.exitCode, leaked: leaked(cli) };
      }),
    );

    expect(observed).toEqual(pages.map((args) => ({ args, exitCode: 0, leaked: [] })));
  }, 120_000);

  test("help: the oauth2 AUTH text names the token's sources and no value", async () => {
    const cli = await run(["items", "get", "--help"]);
    const auth = lines(cli.stdout).find((line) => line.startsWith("AUTH"));

    expect({
      leaked: leaked(cli),
      sources: ["--oauth-file", "CM_OAUTH", "--key-file", "CM_KEY"].map(
        (source) => auth?.includes(source) ?? false,
      ),
    }).toEqual({ leaked: [], sources: [true, true, true, true] });
  }, 60_000);

  test("describe: --describe with the canaries configured prints none", async () => {
    const cli = await run(["--describe"]);

    expect({ exitCode: cli.exitCode, leaked: leaked(cli) }).toEqual({ exitCode: 0, leaked: [] });
  }, 60_000);

  test("readme: the generated README names the secret-file flag and no canary", async () => {
    const generated = await ready.promise;
    const readme = readFileSync(nodePath.join(generated.dir, "README.md"), "utf-8");

    expect({
      flag: readme.includes("--secret-file"),
      leaked: leaked({ stderr: "", stdout: readme }),
    }).toEqual({ flag: true, leaked: [] });
  }, 60_000);
});

describe("FMT-05 a password property is read only from a file", () => {
  test("FMT-05: --secret <value> is not a flag: exit 2, no connection, the value not echoed", async () => {
    const cli = await onA(["accounts", "create", "--secret", canary.password]);

    expect({
      connections: cli.connections,
      exitCode: cli.exitCode,
      leaked: leaked(cli),
      secretFileFlag: cli.stderr.includes("--secret-file path|-"),
    }).toEqual({ connections: 0, exitCode: 2, leaked: [], secretFileFlag: true });
  }, 60_000);

  test("FMT-05: --secret-file - reads the password from stdin and sends it, echoing nothing", async () => {
    capture.script("/accounts", { body: "{}", status: 201 });

    const cli = await onA(
      ["--verbose", "accounts", "create", "--secret-file", "-"],
      canaryEnv,
      canary.password,
    );

    expect({
      body: latin1(cli.requests[0]?.body ?? new Uint8Array()),
      exitCode: cli.exitCode,
      leaked: leaked(cli),
    }).toEqual({ body: `{"secret":"${canary.password}"}`, exitCode: 0, leaked: [] });
  }, 60_000);
});
