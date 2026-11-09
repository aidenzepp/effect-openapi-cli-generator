import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { startRecordingProxy } from "../fixtures/recording-proxy.ts";
import type { RecordingProxy } from "../fixtures/recording-proxy.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// Token pass-through through a generated CLI (design 6.5, D-SEC1; inventory SSC-18 and SSC-19):
// an operator-supplied `oauth2` or `openIdConnect` token, from `TOK_<SCHEME>` or
// `--<scheme>-file`, arrives as `Authorization: Bearer`; no scope reaches the request; a 307 to the
// unbound origin carries no token (spike S2); the TTY prompt is the last source and only on a TTY;
// and `--allow-credentials-for-base-url` warns once for a plaintext non-loopback base (design 13.1
// R3). A is the bound origin, B the capture server's second, unbound listener.

const specPath = nodePath.resolve(import.meta.dir, "../fixtures/specs/token-auth.json");

const tokens = { oauth: "ws3a-oauth-token", oidc: "ws3a-oidc-token" } as const;

// Every scope the fixture names: in a flow or in an operation's requirement.
const scopes = {
  oauth: ["pets:admin", "pets:read", "pets:write"],
  oidc: ["openid", "profile:read"],
} as const;

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "ws3a-auth-"));

const file = (name: string) => nodePath.join(work, name);

const capture = startCaptureServer();

const A = capture.origins["127.0.0.1"];

const B = capture.origins.localhost;

const portOf = (origin: string) => new URL(origin).port;

// A non-loopback name no resolver knows: the recording proxy maps it to B's listener, so the run
// needs no network (HTTP_PROXY carries the plaintext request there).
const plainHost = `plain.example.test:${portOf(B)}`;

const configPath = file("author-config.json");

writeFileSync(
  configPath,
  `${JSON.stringify({
    acceptedOrigins: [A],
    allowInsecure: true,
    binName: "tok",
    envPrefix: "TOK",
    package: { name: "token-auth-cli", version: "0.1.0" },
  })}\n`,
);

const scope = Effect.runSync(Scope.make());

const ready = Promise.withResolvers<GeneratedPackage>();

const proxyReady = Promise.withResolvers<RecordingProxy>();

beforeAll(async () => {
  proxyReady.resolve(
    await startRecordingProxy({
      label: "ws3a",
      targets: { [plainHost]: { hostname: "127.0.0.1", port: Number(portOf(B)) } },
    }),
  );

  const prepare = generateFixture({ configPath, specPath }).pipe(
    Effect.tap(preparePackage),
    Scope.provide(scope),
    Effect.provide(layer),
  );
  ready.resolve(await Effect.runPromise(prepare));
}, 600_000);

afterAll(async () => {
  capture.stop();

  const proxy = await proxyReady.promise;
  proxy.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(work, { force: true, recursive: true });
});

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

const json = { body: "{}", headers: [["Content-Type", "application/json"]] as const, status: 200 };

interface CliRun {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

const run = async (args: readonly string[], env: Record<string, string> = {}): Promise<CliRun> => {
  const generated = await ready.promise;
  const result = await Effect.runPromise(
    runBin(generated, { args, env, timeoutMs: 30_000 }).pipe(Effect.provide(layer)),
  );

  return {
    exitCode: result.exitCode,
    stderr: latin1(result.stderr),
    stdout: latin1(result.stdout),
    timedOut: result.timedOut,
  };
};

const header = (request: RecordedRequest, name: string) =>
  request.headers
    .filter(([candidate]) => candidate.toLowerCase() === name)
    .map(([, value]) => value);

// The requests one run made, from `from` on, that end at `path` on either listener.
const hops = (from: number, path: string) =>
  capture
    .requests()
    .slice(from)
    .filter((request) => request.target.split("?")[0] === path);

// The whole request as text: target, header names and values, and body.
const requestText = (request: RecordedRequest) =>
  [request.target, ...request.headers.flat(), latin1(request.body)].join("\n");

interface Observed {
  readonly authorization: readonly (readonly string[])[];
  readonly exitCode: number | null;
}

// Runs one command against A and returns the `Authorization` values each request to `path` carried.
const exchange = async (
  path: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<Observed> => {
  capture.script(path, json);

  const before = capture.requests().length;
  const cli = await run(["--base-url", A, ...args], env);

  return {
    authorization: hops(before, path).map((request) => header(request, "authorization")),
    exitCode: cli.exitCode,
  };
};

const tokenFile = (name: string, token: string) => {
  const path = file(name);
  writeFileSync(path, `${token}\n`);

  return path;
};

const hopOf = (request: RecordedRequest, token: string) => ({
  authorization: header(request, "authorization"),
  carriesToken: requestText(request).includes(token),
  origin: request.origin,
  path: request.target,
});

// A 307 from A to B: the hop to B is the unbound origin's, so it carries no token (spike S2).
const redirectToUnbound = async (
  group: string,
  id: string,
  env: Record<string, string>,
  token: string,
) => {
  capture.script(`/${group}/${id}`, { location: `${B}/${group}/${id}-landed`, status: 307 });
  capture.script(`/${group}/${id}-landed`, json);

  const before = capture.requests().length;
  const cli = await run(["--base-url", A, group, "get", id], env);
  const sent = capture
    .requests()
    .slice(before)
    .filter((request) => request.target.startsWith(`/${group}/${id}`));

  return {
    exitCode: cli.exitCode,
    hops: sent.map((request) => hopOf(request, token)),
  };
};

// What the received hops are compared with: `toEqual` takes the received value's own type.
type Hop = ReturnType<typeof hopOf>;

const landed = (group: string, id: string, token: string): Hop[] => [
  {
    authorization: [`Bearer ${token}`],
    carriesToken: true,
    origin: "127.0.0.1",
    path: `/${group}/${id}`,
  },
  { authorization: [], carriesToken: false, origin: "localhost", path: `/${group}/${id}-landed` },
];

const leakedScopes = (path: string, from: number, names: readonly string[]) =>
  hops(from, path).flatMap((request) =>
    [...names, "scope"].filter((name) => requestText(request).toLowerCase().includes(name)),
  );

describe("SSC-18 oauth2: operator-supplied token pass-through", () => {
  test("SSC-18: a token from TOK_OAUTH arrives as Authorization: Bearer", async () => {
    const observed = await exchange("/pets/env", ["pets", "get", "env"], {
      TOK_OAUTH: tokens.oauth,
    });

    expect(observed).toEqual({ authorization: [[`Bearer ${tokens.oauth}`]], exitCode: 0 });
  }, 60_000);

  test("SSC-18: a token from --oauth-file arrives as Authorization: Bearer", async () => {
    const path = tokenFile("oauth-token.txt", tokens.oauth);
    const observed = await exchange("/pets/file", ["--oauth-file", path, "pets", "get", "file"]);

    expect(observed).toEqual({ authorization: [[`Bearer ${tokens.oauth}`]], exitCode: 0 });
  }, 60_000);

  test("SSC-18: no oauth2 scope appears in the request", async () => {
    const before = capture.requests().length;
    const observed = await exchange("/pets/bare", ["pets", "get", "bare"], {
      TOK_OAUTH: tokens.oauth,
    });

    expect({
      exitCode: observed.exitCode,
      leaked: leakedScopes("/pets/bare", before, scopes.oauth),
      requests: capture.requests().length - before,
    }).toEqual({ exitCode: 0, leaked: [], requests: 1 });
  }, 60_000);

  test("SSC-18: a 307 to the unbound origin carries no oauth2 token", async () => {
    const observed = await redirectToUnbound(
      "pets",
      "hop",
      { TOK_OAUTH: tokens.oauth },
      tokens.oauth,
    );

    expect(observed).toEqual({ exitCode: 0, hops: landed("pets", "hop", tokens.oauth) });
  }, 60_000);
});

describe("SSC-19 openIdConnect: operator-supplied token pass-through", () => {
  test("SSC-19: a token from TOK_OIDC arrives as Authorization: Bearer", async () => {
    const observed = await exchange("/profiles/env", ["profiles", "get", "env"], {
      TOK_OIDC: tokens.oidc,
    });

    expect(observed).toEqual({ authorization: [[`Bearer ${tokens.oidc}`]], exitCode: 0 });
  }, 60_000);

  test("SSC-19: a token from --oidc-file arrives as Authorization: Bearer", async () => {
    const path = tokenFile("oidc-token.txt", tokens.oidc);
    const observed = await exchange("/profiles/file", [
      "--oidc-file",
      path,
      "profiles",
      "get",
      "file",
    ]);

    expect(observed).toEqual({ authorization: [[`Bearer ${tokens.oidc}`]], exitCode: 0 });
  }, 60_000);

  test("SSC-19: no openIdConnect scope appears in the request", async () => {
    const before = capture.requests().length;
    const observed = await exchange("/profiles/bare", ["profiles", "get", "bare"], {
      TOK_OIDC: tokens.oidc,
    });

    expect({
      exitCode: observed.exitCode,
      leaked: leakedScopes("/profiles/bare", before, scopes.oidc),
      requests: capture.requests().length - before,
    }).toEqual({ exitCode: 0, leaked: [], requests: 1 });
  }, 60_000);

  test("SSC-19: a 307 to the unbound origin carries no openIdConnect token", async () => {
    const observed = await redirectToUnbound(
      "profiles",
      "hop",
      { TOK_OIDC: tokens.oidc },
      tokens.oidc,
    );

    expect(observed).toEqual({ exitCode: 0, hops: landed("profiles", "hop", tokens.oidc) });
  }, 60_000);
});

const PackageBin = Schema.fromJsonString(
  Schema.Struct({ bin: Schema.Record(Schema.String, Schema.String) }),
);

const binEntry = (generated: GeneratedPackage) => {
  const { bin } = Schema.decodeUnknownSync(PackageBin)(
    readFileSync(nodePath.join(generated.dir, "package.json"), "utf-8"),
  );
  const [entry = ""] = Object.values(bin);

  return nodePath.join(generated.dir, ...entry.split("/"));
};

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

// macOS script(1) relays only a terminal stdin: it refuses a pipe or FIFO (tcgetattr fails) and
// sends a regular file's bytes behind an end-of-file, which ends the prompt. So on macOS this
// relay gives script(1) a pseudo-terminal of its own and copies the test's pipe through it; it
// exits once the terminal closes, with the command's status.
const relay = [
  "import os, pty, select, sys",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    os.execv(sys.argv[1], sys.argv[1:])",
  "inputs = [fd, 0]",
  "while fd in inputs:",
  "    for ready in select.select(inputs, [], [])[0]:",
  "        try:",
  "            data = os.read(ready, 65536)",
  "        except OSError:",
  '            data = b""',
  "        if not data:",
  "            inputs.remove(ready)",
  "        elif ready == fd:",
  "            os.write(1, data)",
  "        else:",
  "            os.write(fd, data)",
  "sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))",
].join("\n");

const script = Bun.which("script") ?? "script";

// script(1) gives the bin a pseudo-terminal for stdin and stdout: BSD `script -q /dev/null` on
// macOS, util-linux `script -qec` elsewhere, which reads a pipe directly.
const underScript = (command: readonly string[]) =>
  process.platform === "darwin"
    ? [Bun.which("python3") ?? "python3", "-c", relay, script, "-q", "/dev/null", ...command]
    : [script, "-qec", command.map(quote).join(" "), "/dev/null"];

// Runs the bin under script(1) and types `answer` and Enter once the prompt has drawn. Stdout is
// the terminal's output: the bin's stdout and stderr share the pseudo-terminal.
const runUnderTty = async (args: readonly string[], answer: string) => {
  const generated = await ready.promise;
  const child = Bun.spawn(underScript([process.execPath, binEntry(generated), ...args]), {
    cwd: generated.dir,
    env: { PATH: "/usr/bin:/bin", TERM: "xterm" },
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 30_000);
  let typed = false;
  for await (const chunk of child.stdout) {
    if (!typed && chunk.length > 0) {
      typed = true;
      await child.stdin.write(`${answer}\r`);
      await child.stdin.flush();
    }
  }

  const exitCode = await child.exited;
  clearTimeout(timer);
  await child.stdin.end();

  return { exitCode, typed };
};

const ErrorLine = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ kind: Schema.String }) }),
);

const errorKinds = (stderr: string): readonly string[] =>
  stderr.split("\n").flatMap((line) =>
    Option.match(Schema.decodeUnknownOption(ErrorLine)(line), {
      onNone: () => [],
      onSome: (value) => [value.error.kind],
    }),
  );

describe("SSC-18 oauth2: the TTY prompt source", () => {
  test("SSC-18: the TTY prompt supplies the token under script(1)", async () => {
    capture.script("/pets/tty", json);

    const before = capture.requests().length;
    const typed = "ws3a-typed-token";
    const cli = await runUnderTty(["--base-url", A, "pets", "get", "tty"], typed);

    expect({
      authorization: hops(before, "/pets/tty").map((request) => header(request, "authorization")),
      exitCode: cli.exitCode,
      typed: cli.typed,
    }).toEqual({ authorization: [[`Bearer ${typed}`]], exitCode: 0, typed: true });
  }, 60_000);

  test("SSC-18: with stdin a pipe the prompt is skipped: CredentialMissing and no request", async () => {
    capture.script("/pets/pipe", json);

    const before = capture.requests().length;
    const cli = await run(["--base-url", A, "pets", "get", "pipe", "--error-format", "json"]);

    expect({
      exitCode: cli.exitCode,
      kinds: errorKinds(cli.stderr),
      requests: hops(before, "/pets/pipe").length,
    }).toEqual({ exitCode: 3, kinds: ["CredentialMissing"], requests: 0 });
  }, 60_000);
});

const warnings = (stderr: string) =>
  stderr.split("\n").filter((line) => line.startsWith("Warning:"));

describe("SSC-18 oauth2: the plaintext rule for --allow-credentials-for-base-url", () => {
  // B's listener under a non-loopback name, reached through the recording proxy.
  test("SSC-18: a plaintext non-loopback base prints one warning and still sends the token", async () => {
    const proxy = await proxyReady.promise;
    proxy.reset();
    capture.script("/pets/plain", json);

    const before = capture.requests().length;
    const cli = await run(
      [
        "--base-url",
        `http://${plainHost}`,
        "--allow-credentials-for-base-url",
        "pets",
        "get",
        "plain",
      ],
      { HTTP_PROXY: proxy.url, TOK_OAUTH: tokens.oauth },
    );

    expect({
      authorization: hops(before, "/pets/plain").map((request) => header(request, "authorization")),
      exitCode: cli.exitCode,
      proxied: proxy.records().map((record) => record.target),
      warnings: warnings(cli.stderr).length,
    }).toEqual({
      authorization: [[`Bearer ${tokens.oauth}`]],
      exitCode: 0,
      proxied: [plainHost],
      warnings: 1,
    });
  }, 60_000);

  test("SSC-18: a plaintext base on 127.0.0.1 prints no warning", async () => {
    const proxy = await proxyReady.promise;
    proxy.reset();
    capture.script("/pets/loopback", json);

    const before = capture.requests().length;
    const cli = await run(
      [
        "--base-url",
        `http://127.0.0.1:${portOf(B)}`,
        "--allow-credentials-for-base-url",
        "pets",
        "get",
        "loopback",
      ],
      { HTTP_PROXY: proxy.url, TOK_OAUTH: tokens.oauth },
    );

    expect({
      authorization: hops(before, "/pets/loopback").map((request) =>
        header(request, "authorization"),
      ),
      exitCode: cli.exitCode,
      proxied: proxy.records().length,
      warnings: warnings(cli.stderr).length,
    }).toEqual({
      authorization: [[`Bearer ${tokens.oauth}`]],
      exitCode: 0,
      proxied: 0,
      warnings: 0,
    });
  }, 60_000);
});
