/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import {
  Array as Arr,
  Cause,
  ConfigProvider,
  Console,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Redacted,
  Ref,
  Runtime,
  Schema,
  Sink,
  Stdio,
} from "effect";
import { CliError, CliOutput, Command, Flag } from "effect/cli";
import type { GlobalFlag } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  ApiResponseError,
  CredentialMissing,
  TransportError,
  UsageError,
} from "../../src/runtime-src/domain/errors.ts";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import type * as Client from "../../src/runtime-src/runtime/client.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import type { ScrubEntry } from "../../src/runtime-src/runtime/redact.ts";
import { RunCredentials, runCredentialsLayer } from "../../src/runtime-src/runtime/redact.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

const PREFIX = "EXAMPLE";

const SECRET = "tok-ER1-SECRET";

const SECRET_FILE_VALUE = "pw-ER1-SECRET";

const bearer: Auth.Credential = {
  definition: { kind: "http", scheme: "bearer" },
  scheme: "bearer",
  value: Redacted.make(SECRET),
};

const secretEntry: ScrubEntry = {
  kind: "secret",
  label: "password-file",
  value: Redacted.make(SECRET_FILE_VALUE),
};

interface Options {
  // The env the ConfigProvider serves.
  readonly env?: Record<string, string>;
  // The `finalCatch` options; absent means the call without them.
  readonly envPrefix?: string;
  // The flag value the root parsed for `--error-format`.
  readonly flag?: Output.ErrorFormat;
  // The run record's starting state; absent means no record layer at all.
  readonly record?: Output.RunRecordState;
  // Values already in `RunCredentials` before the catch runs.
  readonly recorded?: readonly ScrubEntry[];
}

// The services `send` reads, so the hint cases run through the real path; every run gets them.
const servers: BaseUrl.ServersTable = {
  boundOrigins: ["https://api.example.com"],
  defaultServer: 0,
  servers: [{ url: "https://api.example.com", variables: {} }],
};

const noSecurity: Auth.SecurityTable = { schemes: {} };

const direct: Client.DirectRoute = { cache: "no-store" };

const metaFor = (method: string): Output.OperationMeta => ({
  media: { request: [], responses: { "200": [], "404": [] } },
  method,
  operationId: "users-act",
  pathTemplate: "/users",
  security: [],
});

const requestFor = (method: string, idempotencyKey = false) =>
  Serialize.request(method, {
    headers: idempotencyKey
      ? [Serialize.header("Idempotency-Key", "k-1", { explode: false, required: false })]
      : [],
    path: Serialize.path("/users", []),
    query: [],
  });

const client = HttpClient.make((sent) =>
  Effect.succeed(HttpClientResponse.fromWeb(sent, new Response("missing", { status: 404 }))),
);

const sendLayer = Layer.mergeAll(
  BaseUrl.layer(servers, PREFIX),
  Auth.layer(noSecurity, PREFIX),
  FileSystem.layerNoop({}),
  Path.layer,
  Input.stdinClaimLayer,
  Layer.succeed(HttpClient.HttpClient, client),
  Layer.succeed(Output.ClientPolicy, {
    allowed: new Set(["GET", "POST"]),
    binName: "example",
    direct,
    version: "1.2.3",
  }),
  Layer.succeed(Output.OutputPath, Option.none()),
  Layer.succeed(Output.Force, false),
  Layer.succeed(Output.MaxErrorBytes, Output.defaultMaxErrorBytes),
  Layer.succeed(BaseUrl.baseUrlSetting, Option.none()),
  Layer.succeed(BaseUrl.serverSetting, Option.none()),
  Layer.succeed(BaseUrl.serverVariableSetting, []),
  Layer.succeed(Auth.allowCredentialsForBaseUrl, false),
);

type TestServices =
  | Layer.Success<typeof sendLayer>
  | RunCredentials
  | Stdio.Stdio
  | GlobalFlag.Setting.Identifier<"error-format">;

const capture = (into: Buffer[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(Buffer.from(chunk));
    }),
  );

/**
 * Run `program` through the real final catch and return what reached stderr and the exit code.
 */
const runCatch = async <A, E>(
  program: Effect.Effect<A, E, TestServices>,
  options: Options = {},
) => {
  const stderr: Buffer[] = [];
  const environment = Layer.mergeAll(
    sendLayer,
    Stdio.layerTest({ stderr: capture(stderr), stdout: capture([]) }),
    Layer.effect(RunCredentials)(Ref.make<readonly ScrubEntry[]>(options.recorded ?? [])),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(options.env ?? {})),
  );
  const caught = Output.finalCatch(
    [bearer],
    options.envPrefix === undefined ? undefined : { envPrefix: options.envPrefix },
  )(
    program.pipe(
      Effect.provideService(Output.errorFormatSetting, Option.fromNullishOr(options.flag)),
    ),
  );
  const recorded =
    options.record === undefined
      ? caught
      : Effect.provideServiceEffect(caught, Output.RunRecord, Ref.make(options.record));
  const exit = await Effect.runPromise(Effect.exit(recorded).pipe(Effect.provide(environment)));
  const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

  return {
    code: error === undefined ? 0 : Runtime.getErrorExitCode(error),
    error,
    stderr: Buffer.concat(stderr).toString("utf-8"),
  };
};

const ErrorObject = Schema.Struct({
  body: Schema.optionalKey(Schema.String),
  kind: Schema.String,
  matched: Schema.optionalKey(Schema.String),
  message: Schema.String,
  operation: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  retryAfter: Schema.optionalKey(Schema.Number),
  status: Schema.optionalKey(Schema.Number),
});

// Raw keys first, in the order printed; then the fields, refusing any key the design does not name.
const decodeLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Record(Schema.String, Schema.Unknown) })),
);

const decodeError = Schema.decodeUnknownSync(ErrorObject, { onExcessProperty: "error" });

/**
 * The one JSON object on stderr: exactly one line, parseable, with the single key `error`, whose
 * keys are alphabetical and named by design 7.4.
 */
const jsonOf = (stderr: string): typeof ErrorObject.Type => {
  const lines = stderr.trimEnd().split("\n");

  expect(lines).toHaveLength(1);

  const { error } = decodeLine(lines[0] ?? "");

  expect(Object.keys(error)).toEqual(Arr.sort(Object.keys(error), Order.String));

  return decodeError(error);
};

const isJson = (stderr: string): boolean => stderr.trimStart().startsWith("{");

const unknownFlag = () =>
  Output.exitForHelp(
    Effect.fail(
      new CliError.ShowHelp({
        commandPath: ["example"],
        errors: [new CliError.UnrecognizedOption({ option: "--bogus", suggestions: [] })],
      }),
    ),
  );

const notFound = (fields: Partial<ConstructorParameters<typeof ApiResponseError>[0]> = {}) =>
  new ApiResponseError({
    bodyExcerpt: '{"error":"no such user"}',
    matched: "404",
    operation: "users-get",
    status: 404,
    ...fields,
  });

const json: Options = { record: { format: "json" } };

describe("a parse-time CliError follows <PREFIX>_ERROR_FORMAT (design 7.4 revision 31)", () => {
  test("the env name set to json and nothing recorded gives one JSON object", async () => {
    const text = await runCatch(unknownFlag(), { envPrefix: PREFIX });
    const rendered = await runCatch(unknownFlag(), {
      env: { EXAMPLE_ERROR_FORMAT: "json" },
      envPrefix: PREFIX,
      record: {},
    });
    const error = jsonOf(rendered.stderr);

    expect(error.kind).toBe("UnrecognizedOption");
    expect(error).not.toHaveProperty("operation");
    expect(rendered.code).toBe(2);
    expect(rendered.code).toBe(text.code);
  });

  test("--error-format json on argv with nothing recorded gives text", async () => {
    const rendered = await runCatch(unknownFlag(), { envPrefix: PREFIX, flag: "json", record: {} });

    expect(isJson(rendered.stderr)).toBe(false);
    expect(rendered.stderr).toContain("--bogus");
  });

  test("without the envPrefix option the env name is not read", async () => {
    const rendered = await runCatch(unknownFlag(), { env: { EXAMPLE_ERROR_FORMAT: "json" } });

    expect(isJson(rendered.stderr)).toBe(false);
  });

  test("any value but json gives text", async () => {
    const rendered = await runCatch(unknownFlag(), {
      env: { EXAMPLE_ERROR_FORMAT: "yaml" },
      envPrefix: PREFIX,
    });

    expect(isJson(rendered.stderr)).toBe(false);
  });
});

describe("recordRun records the run's format before the handler's first step (F1)", () => {
  const usageAfterRecord = Output.recordRun(PREFIX).pipe(
    Effect.andThen(Effect.fail(new UsageError({ flag: "body", message: "invalid body" }))),
  );

  test("--error-format json, then a UsageError raised before send, gives one JSON object", async () => {
    const rendered = await runCatch(usageAfterRecord, { flag: "json", record: {} });
    const error = jsonOf(rendered.stderr);

    expect(error.kind).toBe("UsageError");
    expect(error).not.toHaveProperty("operation");
    expect(rendered.code).toBe(2);
  });

  test("the env name applies when the flag is absent", async () => {
    const rendered = await runCatch(usageAfterRecord, {
      env: { EXAMPLE_ERROR_FORMAT: "json" },
      record: {},
    });

    expect(jsonOf(rendered.stderr).kind).toBe("UsageError");
  });

  test("the flag beats the env name", async () => {
    const rendered = await runCatch(usageAfterRecord, {
      env: { EXAMPLE_ERROR_FORMAT: "json" },
      envPrefix: PREFIX,
      flag: "text",
      record: {},
    });

    expect(isJson(rendered.stderr)).toBe(false);
  });

  test("an invalid env value is a UsageError naming the variable", async () => {
    const rendered = await runCatch(Output.recordRun(PREFIX), {
      env: { EXAMPLE_ERROR_FORMAT: "yaml" },
      record: {},
    });

    expect(rendered.error).toBeInstanceOf(UsageError);
    expect(rendered.error).toMatchObject({ flag: "EXAMPLE_ERROR_FORMAT" });
    expect(rendered.code).toBe(2);
  });

  test("without the record's layer recordRun succeeds and errors render as text", async () => {
    const rendered = await runCatch(usageAfterRecord, { flag: "json" });

    expect(rendered.error).toBeInstanceOf(UsageError);
    expect(isJson(rendered.stderr)).toBe(false);
  });
});

describe("--error-format json renders each design 7.1 error as one object", () => {
  test("ApiResponseError 404 with a body", async () => {
    const text = await runCatch(Effect.fail(notFound()));
    const rendered = await runCatch(Effect.fail(notFound()), json);
    const error = jsonOf(rendered.stderr);

    expect(Object.keys(error)).toEqual([
      "body",
      "kind",
      "matched",
      "message",
      "operation",
      "status",
    ]);
    expect(error.kind).toBe("ApiResponseError");
    expect(error.operation).toBe("users-get");
    expect(error.status).toBe(404);
    expect(error.matched).toBe("404");
    expect(error.body).toBe('{"error":"no such user"}');
    expect(rendered.code).toBe(1);
    expect(rendered.code).toBe(text.code);
  });

  test("an empty excerpt has no body key", async () => {
    const rendered = await runCatch(Effect.fail(notFound({ bodyExcerpt: "" })), json);

    expect(jsonOf(rendered.stderr)).not.toHaveProperty("body");
  });

  test("TransportError, CredentialMissing and UsageError keep their exit codes", async () => {
    const cases = [
      [() => new TransportError({ reason: "connect", url: "https://api.example.com/" }), 4, false],
      [
        () => new CredentialMissing({ alternatives: ["bearerAuth"], operation: "users-get" }),
        3,
        true,
      ],
      [() => new UsageError({ flag: "id", message: "missing --id" }), 2, false],
    ] as const;

    const runs = await Promise.all(
      cases.map(async ([make]) => ({
        rendered: await runCatch(Effect.fail(make()), json),
        text: await runCatch(Effect.fail(make())),
      })),
    );

    for (const [index, [make, code, carriesOperation]] of cases.entries()) {
      const run = runs[index];
      const error = jsonOf(run?.rendered.stderr ?? "");

      expect(error.kind).toBe(make()._tag);
      expect(Object.hasOwn(error, "operation")).toBe(carriesOperation);
      expect(error).not.toHaveProperty("status");
      expect(error).not.toHaveProperty("body");
      expect(run?.rendered.code).toBe(code);
      expect(run?.rendered.code).toBe(run?.text.code);
    }
  });

  test("a parse-time CliError renders inside the same object, value-free", async () => {
    const canary = "VALUE-CANARY";
    const invalid = new CliError.InvalidValue({
      expected: `Expected a port, got "${canary}"`,
      kind: "flag",
      option: "port",
      value: canary,
    });
    const rendered = await runCatch(Effect.fail(invalid), json);
    const error = jsonOf(rendered.stderr);

    expect(error.kind).toBe("InvalidValue");
    expect(error).not.toHaveProperty("operation");
    expect(rendered.stderr).toContain("--port");
    expect(rendered.stderr).not.toContain(canary);
  });

  test("the exit-70 path is kind Internal", async () => {
    const rendered = await runCatch(Effect.die(new Error(`boom ${SECRET}`)), json);
    const error = jsonOf(rendered.stderr);

    expect(error.kind).toBe("Internal");
    expect(rendered.code).toBe(70);
    expect(rendered.stderr).not.toContain(SECRET);
  });

  test("help without errors still prints nothing", async () => {
    const help = new CliError.ShowHelp({ commandPath: [], errors: [] });
    const rendered = await runCatch(Effect.fail(help), json);

    expect(rendered.stderr).toBe("");
  });

  test("credentials and recorded secrets are scrubbed in every field", async () => {
    const echo = notFound({
      bodyExcerpt: `token ${SECRET} password ${SECRET_FILE_VALUE}`,
      requestId: `req-${SECRET}`,
    });
    const rendered = await runCatch(Effect.fail(echo), { ...json, recorded: [secretEntry] });
    const error = jsonOf(rendered.stderr);

    expect(rendered.stderr).not.toContain(SECRET);
    expect(rendered.stderr).not.toContain(SECRET_FILE_VALUE);
    expect(error.body).toContain("<redacted:bearer>");
    expect(error.body).toContain("<redacted:password-file>");
    expect(error.requestId).toBe("req-<redacted:bearer>");
  });

  test("control characters in the body are removed, and the line stays one object", async () => {
    const rendered = await runCatch(
      Effect.fail(notFound({ bodyExcerpt: 'a\u001B[31m"b‮c\nd' })),
      json,
    );

    expect(jsonOf(rendered.stderr).body).toBe('a[31m"bc\nd');
  });
});

describe("retryAfter and requestId (design 7.4, m3 P14)", () => {
  test("retryAfterSeconds 2 gives retryAfter 2", async () => {
    const rendered = await runCatch(Effect.fail(notFound({ retryAfterSeconds: 2 })), json);

    expect(jsonOf(rendered.stderr).retryAfter).toBe(2);
  });

  test("the text form adds one line naming the Retry-After value and the --timeout cap", async () => {
    const plain = await runCatch(Effect.fail(notFound({ bodyExcerpt: "" })));
    const capped = await runCatch(Effect.fail(notFound({ bodyExcerpt: "", retryAfterSeconds: 2 })));
    const added = capped.stderr.trimEnd().split("\n").slice(1);

    expect(plain.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("Retry-After");
    expect(added[0]).toContain("2");
    expect(added[0]).toContain("--timeout");
  });

  test("without retryAfterSeconds there is no retryAfter key", async () => {
    const rendered = await runCatch(Effect.fail(notFound()), json);

    expect(jsonOf(rendered.stderr)).not.toHaveProperty("retryAfter");
  });

  test("requestId set is rendered", async () => {
    const rendered = await runCatch(Effect.fail(notFound({ requestId: "req_123" })), json);

    expect(jsonOf(rendered.stderr).requestId).toBe("req_123");
  });

  test("requestId unset is absent", async () => {
    const rendered = await runCatch(Effect.fail(notFound()), json);

    expect(jsonOf(rendered.stderr)).not.toHaveProperty("requestId");
  });
});

const sendOnce = (method: string, options: Options, idempotencyKey = false) =>
  runCatch(
    Output.recordRun(PREFIX).pipe(
      Effect.andThen(requestFor(method, idempotencyKey)),
      Effect.flatMap(Output.send(metaFor(method))),
    ),
    options,
  );

describe("the retry hint follows wouldRetry for the method send recorded (SM-16)", () => {
  test("a recorded GET failure carries the hint", async () => {
    const rendered = await sendOnce("GET", { flag: "json", record: {} });
    const error = jsonOf(rendered.stderr);

    expect(error.kind).toBe("ApiResponseError");
    expect(error.message).toContain(Output.retryHint);
  });

  test("a recorded POST failure does not", async () => {
    const rendered = await sendOnce("POST", { flag: "json", record: {} });

    expect(jsonOf(rendered.stderr).message).not.toContain(Output.retryHint);
  });

  test("a POST with an Idempotency-Key header carries the hint", async () => {
    const rendered = await sendOnce("POST", { flag: "json", record: {} }, true);

    expect(jsonOf(rendered.stderr).message).toContain(Output.retryHint);
  });

  test("the text form carries the hint after a GET and not after a POST", async () => {
    const get = await sendOnce("GET", { record: {} });
    const post = await sendOnce("POST", { record: {} });

    expect(get.stderr).toContain(Output.retryHint);
    expect(post.stderr).not.toContain(Output.retryHint);
    expect(get.code).toBe(1);
    expect(post.code).toBe(1);
  });

  test("without the record's layer send and finalCatch behave as today: text, no hint", async () => {
    const rendered = await sendOnce("GET", { flag: "json" });

    expect(isJson(rendered.stderr)).toBe(false);
    expect(rendered.stderr).not.toContain(Output.retryHint);
    expect(rendered.code).toBe(1);
  });
});

describe("the retry hint joins the message as a second sentence (ws5 finding 3)", () => {
  test("JSON: a period and a space separate the message from the hint", async () => {
    const rendered = await sendOnce("GET", { flag: "json", record: {} });
    const { message } = jsonOf(rendered.stderr);

    expect(message).toBe(`users-act returned 404 (matched 404). ${Output.retryHint}`);
  });

  test("text keeps the hint on its own line after the Error line", async () => {
    const rendered = await sendOnce("GET", { record: {} });

    expect(rendered.stderr.split("\n").slice(0, 2)).toEqual([
      "Error: users-act returned 404 (matched 404)",
      Output.retryHint,
    ]);
  });
});

// The generated entry's shape for a parse-time error: `Command.runWith` with `renderErrors: false`
// and the runtime presenter, `exitForHelp` inside `finalCatch`, `RunRecord` outside it. Console
// carries the presenter's text and Stdio carries the final catch's; both land in one stderr.
const parseRun = async (args: readonly string[], env: Record<string, string> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  // oxlint-disable-next-line prefer-object-spread
  const console: Console.Console = Object.assign({}, globalThis.console, {
    error: (...parts: readonly unknown[]) => {
      err.push(`${parts.join(" ")}\n`);
    },
    log: (...parts: readonly unknown[]) => {
      out.push(`${parts.join(" ")}\n`);
    },
  });
  const login = Command.make("login", { port: Flag.Int("port") }, () => Effect.void);
  const root = Command.make("example").pipe(Command.withSubcommands([login]));
  const exit = await Effect.runPromise(
    Command.runWith(root, { renderErrors: false, version: "1.2.3" })(args).pipe(
      Output.exitForHelp,
      Output.finalCatch([], { envPrefix: PREFIX }),
      Effect.provide(
        Layer.mergeAll(
          Stdio.layerTest({
            stderr: () =>
              Sink.forEach((chunk: string | Uint8Array) =>
                Effect.sync(() => {
                  err.push(Buffer.from(chunk).toString("utf-8"));
                }),
              ),
            stdout: capture([]),
          }),
          runCredentialsLayer,
          Output.runRecordLayer,
          ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
          CliOutput.layer(Output.valueFreeFormatter),
          CliOutput.layerPresenter(Output.presenter),
        ),
      ),
      Effect.provide(BunServices.layer),
      Effect.provideService(Console.Console, console),
      Effect.exit,
    ),
  );

  return {
    code: Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause)),
    stderr: err.join(""),
    stdout: out.join(""),
  };
};

describe("a parse-time error under <PREFIX>_ERROR_FORMAT=json writes only the object (ws5 finding 2)", () => {
  test("an unknown flag: stderr is exactly one JSON line, exit 2", async () => {
    const run = await parseRun(["login", "--bogus"], { EXAMPLE_ERROR_FORMAT: "json" });

    expect(run.stderr.endsWith("\n")).toBe(true);
    expect(run.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(jsonOf(run.stderr).kind).toBe("UnrecognizedOption");
    expect(run.stdout).toBe("");
    expect(run.code).toBe(2);
  });

  test("text keeps the help before the error", async () => {
    const run = await parseRun(["login", "--bogus"]);

    expect(run.stderr).toContain("USAGE");
    expect(run.stderr.indexOf("USAGE")).toBeLessThan(run.stderr.indexOf("--bogus"));
    expect(run.code).toBe(2);
  });

  test("a group run without a subcommand still prints its help on stderr under json, exit 0", async () => {
    const run = await parseRun([], { EXAMPLE_ERROR_FORMAT: "json" });

    expect(run.stderr).toContain("login");
    expect(isJson(run.stderr)).toBe(false);
    expect(run.code).toBe(0);
  });
});
