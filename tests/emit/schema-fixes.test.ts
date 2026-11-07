import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Json } from "../../src/model/pointer.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The schema fixes of m2-schfx through one built CLI: a keyword beside `$ref` is asserted
// (SCH-03), `additionalProperties: false` rejects an undeclared key (SCH-13), and a body field's
// help lists its enum values, default, read-only and deprecated marks (SCH-29, 49, 50, 51). In
// process: a required body applying a dynamic or recursive keyword raises to operation scope
// (SCH-05, 06, 65, 66).

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// The generated package and its inputs live under the worktree's git-ignored `work/`, never the
// system temp directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "schema-fixes-"));

const priorTmpdir = process.env.TMPDIR;

process.env.TMPDIR = work;

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

const { port } = new URL(origin);

const scope = Effect.runSync(Scope.make());

const done: Json = { "204": { description: "done" } };

const create = (operationId: string, schema: Json): Json => ({
  post: {
    operationId,
    requestBody: { content: { "application/json": { schema } }, required: true },
    responses: done,
  },
});

const spec: Json = {
  components: { schemas: { Count: { type: "integer" } } },
  info: { title: "schema fixes", version: "1.0.0" },
  openapi: "3.1.2",
  paths: {
    "/annotated": create("annotated-create", {
      properties: {
        color: { enum: ["red", "blue"], type: "string" },
        id: { readOnly: true, type: "string" },
        legacy: { deprecated: true, type: "string" },
        size: { default: 10, type: "integer" },
      },
      type: "object",
    }),
    "/closed": create("closed-create", {
      additionalProperties: false,
      properties: {
        a: { type: "string" },
        inner: { additionalProperties: false, properties: { b: { type: "integer" } } },
      },
      type: "object",
    }),
    "/ref-siblings": create("ref-siblings-create", {
      $ref: "#/components/schemas/Count",
      maximum: 5,
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
      binName: "fixes",
      envPrefix: "FIXES",
      package: { name: "schema-fixes-cli", version: "0.1.0" },
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
  process.env.TMPDIR = priorTmpdir;
});

const decoder = new TextDecoder();

const bin = (args: readonly string[]) => {
  if (generated === undefined) {
    throw new Error("the package was not built");
  }

  return Effect.runPromise(
    runBin(generated, {
      args: ["--server", "0", "--server-variable", `port=${port}`, ...args],
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );
};

interface Sent {
  readonly exitCode: number | null;
  readonly sent: readonly string[];
}

// One `--body` invocation of the built CLI and the request bodies the capture server recorded.
const send = async (command: string, body: string): Promise<Sent> => {
  const before = capture.requests().length;
  const result = await bin([command, "--body", body]);

  return {
    exitCode: result.exitCode,
    sent: capture
      .requests()
      .slice(before)
      .map((request) => decoder.decode(request.body)),
  };
};

const sentAsGiven = (body: string): Sent => ({ exitCode: 0, sent: [body] });

const refusedBeforeSending: Sent = { exitCode: 2, sent: [] };

// The help line of one flag of a command.
const helpLine = async (command: string, flag: string): Promise<string | undefined> => {
  const result = await bin([command, "--help"]);

  return decoder
    .decode(result.stdout)
    .split("\n")
    .find((line) => line.trimStart().startsWith(`--${flag} `))
    ?.trim();
};

describe("schema fixes through the built CLI", () => {
  test("SCH-03 a keyword beside $ref is asserted with the target", async () => {
    expect([
      await send("ref-siblings-create", "5"),
      await send("ref-siblings-create", "7"),
      await send("ref-siblings-create", '"x"'),
    ]).toEqual([sentAsGiven("5"), refusedBeforeSending, refusedBeforeSending]);
  }, 60_000);

  test("SCH-13 additionalProperties false rejects an undeclared key, at any depth", async () => {
    expect([
      await send("closed-create", '{"a":"x","inner":{"b":1}}'),
      await send("closed-create", '{"a":"x","z":1}'),
      await send("closed-create", '{"inner":{"b":1,"c":2}}'),
      await send("closed-create", '{"a":1}'),
    ]).toEqual([
      sentAsGiven('{"a":"x","inner":{"b":1}}'),
      refusedBeforeSending,
      refusedBeforeSending,
      refusedBeforeSending,
    ]);
  }, 60_000);

  test("SCH-29 SCH-49 SCH-50 SCH-51 body field help lists values, default and marks", async () => {
    const lines = await Promise.all(
      ["color", "size", "legacy", "id"].map((flag) => helpLine("annotated-create", flag)),
    );

    expect(lines.map((line) => line?.replace(/^--\S+\s+\S+\s+/u, ""))).toEqual([
      "(body /color; choices: red, blue)",
      "(body /size; default: 10)",
      "(body /legacy; deprecated)",
      "(body /id; read-only)",
    ]);
  }, 60_000);
});

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const config = {
  config: Schema.decodeUnknownSync(AuthorConfig)({
    binName: "fixes",
    package: { name: "schema-fixes-cli", version: "0.1.0" },
  }),
  configDocument: Schema.decodeUnknownSync(DocumentUri)("file:///spec/author.json"),
};

// The diagnostics of one operation whose JSON body has `schema`, and whether it was assembled.
const normalized = (required: boolean, schema: Json) => {
  const value: Json = {
    components: {
      schemas: {
        Dynamic: { $dynamicAnchor: "node", type: "object" },
        Recursive: { $recursiveAnchor: true, type: "object" },
      },
    },
    info: { title: "t", version: "1" },
    openapi: "3.1.2",
    paths: {
      "/a": {
        post: {
          requestBody: { content: { "application/json": { schema } }, required },
          responses: done,
        },
      },
    },
  };
  const resolution = Effect.runSync(resolve({ document: entry, line: "3.1", value }));
  const result = Effect.runSync(normalize(resolution, { ...config, checkFindings: [] }));

  // The resolver reports `$dynamicRef`; normalization reports the rest and does not repeat it.
  return {
    assembled: result.api.operations.map((operation) => operation.body !== undefined),
    refusals: [...resolution.diagnostics, ...result.diagnostics]
      .filter((diagnostic) => diagnostic.severity === "refusal")
      .map((diagnostic) => `${diagnostic.code} ${diagnostic.scope}`),
  };
};

describe("a body applying a dynamic or recursive keyword", () => {
  const cases: readonly (readonly [row: string, schema: Json, element: string])[] = [
    ["SCH-05", { $dynamicRef: "#node" }, "SCH-05/dynamic-ref element"],
    ["SCH-06", { $ref: "#/components/schemas/Dynamic" }, "SCH-06/dynamic-anchor element"],
    ["SCH-65", { $ref: "#/components/schemas/Recursive" }, "SCH-65/recursive-anchor element"],
    ["SCH-66", { $recursiveRef: "#" }, "SCH-66/recursive-ref element"],
  ];

  for (const [row, schema, element] of cases) {
    test(`${row} a required body raises to operation scope; an optional one is dropped`, () => {
      const required = normalized(true, schema);
      const optional = normalized(false, schema);

      expect(required.assembled).toEqual([]);
      expect(required.refusals).toContain(element);
      expect(required.refusals).toContain("OPR-09/required-body-refused operation");
      expect(optional).toMatchObject({ assembled: [false] });
      expect(optional.refusals).toContain(element);
      expect(optional.refusals).not.toContain("OPR-09/required-body-refused operation");
    });
  }

  test("a body that does not apply one is kept, though the unused anchors are still refused", () => {
    expect(normalized(true, { type: "object" })).toEqual({
      assembled: [true],
      refusals: ["SCH-06/dynamic-anchor element", "SCH-65/recursive-anchor element"],
    });
  });
});
