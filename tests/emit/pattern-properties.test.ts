import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Scope } from "effect";
import type { Json } from "../../src/model/pointer.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";
import { setEnv } from "../support/env.ts";

// `patternProperties` is not asserted client-side (SCH-15/not-asserted), whatever form it takes:
// open, closed by `additionalProperties: false`, or nested in a property. Generation never aborts
// on it; the declared properties stay typed, and pattern-matched keys are sent as given.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// The generated package and its inputs live under the worktree's git-ignored `work/`, never the
// system temp directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "pattern-properties-"));

const restoreTmpdir = setEnv("TMPDIR", work);

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

const { port } = new URL(origin);

const scope = Effect.runSync(Scope.make());

const done: Json = { "204": { description: "done" } };

const name: Json = { type: "string" };

const create = (operationId: string, schema: Json): Json => ({
  post: {
    operationId,
    requestBody: { content: { "application/json": { schema } }, required: true },
    responses: done,
  },
});

const spec: Json = {
  info: { title: "patternProperties", version: "1.0.0" },
  openapi: "3.1.2",
  paths: {
    "/closed": create("closed-create", {
      additionalProperties: false,
      patternProperties: { "^x-": { type: "integer" } },
      properties: { name },
      type: "object",
    }),
    "/nested": create("nested-create", {
      properties: {
        meta: {
          additionalProperties: false,
          patternProperties: { "^[a-z]+$": { type: "number" } },
          type: "object",
        },
        name,
      },
      type: "object",
    }),
    "/open": create("open-create", {
      patternProperties: { "^x-": { type: "string" } },
      properties: { name },
      type: "object",
    }),
  },
  servers: [{ url: "http://127.0.0.1:{port}", variables: { port: { default: "80" } } }],
};

let generated: GeneratedPackage | undefined;

beforeAll(async () => {
  const specPath = nodePath.join(work, "openapi.json");
  const configPath = nodePath.join(work, "author-config.json");
  nodeFs.writeFileSync(specPath, `${JSON.stringify(spec)}\n`);
  nodeFs.writeFileSync(
    configPath,
    `${JSON.stringify({
      acceptedOrigins: [origin],
      allowInsecure: true,
      binName: "patterns",
      envPrefix: "PATTERNS",
      package: { name: "pattern-properties-cli", version: "0.1.0" },
    })}\n`,
  );

  generated = await Effect.runPromise(
    generateFixture({ configPath, specPath }).pipe(
      Effect.tap(preparePackage),
      Scope.provide(scope),
      Effect.provide(layer),
    ),
  );
}, 600_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  nodeFs.rmSync(work, { force: true, recursive: true });
  restoreTmpdir();
});

interface Sent {
  readonly exitCode: number | null;
  readonly sent: readonly string[];
}

// One `--body` invocation of the built CLI and the request bodies the capture server recorded.
const send = async (command: string, body: string): Promise<Sent> => {
  if (generated === undefined) {
    throw new Error("the package was not built");
  }

  const before = capture.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, {
      args: ["--server", "0", "--server-variable", `port=${port}`, command, "--body", body],
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );

  return {
    exitCode: result.exitCode,
    sent: capture
      .requests()
      .slice(before)
      .map((request) => new TextDecoder().decode(request.body)),
  };
};

const refusedBeforeSending: Sent = { exitCode: 2, sent: [] };

describe("patternProperties in a request body schema", () => {
  test("an open object sends pattern-matched keys as given", async () => {
    const body = '{"name":"n","x-a":"v"}';

    expect(await send("open-create", body)).toEqual({ exitCode: 0, sent: [body] });
  }, 60_000);

  test("a closed object sends pattern-matched keys as given", async () => {
    const body = '{"name":"n","x-a":1}';

    expect(await send("closed-create", body)).toEqual({ exitCode: 0, sent: [body] });
  }, 60_000);

  test("a nested patterned object sends its keys as given", async () => {
    const body = '{"meta":{"a":1.5,"b":2},"name":"n"}';

    expect(await send("nested-create", body)).toEqual({ exitCode: 0, sent: [body] });
  }, 60_000);

  test("the declared properties stay typed", async () => {
    expect([
      await send("open-create", '{"name":1}'),
      await send("closed-create", '{"name":1}'),
      await send("nested-create", '{"meta":1}'),
    ]).toEqual([refusedBeforeSending, refusedBeforeSending, refusedBeforeSending]);
  }, 60_000);
});
