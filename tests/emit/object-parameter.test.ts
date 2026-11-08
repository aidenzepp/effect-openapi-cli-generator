import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Scope } from "effect";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// An object-schema styled parameter takes JSON (m2-objp2): its flag, or its path positional, parses
// the operator's text as JSON and hands the object to the runtime's style serializer. One package
// is built and run against the capture server; each vector is the style example's object
// `R=100, G=200, B=150` (3.2.1#style-examples, the wt-sty1 vectors), sent byte for byte.

const root = nodePath.resolve(import.meta.dir, "../..");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// The spec, config and package live under the worktree's git-ignored `work/`.
const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "object-parameter-"));

const rgb = {
  properties: { B: { type: "integer" }, G: { type: "integer" }, R: { type: "integer" } },
  type: "object",
};

const ok = { "200": { description: "ok" } };

// One `GET /<id>/{o}` operation per path style, its one object-schema path parameter `o`.
const pathOperation = (id: string, style: string, explode: boolean): readonly [string, object] => [
  `/${id}/{o}`,
  {
    get: {
      operationId: id,
      parameters: [{ explode, in: "path", name: "o", required: true, schema: rgb, style }],
      responses: ok,
    },
  },
];

const spec = {
  info: { title: "Object parameters", version: "1.0.0" },
  openapi: "3.1.2",
  paths: {
    ...Object.fromEntries([
      pathOperation("simple", "simple", false),
      pathOperation("simple-x", "simple", true),
      pathOperation("label", "label", false),
      pathOperation("label-x", "label", true),
      pathOperation("matrix", "matrix", false),
      pathOperation("matrix-x", "matrix", true),
    ]),
    "/headers": {
      get: {
        operationId: "headers",
        parameters: [
          { in: "header", name: "X-O", schema: rgb },
          { explode: true, in: "header", name: "X-Ox", schema: rgb },
        ],
        responses: ok,
      },
    },
    "/query": {
      get: {
        operationId: "query",
        parameters: [
          { in: "query", name: "qf", schema: rgb },
          { explode: false, in: "query", name: "qn", schema: rgb },
          { explode: true, in: "query", name: "deep", schema: rgb, style: "deepObject" },
        ],
        responses: ok,
      },
    },
  },
  servers: [{ url: "http://127.0.0.1:{port}", variables: { port: { default: "80" } } }],
};

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

const { port } = new URL(origin);

const scope = Effect.runSync(Scope.make());

let built: GeneratedPackage | undefined;

beforeAll(async () => {
  const specPath = nodePath.join(work, "openapi.json");
  const configPath = nodePath.join(work, "author-config.json");
  nodeFs.writeFileSync(specPath, JSON.stringify(spec));
  nodeFs.writeFileSync(
    configPath,
    JSON.stringify({
      acceptedOrigins: [origin],
      allowInsecure: true,
      binName: "objp",
      envPrefix: "OBJP",
      package: { name: "object-parameter-cli", version: "0.1.0" },
    }),
  );
  built = await Effect.runPromise(
    generateFixture({ configPath, specPath }).pipe(
      Effect.tap(preparePackage),
      Scope.provide(scope),
      Effect.provide(layer),
    ),
  );
}, 900_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  nodeFs.rmSync(work, { force: true, recursive: true });
});

interface Sent {
  // The `x-` header parameters, by lower-case name, in arrival order.
  readonly headers: readonly (readonly [string, string])[];
  readonly target: string;
}

interface Exchange {
  readonly exitCode: number | null;
  readonly sent: readonly Sent[];
}

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

const invoke = (args: readonly string[]) => {
  if (built === undefined) {
    throw new Error("the package was not built");
  }

  return Effect.runPromise(
    runBin(built, {
      args: ["--server", "0", "--server-variable", `port=${port}`, ...args],
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );
};

// One invocation of the built CLI, with what the capture server recorded during it.
const run = async (args: readonly string[]): Promise<Exchange> => {
  const before = capture.requests().length;
  const result = await invoke(args);
  if (result.exitCode !== 0 && result.exitCode !== 2) {
    throw new Error(`unexpected exit ${String(result.exitCode)}: ${latin1(result.stderr)}`);
  }

  return {
    exitCode: result.exitCode,
    sent: capture
      .requests()
      .slice(before)
      .map((request) => ({
        headers: request.headers.flatMap(([name, value]) =>
          name.toLowerCase().startsWith("x-") ? [[name.toLowerCase(), value] as const] : [],
        ),
        target: request.target,
      })),
  };
};

const sentTo = (target: string): Exchange => ({ exitCode: 0, sent: [{ headers: [], target }] });

const refusedBeforeSending: Exchange = { exitCode: 2, sent: [] };

// Member order is the operator's, which is the wire order.
const object = '{"R":100,"G":200,"B":150}';

describe("an object-schema path positional takes JSON through the built CLI", () => {
  test("STY-05/06: simple is R,100,G,200,B,150, exploded R=100,G=200,B=150", async () => {
    expect([await run(["simple", object]), await run(["simple-x", object])]).toEqual([
      sentTo("/simple/R,100,G,200,B,150"),
      sentTo("/simple-x/R=100,G=200,B=150"),
    ]);
  }, 60_000);

  test("STY-03/04: label is .R,100,G,200,B,150, exploded .R=100.G=200.B=150", async () => {
    expect([await run(["label", object]), await run(["label-x", object])]).toEqual([
      sentTo("/label/.R,100,G,200,B,150"),
      sentTo("/label-x/.R=100.G=200.B=150"),
    ]);
  }, 60_000);

  test("STY-01/02: matrix is ;o=R,100,G,200,B,150, exploded ;R=100;G=200;B=150", async () => {
    expect([await run(["matrix", object]), await run(["matrix-x", object])]).toEqual([
      sentTo("/matrix/;o=R,100,G,200,B,150"),
      sentTo("/matrix-x/;R=100;G=200;B=150"),
    ]);
  }, 60_000);

  test("a positional that is not JSON is a usage error before any request", async () => {
    expect(await run(["simple", "R,100"])).toEqual(refusedBeforeSending);
  }, 60_000);
});

describe("an object-schema query flag takes JSON through the built CLI", () => {
  test("STY-13/14: form is R=100&G=200&B=150, non-exploded qn=R,100,G,200,B,150", async () => {
    expect([await run(["query", "--qf", object]), await run(["query", "--qn", object])]).toEqual([
      sentTo("/query?R=100&G=200&B=150"),
      sentTo("/query?qn=R,100,G,200,B,150"),
    ]);
  }, 60_000);

  test("STY-25: deepObject is deep%5BR%5D=100&deep%5BG%5D=200&deep%5BB%5D=150", async () => {
    expect(await run(["query", "--deep", object])).toEqual(
      sentTo("/query?deep%5BR%5D=100&deep%5BG%5D=200&deep%5BB%5D=150"),
    );
  }, 60_000);

  test("a number past 2^53 keeps its digits", async () => {
    expect(await run(["query", "--qf", '{"R":9007199254740993}'])).toEqual(
      sentTo("/query?R=9007199254740993"),
    );
  }, 60_000);

  test("a member that is an object or array is a usage error before any request", async () => {
    expect([
      await run(["query", "--qf", '{"R":{"x":1}}']),
      await run(["query", "--deep", '{"R":[1]}']),
    ]).toEqual([refusedBeforeSending, refusedBeforeSending]);
  }, 60_000);

  test("a flag text that is not JSON is a usage error before any request", async () => {
    expect(await run(["query", "--qf", "R=100"])).toEqual(refusedBeforeSending);
  }, 60_000);
});

describe("an object-schema header flag takes JSON through the built CLI", () => {
  test("STY-31/32: simple is R,100,G,200,B,150, exploded R=100,G=200,B=150", async () => {
    expect(await run(["headers", "--x-o", object, "--x-ox", object])).toEqual({
      exitCode: 0,
      sent: [
        {
          headers: [
            ["x-o", "R,100,G,200,B,150"],
            ["x-ox", "R=100,G=200,B=150"],
          ],
          target: "/headers",
        },
      ],
    });
  }, 60_000);
});

describe("help", () => {
  test("an object-schema flag and positional show that they take JSON", async () => {
    const queryHelp = await invoke(["query", "--help"]);
    const pathHelp = await invoke(["simple", "--help"]);
    const query = latin1(queryHelp.stdout);
    const path = latin1(pathHelp.stdout);

    expect(query).toContain("--qf json");
    expect(path).toContain("  o json");
  }, 60_000);
});
