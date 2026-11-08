/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { HttpBody } from "effect/http";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

// A quote and a kept trailing LF, so the raw form and the JSON-escaped form differ.
const SECRET = 'pa55"word\n';

const ESCAPED = 'pa55\\"word\\n';

const LABEL = "<redacted:password-file>";

const FLAG = "password-file";

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const capture = (into: Buffer[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(Buffer.from(chunk));
    }),
  );

const joined = (chunks: readonly Buffer[]): string => Buffer.concat(chunks).toString("utf-8");

const stdioOf = (stdin: string, stderr: Buffer[] = []): Layer.Layer<Stdio.Stdio> =>
  Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stderr: capture(stderr),
      stdin: Stream.make(encoder.encode(stdin)),
      stdout: () => Sink.drain,
    }),
  );

const secret = (path: string) => Option.some(new Input.SecretField({ flag: FLAG, path }));

const merge = (options: { readonly bodyFile?: string; readonly fields: Input.Fields }) =>
  Input.mergeBody({
    body: Option.none(),
    bodyFile: Option.fromNullishOr(options.bodyFile),
    fields: options.fields,
    required: false,
    schema: Schema.Unknown,
  });

const withTempFile = <A, E, R>(content: string, use: (path: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* temp() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* fs.makeTempFileScoped();

    yield* fs.writeFileString(path, content);

    return yield* use(path);
  }).pipe(Effect.scoped);

const textOf = (body: HttpBody.HttpBody): string =>
  body._tag === "Uint8Array" ? decoder.decode(body.body) : `<${body._tag}>`;

const recorded = Effect.flatMap(Effect.service(Output.RunCredentials), Ref.get);

const inputLayer = (stdin: string, stderr: Buffer[] = []) =>
  Layer.mergeAll(
    BunFileSystem.layer,
    stdioOf(stdin, stderr),
    Input.stdinClaimLayer,
    Output.runCredentialsLayer,
  );

const runInput = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Stdio.Stdio | Input.StdinClaim | Output.RunCredentials
  >,
  stdin = "",
) => Effect.runPromise(Effect.exit(effect).pipe(Effect.provide(inputLayer(stdin))));

const errorOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("a secret-file field flag", () => {
  test("the file's bytes, trailing LF kept, land at the field's path", async () => {
    const exit = await runInput(
      withTempFile(SECRET, (path) =>
        merge({ fields: { "/auth/password": secret(path) } }).pipe(Effect.map(textOf)),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(JSON.parse(Exit.isSuccess(exit) ? exit.value : "null")).toEqual({
      auth: { password: SECRET },
    });
  });

  test("- reads stdin", async () => {
    const exit = await runInput(
      merge({ fields: { "/password": secret("-") } }).pipe(Effect.map(textOf)),
      SECRET,
    );

    expect(JSON.parse(Exit.isSuccess(exit) ? exit.value : "null")).toEqual({ password: SECRET });
  });

  test("- with --body-file - is a UsageError naming the flag", async () => {
    const exit = await runInput(
      merge({ bodyFile: "-", fields: { "/password": secret("-") } }),
      "{}",
    );
    const error = errorOf(exit);

    expect(error?._tag).toBe("UsageError");
    expect(error?._tag === "UsageError" ? error.flag : undefined).toBe(FLAG);
  });

  test("an unreadable path is a UsageError naming the flag", async () => {
    const exit = await runInput(
      merge({ fields: { "/password": secret("/nonexistent/openapi-cli/secret") } }),
    );
    const error = errorOf(exit);

    expect(error?._tag).toBe("UsageError");
    expect(error?._tag === "UsageError" ? error.flag : undefined).toBe(FLAG);
  });

  test("the value is recorded for the run, and an absent flag records nothing", async () => {
    const given = await runInput(
      merge({ fields: { "/password": secret("-") } }).pipe(Effect.andThen(recorded)),
      SECRET,
    );
    const absent = await runInput(
      merge({ fields: { "/password": Option.none() } }).pipe(Effect.andThen(recorded)),
    );

    expect(Exit.isSuccess(given) ? given.value.length : -1).toBe(1);
    expect(Exit.isSuccess(absent) ? absent.value.length : -1).toBe(0);
  });

  test("an excerpt echoing the value raw or JSON-escaped renders the label", async () => {
    const exit = await runInput(
      merge({ fields: { "/password": secret("-") } }).pipe(
        Effect.andThen(recorded),
        Effect.map((entries) => [
          Output.boundedExcerpt(`raw=${SECRET};`, 4096, entries),
          Output.boundedExcerpt(`{"echo":"${ESCAPED}"}`, 4096, entries),
        ]),
      ),
      SECRET,
    );

    expect(Exit.isSuccess(exit) ? exit.value : []).toEqual([
      `raw=${LABEL};`,
      `{"echo":"${LABEL}"}`,
    ]);
  });

  test("the defect line scrubs the value", async () => {
    const stderr: Buffer[] = [];
    const program = Output.finalCatch([])(
      merge({ fields: { "/password": secret("-") } }).pipe(
        Effect.andThen(Effect.die(new Error(`boom ${SECRET} and ${ESCAPED}`))),
      ),
    );
    const exit = await Effect.runPromise(
      Effect.exit(program).pipe(Effect.provide(inputLayer(SECRET, stderr))),
    );
    const text = joined(stderr);

    expect(errorOf(exit)?._tag).toBe("InternalError");
    expect(text).toContain(LABEL);
    expect(text).not.toContain("pa55");
  });
});

const servers: BaseUrl.ServersTable = {
  boundOrigins: ["https://api.example.com"],
  defaultServer: 0,
  servers: [{ url: "https://api.example.com", variables: {} }],
};

const meta: Output.OperationMeta = {
  media: { request: ["application/json"], responses: { "200": [] } },
  method: "POST",
  operationId: "users-create",
  pathTemplate: "/users",
  security: [],
};

const request = Serialize.request("POST", {
  headers: [],
  path: Serialize.path("/users", []),
  query: [],
});

// The leak case (audit ad9f808b F3): a secret recorded before `send` survives it, and the 500 body
// that echoes it raw and JSON-escaped never carries the value out.
describe("a secret recorded before send", () => {
  test("is scrubbed from the ApiResponseError excerpt and by finalCatch", async () => {
    const stderr: Buffer[] = [];
    const client = HttpClient.make((sent) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          sent,
          new Response(`raw=${SECRET} json={"password":"${ESCAPED}"}`, {
            headers: { "content-type": "text/plain" },
            status: 500,
          }),
        ),
      ),
    );
    const environment = Layer.mergeAll(
      BaseUrl.layer(servers, "EXAMPLE"),
      Auth.layer({ schemes: {} }, "EXAMPLE"),
      ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
      BunFileSystem.layer,
      Path.layer,
      stdioOf(SECRET, stderr),
      Input.stdinClaimLayer,
      Output.runCredentialsLayer,
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.succeed(Output.ClientPolicy, {
        allowed: new Set(["POST"]),
        binName: "example",
        direct: {},
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
    const program = Output.finalCatch([])(
      merge({ fields: { "/password": secret("-") } }).pipe(
        Effect.andThen(request),
        Effect.flatMap(Output.send(meta)),
      ),
    );
    const exit = await Effect.runPromise(Effect.exit(program).pipe(Effect.provide(environment)));
    const error = errorOf(exit);
    const excerpt = error?._tag === "ApiResponseError" ? error.bodyExcerpt : "";
    const text = joined(stderr);

    expect(error?._tag).toBe("ApiResponseError");
    expect(excerpt).toBe(`raw=${LABEL} json={"password":"${LABEL}"}`);
    expect(text).toContain(LABEL);
    expect(text).not.toContain("pa55");
  });
});
