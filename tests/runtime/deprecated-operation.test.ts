/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path, Sink, Stdio } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import { runCredentialsLayer } from "../../src/runtime-src/runtime/redact.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

// A deprecated operation writes one stderr notice naming the command, before the request, and
// nothing reaches stdout; any other operation writes nothing.

const rootTable: BaseUrl.ServersTable = {
  boundOrigins: ["https://api.example.com"],
  defaultServer: 0,
  servers: [{ url: "https://api.example.com/v1" }],
};

const base: Output.OperationMeta = {
  media: { request: [], responses: { "200": [] } },
  method: "GET",
  operationId: "legacy-get",
  pathTemplate: "/legacy",
  security: [],
};

const run = async (meta: Output.OperationMeta) => {
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
    Effect.sync(() => {
      events.push("request");

      return HttpClientResponse.fromWeb(sent, new Response(null, { status: 200 }));
    }),
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
    runCredentialsLayer,
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
    path: Serialize.path(meta.pathTemplate, []),
    query: [],
  });

  // The recording client has no response stream, so `send` itself may fail after the request.
  await Effect.runPromise(
    Effect.exit(request.pipe(Effect.flatMap(Output.send(meta)))).pipe(Effect.provide(environment)),
  );

  return { events, stderr: stderr.join(""), stdout: stdout.join("") };
};

describe("deprecated operation notice", () => {
  test("OPR-14: a deprecated operation writes one notice naming the command before the request", async () => {
    const result = await run({ ...base, deprecated: true });

    expect(result.stderr).toBe("Notice: the operation legacy-get is deprecated\n");
    expect(result.events.indexOf("stderr")).toBeLessThan(result.events.indexOf("request"));
    expect(result.events).toContain("request");
  });

  test("OPR-14: the notice names the method and path when there is no operationId", async () => {
    const result = await run({ ...base, deprecated: true, operationId: undefined });

    expect(result.stderr).toBe("Notice: the operation GET /legacy is deprecated\n");
  });

  test("OPR-14: stdout is unchanged by the notice", async () => {
    const marked = await run({ ...base, deprecated: true });
    const plain = await run(base);

    expect(marked.stdout).toBe(plain.stdout);
  });

  test("OPR-14: deprecated: false writes no notice", async () => {
    const result = await run({ ...base, deprecated: false });

    expect(result.stderr).toBe("");
    expect(result.events).toEqual(["request"]);
  });

  test("OPR-14: an operation without the flag writes no notice", async () => {
    const result = await run(base);

    expect(result.stderr).toBe("");
    expect(result.events).toEqual(["request"]);
  });
});
