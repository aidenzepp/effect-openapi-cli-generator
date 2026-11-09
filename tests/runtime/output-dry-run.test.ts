/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Redacted,
  Ref,
  Schema,
  Sink,
  Stdio,
  Stream,
  Terminal,
} from "effect";
import { TerminalCapabilities } from "effect/cli";
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import * as Client from "../../src/runtime-src/runtime/client.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Multipart from "../../src/runtime-src/runtime/multipart.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import type { ScrubEntry } from "../../src/runtime-src/runtime/redact.ts";
import { RunCredentials } from "../../src/runtime-src/runtime/redact.ts";

// `--dry-run` (m3-dr1): `Output.send` builds the request as for sending, prints it to stdout with
// every credential replaced by `<redacted:<scheme>>`, and sends nothing.

const SECRET = "tok-DRY-RUN-SECRET";

const KEY = "key-DRY-RUN-SECRET";

const servers: BaseUrl.ServersTable = {
  boundOrigins: ["https://api.example.com"],
  defaultServer: 0,
  servers: [{ url: "https://api.example.com/v1", variables: {} }],
};

const security: Auth.SecurityTable = {
  schemes: {
    apiKey: { in: "header", kind: "apiKey", name: "X-Key" },
    bearerAuth: { kind: "http", scheme: "bearer" },
  },
};

const meta = (
  method: string,
  requirement: Auth.SecurityRequirement = [["bearerAuth"]],
): Output.OperationMeta => ({
  media: { request: [], responses: { "200": ["application/json"] } },
  method,
  operationId: "items-call",
  pathTemplate: "/items",
  security: requirement,
});

const jsonPost = HttpClientRequest.post("/items").pipe(
  HttpClientRequest.bodyText('{"name":"a"}', "application/json"),
);

const bytes = (text: string) => new TextEncoder().encode(text);

const key = (name: string, input: Option.Option<string>): Terminal.UserInput => ({
  input,
  key: { ctrl: false, meta: false, name, shift: false },
});

interface World {
  readonly dryRun?: boolean;
  readonly env?: Record<string, string>;
  readonly operation: Output.OperationMeta;
  readonly recorded?: readonly ScrubEntry[];
  readonly reply?: () => Response;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly tty?: boolean;
  readonly verbose?: boolean;
}

const capture = (into: Buffer[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(Buffer.from(chunk));
    }),
  );

const run = async (world: World) => {
  let sent = 0;
  let asked = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      sent += 1;

      return HttpClientResponse.fromWeb(
        request,
        world.reply?.() ?? new Response("[]", { status: 200 }),
      );
    }),
  );
  const terminal = Terminal.make({
    columns: Effect.succeed(80),
    display: () => Effect.void,
    readInput: Effect.gen(function* readInput() {
      asked += 1;
      const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
      yield* Queue.offerAll(queue, [key("x", Option.some("x")), key("enter", Option.none())]);

      return queue;
    }),
    readLine: Effect.die("unused"),
    rows: Effect.succeed(24),
    size: Effect.die("unused"),
  });
  const tty = world.tty ?? false;
  const stdio = Stdio.layerTest({
    stderr: capture(stderr),
    stdin: Stream.empty,
    stdinIsTerminal: Effect.succeed(tty),
    stdout: capture(stdout),
    stdoutIsTerminal: Effect.succeed(tty),
  });
  const recorded = Layer.effect(RunCredentials)(Ref.make(world.recorded ?? []));
  const environment = Layer.mergeAll(
    BaseUrl.layer(servers, "EXAMPLE"),
    Auth.layer(security, "EXAMPLE"),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(world.env ?? {})),
    FileSystem.layerNoop({}),
    Path.layer,
    stdio,
    TerminalCapabilities.layer.pipe(Layer.provide(stdio)),
    Layer.succeed(Terminal.Terminal, terminal),
    Input.stdinClaimLayer,
    recorded,
    Output.runWarningsLayer,
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Output.ClientPolicy, {
      allowed: new Set(["GET", "POST"]),
      binName: "example",
      direct: { cache: "no-store" },
      version: "1.2.3",
    }),
    Layer.succeed(Output.OutputPath, Option.none()),
    Layer.succeed(Output.Force, false),
    Layer.succeed(Output.MaxErrorBytes, Output.defaultMaxErrorBytes),
    Layer.succeed(BaseUrl.baseUrlSetting, Option.none()),
    Layer.succeed(BaseUrl.serverSetting, Option.none()),
    Layer.succeed(BaseUrl.serverVariableSetting, []),
    Layer.succeed(Auth.allowCredentialsForBaseUrl, false),
    Layer.succeed(Client.verboseSetting, world.verbose ?? false),
    Layer.succeed(Output.dryRunSetting, world.dryRun ?? true),
  );
  const exit = await Effect.runPromise(
    Effect.exit(
      Output.finalCatch([], { envPrefix: "EXAMPLE" })(Output.send(world.operation)(world.request)),
    ).pipe(Effect.provide(environment)),
  );
  const failure = Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined;

  return {
    asked,
    exit,
    failure,
    sent,
    stderr: Buffer.concat(stderr).toString("utf-8"),
    stdout: Buffer.concat(stdout).toString("utf-8"),
  };
};

describe("Output.send --dry-run", () => {
  test("prints the method line, the headers in send order with the placeholder, and the body", async () => {
    const result = await run({
      env: { EXAMPLE_BEARER_AUTH: SECRET },
      operation: meta("POST"),
      request: jsonPost,
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      "POST https://api.example.com/v1/items HTTP/1.1",
      "accept: application/json",
      "authorization: Bearer <redacted:bearerAuth>",
      "content-length: 12",
      "content-type: application/json",
      "user-agent: example/1.2.3",
      "",
      '{"name":"a"}',
      "",
    ]);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
  });

  test("with no credential configured it exits 0 and shows the first alternative's placeholders", async () => {
    const result = await run({
      operation: meta("GET", [["bearerAuth", "apiKey"], ["apiKey"]]),
      request: HttpClientRequest.get("/items"),
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.sent).toBe(0);
    expect(result.stdout).toContain("authorization: Bearer <redacted:bearerAuth>\n");
    expect(result.stdout).toContain("x-key: <redacted:apiKey>\n");
  });

  test("[{}, {apiKey}] with the key configured prints the apiKey placeholder, not an anonymous request", async () => {
    const result = await run({
      env: { EXAMPLE_API_KEY: KEY },
      operation: meta("GET", [[], ["apiKey"]]),
      request: HttpClientRequest.get("/items"),
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.stdout).toContain("x-key: <redacted:apiKey>\n");
    expect(result.stdout).not.toContain("authorization");
    expect(result.stdout).not.toContain(KEY);
  });

  test("never prompts, even when stdin and stdout are TTYs", async () => {
    const control = await run({
      dryRun: false,
      operation: meta("GET"),
      request: HttpClientRequest.get("/items"),
      tty: true,
    });
    const result = await run({
      operation: meta("GET"),
      request: HttpClientRequest.get("/items"),
      tty: true,
    });

    expect(control.asked).toBe(1);
    expect(result.asked).toBe(0);
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.stdout).toContain("authorization: Bearer <redacted:bearerAuth>\n");
  });

  test("a multipart file part prints as <file <basename>, N bytes>", async () => {
    const body = await Effect.runPromise(
      Multipart.formData(
        [
          { body: bytes('{"a":1}'), contentType: "application/json", name: "meta" },
          {
            body: Stream.make(bytes("PNG"), bytes("DATA")),
            contentType: "image/png",
            filename: "photo.png",
            name: "file",
          },
        ],
        { boundary: "BOUNDARY" },
      ),
    );
    const result = await run({
      env: { EXAMPLE_BEARER_AUTH: SECRET },
      operation: meta("POST"),
      request: HttpClientRequest.post("/items").pipe(HttpClientRequest.setBody(body)),
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.stdout.slice(result.stdout.indexOf("\n\n") + 2)).toBe(
      [
        "--BOUNDARY",
        'Content-Disposition: form-data; name="meta"',
        "Content-Type: application/json",
        "",
        '{"a":1}',
        "--BOUNDARY",
        'Content-Disposition: form-data; name="file"; filename="photo.png"',
        "Content-Type: image/png",
        "",
        "<file photo.png, 7 bytes>",
        "--BOUNDARY--",
        "",
      ].join("\r\n"),
    );
    expect(result.stdout).not.toContain("PNGDATA");
  });

  test("a stdin binary body prints <binary body from stdin> without reading stdin", async () => {
    let read = false;
    const stdin = Stream.fromEffect(
      Effect.sync(() => {
        read = true;

        return bytes("raw");
      }),
    );
    const result = await run({
      env: { EXAMPLE_BEARER_AUTH: SECRET },
      operation: meta("POST"),
      request: HttpClientRequest.post("/items").pipe(
        HttpClientRequest.setBody(HttpBody.stream(stdin)),
      ),
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(read).toBe(false);
    expect(result.stdout.endsWith("\n\n<binary body from stdin>\n")).toBe(true);
  });

  test("a recorded secret-file value in the body is replaced by its placeholder", async () => {
    const password = "pw-DRY-RUN-SECRET";
    const result = await run({
      env: { EXAMPLE_BEARER_AUTH: SECRET },
      operation: meta("POST"),
      recorded: [{ kind: "secret", label: "password-file", value: Redacted.make(password) }],
      request: HttpClientRequest.post("/items").pipe(
        HttpClientRequest.bodyText(JSON.stringify({ password }), "application/json"),
      ),
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.stdout).toContain('{"password":"<redacted:password-file>"}');
    expect(result.stdout).not.toContain(password);
  });

  test("a streamed text body never prints a recorded secret-file value or a credential", async () => {
    const password = "pw-STREAM-SECRET";
    const text = `{"password":"${password}","token":"${SECRET}"}\n`;
    const cut = text.indexOf(password) + 4;
    const chunks = [
      bytes(text.slice(0, cut)),
      bytes(text.slice(cut, cut + 9)),
      bytes(text.slice(cut + 9)),
    ];
    const result = await run({
      env: { EXAMPLE_BEARER_AUTH: SECRET },
      operation: meta("POST"),
      recorded: [{ kind: "secret", label: "password-file", value: Redacted.make(password) }],
      request: HttpClientRequest.post("/items").pipe(
        HttpClientRequest.setBody(
          HttpBody.stream(Stream.fromIterable(chunks), "text/plain", text.length),
        ),
        HttpClientRequest.setHeader("content-type", "text/plain"),
      ),
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.stdout).toContain(
      '{"password":"<redacted:password-file>","token":"<redacted:bearerAuth>"}\n',
    );
    expect(result.stdout).not.toContain(password);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(password);
    expect(result.stderr).not.toContain(SECRET);
  });

  test("a multipart text part never prints a recorded secret-file value or a credential", async () => {
    const password = "pw-PART-SECRET";
    const text = `note ${password} and ${SECRET}`;
    const cut = text.indexOf(SECRET) + 5;
    const body = await Effect.runPromise(
      Multipart.formData(
        [
          {
            body: Stream.make(bytes(text.slice(0, cut)), bytes(text.slice(cut))),
            contentType: "text/plain",
            name: "note",
          },
        ],
        { boundary: "BOUNDARY" },
      ),
    );
    const result = await run({
      env: { EXAMPLE_BEARER_AUTH: SECRET },
      operation: meta("POST"),
      recorded: [{ kind: "secret", label: "password-file", value: Redacted.make(password) }],
      request: HttpClientRequest.post("/items").pipe(HttpClientRequest.setBody(body)),
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.stdout).toContain(
      "\r\n\r\nnote <redacted:password-file> and <redacted:bearerAuth>\r\n--BOUNDARY--",
    );
    expect(result.stdout).not.toContain(password);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(password);
    expect(result.stderr).not.toContain(SECRET);
  });

  test("an application/x-ndjson body from a file prints its records with a recorded value replaced", async () => {
    const password = "pw-NDJSON-SECRET";
    const text = `{"id":1,"password":"${password}"}\n{"id":2}\n`;
    const cut = text.indexOf(password) + 3;
    const result = await run({
      env: { EXAMPLE_BEARER_AUTH: SECRET },
      operation: meta("POST"),
      recorded: [{ kind: "secret", label: "password-file", value: Redacted.make(password) }],
      request: HttpClientRequest.post("/items").pipe(
        HttpClientRequest.setBody(
          HttpBody.stream(
            Stream.make(bytes(text.slice(0, cut)), bytes(text.slice(cut))),
            "application/x-ndjson",
            text.length,
          ),
        ),
        HttpClientRequest.setHeader("content-type", "application/x-ndjson"),
      ),
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.stdout.slice(result.stdout.indexOf("\n\n") + 2)).toBe(
      '{"id":1,"password":"<redacted:password-file>"}\n{"id":2}\n',
    );
    expect(result.stdout).not.toContain(password);
    expect(result.stdout).not.toContain("<binary body");
  });

  test("a text-family stdin body prints <body from stdin> without reading stdin", async () => {
    let read = false;
    const stdin = Stream.fromEffect(
      Effect.sync(() => {
        read = true;

        return bytes('{"name":"a"}');
      }),
    );
    const result = await run({
      env: { EXAMPLE_BEARER_AUTH: SECRET },
      operation: meta("POST"),
      request: HttpClientRequest.post("/items").pipe(
        HttpClientRequest.setBody(HttpBody.stream(stdin, "application/json")),
        HttpClientRequest.setHeader("content-type", "application/json"),
      ),
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(read).toBe(false);
    expect(result.stdout.endsWith("\n\n<body from stdin>\n")).toBe(true);
  });

  test("a sequential stdin body prints <body from stdin> without reading stdin", async () => {
    let read = false;
    const stdin = Stream.fromEffect(
      Effect.sync(() => {
        read = true;

        return bytes('{"id":1}\n');
      }),
    );
    const result = await run({
      env: { EXAMPLE_BEARER_AUTH: SECRET },
      operation: meta("POST"),
      request: HttpClientRequest.post("/items").pipe(
        HttpClientRequest.setBody(HttpBody.stream(stdin, "application/x-ndjson")),
        HttpClientRequest.setHeader("content-type", "application/x-ndjson"),
      ),
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(read).toBe(false);
    expect(result.stdout.endsWith("\n\n<body from stdin>\n")).toBe(true);
  });

  test("an application/octet-stream body still prints <binary body, N bytes>", async () => {
    const result = await run({
      env: { EXAMPLE_BEARER_AUTH: SECRET },
      operation: meta("POST"),
      request: HttpClientRequest.post("/items").pipe(
        HttpClientRequest.setBody(
          HttpBody.stream(Stream.make(bytes("RAWDATA")), "application/octet-stream", 7),
        ),
        HttpClientRequest.setHeader("content-type", "application/octet-stream"),
      ),
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.stdout.endsWith("\n\n<binary body, 7 bytes>\n")).toBe(true);
    expect(result.stdout).not.toContain("RAWDATA");
  });

  test("a redacted header is exempt only when it is exactly a placeholder form", async () => {
    const canary = "canary-COOKIE-SECRET";
    const result = await run({
      operation: meta("GET"),
      request: HttpClientRequest.get("/items").pipe(
        HttpClientRequest.setHeader("cookie", `a=<redacted:bearerAuth>; session=${canary}`),
      ),
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.stdout).not.toContain(canary);
    expect(result.stdout).toContain("cookie: a=<redacted:bearerAuth>; session=<redacted>\n");
    expect(result.stdout).toContain("authorization: Bearer <redacted:bearerAuth>\n");
  });
});

// Hater m3 HB1: a credential shorter than a placeholder is never spelled out inside one. Removing
// every placeholder token leaves no character of the credential, and no marker nests in another.
describe("a one-character credential is never recoverable from output (HB1)", () => {
  const placeholderToken = /<redacted(?::[^<>]*)?>/gu;

  const decodeErrorJson = Schema.decodeUnknownSync(
    Schema.Struct({
      error: Schema.Struct({
        body: Schema.String,
        kind: Schema.String,
        message: Schema.String,
        operation: Schema.String,
        status: Schema.Number,
      }),
    }),
  );

  const expectOpaque = (text: string) => {
    expect(text).not.toContain("<red<");
    expect(text.replaceAll(placeholderToken, "")).not.toContain("a");
  };

  test("--dry-run", async () => {
    const result = await run({
      env: { EXAMPLE_BEARER_AUTH: "a" },
      operation: meta("POST"),
      request: jsonPost,
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.stdout.split("\n").find((line) => line.includes("thoriz"))).toMatch(
      /rer <redacted:bearerAuth>$/u,
    );
    expectOpaque(result.stdout);
    expectOpaque(result.stderr);
  });

  test("--verbose", async () => {
    const result = await run({
      dryRun: false,
      env: { EXAMPLE_BEARER_AUTH: "a" },
      operation: meta("GET"),
      request: HttpClientRequest.get("/items"),
      verbose: true,
    });

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.sent).toBe(1);

    // The `> ` and `< ` blocks; the undeclared-media notice carries only the operation id.
    const blocks = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("> ") || line.startsWith("< "))
      .join("\n");

    expect(blocks).toContain("thoriz<redacted:bearerAuth>tion: <redacted>");
    expectOpaque(blocks);
  });

  test("an error under <PREFIX>_ERROR_FORMAT=json", async () => {
    const result = await run({
      dryRun: false,
      env: { EXAMPLE_BEARER_AUTH: "a", EXAMPLE_ERROR_FORMAT: "json" },
      operation: meta("GET"),
      reply: () =>
        new Response('{"error":"bad token a","hint":"<redacted:bearerAuth>"}', {
          headers: { "content-type": "application/json" },
          status: 400,
        }),
      request: HttpClientRequest.get("/items"),
    });

    expect(Exit.isFailure(result.exit)).toBe(true);

    // The scrubbed fields; the keys and `kind` and `matched` are the runtime's own vocabulary.
    const { error } = decodeErrorJson(JSON.parse(result.stderr));

    expect(error).toMatchObject({ kind: "ApiResponseError", status: 400 });
    expect(error.body).toContain('"hint":"<redacted:bearerAuth>"');
    expectOpaque(result.stdout);
    for (const field of [error.body, error.message, error.operation]) {
      expectOpaque(field);
    }
  });
});

// Security review of m3-hb1: a server that wraps the credential in placeholder-shaped text cannot
// make it print in an error body.
describe("a credential echoed inside placeholder-shaped text is scrubbed (HB1b)", () => {
  const echo = `{"echo":"<redacted:${SECRET}>","open":"<redacted:${SECRET} tail>"}`;

  test("an error body under <PREFIX>_ERROR_FORMAT=json", async () => {
    const result = await run({
      dryRun: false,
      env: { EXAMPLE_BEARER_AUTH: SECRET, EXAMPLE_ERROR_FORMAT: "json" },
      operation: meta("GET"),
      reply: () =>
        new Response(echo, { headers: { "content-type": "application/json" }, status: 400 }),
      request: HttpClientRequest.get("/items"),
    });

    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.stderr).toContain("<redacted:bearerAuth>");
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
  });
});
