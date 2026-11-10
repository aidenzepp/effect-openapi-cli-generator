import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunCrypto, BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Scope, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate, GenerateRefused } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Json } from "../../src/model/pointer.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { HeaderList } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The Milestone 2 witness for the Security Scheme and OAuth Flow rows (SSC-*, OAF-*): one generated
// package per version line, built once, run against the capture server with a canary credential
// that must never reach stdout or stderr; the refusal rows call `generate()` in process. A row the
// product gets wrong is a `test.todo` with what was observed.

const fixtures = nodePath.resolve(import.meta.dir, "../../corpus/fixtures/rows/ssc");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layerDigest);

const work = nodeFs.mkdtempSync(nodePath.join(tmpdir(), "wt-ssc-"));

interface Members {
  readonly [key: string]: Json;
}

const readJson = (file: string): Members =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
    nodeFs.readFileSync(file, "utf-8"),
  );

const authorConfig = readJson(nodePath.join(fixtures, "author-config.json"));

// The 500 path echoes nothing back (no `canary` option), so a canary in the output can only come
// from the CLI itself.
const capture = startCaptureServer();

capture.script("/query-fail", { body: "{}", status: 500 });

const origin = capture.origins["127.0.0.1"];

const { port } = new URL(origin);

const scope = Effect.runSync(Scope.make());

const packages = new Map<Line, GeneratedPackage>();

beforeAll(async () => {
  // The port is known only once the capture server listens, so the bound origin is added here.
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

const canary = "canary-ssc-7f3a9c";

const basicValue = `witness:${canary}`;

const basicWire = Buffer.from(basicValue).toString("base64");

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

interface Sent {
  readonly headers: HeaderList;
  readonly target: string;
}

interface Exchange {
  readonly exitCode: number | null;
  readonly output: string;
  readonly sent: readonly Sent[];
  readonly stderr: string;
  readonly stdout: string;
}

// One invocation of the line's built CLI against the bound server, with what the capture server
// recorded during it. `runBin` is asynchronous, so the in-process capture server keeps answering.
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
    runBin(generated, {
      args: ["--server", "0", "--server-variable", `port=${port}`, ...args],
      env,
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );
  const stdout = latin1(result.stdout);
  const stderr = latin1(result.stderr);

  return {
    exitCode: result.exitCode,
    output: `${stdout}${stderr}`,
    sent: capture
      .requests()
      .slice(before)
      .map((request) => ({ headers: request.headers, target: request.target })),
    stderr,
    stdout,
  };
};

// The values one header carried in each recorded request.
const header = (exchange: Exchange, name: string): readonly (readonly string[])[] =>
  exchange.sent.map((sent) =>
    sent.headers.flatMap(([key, value]) => (key.toLowerCase() === name ? [value] : [])),
  );

// The AUTH entry of a command's help, from the built CLI: the text after the `AUTH` label, with any
// indented continuation lines rejoined so a wrapped entry reads as one line.
const authHelp = async (line: Line, command: string): Promise<string> => {
  const observed = await run(line, [command, "--help"]);
  const help = observed.stdout.split("\n");
  const label = help.findIndex((text) => text.startsWith("AUTH "));
  if (label === -1) {
    return "";
  }

  const rest = help.slice(label + 1);
  const next = rest.findIndex((text) => !text.startsWith(" "));
  const continued = next === -1 ? rest : rest.slice(0, next);

  return [help[label]?.slice("AUTH".length), ...continued].map((text) => text?.trim()).join(" ");
};

const expectNoCanary = (exchange: Exchange) => {
  expect(exchange.output).not.toContain(canary);
  expect(exchange.output).not.toContain(basicWire);
};

describe("SSC rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`SSC-12: an apiKey header credential from the environment is sent as the named header (${line})`, async () => {
        const observed = await run(line, ["header-get"], { SSC_HEADER_KEY: canary });

        expect(observed.exitCode).toBe(0);
        expect(header(observed, "x-api-key")).toEqual([[canary]]);
        expectNoCanary(observed);
      }, 60_000);

      test(`SSC-13: an apiKey query credential is sent under its name (${line})`, async () => {
        const observed = await run(line, ["query-get"], { SSC_QUERY_KEY: canary });

        expect(observed.exitCode).toBe(0);
        expect(observed.sent.map((sent) => sent.target)).toEqual([`/query?api_key=${canary}`]);
        expectNoCanary(observed);
      }, 60_000);

      test(`SSC-13: a failed request with a query credential never prints it (${line})`, async () => {
        const observed = await run(line, ["query-fail"], { SSC_QUERY_KEY: canary });

        // The 500 is retried twice by default; the output, retry notes included, never shows the key.
        expect(observed.exitCode).toBe(1);
        expect(observed.sent.map((sent) => sent.target)).toEqual(
          Array.from({ length: 3 }, () => `/query-fail?api_key=${canary}`),
        );
        expectNoCanary(observed);
      }, 60_000);

      test(`SSC-14: an apiKey cookie credential is sent in the Cookie header (${line})`, async () => {
        const observed = await run(line, ["cookie-get"], { SSC_COOKIE_KEY: canary });

        expect(observed.exitCode).toBe(0);
        expect(header(observed, "cookie")).toEqual([[`sid=${canary}`]]);
        expectNoCanary(observed);
      }, 60_000);

      test(`SSC-04: each apiKey credential is sent under the scheme's name (${line})`, async () => {
        const headerKey = await run(line, ["header-get"], { SSC_HEADER_KEY: canary });
        const queryKey = await run(line, ["query-get"], { SSC_QUERY_KEY: canary });
        const cookieKey = await run(line, ["cookie-get"], { SSC_COOKIE_KEY: canary });

        expect([
          header(headerKey, "x-api-key"),
          queryKey.sent.map((sent) => new URL(sent.target, origin).searchParams.get("api_key")),
          header(cookieKey, "cookie"),
        ]).toEqual([[[canary]], [canary], [[`sid=${canary}`]]]);
      }, 60_000);

      test(`SSC-05: in header, query and cookie each place the credential where it says (${line})`, async () => {
        const headerKey = await run(line, ["header-get"], { SSC_HEADER_KEY: canary });
        const queryKey = await run(line, ["query-get"], { SSC_QUERY_KEY: canary });
        const cookieKey = await run(line, ["cookie-get"], { SSC_COOKIE_KEY: canary });

        // Each location carries the credential and the other two do not.
        expect([
          header(headerKey, "x-api-key").flat(),
          header(headerKey, "cookie").flat(),
          headerKey.sent.map((sent) => sent.target),
        ]).toEqual([[canary], [], ["/header"]]);
        expect([header(queryKey, "x-api-key").flat(), header(queryKey, "cookie").flat()]).toEqual([
          [],
          [],
        ]);
        expect([
          header(cookieKey, "x-api-key").flat(),
          cookieKey.sent.map((sent) => sent.target),
        ]).toEqual([[], ["/cookie"]]);
      }, 60_000);

      test(`SSC-15: http basic sends Authorization: Basic base64(user:pass) (${line})`, async () => {
        const observed = await run(line, ["basic-get"], { SSC_BASIC_AUTH: basicValue });

        expect(observed.exitCode).toBe(0);
        expect(header(observed, "authorization")).toEqual([[`Basic ${basicWire}`]]);
        expectNoCanary(observed);
      }, 60_000);

      test(`SSC-16: http bearer sends Authorization: Bearer <token> (${line})`, async () => {
        const observed = await run(line, ["bearer-get"], { SSC_BEARER_AUTH: canary });

        expect(observed.exitCode).toBe(0);
        expect(header(observed, "authorization")).toEqual([[`Bearer ${canary}`]]);
        expectNoCanary(observed);
      }, 60_000);

      test(`SSC-06: the http scheme matches case-insensitively: Basic, bearer and BEARER (${line})`, async () => {
        const basic = await run(line, ["basic-get"], { SSC_BASIC_AUTH: basicValue });
        const bearer = await run(line, ["bearer-get"], { SSC_BEARER_AUTH: canary });
        const shout = await run(line, ["shout-get"], { SSC_SHOUT_AUTH: canary });

        expect([basic, bearer, shout].map((observed) => header(observed, "authorization"))).toEqual(
          [[[`Basic ${basicWire}`]], [[`Bearer ${canary}`]], [[`Bearer ${canary}`]]],
        );
      }, 60_000);

      test(`SSC-01: every supported scheme type sends its credential (${line})`, async () => {
        // One after the other, so each run's slice of the capture log is its own.
        const sent = [
          await run(line, ["header-get"], { SSC_HEADER_KEY: canary }),
          await run(line, ["query-get"], { SSC_QUERY_KEY: canary }),
          await run(line, ["cookie-get"], { SSC_COOKIE_KEY: canary }),
          await run(line, ["basic-get"], { SSC_BASIC_AUTH: basicValue }),
          await run(line, ["bearer-get"], { SSC_BEARER_AUTH: canary }),
        ];

        expect(sent.map((observed) => [observed.exitCode, observed.sent.length])).toEqual([
          [0, 1],
          [0, 1],
          [0, 1],
          [0, 1],
          [0, 1],
        ]);
        for (const observed of sent) {
          expectNoCanary(observed);
        }
      }, 60_000);

      test(`SSC-01: a missing credential is refused before any request (${line})`, async () => {
        const observed = await run(line, ["header-get"]);

        // Exit 3 lists the alternatives and their credential sources (design 6.5 Run-time choice).
        expect({ exitCode: observed.exitCode, sent: observed.sent }).toEqual({
          exitCode: 3,
          sent: [],
        });
      }, 60_000);

      test(`SSC-01: an author-supplied scheme is sent and marked in help (${line})`, async () => {
        const observed = await run(line, ["author-get"], { SSC_AUTHOR_KEY: canary });
        const auth = await authHelp(line, "author-get");

        expect(observed.exitCode).toBe(0);
        expect(header(observed, "x-author-key")).toEqual([[canary]]);
        expectNoCanary(observed);
        expect(auth).toContain("authorKey (apiKey header X-Author-Key) [author-supplied]");
        expect(await authHelp(line, "header-get")).not.toContain("author-supplied");
      }, 60_000);
    });
  }

  test("SSC-11: a deprecated 3.2 scheme shows [deprecated] in AUTH help", async () => {
    const legacy = await authHelp("3.2.1", "legacy-get");
    const current = await authHelp("3.2.1", "header-get");

    expect(legacy).toContain("legacyKey (apiKey header X-Legacy-Key) [deprecated]");
    expect(current).toContain("headerKey (apiKey header X-Api-Key)");
    expect(current).not.toContain("deprecated");
  }, 60_000);

  test("SSC-11: using a deprecated scheme writes one stderr notice naming only the scheme", async () => {
    const observed = await run("3.2.1", ["legacy-get"], { SSC_LEGACY_KEY: canary });
    const current = await run("3.2.1", ["header-get"], { SSC_HEADER_KEY: canary });

    expect(observed.exitCode).toBe(0);
    expect(header(observed, "x-legacy-key")).toEqual([[canary]]);
    expect(observed.stderr.split("\n").filter((text) => text !== "")).toHaveLength(1);
    expect(observed.stderr.match(/legacyKey/gu)?.length).toBe(1);
    expect(observed.stdout).not.toContain("legacyKey");
    expectNoCanary(observed);
    expect(current.stderr).toBe("");
  }, 60_000);
});

// In process generation of a small document of a line; the diagnostics of a refused run are the
// refusal's.
const members = (line: Line, securitySchemes: Json): Members => ({
  components: { securitySchemes },
  info: { title: "Security scheme rows", version: "1.0.0" },
  openapi: line,
  paths: { "/a": { get: { responses: { "200": { description: "ok" } } } } },
});

interface Generated {
  readonly diagnostics: readonly Diagnostic[];
}

let counter = 0;

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const inProcess = async (document: Members): Promise<Generated> => {
  counter += 1;
  const dir = nodePath.join(work, `case-${counter}`);
  nodeFs.mkdirSync(dir, { recursive: true });

  const specPath = nodePath.join(dir, "openapi.json");
  const configPath = nodePath.join(dir, "author-config.json");

  nodeFs.writeFileSync(specPath, JSON.stringify(document));
  nodeFs.writeFileSync(configPath, JSON.stringify({ ...authorConfig, security: undefined }));

  const decodeDocument = Schema.decodeUnknownSync(DocumentUri);
  const exit = await Effect.runPromiseExit(
    generate(
      {
        document: decodeDocument("file:///fixture/openapi.json"),
        generator,
        outDir: nodePath.join(dir, "out"),
        source: { _tag: "File", path: specPath },
        strict: false,
      },
      { document: decodeDocument("file:///fixture/author-config.json"), path: configPath },
    ).pipe(Effect.provide(layer)),
  );
  nodeFs.rmSync(dir, { force: true, recursive: true });
  if (Exit.isSuccess(exit)) {
    return { diagnostics: exit.value.diagnostics };
  }

  const [failure] = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" && reason.error instanceof GenerateRefused ? [reason.error] : [],
  );
  if (failure === undefined) {
    throw new Error(`generate failed for a reason other than a refusal: ${String(exit.cause)}`);
  }

  return { diagnostics: failure.diagnostics };
};

const summary = (found: Generated) =>
  found.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.severity,
    diagnostic.scope,
    diagnostic.pointer,
  ]);

const validationRow: Record<Line, string> = {
  "3.0.4": "VAL-02",
  "3.1.2": "VAL-03",
  "3.2.1": "VAL-04",
};

// The fields each OAuth Flow Object requires, by flow.
const flowFields = {
  authorizationCode: {
    authorizationUrl: "https://auth.example/a",
    scopes: {},
    tokenUrl: "https://auth.example/t",
  },
  clientCredentials: { scopes: {}, tokenUrl: "https://auth.example/t" },
  deviceAuthorization: {
    deviceAuthorizationUrl: "https://auth.example/d",
    scopes: {},
    tokenUrl: "https://auth.example/t",
  },
  implicit: { authorizationUrl: "https://auth.example/a", scopes: {} },
  password: { scopes: {}, tokenUrl: "https://auth.example/t" },
} satisfies Readonly<Record<string, Json>>;

const oauth = (line: Line, flow: string, fields: Json) =>
  members(line, { o: { flows: { [flow]: fields }, type: "oauth2" } });

const flowPointer = (flow: string) => `/components/securitySchemes/o/flows/${flow}`;

// The one element-scope refusal of a document with one flow.
const flowRefusal = (row: string, flow: string) => [
  [`${row}/token-acquisition`, "refusal", "element", flowPointer(flow)],
];

// The diagnostics of a document with one flow and only its required fields.
const flowSummary = async (line: Line, flow: keyof typeof flowFields) =>
  summary(await inProcess(oauth(line, flow, flowFields[flow])));

describe("SSC and OAF rows through generate()", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`SSC-02: an unknown type is refused by validation at the type (${line})`, async () => {
        const found = await inProcess(members(line, { x: { type: "token" } }));

        expect(summary(found)).toEqual([
          [
            `${validationRow[line]}/schema-invalid`,
            "refusal",
            "document",
            "/components/securitySchemes/x/type",
          ],
        ]);
      }, 60_000);

      test(`SSC-17: http digest and an unregistered scheme are refused at element scope (${line})`, async () => {
        const found = await inProcess(
          members(line, {
            d: { scheme: "Digest", type: "http" },
            u: { scheme: "x-custom", type: "http" },
          }),
        );

        expect(summary(found)).toEqual([
          ["SSC-17/unsupported-scheme", "refusal", "element", "/components/securitySchemes/d"],
          ["SSC-17/unsupported-scheme", "refusal", "element", "/components/securitySchemes/u"],
        ]);
      }, 60_000);

      // Each title is literal so the inventory trace reads its row.
      test(`OAF-02: the implicit flow is refused at element scope at its pointer (${line})`, async () => {
        expect(await flowSummary(line, "implicit")).toEqual(flowRefusal("OAF-02", "implicit"));
      }, 60_000);

      test(`OAF-03: the password flow is refused at element scope at its pointer (${line})`, async () => {
        expect(await flowSummary(line, "password")).toEqual(flowRefusal("OAF-03", "password"));
      }, 60_000);

      test(`OAF-04: the clientCredentials flow is refused at element scope at its pointer (${line})`, async () => {
        expect(await flowSummary(line, "clientCredentials")).toEqual(
          flowRefusal("OAF-04", "clientCredentials"),
        );
      }, 60_000);

      test(`OAF-05: the authorizationCode flow is refused at element scope at its pointer (${line})`, async () => {
        expect(await flowSummary(line, "authorizationCode")).toEqual(
          flowRefusal("OAF-05", "authorizationCode"),
        );
      }, 60_000);

      test(`OAF-07: a Flow Object's fields are refused with their flow, at the flow (${line})`, async () => {
        const found = await inProcess(
          oauth(line, "clientCredentials", {
            refreshUrl: "https://auth.example/r",
            scopes: { read: "Read things" },
            tokenUrl: "https://auth.example/t",
          }),
        );

        expect(summary(found)).toEqual(flowRefusal("OAF-04", "clientCredentials"));
      }, 60_000);

      test(`OAF-08: authorizationUrl is refused with its flow and never fetched (${line})`, async () => {
        const implicit = await inProcess(
          oauth(line, "implicit", { authorizationUrl: "https://auth.example/a", scopes: {} }),
        );
        const code = await inProcess(
          oauth(line, "authorizationCode", {
            authorizationUrl: "https://auth.example/a",
            scopes: {},
            tokenUrl: "https://auth.example/t",
          }),
        );

        expect([summary(implicit), summary(code)]).toEqual([
          flowRefusal("OAF-02", "implicit"),
          flowRefusal("OAF-05", "authorizationCode"),
        ]);
      }, 60_000);

      test(`OAF-10: tokenUrl is refused with its flow and never fetched (${line})`, async () => {
        const found = await inProcess(
          oauth(line, "password", { scopes: {}, tokenUrl: "https://auth.example/t" }),
        );

        expect(summary(found)).toEqual(flowRefusal("OAF-03", "password"));
      }, 60_000);

      test(`OAF-11: refreshUrl is refused with its flow and never fetched (${line})`, async () => {
        const found = await inProcess(
          oauth(line, "implicit", {
            authorizationUrl: "https://auth.example/a",
            refreshUrl: "https://auth.example/r",
            scopes: {},
          }),
        );

        expect(summary(found)).toEqual(flowRefusal("OAF-02", "implicit"));
      }, 60_000);
    });
  }

  test("OAF-06: the 3.2 deviceAuthorization flow is refused at element scope at its pointer", async () => {
    expect(await flowSummary("3.2.1", "deviceAuthorization")).toEqual(
      flowRefusal("OAF-06", "deviceAuthorization"),
    );
  }, 60_000);

  test("OAF-09: deviceAuthorizationUrl is refused with its 3.2 flow and never fetched", async () => {
    const found = await inProcess(
      oauth("3.2.1", "deviceAuthorization", {
        deviceAuthorizationUrl: "https://auth.example/d",
        scopes: {},
        tokenUrl: "https://auth.example/t",
      }),
    );

    expect(summary(found)).toEqual(flowRefusal("OAF-06", "deviceAuthorization"));
  }, 60_000);
});
