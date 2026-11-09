/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Ref,
  Sink,
  Stdio,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ApiResponseError } from "../../src/runtime-src/domain/errors.ts";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import type { Credential } from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import * as Client from "../../src/runtime-src/runtime/client.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import { finalCatch } from "../../src/runtime-src/runtime/output.ts";
import type { ScrubEntry } from "../../src/runtime-src/runtime/redact.ts";
import { RunCredentials, runCredentialsLayer } from "../../src/runtime-src/runtime/redact.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

const bearer: Credential = {
  definition: { kind: "http", scheme: "bearer" },
  scheme: "bearer",
  value: Redacted.make("test-secret-value"),
};

const fail = (fields: Partial<ConstructorParameters<typeof ApiResponseError>[0]> = {}) =>
  new ApiResponseError({
    bodyExcerpt: "",
    matched: "404",
    operation: "users.get",
    status: 404,
    ...fields,
  });

/**
 * Runs the error through the real final-catch path and returns what reached stderr.
 */
const stderrOf = async (error: ApiResponseError): Promise<string> => {
  const chunks: Buffer[] = [];
  const layer = Stdio.layerTest({
    stderr: () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.sync(() => {
          chunks.push(Buffer.from(chunk));
        }),
      ),
  });

  await Effect.runPromise(
    Effect.exit(finalCatch([bearer])(Effect.fail(error))).pipe(
      Effect.provide(Layer.merge(layer, runCredentialsLayer)),
    ),
  );

  return Buffer.concat(chunks).toString("utf-8");
};

const statusLine = "Error: users.get returned 404 (matched 404)";

describe("text error output prints the Request ID line (design 7.4)", () => {
  test("the line sits between the Error line and the body excerpt", async () => {
    const text = await stderrOf(fail({ bodyExcerpt: "no such user", requestId: "req_123" }));

    expect(text.trimEnd().split("\n")).toEqual([statusLine, "Request ID: req_123", "no such user"]);
  });

  test("without a request id the output equals the M1 bytes", async () => {
    const text = await stderrOf(fail({ bodyExcerpt: "no such user" }));

    expect(text).not.toContain("Request ID");
    expect(text.trimEnd().split("\n")).toEqual([statusLine, "no such user"]);
  });

  test("an empty excerpt (--max-error-bytes 0) keeps the Request ID line", async () => {
    const text = await stderrOf(fail({ bodyExcerpt: "", requestId: "req_123" }));

    expect(text.trimEnd().split("\n")).toEqual([statusLine, "Request ID: req_123"]);
  });
});

// A secret-file value the run recorded is scrubbed from the request id before it is bounded
// (design 9 I4, 7.5; audit F2): a cut prefix would no longer match the final catch's scrub.
describe("Output.send scrubs the request id with the run's recorded values", () => {
  const PASSWORD = "Zq9-PASSWORD-FILE-VALUE";
  const padding = "r".repeat(250);
  const secretFile: ScrubEntry = {
    kind: "secret",
    label: "password-file",
    value: Redacted.make(PASSWORD),
  };
  const servers: BaseUrl.ServersTable = {
    boundOrigins: ["https://api.example.com"],
    defaultServer: 0,
    servers: [{ url: "https://api.example.com", variables: {} }],
  };
  const meta: Output.OperationMeta = {
    media: { request: [], responses: { "200": ["application/json"] } },
    method: "GET",
    operationId: "users-get",
    pathTemplate: "/users",
    requestIdHeader: "x-request-id",
    security: [[]],
  };
  const getRequest = Serialize.request("GET", {
    headers: [],
    path: Serialize.path("/users", []),
    query: [],
  });

  const sendStderr = async (format: Output.ErrorFormat): Promise<string> => {
    const chunks: Buffer[] = [];
    const capture = () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.sync(() => {
          chunks.push(Buffer.from(chunk));
        }),
      );
    const client = HttpClient.make((sent) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          sent,
          new Response("", { headers: { "x-request-id": padding + PASSWORD }, status: 404 }),
        ),
      ),
    );
    const environment = Layer.mergeAll(
      BaseUrl.layer(servers, "EXAMPLE"),
      Auth.layer({ schemes: {} }, "EXAMPLE"),
      ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
      FileSystem.layerNoop({}),
      Path.layer,
      Stdio.layerTest({
        stderr: capture,
        stdout: () => Sink.drain,
        stdoutIsTerminal: Effect.succeed(false),
      }),
      Input.stdinClaimLayer,
      runCredentialsLayer,
      Output.runWarningsLayer,
      Layer.effect(Output.RunRecord)(Ref.make<Output.RunRecordState>({ format })),
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.succeed(Output.ClientPolicy, {
        allowed: new Set(["GET"]),
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
      Layer.succeed(Client.verboseSetting, false),
    );
    // The body records the secret-file value before `send`, as `input.ts` does.
    const handler = Effect.gen(function* recordThenSend() {
      yield* Ref.update(yield* Effect.service(RunCredentials), (entries) => [
        ...entries,
        secretFile,
      ]);
      yield* getRequest.pipe(Effect.flatMap(Output.send(meta)));
    });

    await Effect.runPromise(Effect.exit(finalCatch([])(handler)).pipe(Effect.provide(environment)));

    return Buffer.concat(chunks).toString("utf-8");
  };

  test.each(["text", "json"] as const)(
    "a secret straddling the 256-unit bound leaves no prefix in %s",
    async (format) => {
      const text = await sendStderr(format);

      expect(text).toContain(padding);
      for (let length = 1; length <= PASSWORD.length; length += 1) {
        expect(text).not.toContain(padding + PASSWORD.slice(0, length));
      }
    },
  );
});
