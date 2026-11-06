import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Scope, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate, GenerateRefused } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Json } from "../../src/model/pointer.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The Milestone 2 witness for the Server and Server Variable rows (SRV-*): one generated package
// per version line, built once, run against the capture server; the refusal and notice rows call
// `generate()` in process. A row the product gets wrong is a `test.todo` with what was observed.

const fixtures = nodePath.resolve(import.meta.dir, "../../corpus/fixtures/rows/srv");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = nodeFs.mkdtempSync(nodePath.join(tmpdir(), "wt-srv-"));

interface Members {
  readonly [key: string]: Json;
}

const readJson = (file: string): Members =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
    nodeFs.readFileSync(file, "utf-8"),
  );

const authorConfig = readJson(nodePath.join(fixtures, "author-config.json"));

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

const { port } = new URL(origin);

// The unbound origin: the same host at the other listener's port.
const { port: otherPort } = new URL(capture.origins.localhost);

const scope = Effect.runSync(Scope.make());

const packages = new Map<Line, GeneratedPackage>();

beforeAll(async () => {
  // The ports are known only once the capture server listens, so the bound origin is added here.
  const configPath = nodePath.join(work, "author-config.json");
  nodeFs.writeFileSync(
    configPath,
    `${JSON.stringify({ ...authorConfig, acceptedOrigins: [origin] })}\n`,
  );

  // One package per line, built one after the other.
  const built = await Effect.runPromise(
    Effect.forEach(
      lines,
      (line) =>
        generateFixture({ configPath, specPath: nodePath.join(fixtures, `${line}.json`) }).pipe(
          Effect.tap(preparePackage),
          Effect.map((generated) => [line, generated] as const),
        ),
      { concurrency: 1 },
    ).pipe(Scope.provide(scope), Effect.provide(layer)),
  );
  for (const [line, generated] of built) {
    packages.set(line, generated);
  }
}, 900_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  nodeFs.rmSync(work, { force: true, recursive: true });
});

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

interface Exchange {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly targets: readonly string[];
}

// One invocation of the line's built CLI, with the targets the capture server recorded during it.
// `runBin` is asynchronous, so the in-process capture server keeps answering.
const run = async (
  line: Line,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<Exchange> => {
  const generated = packages.get(line);
  if (generated === undefined) {
    throw new Error(`no package built for ${line}`);
  }

  const before = capture.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, { args, env, timeoutMs: 30_000 }).pipe(Effect.provide(layer)),
  );

  return {
    exitCode: result.exitCode,
    stderr: latin1(result.stderr),
    targets: capture
      .requests()
      .slice(before)
      .map((request) => request.target),
  };
};

const specOf = (line: Line) => readJson(nodePath.join(fixtures, `${line}.json`));

const serverIndex = (line: Line, url: string): string => {
  const servers = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ url: Schema.String })))(
    specOf(line).servers,
  );

  return String(servers.findIndex((server) => server.url === url));
};

const portVariable = ["--server-variable", `port=${port}`] as const;

const first = (line: Line, ...rest: readonly string[]) =>
  run(line, ["--server", "0", ...portVariable, ...rest]);

// In process generation of a small document of a line; the diagnostics of a refused run are the
// refusal's.
const members = (line: Line, extra: Members): Members => ({
  info: { title: "Server rows", version: "1.0.0" },
  openapi: line,
  ...extra,
});

const operation = (extra: Members = {}): Members => ({
  responses: { "200": { description: "ok" } },
  ...extra,
});

interface Generated {
  readonly diagnostics: readonly Diagnostic[];
  readonly dir: string;
}

let counter = 0;

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const inProcess = async (document: Members, config: Members = authorConfig): Promise<Generated> => {
  counter += 1;
  const dir = nodePath.join(work, `case-${counter}`);
  nodeFs.mkdirSync(dir, { recursive: true });

  const specPath = nodePath.join(dir, "openapi.json");
  const configPath = nodePath.join(dir, "author-config.json");

  nodeFs.writeFileSync(specPath, JSON.stringify(document));
  nodeFs.writeFileSync(configPath, JSON.stringify(config));

  const outDir = nodePath.join(dir, "out");
  const decodeDocument = Schema.decodeUnknownSync(DocumentUri);
  const exit = await Effect.runPromiseExit(
    generate(
      {
        document: decodeDocument("file:///fixture/openapi.json"),
        generator,
        outDir,
        source: { _tag: "File", path: specPath },
        strict: false,
      },
      { document: decodeDocument("file:///fixture/author-config.json"), path: configPath },
    ).pipe(Effect.provide(layer)),
  );
  if (Exit.isSuccess(exit)) {
    return { diagnostics: exit.value.diagnostics, dir: outDir };
  }

  const [failure] = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" && reason.error instanceof GenerateRefused ? [reason.error] : [],
  );
  if (failure === undefined) {
    throw new Error(`generate failed for a reason other than a refusal: ${String(exit.cause)}`);
  }

  return { diagnostics: failure.diagnostics, dir: outDir };
};

const summary = (found: Generated) =>
  found.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.scope]);

const pointers = (found: Generated): readonly string[] =>
  found.diagnostics.map((diagnostic) => diagnostic.pointer);

const serversTable = (found: Generated): string =>
  nodeFs.readFileSync(nodePath.join(found.dir, "src", "api", "servers.ts"), "utf-8");

describe("SRV rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`SRV-01: the base URL is built from the selected Server Object (${line})`, async () => {
        const observed = await first(line, "pets-list");

        expect(observed.exitCode).toBe(0);
        expect(observed.targets).toEqual(["/v1/pets"]);
      }, 60_000);

      test(`SRV-02: the expanded url is the request base and its origin must be bound (${line})`, async () => {
        const unbound = await run(line, [
          "--server",
          "0",
          "--server-variable",
          `port=${otherPort}`,
          "pets-list",
        ]);

        expect({ exitCode: unbound.exitCode, targets: unbound.targets }).toEqual({
          exitCode: 2,
          targets: [],
        });
        expect(unbound.stderr).toContain("--server-variable");
      }, 60_000);

      test(`SRV-05: server variables are substituted (${line})`, async () => {
        const observed = await first(line, "--server-variable", "tier=v2", "pets-list");

        expect(observed.targets).toEqual(["/v2/pets"]);
      }, 60_000);

      test(`SRV-07: a value outside the enum is rejected before any request (${line})`, async () => {
        const observed = await first(line, "--server-variable", "tier=v3", "pets-list");

        expect({ exitCode: observed.exitCode, targets: observed.targets }).toEqual({
          exitCode: 2,
          targets: [],
        });
      }, 60_000);

      test(`SRV-08: an omitted variable expands to its default (${line})`, async () => {
        const observed = await first(line, "pets-list");

        expect(observed.targets).toEqual(["/v1/pets"]);
      }, 60_000);

      test(`SRV-11: {tier} is replaced by the operator value, or by the default (${line})`, async () => {
        const given = await first(line, "--server-variable", "tier=v2", "pets-list");
        const omitted = await first(line, "pets-list");

        expect([given.targets, omitted.targets]).toEqual([["/v2/pets"], ["/v1/pets"]]);
      }, 60_000);

      // The runtime reads only the root servers table; the operation and path item servers reach
      // the package as `--describe` metadata alone.
      test.todo(`SRV-15: mixed-get and mixed-put with --server 0 request /v1/mixed (the root server) vs /oplevel/mixed and /pathlevel/mixed (${line})`, () =>
        Promise.resolve());

      test(`SRV-20: the path is appended to the base, never resolved against it (${line})`, async () => {
        const observed = await run(line, ["--base-url", `${origin}/base`, "pets-list"]);

        expect(observed.targets).toEqual(["/base/pets"]);
      }, 60_000);

      test(`SRV-01: precedence is --base-url, then the environment, then --server (${line})`, async () => {
        const flag = await run(
          line,
          ["--base-url", `${origin}/flag`, "--server", "0", ...portVariable, "pets-list"],
          { SRV_BASE_URL: `${origin}/env` },
        );
        const env = await run(line, ["--server", "0", ...portVariable, "pets-list"], {
          SRV_BASE_URL: `${origin}/env`,
        });

        expect([flag.targets, env.targets]).toEqual([["/flag/pets"], ["/env/pets"]]);
      }, 60_000);

      test(`SRV-10: without an accepted server the CLI exits 2 naming --base-url (${line})`, async () => {
        const observed = await run(line, ["pets-list"]);

        expect({ exitCode: observed.exitCode, targets: observed.targets }).toEqual({
          exitCode: 2,
          targets: [],
        });
        expect(observed.stderr).toContain("--base-url");
      }, 60_000);

      test(`SRV-17: a relative server URL is no base without a retrieval URI (${line})`, async () => {
        const observed = await run(line, ["--server", serverIndex(line, "/relative"), "pets-list"]);

        expect({ exitCode: observed.exitCode, targets: observed.targets }).toEqual({
          exitCode: 2,
          targets: [],
        });
      }, 60_000);
    });
  }

  test("SRV-04: --server selects a 3.2 server by its name", async () => {
    const observed = await run("3.2.1", ["--server", "named", ...portVariable, "pets-list"]);

    expect(observed.targets).toEqual(["/named/pets"]);
  }, 60_000);

  test("SRV-13: a 3.0.4 default outside its enum is still usable", async () => {
    const observed = await run("3.0.4", [
      "--server",
      serverIndex("3.0.4", "http://127.0.0.1:{port}/{legacy}"),
      ...portVariable,
      "pets-list",
    ]);

    expect(observed.targets).toEqual(["/x/pets"]);
  }, 60_000);
});

const url = "https://{v}.example.com";

const withServer = (
  line: Line,
  servers: Json | undefined,
  where: "operation" | "path" | "root" = "operation",
): Members => {
  const get = operation(where === "operation" && servers !== undefined ? { servers } : {});
  const item: Members = where === "path" && servers !== undefined ? { get, servers } : { get };

  return members(
    line,
    where === "root" && servers !== undefined
      ? { paths: { "/a": item }, servers }
      : { paths: { "/a": item } },
  );
};

describe("SRV rows through generate()", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`SRV-11: a {name} with no Server Variable is refused (${line})`, async () => {
        const found = await inProcess(
          withServer(line, [{ url: "https://{missing}.example.com" }], "path"),
        );

        expect(summary(found)).toEqual([["SRV-11/undeclared-variable", "refusal", "operation"]]);
        expect(pointers(found)).toEqual(["/paths/~1a/servers/0"]);
      }, 60_000);

      test(`SRV-16: an empty servers array at the Path Item or the Operation is refused (${line})`, async () => {
        const pathItem = await inProcess(withServer(line, [], "path"));
        const operationLevel = await inProcess(withServer(line, []));

        expect([summary(pathItem), summary(operationLevel)]).toEqual([
          [["SRV-16/empty-override", "refusal", "operation"]],
          [["SRV-16/empty-override", "refusal", "operation"]],
        ]);
        expect([pointers(pathItem), pointers(operationLevel)]).toEqual([
          ["/paths/~1a/servers"],
          ["/paths/~1a/get/servers"],
        ]);
      }, 60_000);

      test(`SRV-18: a query or a fragment in a server URL is refused (${line})`, async () => {
        const query = await inProcess(withServer(line, [{ url: "https://example.com/v1?x=1" }]));
        const fragment = await inProcess(withServer(line, [{ url: "https://example.com/v1#top" }]));

        expect([summary(query), summary(fragment)]).toEqual([
          [["SRV-18/query-or-fragment", "refusal", "operation"]],
          [["SRV-18/query-or-fragment", "refusal", "operation"]],
        ]);
        expect([pointers(query), pointers(fragment)]).toEqual([
          ["/paths/~1a/get/servers/0/url"],
          ["/paths/~1a/get/servers/0/url"],
        ]);
      }, 60_000);

      test(`SRV-10: an absent or empty root servers is the single server / and no default is baked (${line})`, async () => {
        const absent = await inProcess(withServer(line, undefined, "path"));
        const empty = await inProcess({ ...withServer(line, undefined, "path"), servers: [] });

        for (const found of [absent, empty]) {
          expect(found.diagnostics).toEqual([]);
          expect(serversTable(found)).toContain('url: "/"');
          expect(serversTable(found)).not.toContain("defaultServer");
        }
      }, 60_000);

      test(`SRV-17: a relative server URL resolves against the author's retrievalUri (${line})`, async () => {
        const document = withServer(line, [{ url: "/v1" }], "root");
        const refused = await inProcess(document, {
          ...authorConfig,
          servers: { accepted: ["/v1"] },
        });
        const resolved = await inProcess(document, {
          ...authorConfig,
          retrievalUri: "https://api.example.test/docs/openapi.json",
          servers: { accepted: ["/v1"] },
        });

        expect(summary(refused)).toEqual([
          ["SRV-17/relative-needs-retrieval-uri", "refusal", "document"],
        ]);
        expect(resolved.diagnostics).toEqual([]);
        expect(serversTable(resolved)).toContain("https://api.example.test");
      }, 60_000);
    });
  }

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`SRV-12: a default outside its enum is refused (${line})`, async () => {
      const found = await inProcess(
        withServer(line, [{ url, variables: { v: { default: "x", enum: ["a"] } } }]),
      );

      expect(summary(found)).toEqual([["SRV-12/default-not-in-enum", "refusal", "operation"]]);
      expect(pointers(found)).toEqual(["/paths/~1a/get/servers/0/variables/v"]);
    }, 60_000);

    test(`SRV-14: an empty enum is refused (${line})`, async () => {
      const found = await inProcess(
        withServer(line, [{ url, variables: { v: { default: "x", enum: [] } } }]),
      );

      // The official schema refuses an empty `enum` before the SRV rule runs, so the refusal
      // carries the schema row of the line (VAL-03 for 3.1, VAL-04 for 3.2), not SRV-14.
      expect(
        found.diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.scope]),
      ).toEqual([["refusal", "document"]]);
      expect(pointers(found)).toEqual(["/paths/~1a/get/servers/0/variables/v/enum"]);
    }, 60_000);
  }

  test("SRV-13: a 3.0.4 default outside its enum is a notice and the document still generates", async () => {
    const found = await inProcess(
      withServer("3.0.4", [{ url, variables: { v: { default: "x", enum: ["a"] } } }]),
    );

    expect(summary(found)).toEqual([["SRV-12/default-not-in-enum", "notice", "operation"]]);
  }, 60_000);

  // Nothing checks server name uniqueness: the run reports no diagnostic at all.
  test.todo("SRV-04: two 3.2.1 servers named the same raise no diagnostic vs a refusal of the duplicate name (D-OC3)", () =>
    Promise.resolve());

  test("SRV-19: a repeated variable or an illegal literal character is refused", async () => {
    const repeated = await inProcess(
      withServer("3.2.1", [
        { url: "https://{v}.example.com/{v}", variables: { v: { default: "x" } } },
      ]),
    );
    const illegal = await inProcess(withServer("3.2.1", [{ url: "https://exa mple.com/^" }]));

    expect([summary(repeated), summary(illegal)]).toEqual([
      [["SRV-19/repeated-variable", "refusal", "operation"]],
      [["SRV-19/invalid-template", "refusal", "operation"]],
    ]);
  }, 60_000);
});
