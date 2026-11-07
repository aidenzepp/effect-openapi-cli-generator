import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Runtime, Scope, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate, GenerateRefused } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The Milestone 2 witness for the path, query and header style rows (STY-01 to STY-32): one
// generated package per version line, built once, run against the capture server; the refusal and
// notice rows call `generate()` in process. Object vectors, which the built CLI cannot give (an
// object-schema parameter gets a string flag), run on the runtime serializer the package embeds.
// A row the product gets wrong is a `test.todo` with what was observed.

const fixtures = nodePath.resolve(
  import.meta.dir,
  "../../corpus/fixtures/rows/sty-path-query-header",
);

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = nodeFs.mkdtempSync(nodePath.join(tmpdir(), "wt-sty1-"));

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

interface Sent {
  // The fixture's own `x-` header parameters, by lower-case name, in arrival order.
  readonly headers: readonly (readonly [string, string])[];
  readonly target: string;
}

interface Exchange {
  readonly exitCode: number | null;
  readonly sent: readonly Sent[];
}

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
      .map((request) => ({
        headers: request.headers.flatMap(([name, value]) =>
          name.toLowerCase().startsWith("x-") ? [[name.toLowerCase(), value] as const] : [],
        ),
        target: request.target,
      })),
  };
};

// The target of one request the CLI sent with exit 0.
const sentTo = (target: string): Exchange => ({ exitCode: 0, sent: [{ headers: [], target }] });

// The headers of one request to /headers the CLI sent with exit 0.
const sentHeaders = (headers: readonly (readonly [string, string])[]): Exchange => ({
  exitCode: 0,
  sent: [{ headers, target: "/headers" }],
});

const refusedBeforeSending: Exchange = { exitCode: 2, sent: [] };

// The style examples' vectors (3.2.1#style-examples): the name `color`, the string `blue`, the
// array `blue, black, brown` and the object `R=100, G=200, B=150`.
const array = ["blue", "black", "brown"];

// Built from entries: member order is the wire order, which sorted object keys would change.
const object = Object.fromEntries([
  ["R", 100],
  ["G", 200],
  ["B", 150],
]);

const expanded = (expansion: Effect.Effect<string | undefined, UsageError>) =>
  Effect.runPromise(expansion);

// A runtime expansion that fails: its tag and exit code, as the built CLI would exit.
const refusal = async (
  expansion: Effect.Effect<string | undefined, UsageError>,
): Promise<readonly (string | number)[]> => {
  const error = await Effect.runPromise(Effect.flip(expansion));

  return [error._tag, error[Runtime.errorExitCode]];
};

const usageError: readonly (string | number)[] = ["UsageError", 2];

// In process generation of a small document of a line; the diagnostics of a refused run are the
// refusal's.
const members = (line: Line, extra: Members): Members => ({
  info: { title: "Path, query and header style rows", version: "1.0.0" },
  openapi: line,
  ...extra,
});

const ok: Members = { "200": { description: "ok" } };

const text: Members = { type: "string" };

const list: Members = { items: text, type: "array" };

const rgb: Members = {
  properties: { B: { type: "integer" }, G: { type: "integer" }, R: { type: "integer" } },
  type: "object",
};

const withParameters = (line: Line, parameters: readonly Json[]): Members =>
  members(line, { paths: { "/a": { get: { parameters, responses: ok } } } });

const queryParameter = (schema: Members, extra: Members): Members => ({
  in: "query",
  name: "color",
  schema,
  ...extra,
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
  nodeFs.writeFileSync(configPath, JSON.stringify(authorConfig));

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

const parameterPointer = "/paths/~1a/get/parameters/0";

describe("STY path rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`STY-01: matrix is ;color=blue and ;list=blue,black,brown; an empty string is ;color (${line})`, async () => {
        const vectors = await run(line, ["path-matrix", "blue", ...array]);
        const empty = await run(line, ["path-matrix", "", "x y"]);

        expect([vectors, empty]).toEqual([
          sentTo("/path-matrix/;color=blue/;list=blue,black,brown"),
          sentTo("/path-matrix/;color/;list=x%20y"),
        ]);
      }, 60_000);

      test(`STY-02: exploded matrix repeats the name per item (${line})`, async () => {
        const vectors = await run(line, ["path-matrix-x", "blue", ...array]);
        const empty = await run(line, ["path-matrix-x", "", "a,b"]);

        expect([vectors, empty]).toEqual([
          sentTo("/path-matrix-x/;color=blue/;list=blue;list=black;list=brown"),
          sentTo("/path-matrix-x/;color/;list=a%2Cb"),
        ]);
      }, 60_000);

      test(`STY-03: label is .blue and .blue,black,brown; an empty string is the refused dot segment (${line})`, async () => {
        const vectors = await run(line, ["path-label", "blue", ...array]);
        const empty = await run(line, ["path-label", "", "x"]);

        expect([vectors, empty]).toEqual([
          sentTo("/path-label/.blue/.blue,black,brown"),
          refusedBeforeSending,
        ]);
      }, 60_000);

      test(`STY-04: exploded label joins items with . (${line})`, async () => {
        const vectors = await run(line, ["path-label-x", "blue", ...array]);
        const empty = await run(line, ["path-label-x", "", "x"]);

        expect([vectors, empty]).toEqual([
          sentTo("/path-label-x/.blue/.blue.black.brown"),
          refusedBeforeSending,
        ]);
      }, 60_000);

      test(`STY-04: an exploded label item holding . is a usage error before any request (${line})`, async () => {
        const observed = await run(line, ["path-label-x", "blue", "a.b", "c"]);

        expect(observed).toEqual(refusedBeforeSending);
      }, 60_000);

      test(`STY-05: default simple is blue and blue,black,brown, percent-encoded outside unreserved (${line})`, async () => {
        const vectors = await run(line, ["path-simple", "blue", ...array]);
        const encoded = await run(line, ["path-simple", "a b/c", "d,e", "f~g"]);

        expect([vectors, encoded]).toEqual([
          sentTo("/path-simple/blue/blue,black,brown"),
          sentTo("/path-simple/a%20b%2Fc/d%2Ce,f~g"),
        ]);
      }, 60_000);

      test(`STY-05: a simple expansion that is the empty string is a usage error before any request (${line})`, async () => {
        const value = await run(line, ["path-simple", "", "x"]);
        const item = await run(line, ["path-simple", "blue", ""]);

        expect([value, item]).toEqual([refusedBeforeSending, refusedBeforeSending]);
      }, 60_000);

      test(`STY-06: exploded simple is blue and blue,black,brown (${line})`, async () => {
        const observed = await run(line, ["path-simple-x", "blue", ...array]);

        expect(observed).toEqual(sentTo("/path-simple-x/blue/blue,black,brown"));
      }, 60_000);

      test(`STY-06: an exploded simple expansion that is the empty string is a usage error before any request (${line})`, async () => {
        const value = await run(line, ["path-simple-x", "", "x"]);
        const item = await run(line, ["path-simple-x", "blue", ""]);

        expect([value, item]).toEqual([refusedBeforeSending, refusedBeforeSending]);
      }, 60_000);
    });
  }
});

describe("STY 3.2 path rows with allowReserved through the built CLI", () => {
  const reserved = ["a:b@c/d?e#f", "x:y", "z@w!$"] as const;

  test("STY-07: matrix with allowReserved sends reserved characters but / ? # unencoded", async () => {
    const observed = await run("3.2.1", ["path-matrix-r", ...reserved]);

    expect(observed).toEqual(sentTo("/path-matrix-r/;color=a:b@c%2Fd%3Fe%23f/;list=x:y,z@w!$"));
  }, 60_000);

  test("STY-07: a matrix item holding ; , or = is a usage error before any request", async () => {
    const observed = await Promise.all(
      ["a;b", "a,b", "a=b"].map((item) => run("3.2.1", ["path-matrix-r", "c", item])),
    );

    expect(observed).toEqual([refusedBeforeSending, refusedBeforeSending, refusedBeforeSending]);
  }, 60_000);

  test("STY-08: exploded matrix with allowReserved repeats the name, reserved characters unencoded", async () => {
    const observed = await run("3.2.1", ["path-matrix-x-r", ...reserved]);

    expect(observed).toEqual(
      sentTo("/path-matrix-x-r/;color=a:b@c%2Fd%3Fe%23f/;list=x:y;list=z@w!$"),
    );
  }, 60_000);

  test("STY-08: an exploded matrix item holding ; , or = is a usage error before any request", async () => {
    const observed = await Promise.all(
      ["a;b", "a,b", "a=b"].map((item) => run("3.2.1", ["path-matrix-x-r", "c", item])),
    );

    expect(observed).toEqual([refusedBeforeSending, refusedBeforeSending, refusedBeforeSending]);
  }, 60_000);

  test("STY-09: label with allowReserved sends reserved characters but / ? # unencoded", async () => {
    const observed = await run("3.2.1", ["path-label-r", ...reserved]);

    expect(observed).toEqual(sentTo("/path-label-r/.a:b@c%2Fd%3Fe%23f/.x:y,z@w!$"));
  }, 60_000);

  test("STY-09: a label item holding , or = is a usage error before any request", async () => {
    const observed = await Promise.all(
      ["a,b", "a=b"].map((item) => run("3.2.1", ["path-label-r", "c", item])),
    );

    expect(observed).toEqual([refusedBeforeSending, refusedBeforeSending]);
  }, 60_000);

  test("STY-10: exploded label with allowReserved joins items with ., reserved characters unencoded", async () => {
    const observed = await run("3.2.1", ["path-label-x-r", ...reserved]);

    expect(observed).toEqual(sentTo("/path-label-x-r/.a:b@c%2Fd%3Fe%23f/.x:y.z@w!$"));
  }, 60_000);

  test("STY-10: an exploded label item holding . , or = is a usage error before any request", async () => {
    const observed = await Promise.all(
      ["a.b", "a,b", "a=b"].map((item) => run("3.2.1", ["path-label-x-r", "c", item])),
    );

    expect(observed).toEqual([refusedBeforeSending, refusedBeforeSending, refusedBeforeSending]);
  }, 60_000);

  test("STY-11: simple with allowReserved sends reserved characters but / ? # unencoded", async () => {
    const observed = await run("3.2.1", ["path-simple-r", ...reserved]);

    expect(observed).toEqual(sentTo("/path-simple-r/a:b@c%2Fd%3Fe%23f/x:y,z@w!$"));
  }, 60_000);

  test("STY-11: a simple item holding , is a usage error before any request", async () => {
    const observed = await run("3.2.1", ["path-simple-r", "c", "a,b"]);

    expect(observed).toEqual(refusedBeforeSending);
  }, 60_000);

  test("STY-12: exploded simple with allowReserved sends reserved characters but / ? # unencoded", async () => {
    const observed = await run("3.2.1", ["path-simple-x-r", ...reserved]);

    expect(observed).toEqual(sentTo("/path-simple-x-r/a:b@c%2Fd%3Fe%23f/x:y,z@w!$"));
  }, 60_000);

  test("STY-12: an exploded simple item holding , is a usage error before any request", async () => {
    const observed = await run("3.2.1", ["path-simple-x-r", "c", "a,b"]);

    expect(observed).toEqual(refusedBeforeSending);
  }, 60_000);
});

describe("STY query rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`STY-13: default form is color=blue and one pair per item; undefined sends no query (${line})`, async () => {
        const string = await run(line, ["query", "--color", "blue"]);
        const items = await run(line, ["query", ...array.flatMap((item) => ["--colors", item])]);
        const absent = await run(line, ["query"]);
        const encoded = await run(line, ["query", "--color", "a b/c&d=e+f"]);

        expect([string, items, absent, encoded]).toEqual([
          sentTo("/query?color=blue"),
          sentTo("/query?colors=blue&colors=black&colors=brown"),
          sentTo("/query"),
          sentTo("/query?color=a%20b%2Fc%26d%3De%2Bf"),
        ]);
      }, 60_000);

      test(`STY-14: form with explode false joins items with , and encodes a , inside an item (${line})`, async () => {
        const string = await run(line, ["query", "--flat", "blue"]);
        const items = await run(line, ["query", ...array.flatMap((item) => ["--flats", item])]);
        const comma = await run(line, ["query", "--flats", "a,b", "--flats", "c"]);

        expect([string, items, comma]).toEqual([
          sentTo("/query?flat=blue"),
          sentTo("/query?flats=blue,black,brown"),
          sentTo("/query?flats=a%2Cb,c"),
        ]);
      }, 60_000);

      test(`STY-15: form with allowReserved passes reserved characters but & = + # (${line})`, async () => {
        const string = await run(line, ["query", "--kept", "a/b?c:d@e[f]g!h$i,j;k*l(m)n"]);
        const delimiters = await run(line, ["query", "--kept", "a&b=c+d#e%41%zz"]);
        const items = await run(line, ["query", "--kepts", "a/b", "--kepts", "c&d"]);

        expect([string, delimiters, items]).toEqual([
          sentTo("/query?kept=a/b?c:d@e[f]g!h$i,j;k*l(m)n"),
          sentTo("/query?kept=a%26b%3Dc%2Bd%23e%41%25zz"),
          sentTo("/query?kepts=a/b&kepts=c%26d"),
        ]);
      }, 60_000);

      test(`STY-16: form with explode false and allowReserved joins items with , unencoded (${line})`, async () => {
        const observed = await run(line, ["query", "--joined", "a/b", "--joined", "c:d"]);

        expect(observed).toEqual(sentTo("/query?joined=a/b,c:d"));
      }, 60_000);

      test(`STY-16: a non-exploded allowReserved form item holding , is a usage error before any request (${line})`, async () => {
        const observed = await run(line, ["query", "--joined", "a,b", "--joined", "c"]);

        expect(observed).toEqual(refusedBeforeSending);
      }, 60_000);

      test(`STY-17: spaceDelimited joins items with %20 (${line})`, async () => {
        const items = await run(line, ["query", ...array.flatMap((item) => ["--spaced", item])]);
        const escaped = await run(line, ["query", "--spaced", "a%20b", "--spaced", "c"]);

        expect([items, escaped]).toEqual([
          sentTo("/query?spaced=blue%20black%20brown"),
          sentTo("/query?spaced=a%2520b%20c"),
        ]);
      }, 60_000);

      test(`STY-17: a spaceDelimited item holding a space is a usage error before any request (${line})`, async () => {
        const observed = await run(line, ["query", "--spaced", "a b", "--spaced", "c"]);

        expect(observed).toEqual(refusedBeforeSending);
      }, 60_000);

      test(`STY-19: spaceDelimited with allowReserved joins items with %20, reserved characters unencoded (${line})`, async () => {
        const observed = await run(line, ["query", "--spacedr", "a/b", "--spacedr", "c:d"]);

        expect(observed).toEqual(sentTo("/query?spacedr=a/b%20c:d"));
      }, 60_000);

      test(`STY-19: an allowReserved spaceDelimited item holding a space or %20 is a usage error before any request (${line})`, async () => {
        const space = await run(line, ["query", "--spacedr", "a b", "--spacedr", "c"]);
        const escaped = await run(line, ["query", "--spacedr", "a%20b", "--spacedr", "c"]);

        expect([space, escaped]).toEqual([refusedBeforeSending, refusedBeforeSending]);
      }, 60_000);

      test(`STY-21: pipeDelimited joins items with %7C (${line})`, async () => {
        const items = await run(line, ["query", ...array.flatMap((item) => ["--piped", item])]);
        const escaped = await run(line, ["query", "--piped", "a%7Cb", "--piped", "c"]);

        expect([items, escaped]).toEqual([
          sentTo("/query?piped=blue%7Cblack%7Cbrown"),
          sentTo("/query?piped=a%257Cb%7Cc"),
        ]);
      }, 60_000);

      test(`STY-21: a pipeDelimited item holding | is a usage error before any request (${line})`, async () => {
        const observed = await run(line, ["query", "--piped", "a|b", "--piped", "c"]);

        expect(observed).toEqual(refusedBeforeSending);
      }, 60_000);

      test(`STY-23: pipeDelimited with allowReserved joins items with %7C, reserved characters unencoded (${line})`, async () => {
        const observed = await run(line, ["query", "--pipedr", "a/b", "--pipedr", "c:d"]);

        expect(observed).toEqual(sentTo("/query?pipedr=a/b%7Cc:d"));
      }, 60_000);

      test(`STY-23: an allowReserved pipeDelimited item holding | or %7C is a usage error before any request (${line})`, async () => {
        const pipe = await run(line, ["query", "--pipedr", "a|b", "--pipedr", "c"]);
        const escaped = await run(line, ["query", "--pipedr", "a%7cb", "--pipedr", "c"]);

        expect([pipe, escaped]).toEqual([refusedBeforeSending, refusedBeforeSending]);
      }, 60_000);
    });
  }
});

describe("STY header rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`STY-31: a simple header is blue and blue,black,brown, never percent-encoded; undefined sends none (${line})`, async () => {
        const string = await run(line, ["headers", "--x-color", "a b/c%"]);
        const items = await run(line, [
          "headers",
          ...array.flatMap((item) => ["--x-colors", item]),
        ]);
        const absent = await run(line, ["headers"]);

        expect([string, items, absent]).toEqual([
          sentHeaders([["x-color", "a b/c%"]]),
          sentHeaders([["x-colors", "blue,black,brown"]]),
          sentHeaders([]),
        ]);
      }, 60_000);

      test(`STY-31: a header item holding , is a usage error before any request (${line})`, async () => {
        const observed = await run(line, ["headers", "--x-colors", "a,b", "--x-colors", "c"]);

        expect(observed).toEqual(refusedBeforeSending);
      }, 60_000);

      test(`STY-32: an exploded simple header is blue and blue,black,brown (${line})`, async () => {
        const string = await run(line, ["headers", "--x-color-x", "blue"]);
        const items = await run(line, [
          "headers",
          ...array.flatMap((item) => ["--x-colors-x", item]),
        ]);

        expect([string, items]).toEqual([
          sentHeaders([["x-color-x", "blue"]]),
          sentHeaders([["x-colors-x", "blue,black,brown"]]),
        ]);
      }, 60_000);

      test(`STY-32: an exploded header item holding , is a usage error before any request (${line})`, async () => {
        const observed = await run(line, ["headers", "--x-colors-x", "a,b", "--x-colors-x", "c"]);

        expect(observed).toEqual(refusedBeforeSending);
      }, 60_000);
    });
  }
});

describe("STY object vectors on the runtime serializer the package embeds", () => {
  const strict = { allowReserved: false, explode: false };
  const exploded = { allowReserved: false, explode: true };
  const query = { allowReserved: false, explode: true, required: false };

  test("STY-01: matrix of an object is ;color=R,100,G,200,B,150", async () => {
    expect(await expanded(Serialize.matrix("color", object, strict).expand)).toBe(
      ";color=R,100,G,200,B,150",
    );
  });

  test("STY-02: exploded matrix of an object is ;R=100;G=200;B=150", async () => {
    expect(await expanded(Serialize.matrix("color", object, exploded).expand)).toBe(
      ";R=100;G=200;B=150",
    );
  });

  test("STY-03: label of an object is .R,100,G,200,B,150", async () => {
    expect(await expanded(Serialize.label("color", object, strict).expand)).toBe(
      ".R,100,G,200,B,150",
    );
  });

  test("STY-04: exploded label of an object is .R=100.G=200.B=150; a member holding . is refused", async () => {
    expect([
      await expanded(Serialize.label("color", object, exploded).expand),
      await refusal(Serialize.label("color", { R: "1.5" }, exploded).expand),
    ]).toEqual([".R=100.G=200.B=150", usageError]);
  });

  test("STY-05: simple of an object is R,100,G,200,B,150", async () => {
    expect(await expanded(Serialize.simple("color", object, strict).expand)).toBe(
      "R,100,G,200,B,150",
    );
  });

  test("STY-06: exploded simple of an object is R=100,G=200,B=150", async () => {
    expect(await expanded(Serialize.simple("color", object, exploded).expand)).toBe(
      "R=100,G=200,B=150",
    );
  });

  test("STY-12: an exploded allowReserved simple object member holding = is refused", async () => {
    const options = { allowReserved: true, explode: true };

    expect([
      await refusal(Serialize.simple("color", { "R=": "1" }, options).expand),
      await refusal(Serialize.simple("color", { R: "1,2" }, options).expand),
    ]).toEqual([usageError, usageError]);
  });

  test("STY-13: form of an object is R=100&G=200&B=150", async () => {
    expect(await expanded(Serialize.form("color", object, query).expand)).toBe("R=100&G=200&B=150");
  });

  test("STY-14: non-exploded form of an object is color=R,100,G,200,B,150", async () => {
    expect(
      await expanded(Serialize.form("color", object, { ...query, explode: false }).expand),
    ).toBe("color=R,100,G,200,B,150");
  });

  test("STY-17: spaceDelimited of an object is color=R%20100%20G%20200%20B%20150", async () => {
    const options = { ...query, explode: false };

    expect(await expanded(Serialize.spaceDelimited("color", object, options).expand)).toBe(
      "color=R%20100%20G%20200%20B%20150",
    );
  });

  test("STY-21: pipeDelimited of an object is color=R%7C100%7CG%7C200%7CB%7C150", async () => {
    const options = { ...query, explode: false };

    expect(await expanded(Serialize.pipeDelimited("color", object, options).expand)).toBe(
      "color=R%7C100%7CG%7C200%7CB%7C150",
    );
  });

  const deep = "color%5BR%5D=100&color%5BG%5D=200&color%5BB%5D=150";

  test("STY-25: deepObject is color%5BR%5D=100&color%5BG%5D=200&color%5BB%5D=150", async () => {
    expect(await expanded(Serialize.deepObject("color", object, query).expand)).toBe(deep);
  });

  test("STY-26: deepObject with explode false sends what STY-25 sends", async () => {
    const options = { ...query, explode: false };

    expect(await expanded(Serialize.deepObject("color", object, options).expand)).toBe(deep);
  });

  test("STY-27: 3.2 deepObject sends the same bytes with explode true or false", async () => {
    expect([
      await expanded(Serialize.deepObject("color", object, query).expand),
      await expanded(Serialize.deepObject("color", object, { ...query, explode: false }).expand),
    ]).toEqual([deep, deep]);
  });

  const reservedMembers = Object.fromEntries([
    ["R", "a/b:c"],
    ["G", "d&e=f+g#h"],
  ]);

  const reservedDeep = "color%5BR%5D=a/b:c&color%5BG%5D=d%26e%3Df%2Bg%23h";

  test("STY-28: deepObject with allowReserved keeps the brackets encoded and passes reserved value characters", async () => {
    const options = { ...query, allowReserved: true };

    expect(await expanded(Serialize.deepObject("color", reservedMembers, options).expand)).toBe(
      reservedDeep,
    );
  });

  test("STY-29: deepObject with explode false and allowReserved sends what STY-28 sends", async () => {
    const options = { ...query, allowReserved: true, explode: false };

    expect(await expanded(Serialize.deepObject("color", reservedMembers, options).expand)).toBe(
      reservedDeep,
    );
  });

  test("STY-30: 3.2 deepObject with allowReserved sends the same bytes with explode true or false", async () => {
    const options = { ...query, allowReserved: true };

    expect([
      await expanded(Serialize.deepObject("color", reservedMembers, options).expand),
      await expanded(
        Serialize.deepObject("color", reservedMembers, { ...options, explode: false }).expand,
      ),
    ]).toEqual([reservedDeep, reservedDeep]);
  });

  test("STY-31: a simple header object is R,100,G,200,B,150 and a member holding , is refused", async () => {
    const options = { explode: false, required: false };

    expect([
      await expanded(Serialize.header("X-Color", object, options).expand),
      await refusal(Serialize.header("X-Color", { R: "1,2" }, options).expand),
    ]).toEqual(["R,100,G,200,B,150", usageError]);
  });

  test("STY-32: an exploded simple header object is R=100,G=200,B=150 and a member holding , is refused", async () => {
    const options = { explode: true, required: false };

    expect([
      await expanded(Serialize.header("X-Color", object, options).expand),
      await refusal(Serialize.header("X-Color", { R: "1,2" }, options).expand),
    ]).toEqual(["R=100,G=200,B=150", usageError]);
  });
});

describe("STY rows through generate()", () => {
  for (const line of lines) {
    test(`STY-18: spaceDelimited with explode true is refused (${line})`, async () => {
      const found = await inProcess(
        withParameters(line, [
          queryParameter(list, { allowReserved: false, explode: true, style: "spaceDelimited" }),
        ]),
      );

      expect(summary(found)).toEqual([
        ["STY-18/explode-not-applicable", "refusal", "element", parameterPointer],
      ]);
    }, 60_000);

    test(`STY-20: spaceDelimited with explode true and allowReserved is refused (${line})`, async () => {
      const found = await inProcess(
        withParameters(line, [
          queryParameter(list, { allowReserved: true, explode: true, style: "spaceDelimited" }),
        ]),
      );

      expect(summary(found)).toEqual([
        ["STY-20/explode-not-applicable", "refusal", "element", parameterPointer],
      ]);
    }, 60_000);

    test(`STY-22: pipeDelimited with explode true is refused (${line})`, async () => {
      const found = await inProcess(
        withParameters(line, [
          queryParameter(list, { allowReserved: false, explode: true, style: "pipeDelimited" }),
        ]),
      );

      expect(summary(found)).toEqual([
        ["STY-22/explode-not-applicable", "refusal", "element", parameterPointer],
      ]);
    }, 60_000);

    test(`STY-24: pipeDelimited with explode true and allowReserved is refused (${line})`, async () => {
      const found = await inProcess(
        withParameters(line, [
          queryParameter(list, { allowReserved: true, explode: true, style: "pipeDelimited" }),
        ]),
      );

      expect(summary(found)).toEqual([
        ["STY-24/explode-not-applicable", "refusal", "element", parameterPointer],
      ]);
    }, 60_000);
  }

  for (const line of ["3.0.4", "3.1.2"] as const) {
    test(`STY-25: deepObject with explode true generates with no notice (${line})`, async () => {
      const found = await inProcess(
        withParameters(line, [queryParameter(rgb, { explode: true, style: "deepObject" })]),
      );

      expect(summary(found)).toEqual([]);
    }, 60_000);

    test(`STY-26: deepObject with explode false or omitted generates with one notice each (${line})`, async () => {
      const omitted = await inProcess(
        withParameters(line, [queryParameter(rgb, { style: "deepObject" })]),
      );
      const explicit = await inProcess(
        withParameters(line, [queryParameter(rgb, { explode: false, style: "deepObject" })]),
      );

      const notice = [["STY-26/explode-no-effect", "notice", "element", parameterPointer]];
      expect([summary(omitted), summary(explicit)]).toEqual([notice, notice]);
    }, 60_000);

    test(`STY-28: deepObject with explode true and allowReserved generates with no notice (${line})`, async () => {
      const found = await inProcess(
        withParameters(line, [
          queryParameter(rgb, { allowReserved: true, explode: true, style: "deepObject" }),
        ]),
      );

      expect(summary(found)).toEqual([]);
    }, 60_000);

    test(`STY-29: deepObject with allowReserved and explode false or omitted generates with one notice each (${line})`, async () => {
      const omitted = await inProcess(
        withParameters(line, [queryParameter(rgb, { allowReserved: true, style: "deepObject" })]),
      );
      const explicit = await inProcess(
        withParameters(line, [
          queryParameter(rgb, { allowReserved: true, explode: false, style: "deepObject" }),
        ]),
      );

      const notice = [["STY-29/explode-no-effect", "notice", "element", parameterPointer]];
      expect([summary(omitted), summary(explicit)]).toEqual([notice, notice]);
    }, 60_000);
  }

  test("STY-27: 3.2 deepObject generates with no notice for explode true, false or omitted", async () => {
    const found = await Promise.all(
      [{ explode: true }, { explode: false }, {}].map((extra) =>
        inProcess(
          withParameters("3.2.1", [queryParameter(rgb, { ...extra, style: "deepObject" })]),
        ),
      ),
    );

    expect(found.map(summary)).toEqual([[], [], []]);
  }, 60_000);

  test("STY-30: 3.2 deepObject with allowReserved generates with no notice for explode true, false or omitted", async () => {
    const found = await Promise.all(
      [{ explode: true }, { explode: false }, {}].map((extra) =>
        inProcess(
          withParameters("3.2.1", [
            queryParameter(rgb, { ...extra, allowReserved: true, style: "deepObject" }),
          ]),
        ),
      ),
    );

    expect(found.map(summary)).toEqual([[], [], []]);
  }, 60_000);
});

// What the built CLI gets wrong. An object-schema parameter gets `Flag.String` or
// `Argument.String`, so the operator cannot give an object: in every line the probe sent the path
// text `R,100,G,200` under `simple` as `/objects/R%2C100%2CG%2C200`, `--qo R=100` under `form` as
// `qo=R%3D100` and `--x-o R,100` as the header text `R,100`, and `deepObject` refused both
// `--deep R=100` and `--deep '{"R":100}'` with exit 2 (it receives a string). The object vectors
// above pass on the runtime serializer, so each of these rows is partial.
describe("STY rows the product gets wrong", () => {
  test.todo("STY-01: object vector through the built CLI: an object-schema path parameter is a string positional (R,100,G,200 is sent as R%2C100%2CG%2C200) vs ;color=R,100,G,200,B,150", () =>
    Promise.resolve());

  test.todo("STY-02: object vector through the built CLI: an object-schema path parameter is a string positional (R,100,G,200 is sent as R%2C100%2CG%2C200) vs ;R=100;G=200;B=150", () =>
    Promise.resolve());

  test.todo("STY-03: object vector through the built CLI: an object-schema path parameter is a string positional (R,100,G,200 is sent as R%2C100%2CG%2C200) vs .R,100,G,200,B,150", () =>
    Promise.resolve());

  test.todo("STY-04: object vector through the built CLI: an object-schema path parameter is a string positional (R,100,G,200 is sent as R%2C100%2CG%2C200) vs .R=100.G=200.B=150", () =>
    Promise.resolve());

  test.todo("STY-05: object vector through the built CLI: an object-schema path parameter is a string positional (R,100,G,200 is sent as /objects/R%2C100%2CG%2C200) vs R,100,G,200,B,150", () =>
    Promise.resolve());

  test.todo("STY-06: object vector through the built CLI: an object-schema path parameter is a string positional (R,100,G,200 is sent as R%2C100%2CG%2C200) vs R=100,G=200,B=150", () =>
    Promise.resolve());

  test.todo("STY-13: object vector through the built CLI: an object-schema query parameter is a string flag (--qo R=100 is sent as qo=R%3D100) vs R=100&G=200&B=150", () =>
    Promise.resolve());

  test.todo("STY-14: object vector through the built CLI: an object-schema query parameter is a string flag (--qo R=100 is sent as qo=R%3D100) vs color=R,100,G,200,B,150", () =>
    Promise.resolve());

  test.todo("STY-17: object vector through the built CLI: an object-schema query parameter is a string flag (--qo R=100 is sent as qo=R%3D100) vs color=R%20100%20G%20200%20B%20150", () =>
    Promise.resolve());

  test.todo("STY-17: a spaceDelimited query parameter over a primitive schema generates with no diagnostic in every line vs refused at generation", () =>
    Promise.resolve());

  test.todo("STY-21: object vector through the built CLI: an object-schema query parameter is a string flag (--qo R=100 is sent as qo=R%3D100) vs color=R%7C100%7CG%7C200%7CB%7C150", () =>
    Promise.resolve());

  test.todo("STY-21: a pipeDelimited query parameter over a primitive schema generates with no diagnostic in every line vs refused at generation", () =>
    Promise.resolve());

  test.todo(`STY-25: through the built CLI the deepObject flag is a string flag: --deep R=100 and --deep '{"R":100}' exit 2 with no request vs color%5BR%5D=100&color%5BG%5D=200&color%5BB%5D=150`, () =>
    Promise.resolve());

  test.todo(`STY-26: through the built CLI the deepObject flag is a string flag: --deepn R=100 and --deepn '{"R":100}' exit 2 with no request vs the bytes STY-25 sends`, () =>
    Promise.resolve());

  test.todo(`STY-27: through the built CLI the deepObject flag is a string flag: --deep R=100 and --deep '{"R":100}' exit 2 with no request vs one byte-identical query for explode true, false and omitted`, () =>
    Promise.resolve());

  test.todo(`STY-28: through the built CLI the deepObject flag is a string flag: --deepr R=100 and --deepr '{"R":100}' exit 2 with no request vs color%5BR%5D=a/b:c with reserved value characters unencoded`, () =>
    Promise.resolve());

  test.todo(`STY-29: through the built CLI the deepObject flag is a string flag: --deepnr R=100 and --deepnr '{"R":100}' exit 2 with no request vs the bytes STY-28 sends`, () =>
    Promise.resolve());

  test.todo(`STY-30: through the built CLI the deepObject flag is a string flag: --deepr R=100 and --deepr '{"R":100}' exit 2 with no request vs one byte-identical query for explode true, false and omitted`, () =>
    Promise.resolve());

  test.todo("STY-31: object vector through the built CLI: an object-schema header parameter is a string flag (--x-o R,100 is sent as the text R,100, unsplit and unchecked) vs an object serialized R,100,G,200,B,150 with a member holding , refused", () =>
    Promise.resolve());

  test.todo("STY-32: object vector through the built CLI: an object-schema header parameter is a string flag (--x-o R,100 is sent as the text R,100, unsplit and unchecked) vs an object serialized R=100,G=200,B=150 with a member holding , refused", () =>
    Promise.resolve());
});
