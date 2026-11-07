import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, Exit, Layer, Order, Runtime, Scope, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate, GenerateRefused } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Json } from "../../src/model/pointer.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { HeaderList, RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The Milestone 2 witness for the Parameter Object rows (PRM-01 to PRM-35): one generated package
// per version line, built once, run against the capture server; the generation rows call
// `generate()` in process. A row the product gets wrong is a `test.todo` with what was observed.

const fixtures = nodePath.resolve(import.meta.dir, "../../corpus/fixtures/rows/prm");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = nodeFs.mkdtempSync(nodePath.join(tmpdir(), "wt-prm-"));

interface Members {
  readonly [key: string]: Json;
}

const readJson = (file: string): Members =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
    nodeFs.readFileSync(file, "utf-8"),
  );

const authorConfig = readJson(nodePath.join(fixtures, "author-config.json"));

// The small in-process documents have no identity-get, so they take the config without its naming
// override, which would otherwise raise CFG-1/unmatched-override.
const plainConfig: Members = Object.fromEntries(
  Object.entries(authorConfig).filter(([key]) => key !== "naming"),
);

const specOf = (line: Line): Members => readJson(nodePath.join(fixtures, `${line}.json`));

const capture = startCaptureServer();

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

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

// The headers the fixture's parameters can set, plus Accept; the rest are the runtime's own.
const watched: ReadonlySet<string> = new Set([
  "accept",
  "cookie",
  "id",
  "x-note",
  "x-raw",
  "x-trace",
]);

interface Sent {
  readonly headers: HeaderList;
  readonly target: string;
}

interface Exchange {
  readonly exitCode: number | null;
  readonly sent: readonly Sent[];
}

const byName = (headers: HeaderList): HeaderList =>
  Arr.sort(
    headers,
    Order.mapInput(Order.String, ([name]: readonly [string, string]) => name),
  );

// Header names compare case-insensitively (RFC 9110 5.1): lowercased, sorted by name.
const watchedOf = (headers: HeaderList): HeaderList =>
  byName(
    headers.flatMap(([name, value]) =>
      watched.has(name.toLowerCase()) ? [[name.toLowerCase(), value] as const] : [],
    ),
  );

interface Invocation {
  readonly exchange: Exchange;
  readonly stderr: string;
  readonly stdout: string;
}

// One invocation of the line's built CLI against the bound server, with what the capture server
// recorded during it and the CLI's output. `runBin` is asynchronous, so the in-process capture
// server keeps answering.
const invoke = async (line: Line, args: readonly string[]): Promise<Invocation> => {
  const generated = packages.get(line);
  if (generated === undefined) {
    throw new Error(`no package built for ${line}`);
  }

  const before = capture.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, {
      args: ["--server", "0", "--server-variable", `port=${port}`, ...args],
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );
  if (result.exitCode !== 0 && result.exitCode !== 2) {
    throw new Error(`unexpected exit ${String(result.exitCode)}: ${latin1(result.stderr)}`);
  }

  return {
    exchange: {
      exitCode: result.exitCode,
      sent: capture
        .requests()
        .slice(before)
        .map((request) => ({ headers: watchedOf(request.headers), target: request.target })),
    },
    stderr: latin1(result.stderr),
    stdout: latin1(result.stdout),
  };
};

// The requests one successful invocation sent, as the capture server recorded them: raw header
// names and the request target, before any normalization.
const sentRaw = async (
  line: Line,
  args: readonly string[],
): Promise<readonly RecordedRequest[]> => {
  const before = capture.requests().length;
  const { exchange } = await invoke(line, args);
  expect(exchange.exitCode).toBe(0);

  return capture.requests().slice(before);
};

// The fields named `name`, compared case-insensitively (RFC 9110 5.1), with the name as sent.
const fieldsNamed = (request: RecordedRequest | undefined, name: string): HeaderList =>
  (request?.headers ?? []).filter(([field]) => field.toLowerCase() === name.toLowerCase());

// The Cookie field's values: the cookie names are inside them; the field name is the runtime's own.
const cookiesOf = (request: RecordedRequest | undefined): readonly string[] =>
  fieldsNamed(request, "Cookie").map(([, value]) => value);

const run = async (line: Line, args: readonly string[]): Promise<Exchange> => {
  const { exchange } = await invoke(line, args);

  return exchange;
};

const accept: readonly [string, string] = ["accept", "*/*"];

const sentOnce = (target: string, headers: HeaderList = []): Exchange => ({
  exitCode: 0,
  sent: [{ headers: byName([accept, ...headers]), target }],
});

const refusedBeforeSending: Exchange = { exitCode: 2, sent: [] };

// In process generation of a small document of a line; the diagnostics of a refused run are the
// refusal's.
const members = (line: Line, extra: Members): Members => ({
  info: { title: "Parameter Object rows", version: "1.0.0" },
  openapi: line,
  ...extra,
});

const ok: Members = { "200": { description: "ok" } };

const text: Members = { type: "string" };

const withParameters = (line: Line, parameters: readonly Json[]): Members =>
  members(line, { paths: { "/a": { get: { parameters, responses: ok } } } });

const withPathParameter = (line: Line, parameter: Members): Members =>
  members(line, {
    paths: {
      "/a/{p}": {
        get: {
          parameters: [{ in: "path", name: "p", required: true, schema: text, ...parameter }],
          responses: ok,
        },
      },
    },
  });

interface Generated {
  readonly diagnostics: readonly Diagnostic[];
}

let counter = 0;

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const inProcess = async (document: Members, config: Members = plainConfig): Promise<Generated> => {
  counter += 1;
  const dir = nodePath.join(work, `case-${counter}`);
  nodeFs.mkdirSync(dir, { recursive: true });

  const specPath = nodePath.join(dir, "openapi.json");
  const configPath = nodePath.join(dir, "author-config.json");

  nodeFs.writeFileSync(specPath, JSON.stringify(document));
  nodeFs.writeFileSync(configPath, JSON.stringify(config));

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
    String(diagnostic.pointer),
  ]);

// A refusal by the line's official schema, which runs before the PRM rule: its code is the schema
// row of the line (VAL-02, VAL-03 or VAL-04), so only severity, scope and pointer are stable here.
const schemaRefusals = (found: Generated) =>
  found.diagnostics.map((diagnostic) => [
    diagnostic.severity,
    diagnostic.scope,
    String(diagnostic.pointer),
  ]);

const parameterPointer = "/paths/~1a/get/parameters/0";

const pathParameterPointer = "/paths/~1a~1{p}/get/parameters/0";

// Options for the runtime serializer, for the PRM-29 cases the built CLI cannot reach.
const runtimeOptions = { allowReserved: false, explode: true, required: false };

const deepObjectRefusal = (value: Serialize.Nested, brackets: boolean) =>
  Effect.runPromise(
    Effect.flip(Serialize.deepObject("filter", value, { ...runtimeOptions, brackets }).expand),
  );

// A deepObject query parameter whose member is itself an object (PRM-27).
const nestedFilter: Members = {
  explode: true,
  in: "query",
  name: "filter",
  schema: { properties: { a: { type: "object" } }, type: "object" },
  style: "deepObject",
};

// PRM-35 in 3.1: the element's notice and the known-disagreement notice citing both sides.
const ignoredOutsideQuery = (pointer: string) => [
  ["PRM-35/allow-reserved-ignored", "notice", "element", pointer],
  ["PRM-35/allow-reserved-outside-query", "notice", "element", `${pointer}/allowReserved`],
];

describe("PRM rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`PRM-01: one operation's path, query, header and cookie parameters each reach the request (${line})`, async () => {
        const observed = await run(line, [
          "locations-get",
          "p1",
          "--tags",
          "q1",
          "--x-trace",
          "h1",
          "--session",
          "c1",
        ]);

        expect(observed).toEqual(
          sentOnce("/locations/p1?tags=q1", [
            ["cookie", "session=c1"],
            ["x-trace", "h1"],
          ]),
        );
      }, 60_000);

      // PRM-02 (audit 15dfff22 S6): the name as sent, read from the raw capture. Query and cookie
      // names are case-sensitive and sent as written, a name outside the unreserved set
      // percent-encoded (PRM-26); a header name is a case-insensitive field name (RFC 9110 5.1) that
      // the HTTP client sends lowercased, so the header bytes are the lowercase name; a path
      // parameter's name is never sent in a simple expansion; one name in two locations is sent once
      // in each.
      test(`PRM-02: each parameter name reaches the wire exactly as the document spells it (${line})`, async () => {
        const [located] = await sentRaw(line, [
          "locations-get",
          "p1",
          "--tags",
          "q1",
          "--x-trace",
          "h1",
          "--session",
          "c1",
        ]);
        const [spaced] = await sentRaw(line, ["delimited-get", "--a-b", "v"]);
        const [identity] = await sentRaw(line, ["identity-get", "--id", "q", "--header-id", "h"]);

        expect([located?.target, spaced?.target, identity?.target]).toEqual([
          "/locations/p1?tags=q1",
          "/delimited?a%20b=v",
          "/identity?id=q",
        ]);
        expect([fieldsNamed(located, "X-Trace"), fieldsNamed(identity, "id")]).toEqual([
          [["x-trace", "h1"]],
          [["id", "h"]],
        ]);
        expect(cookiesOf(located)).toEqual(["session=c1"]);
      }, 60_000);

      test(`PRM-03: in path, query, header and cookie each serialize to their own place (${line})`, async () => {
        const path = await run(line, ["locations-get", "p1"]);
        const query = await run(line, ["locations-get", "p1", "--tags", "q1"]);
        const header = await run(line, ["locations-get", "p1", "--x-trace", "h1"]);
        const cookie = await run(line, ["locations-get", "p1", "--session", "c1"]);

        expect([path, query, header, cookie]).toEqual([
          sentOnce("/locations/p1"),
          sentOnce("/locations/p1?tags=q1"),
          sentOnce("/locations/p1", [["x-trace", "h1"]]),
          sentOnce("/locations/p1", [["cookie", "session=c1"]]),
        ]);
      }, 60_000);

      test(`PRM-05: a missing required parameter is a usage error before any request (${line})`, async () => {
        const missing = await run(line, ["flags-get"]);
        const given = await run(line, ["flags-get", "--need", "n"]);

        expect([missing, given]).toEqual([refusedBeforeSending, sentOnce("/flags?need=n")]);
      }, 60_000);

      test(`PRM-08: allowEmptyValue on a query parameter sends name= for an empty value (${line})`, async () => {
        const observed = await run(line, ["flags-get", "--need", "n", "--empty", ""]);

        expect(observed).toEqual(sentOnce("/flags?need=n&empty="));
      }, 60_000);

      test(`PRM-11: style defaults per location: path simple, query form, header simple, cookie form (${line})`, async () => {
        const observed = await run(line, [
          "locations-get",
          "a",
          "b",
          "--tags",
          "t1",
          "--tags",
          "t2",
          "--x-trace",
          "h1",
          "--x-trace",
          "h2",
          "--session",
          "s 1",
        ]);

        expect(observed).toEqual(
          sentOnce("/locations/a,b?tags=t1&tags=t2", [
            ["cookie", "session=s%201"],
            ["x-trace", "h1,h2"],
          ]),
        );
      }, 60_000);

      test(`PRM-12: explode defaults to true for form and false for simple; an explicit false joins with , (${line})`, async () => {
        const observed = await run(line, [
          "locations-get",
          "a",
          "b",
          "--tags",
          "t1",
          "--tags",
          "t2",
          "--colors",
          "c1",
          "--colors",
          "c2",
          "--x-trace",
          "h1",
          "--x-trace",
          "h2",
        ]);

        expect(observed).toEqual(
          sentOnce("/locations/a,b?tags=t1&tags=t2&colors=c1,c2", [["x-trace", "h1,h2"]]),
        );
      }, 60_000);

      test(`PRM-13: allowReserved in query passes reserved characters but & = + #, and encodes a bare % (${line})`, async () => {
        const reserved = await run(line, ["reserved-get", "--kept", "a/b?c:d@e!$()*,;&=+#%41%zz"]);
        const strict = await run(line, ["reserved-get", "--plain", "a/b?c:d"]);

        expect([reserved, strict]).toEqual([
          sentOnce("/reserved?kept=a/b?c:d@e!$()*,;%26%3D%2B%23%41%25zz"),
          sentOnce("/reserved?plain=a%2Fb%3Fc%3Ad"),
        ]);
      }, 60_000);

      test(`PRM-13: --kept "'" with allowReserved arrives as kept=%27 (a platform limit, D-OC7) (${line})`, async () => {
        const observed = await run(line, ["reserved-get", "--kept", "a'b"]);

        expect(observed).toEqual(sentOnce("/reserved?kept=a%27b"));
      }, 60_000);

      test(`PRM-14: a parameter schema given as a Reference Object generates its flag (${line})`, async () => {
        const observed = await run(line, ["flags-get", "--need", "n", "--limit", "7"]);

        expect(observed).toEqual(sentOnce("/flags?need=n&limit=7"));
      }, 60_000);

      test(`PRM-14: an integer flag takes int64 digits and a number flag JSON number text, sent unchanged; other text is a usage error before any request (${line})`, async () => {
        const word = await run(line, ["flags-get", "--need", "n", "--limit", "abc"]);
        const exponent = await run(line, ["flags-get", "--need", "n", "--limit", "1e2"]);
        const fraction = await run(line, ["flags-get", "--need", "n", "--limit", "1.0"]);
        const padded = await run(line, ["flags-get", "--need", "n", "--limit", "007"]);
        const ratio = await run(line, ["types-get", "--ratio", "abc"]);
        const wide = await run(line, ["flags-get", "--need", "n", "--limit", "9007199254740993"]);
        const decimal = await run(line, ["types-get", "--ratio", "1.50"]);

        expect([word, exponent, fraction, padded, ratio, wide, decimal]).toEqual([
          refusedBeforeSending,
          refusedBeforeSending,
          refusedBeforeSending,
          refusedBeforeSending,
          refusedBeforeSending,
          sentOnce("/flags?need=n&limit=9007199254740993"),
          sentOnce("/types?ratio=1.50"),
        ]);
      }, 60_000);

      test(`PRM-16: id in query and id in header are two parameters, sent to two places (${line})`, async () => {
        const observed = await run(line, ["identity-get", "--id", "q1", "--header-id", "h1"]);

        expect(observed).toEqual(sentOnce("/identity?id=q1", [["id", "h1"]]));
      }, 60_000);

      test(`PRM-19: a header parameter named Accept has no flag; Accept comes from negotiation (${line})`, async () => {
        const flag = await run(line, ["headers-get", "--accept", "text/x-mine"]);
        const plain = await run(line, ["headers-get"]);

        expect([flag, plain]).toEqual([refusedBeforeSending, sentOnce("/headers")]);
      }, 60_000);

      test(`PRM-20: a header parameter goes out under its lowercased wire name (${line})`, async () => {
        const observed = await run(line, ["headers-get", "--x-raw", "v"]);

        expect(observed).toEqual(sentOnce("/headers", [["x-raw", "v"]]));
      }, 60_000);

      test(`PRM-22: booleans are true or false; number text reaches the wire unchanged (${line})`, async () => {
        const truthy = await run(line, [
          "types-get",
          "--on",
          "--count",
          "9007199254740993",
          "--ratio",
          "1.50",
        ]);
        const falsy = await run(line, ["types-get", "--no-on", "--ratio", "1e2"]);

        expect([truthy, falsy]).toEqual([
          sentOnce("/types?count=9007199254740993&ratio=1.50&on=true"),
          sentOnce("/types?ratio=1e2&on=false"),
        ]);
      }, 60_000);

      test(`PRM-25: several form query parameters share one ? and & joins (${line})`, async () => {
        const observed = await run(line, [
          "locations-get",
          "p",
          "--tags",
          "1",
          "--tags",
          "2",
          "--colors",
          "3",
        ]);

        expect(observed).toEqual(sentOnce("/locations/p?tags=1&tags=2&colors=3"));
      }, 60_000);

      test(`PRM-26: a parameter name that is not an RFC 6570 variable name is percent-encoded (${line})`, async () => {
        const observed = await run(line, ["delimited-get", "--a-b", "v w"]);

        expect(observed).toEqual(sentOnce("/delimited?a%20b=v%20w"));
      }, 60_000);

      test(`PRM-28: the , delimiter stays raw and a , inside an item is encoded (${line})`, async () => {
        const observed = await run(line, ["reserved-get", "--list", "x,y", "--list", "z"]);

        expect(observed).toEqual(sentOnce("/reserved?list=x%2Cy,z"));
      }, 60_000);

      test(`PRM-29: pipe and space delimiters are percent-encoded; data holding them is refused (${line})`, async () => {
        const delimited = await run(line, [
          "delimited-get",
          "--pipes",
          "blue",
          "--pipes",
          "black",
          "--spaces",
          "s1",
          "--spaces",
          "s2",
        ]);
        const pipe = await run(line, ["delimited-get", "--pipes", "a|b"]);
        const space = await run(line, ["delimited-get", "--spaces", "a b"]);

        expect([delimited, pipe, space]).toEqual([
          sentOnce("/delimited?pipes=blue%7Cblack&spaces=s1%20s2"),
          refusedBeforeSending,
          refusedBeforeSending,
        ]);
      }, 60_000);

      test(`PRM-29: under allowReserved the delimiter and its percent-encoded form are refused and other escapes pass; without it an escape's % is encoded (${line})`, async () => {
        const pipe = await run(line, ["delimited-get", "--rpipes", "a|b"]);
        const encodedPipe = await run(line, ["delimited-get", "--rpipes", "a%7Cb"]);
        const lowerPipe = await run(line, ["delimited-get", "--rpipes", "a%7cb"]);
        const space = await run(line, ["delimited-get", "--rspaces", "a b"]);
        const encodedSpace = await run(line, ["delimited-get", "--rspaces", "a%20b"]);
        const escape = await run(line, ["delimited-get", "--rpipes", "a%5Cb", "--rpipes", "c"]);
        const strict = await run(line, ["delimited-get", "--pipes", "a%7Cb"]);

        expect([pipe, encodedPipe, lowerPipe, space, encodedSpace, escape, strict]).toEqual([
          refusedBeforeSending,
          refusedBeforeSending,
          refusedBeforeSending,
          refusedBeforeSending,
          refusedBeforeSending,
          sentOnce("/delimited?rpipes=a%5Cb%7Cc"),
          sentOnce("/delimited?pipes=a%257Cb"),
        ]);
      }, 60_000);

      test(`PRM-15: a content-based query, header and cookie parameter each send their one media type's text (${line})`, async () => {
        const observed = await run(line, [
          "content-get",
          "--coordinates",
          '{"lat":1,"long":2}',
          "--x-note",
          "a b,c",
          "--pref",
          "dark",
        ]);

        expect(observed).toEqual(
          sentOnce("/content?coordinates=%7B%22lat%22%3A1%2C%22long%22%3A2%7D", [
            ["cookie", "pref=dark"],
            ["x-note", "a b,c"],
          ]),
        );
      }, 60_000);

      test(`PRM-23: JSON query content is serialized compact, then percent-encoded (${line})`, async () => {
        const observed = await run(line, [
          "content-get",
          "--coordinates",
          '{ "lat": 1.5, "long": -2 }',
        ]);

        expect(observed).toEqual(
          sentOnce("/content?coordinates=%7B%22lat%22%3A1.5%2C%22long%22%3A-2%7D"),
        );
      }, 60_000);

      test(`PRM-24: text/plain header and cookie content pass through unencoded; cookie text outside cookie-octet is refused (${line})`, async () => {
        const passed = await run(line, ["content-get", "--x-note", '"a%20b" c', "--pref", "a%20b"]);
        const spaced = await run(line, ["content-get", "--pref", "a b"]);

        expect([passed, spaced]).toEqual([
          sentOnce("/content", [
            ["cookie", "pref=a%20b"],
            ["x-note", '"a%20b" c'],
          ]),
          refusedBeforeSending,
        ]);
      }, 60_000);
    });
  }

  for (const line of lines) {
    test(`PRM-07: --old is marked deprecated in help and its use writes one stderr notice naming the flag, never the value (${line})`, async () => {
      const help = await invoke(line, ["flags-get", "--help"]);
      const used = await invoke(line, ["flags-get", "--need", "n", "--old", "SECRET-o"]);
      const unused = await invoke(line, ["flags-get", "--need", "n"]);
      const row = (flag: string) =>
        help.stdout
          .split("\n")
          .map((entry) => entry.trim())
          .filter((entry) => entry.startsWith(`${flag} `));
      const before = new Set(unused.stderr.split("\n"));
      const added = used.stderr.split("\n").filter((entry) => !before.has(entry));

      expect(row("--old").map((entry) => entry.endsWith("(query old; deprecated)"))).toEqual([
        true,
      ]);
      expect(row("--need").map((entry) => entry.includes("deprecated"))).toEqual([false]);
      expect(added).toHaveLength(1);
      expect(added[0]).toContain("--old");
      expect(used.stderr).not.toContain("SECRET-o");
      expect([used.exchange, unused.exchange]).toEqual([
        sentOnce("/flags?need=n&old=SECRET-o"),
        sentOnce("/flags?need=n"),
      ]);
    }, 60_000);
  }

  for (const line of ["3.0.4", "3.1.2"] as const) {
    test(`PRM-30: = & + in query data are percent-encoded under form rules (${line})`, async () => {
      const observed = await run(line, ["reserved-get", "--plain", "c&d=e+f g"]);

      expect(observed).toEqual(sentOnce("/reserved?plain=c%26d%3De%2Bf%20g"));
    }, 60_000);

    test(`PRM-33: a schema-based header value is sent unchanged, " and % included (${line})`, async () => {
      const observed = await run(line, ["headers-get", "--x-raw", '"a%20b" c']);

      expect(observed).toEqual(sentOnce("/headers", [["x-raw", '"a%20b" c']]));
    }, 60_000);
  }

  test('PRM-33: a schema-based header value is sent unchanged, " and % included (3.2.1)', async () => {
    const observed = await run("3.2.1", ["headers-get", "--x-raw", '"a%20b" c']);

    expect(observed).toEqual(sentOnce("/headers", [["x-raw", '"a%20b" c']]));
  }, 60_000);

  // RFC 3986 percent-encoding, space as %20, ~ raw, * as %2A, + as %2B, which decodes to the same
  // text under WHATWG form-urlencoded rules. Design 6.1's query row lists no version difference.
  test("PRM-31: 3.2.1 --plain 'a b~*+' is sent as plain=a%20b~%2A%2B, the 3.1.2 bytes", async () => {
    const modern = await run("3.2.1", ["reserved-get", "--plain", "a b~*+"]);
    const previous = await run("3.1.2", ["reserved-get", "--plain", "a b~*+"]);

    expect([modern, previous]).toEqual([
      sentOnce("/reserved?plain=a%20b~%2A%2B"),
      sentOnce("/reserved?plain=a%20b~%2A%2B"),
    ]);
  }, 60_000);

  test("PRM-32: a 3.0 schema-based header value is not percent-encoded", async () => {
    const observed = await run("3.0.4", ["headers-get", "--x-raw", '"a%20b" c']);

    expect(observed).toEqual(sentOnce("/headers", [["x-raw", '"a%20b" c']]));
  }, 60_000);

  test("PRM-03: in querystring (3.2) is the whole query string", async () => {
    const observed = await run("3.2.1", ["querystring-get", "--selector", '"x y"']);

    expect(observed).toEqual(sentOnce("/querystring?%22x%20y%22"));
  }, 60_000);

  // A text/plain querystring flag is a plain string flag: the operator's text needs no JSON quotes.
  test("PRM-15: a text/plain querystring parameter takes the operator's text as given, percent-encoded once (3.2.1)", async () => {
    const observed = await run("3.2.1", ["querystring-text-get", "--phrase", "a b&c=d"]);

    expect(observed).toEqual(sentOnce("/querystring-text?a%20b%26c%3Dd"));
  }, 60_000);

  test("PRM-02: in querystring (3.2) the parameter name selector is not sent", async () => {
    const [sent] = await sentRaw("3.2.1", ["querystring-get", "--selector", '"x"']);

    expect(sent?.target).toBe("/querystring?%22x%22");
    expect(sent?.target).not.toContain("selector");
  }, 60_000);

  // PRM-02 names the fixture cannot hold (a non-ASCII name; two names differing only in case, whose
  // flags would collide): built by the runtime serializer the package embeds and sent by Bun's
  // fetch to the capture server, so the bytes are the ones on the wire. A matrix path expansion,
  // the query and the cookie keep the case and percent-encode the UTF-8 of a non-ASCII name; the
  // header name goes out lowercased (RFC 9110 5.1).
  test("PRM-02: a non-ASCII or case-distinct name is sent with its case kept and its UTF-8 percent-encoded", async () => {
    const before = capture.requests().length;
    const cookieOptions = {
      allowReserved: false,
      explode: true,
      line: "3.1",
      required: false,
      style: "form",
    } as const;
    const sending = Serialize.request("GET", {
      cookies: [
        Serialize.cookie("SID", "1", cookieOptions),
        Serialize.cookie("sid", "2", cookieOptions),
      ],
      headers: [Serialize.header("X-Mixed-Case", "h", { explode: false, required: false })],
      path: Serialize.path("/names/{Naïve}", [
        Serialize.matrix("Naïve", "v", { allowReserved: false, explode: false }),
      ]),
      query: [
        Serialize.form("Naïve", "v", runtimeOptions),
        Serialize.form("Q", "1", runtimeOptions),
        Serialize.form("q", "2", runtimeOptions),
      ],
    }).pipe(
      Effect.map(HttpClientRequest.prependUrl(origin)),
      Effect.flatMap(HttpClient.execute),
      Effect.provide(FetchHttpClient.layer),
    );
    await Effect.runPromise(sending);
    const [sent] = capture.requests().slice(before);

    expect(sent?.target).toBe("/names/;Na%C3%AFve=v?Na%C3%AFve=v&Q=1&q=2");
    expect(fieldsNamed(sent, "X-Mixed-Case")).toEqual([["x-mixed-case", "h"]]);
    expect(cookiesOf(sent)).toEqual(["SID=1; sid=2"]);
  });

  // Two PRM-29 cases the built CLI cannot reach, checked on the runtime serializer the package
  // embeds: a deepObject parameter gets a string flag, so no object with a bracketed member key can
  // be given, and a pipeDelimited parameter with explode true is refused at generation (STY-22).
  test("PRM-29: an exploded pipeDelimited item holding | is sent, its | encoded", async () => {
    const sent = await Effect.runPromise(
      Serialize.pipeDelimited("c", ["a|b", "x"], { ...runtimeOptions, allowReserved: true }).expand,
    );

    expect(sent).toBe("c=a%7Cb&c=x");
  });

  test("PRM-29: a deepObject member key holding [ or ] is a usage error, standard and bracket mode", async () => {
    const errors = [
      await deepObjectRefusal({ "a]b": "v" }, false),
      await deepObjectRefusal({ "a[b": "v" }, false),
      await deepObjectRefusal({ x: { "[k]": "v" } }, true),
    ];

    expect(errors.map((error) => [error._tag, error[Runtime.errorExitCode]])).toEqual([
      ["UsageError", 2],
      ["UsageError", 2],
      ["UsageError", 2],
    ]);
  });

  // A schema-based scalar parameter is a string flag, so the operator has no null to give: RFC 6570
  // undefined is reached by omitting the flag, which sends no pair (memo 121cf83f, B4).
  for (const line of lines) {
    test(`PRM-22: an omitted nullable scalar flag sends no pair; --maybe null sends the text null (${line})`, async () => {
      const omitted = await run(line, ["types-get", "--ratio", "1"]);
      const given = await run(line, ["types-get", "--ratio", "1", "--maybe", "null"]);

      expect([omitted, given]).toEqual([
        sentOnce("/types?ratio=1"),
        sentOnce("/types?ratio=1&maybe=null"),
      ]);
    }, 60_000);
  }
});

describe("PRM rows through generate()", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`PRM-06: a path parameter with required absent or false is refused by the schema (${line})`, async () => {
        const absent = await inProcess(
          members(line, {
            paths: {
              "/a/{p}": {
                get: { parameters: [{ in: "path", name: "p", schema: text }], responses: ok },
              },
            },
          }),
        );
        const falsy = await inProcess(withPathParameter(line, { required: false }));

        // 3.0's schema reports the `in` its parameter variants could not match; 3.1 and 3.2
        // report the parameter or its `required`.
        expect(schemaRefusals(falsy)).toContainEqual([
          "refusal",
          "document",
          `${pathParameterPointer}/required`,
        ]);
        expect(
          [...absent.diagnostics, ...falsy.diagnostics].every(
            (diagnostic) => diagnostic.severity === "refusal" && diagnostic.scope === "document",
          ),
        ).toBe(true);
        expect(absent.diagnostics.length).toBeGreaterThan(0);
      }, 60_000);

      test(`PRM-15: a content key that is not a concrete media type, or has no schema, is refused (${line})`, async () => {
        const range = await inProcess(
          withParameters(line, [
            { content: { "application/*": { schema: text } }, in: "query", name: "q" },
          ]),
        );
        const schemaless = await inProcess(
          withParameters(line, [{ content: { "application/json": {} }, in: "query", name: "q" }]),
        );

        expect([summary(range), summary(schemaless)]).toEqual([
          [["PRM-15/invalid-media-type", "refusal", "element", parameterPointer]],
          [["PRM-15/missing-schema", "refusal", "element", parameterPointer]],
        ]);
      }, 60_000);

      test(`PRM-16: identity is name plus location: id in query and id in header are no duplicate (${line})`, async () => {
        const twoPlaces = await inProcess(
          withParameters(line, [
            { in: "query", name: "id", schema: text },
            { in: "header", name: "id", schema: text },
          ]),
        );
        // The two differ in description, so 3.0's uniqueItems does not catch them first.
        const onePlace = await inProcess(
          withParameters(line, [
            { in: "query", name: "id", schema: text },
            { description: "again", in: "query", name: "id", schema: text },
          ]),
        );

        // Without a naming override both fold to --id, the flag collision of design 4.4.
        expect([
          summary(twoPlaces).filter(([code]) => code !== "PRM-32/header-percent-encoding"),
          summary(onePlace),
        ]).toEqual([
          [["PRM-02/flag-collision", "refusal", "operation", parameterPointer]],
          [["PTH-28/duplicate-parameter", "refusal", "operation", "/paths/~1a/get/parameters/1"]],
        ]);
      }, 60_000);

      test(`PRM-17: a parameter with both schema and content, or neither, is refused by the schema (${line})`, async () => {
        const both = await inProcess(
          withParameters(line, [
            {
              content: { "application/json": { schema: text } },
              in: "query",
              name: "q",
              schema: text,
            },
          ]),
        );
        const neither = await inProcess(withParameters(line, [{ in: "query", name: "q" }]));

        expect([schemaRefusals(both), schemaRefusals(neither)]).toEqual([
          [["refusal", "document", parameterPointer]],
          [["refusal", "document", parameterPointer]],
        ]);
      }, 60_000);

      test(`PRM-18: a content map with two media types is refused by the schema (${line})`, async () => {
        const found = await inProcess(
          withParameters(line, [
            {
              content: { "application/json": { schema: text }, "text/plain": { schema: text } },
              in: "query",
              name: "q",
            },
          ]),
        );

        expect(schemaRefusals(found)).toEqual([
          ["refusal", "document", `${parameterPointer}/content`],
        ]);
      }, 60_000);

      test(`PRM-19: header parameters Accept, Content-Type and Authorization are ignored with a notice (${line})`, async () => {
        const found = await inProcess(
          withParameters(line, [
            { in: "header", name: "Accept", schema: text },
            { in: "header", name: "content-type", schema: text },
            { in: "header", name: "AUTHORIZATION", schema: text },
          ]),
        );

        expect(summary(found)).toEqual(
          [0, 1, 2].map((index) => [
            "PRM-19/ignored-header",
            "notice",
            "element",
            `/paths/~1a/get/parameters/${index}`,
          ]),
        );
      }, 60_000);

      test(`PRM-20: two header parameters differing only in case are duplicates (${line})`, async () => {
        const found = await inProcess(
          withParameters(line, [
            { in: "header", name: "X-Id", schema: text },
            { in: "header", name: "x-id", schema: text },
          ]),
        );

        expect(
          summary(found).filter(([code]) => code !== "PRM-32/header-percent-encoding"),
        ).toEqual([
          ["PTH-28/duplicate-parameter", "refusal", "operation", "/paths/~1a/get/parameters/1"],
        ]);
      }, 60_000);

      test(`PRM-21: a header parameter named Cookie is refused (${line})`, async () => {
        const found = await inProcess(
          withParameters(line, [{ in: "header", name: "Cookie", schema: text }]),
        );

        expect(summary(found)).toEqual([
          ["PRM-21/cookie-header", "refusal", "element", parameterPointer],
        ]);
      }, 60_000);

      test(`PRM-15: path content and form-urlencoded query content refuse their operation as EMT-1/unsupported-parameter (${line})`, async () => {
        const path = await inProcess(
          members(line, {
            paths: {
              "/a/{p}": {
                get: {
                  parameters: [
                    {
                      content: { "text/plain": { schema: text } },
                      in: "path",
                      name: "p",
                      required: true,
                    },
                  ],
                  responses: ok,
                },
              },
            },
          }),
        );
        const form = await inProcess(
          withParameters(line, [
            {
              content: { "application/x-www-form-urlencoded": { schema: { type: "object" } } },
              in: "query",
              name: "q",
            },
          ]),
        );

        expect([summary(path), summary(form)]).toEqual([
          [["EMT-1/unsupported-parameter", "refusal", "operation", "/paths/~1a~1{p}/get"]],
          [["EMT-1/unsupported-parameter", "refusal", "operation", "/paths/~1a/get"]],
        ]);
      }, 60_000);

      test(`PRM-27: a deepObject query parameter with a nested object property is refused at element scope (${line})`, async () => {
        const found = await inProcess(withParameters(line, [nestedFilter]));

        expect(summary(found)).toEqual([
          ["PRM-27/compound-nested", "refusal", "element", parameterPointer],
        ]);
      }, 60_000);

      test(`PRM-27: with nonStandard.deepObjectBrackets the nested deepObject parameter is built with one author-choice notice (${line})`, async () => {
        const found = await inProcess(withParameters(line, [nestedFilter]), {
          ...plainConfig,
          nonStandard: { deepObjectBrackets: true },
        });

        expect(summary(found)).toEqual([
          ["PRM-27/bracket-author-choice", "notice", "element", parameterPointer],
        ]);
      }, 60_000);
    });
  }

  for (const line of ["3.0.4", "3.1.2"] as const) {
    test(`PRM-20: a header parameter name that is not an RFC 9110 token is refused (${line})`, async () => {
      const found = await inProcess(
        withParameters(line, [{ in: "header", name: "X Id", schema: text }]),
      );

      expect(summary(found).filter(([code]) => code !== "PRM-32/header-percent-encoding")).toEqual([
        ["PRM-20/invalid-header-name", "refusal", "element", `${parameterPointer}/name`],
      ]);
    }, 60_000);
  }

  test("PRM-20: a header parameter name that is not a token is refused by the 3.2 schema", async () => {
    const found = await inProcess(
      withParameters("3.2.1", [{ in: "header", name: "X Id", schema: text }]),
    );

    expect(schemaRefusals(found)).toEqual([["refusal", "document", `${parameterPointer}/name`]]);
  }, 60_000);

  test("PRM-08: allowEmptyValue on a 3.0 header parameter is ignored with a notice", async () => {
    const found = await inProcess(
      withParameters("3.0.4", [{ allowEmptyValue: true, in: "header", name: "X-A", schema: text }]),
    );

    expect(summary(found)).toEqual([
      ["PRM-08/allow-empty-value-ignored", "notice", "element", parameterPointer],
      ["PRM-32/header-percent-encoding", "notice", "element", parameterPointer],
    ]);
  }, 60_000);

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`PRM-08: allowEmptyValue on a header parameter is refused by the schema (${line})`, async () => {
      const found = await inProcess(
        withParameters(line, [{ allowEmptyValue: true, in: "header", name: "X-A", schema: text }]),
      );

      expect(schemaRefusals(found)).toEqual([
        ["refusal", "document", `${parameterPointer}/allowEmptyValue`],
      ]);
    }, 60_000);
  }

  test("PRM-32: every generated 3.0 header parameter carries one percent-encoding notice", async () => {
    const found = await inProcess(specOf("3.0.4"), authorConfig);

    // headers-get's X-Raw, identity-get's id and locations-get's X-Trace; the ignored Accept
    // header has none.
    expect(summary(found).filter(([code]) => code === "PRM-32/header-percent-encoding")).toEqual(
      [
        "/paths/~1headers/get/parameters/0",
        "/paths/~1identity/get/parameters/1",
        "/paths/~1locations~1{id}/get/parameters/3",
      ].map((pointer) => ["PRM-32/header-percent-encoding", "notice", "element", pointer]),
    );
  }, 60_000);

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`PRM-33: a ${line} header parameter carries no percent-encoding notice`, async () => {
      const found = await inProcess(specOf(line), authorConfig);

      expect(summary(found).filter(([code]) => code === "PRM-32/header-percent-encoding")).toEqual(
        [],
      );
    }, 60_000);
  }

  test("PRM-35: allowReserved on a 3.0 path, header or cookie parameter is ignored with a notice", async () => {
    const path = await inProcess(withPathParameter("3.0.4", { allowReserved: true }));
    const header = await inProcess(
      withParameters("3.0.4", [{ allowReserved: true, in: "header", name: "X-A", schema: text }]),
    );
    const cookie = await inProcess(
      withParameters("3.0.4", [{ allowReserved: true, in: "cookie", name: "c", schema: text }]),
    );

    expect([
      summary(path),
      summary(header).filter(([code]) => code !== "PRM-32/header-percent-encoding"),
      summary(cookie),
    ]).toEqual([
      [["PRM-35/allow-reserved-ignored", "notice", "element", pathParameterPointer]],
      [["PRM-35/allow-reserved-ignored", "notice", "element", parameterPointer]],
      [["PRM-35/allow-reserved-ignored", "notice", "element", parameterPointer]],
    ]);
  }, 60_000);

  test("PRM-35: allowReserved on a 3.1 path, header or cookie parameter is accepted through the disagreement table and ignored", async () => {
    const path = await inProcess(withPathParameter("3.1.2", { allowReserved: true }));
    const header = await inProcess(
      withParameters("3.1.2", [{ allowReserved: true, in: "header", name: "X-A", schema: text }]),
    );
    const cookie = await inProcess(
      withParameters("3.1.2", [{ allowReserved: true, in: "cookie", name: "c", schema: text }]),
    );

    expect([summary(path), summary(header), summary(cookie)]).toEqual([
      ignoredOutsideQuery(pathParameterPointer),
      ignoredOutsideQuery(parameterPointer),
      ignoredOutsideQuery(parameterPointer),
    ]);
  }, 60_000);

  test("PRM-35: 3.2 honors allowReserved on path and form cookie; on a header the schema refuses it", async () => {
    const path = await inProcess(withPathParameter("3.2.1", { allowReserved: true }));
    const cookie = await inProcess(
      withParameters("3.2.1", [{ allowReserved: true, in: "cookie", name: "c", schema: text }]),
    );
    const header = await inProcess(
      withParameters("3.2.1", [{ allowReserved: true, in: "header", name: "X-A", schema: text }]),
    );

    expect([summary(path), summary(cookie), schemaRefusals(header)]).toEqual([
      [],
      [],
      [["refusal", "document", `${parameterPointer}/allowReserved`]],
    ]);
  }, 60_000);
});
