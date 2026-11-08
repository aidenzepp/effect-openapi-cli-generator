/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Option, Path, Sink, Stdio } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

// HDR-03 (response clause): a required response header the matched case declares and the response
// omits writes one stderr warning, in document order, before the body; stdout and the exit are
// unchanged.

const rootTable: BaseUrl.ServersTable = {
  boundOrigins: ["https://api.example.com"],
  defaultServer: 0,
  servers: [{ url: "https://api.example.com/v1" }],
};

const meta: Output.OperationMeta = {
  media: { request: [], responses: { "200": ["text/plain"], "4XX": [] } },
  method: "GET",
  operationId: "typed-get",
  pathTemplate: "/typed",
  requiredHeaders: { "200": ["X-Required", "X-Second"], "4XX": ["X-Trace"] },
  security: [],
};

// Retry notices carry a jittered delay (design D-AD7); fix only that value so two runs compare equal.
const fixRetryDelays = (stderr: string) =>
  stderr.replaceAll(
    /^(?<notice>Notice: retrying .+ \(attempt \d+ of \d+\) in )\d+ ms$/gmu,
    "$<notice><delay> ms",
  );

const run = async (
  operation: Output.OperationMeta,
  status: number,
  headers: Record<string, string>,
) => {
  const events: string[] = [];
  const stderr: string[] = [];
  const stdout: string[] = [];
  const capture = (into: string[], tag: string) => () =>
    Sink.forEach((chunk: string | Uint8Array) =>
      Effect.sync(() => {
        into.push(Buffer.from(chunk).toString());
        events.push(tag);
      }),
    );
  const client = HttpClient.make((sent) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        sent,
        new Response("body", { headers: { "content-type": "text/plain", ...headers }, status }),
      ),
    ),
  );
  const environment = Layer.mergeAll(
    BaseUrl.layer(rootTable, "X"),
    Auth.layer({ schemes: {} }, "X"),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
    FileSystem.layerNoop({}),
    Path.layer,
    Stdio.layerTest({
      stderr: capture(stderr, "stderr"),
      stdout: capture(stdout, "stdout"),
      stdoutIsTerminal: Effect.succeed(false),
    }),
    Input.stdinClaimLayer,
    Output.runCredentialsLayer,
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Output.ClientPolicy, {
      allowed: new Set(["GET"]),
      binName: "x",
      direct: {},
      version: "1.0.0",
    }),
    Layer.succeed(Output.OutputPath, Option.none()),
    Layer.succeed(Output.Force, false),
    Layer.succeed(Output.MaxErrorBytes, Output.defaultMaxErrorBytes),
    Layer.succeed(BaseUrl.baseUrlSetting, Option.none()),
    Layer.succeed(BaseUrl.serverSetting, Option.none()),
    Layer.succeed(BaseUrl.serverVariableSetting, []),
    Layer.succeed(Auth.allowCredentialsForBaseUrl, false),
  );
  const request = Serialize.request("GET", {
    headers: [],
    path: Serialize.path(operation.pathTemplate, []),
    query: [],
  });
  const exit = await Effect.runPromise(
    Effect.exit(request.pipe(Effect.flatMap(Output.send(operation)))).pipe(
      Effect.provide(environment),
    ),
  );

  return { events, exit, stderr: stderr.join(""), stdout: stdout.join("") };
};

const warning = (name: string) => `Warning: the response is missing the required header ${name}\n`;

describe("missing required response headers (HDR-03)", () => {
  test("each missing required header of the matched case warns once, in document order, before the body", async () => {
    const result = await run(meta, 200, {});

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.stdout).toBe("body");
    expect(result.stderr).toBe(`${warning("X-Required")}${warning("X-Second")}`);
    expect(result.events).toEqual(["stderr", "stderr", "stdout"]);
  });

  test("a present header is matched case-insensitively and writes nothing", async () => {
    const result = await run(meta, 200, { "X-SECOND": "b", "x-required": "a" });

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("body");
  });

  test("a non-2xx case is checked by its matched key, and the error is unchanged", async () => {
    const plain = await run({ ...meta, requiredHeaders: undefined }, 404, {});
    const result = await run(meta, 404, {});

    expect(result.stderr).toBe(`${warning("X-Trace")}${plain.stderr}`);
    expect(result.exit).toEqual(plain.exit);
  });

  test("an undeclared status matches no case and checks nothing", async () => {
    const result = await run(meta, 500, {});
    const plain = await run({ ...meta, requiredHeaders: undefined }, 500, {});

    expect(fixRetryDelays(result.stderr)).toBe(fixRetryDelays(plain.stderr));
  });

  test("an operation without required headers writes nothing", async () => {
    const result = await run({ ...meta, requiredHeaders: undefined }, 200, {});

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("body");
  });
});
