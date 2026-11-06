import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, Exit, Layer, Order, Scope, Schema } from "effect";
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
const watched: ReadonlySet<string> = new Set(["accept", "cookie", "id", "x-raw", "x-trace"]);

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

// One invocation of the line's built CLI against the bound server, with what the capture server
// recorded during it. `runBin` is asynchronous, so the in-process capture server keeps answering.
const run = async (line: Line, args: readonly string[]): Promise<Exchange> => {
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
    exitCode: result.exitCode,
    sent: capture
      .requests()
      .slice(before)
      .map((request) => ({ headers: watchedOf(request.headers), target: request.target })),
  };
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

      // The rest of the reserved set passes; the sub-delim ' arrives as %27. The runtime's query
      // reserved set keeps ', so the WHATWG URL serializer under fetch encodes it.
      test.todo(`PRM-13: --kept "'" with allowReserved arrives as kept=%27 vs kept=' raw, a reserved character (${line})`, () =>
        Promise.resolve());

      test(`PRM-14: a parameter schema given as a Reference Object generates its flag (${line})`, async () => {
        const observed = await run(line, ["flags-get", "--need", "n", "--limit", "7"]);

        expect(observed).toEqual(sentOnce("/flags?need=n&limit=7"));
      }, 60_000);

      // Every schema-based scalar parameter is a string flag: `--count abc` and `--limit abc` are
      // sent as given.
      test.todo(`PRM-14: --limit abc on an integer parameter is sent as limit=abc (exit 0) vs a usage error from the schema type before any request (${line})`, () =>
        Promise.resolve());

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
    });
  }

  // The help text and the use of a deprecated parameter carry no mark; the request is sent.
  test.todo("PRM-07: --old help carries no deprecation mark and its use prints nothing on stderr vs a deprecated marker in help and a stderr notice on use (all lines)", () =>
    Promise.resolve());

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

  // The 3.2.1 query bytes equal the 3.1.2 ones: RFC 3986 percent-encoding, space as %20, ~ raw,
  // * as %2A. Design 6.1's query row lists no version difference.
  test.todo("PRM-31: 3.2.1 --plain 'a b~*' is sent as plain=a%20b~%2A, the 3.1.2 bytes, vs the WHATWG application/x-www-form-urlencoded set (plain=a+b%7E*)", () =>
    Promise.resolve());

  test("PRM-32: a 3.0 schema-based header value is not percent-encoded", async () => {
    const observed = await run("3.0.4", ["headers-get", "--x-raw", '"a%20b" c']);

    expect(observed).toEqual(sentOnce("/headers", [["x-raw", '"a%20b" c']]));
  }, 60_000);

  test("PRM-03: in querystring (3.2) is the whole query string", async () => {
    const observed = await run("3.2.1", ["querystring-get", "--selector", '"x y"']);

    expect(observed).toEqual(sentOnce("/querystring?%22x%20y%22"));
  }, 60_000);

  // No content-based parameter outside querystring generates: `generate()` fails with
  // ApiEmitError reason unsupported-parameter (subjects query:c, header:X-C, cookie:c, path:p).
  test.todo("PRM-15: a content-based query, header, cookie or path parameter fails generation with ApiEmitError unsupported-parameter vs a value serialized with its one media type (all lines)", () =>
    Promise.resolve());

  test.todo("PRM-23: a query parameter with application/json content fails generation with ApiEmitError unsupported-parameter vs coordinates=%7B%22lat%22… on the wire (all lines)", () =>
    Promise.resolve());

  test.todo("PRM-24: a cookie parameter with text/plain content fails generation with ApiEmitError unsupported-parameter vs the value passed through in the Cookie header (all lines)", () =>
    Promise.resolve());

  test.todo("PRM-22: INCONCLUSIVE: a schema-based scalar parameter is a string flag, so the operator has no null to give (--maybe null sends the text null); RFC 6570 undefined is reached only by omitting the flag", () =>
    Promise.resolve());
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

      // A deepObject query parameter with an object property generates with no diagnostic; the
      // built flag is a plain string, so any --filter value exits 2 as not an object.
      test.todo(`PRM-27: a deepObject query parameter with a nested object property generates with no diagnostic vs a PRM-27/compound-nested refusal at element scope (${line})`, () =>
        Promise.resolve());
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
