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

// The Milestone 2 witness for the cookie, querystring and style-rule rows (STY-33 to STY-45): one
// generated package per version line, built once, run against the capture server; the refusal rows
// call `generate()` in process. A row the product gets wrong is a `test.todo` with what was
// observed.

const fixtures = nodePath.resolve(
  import.meta.dir,
  "../../corpus/fixtures/rows/sty-cookie-querystring",
);

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layerDigest);

const work = nodeFs.mkdtempSync(nodePath.join(tmpdir(), "wt-sty2-"));

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
  readonly cookies: readonly string[];
  readonly target: string;
}

interface Exchange {
  readonly exitCode: number | null;
  readonly sent: readonly Sent[];
}

const cookiesOf = (headers: HeaderList): readonly string[] =>
  headers.flatMap(([name, value]) => (name.toLowerCase() === "cookie" ? [value] : []));

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
  if (result.exitCode !== 0 && result.exitCode !== 2) {
    throw new Error(`unexpected exit ${String(result.exitCode)}: ${latin1(result.stderr)}`);
  }

  return {
    exitCode: result.exitCode,
    sent: capture
      .requests()
      .slice(before)
      .map((request) => ({ cookies: cookiesOf(request.headers), target: request.target })),
  };
};

const refusedBeforeSending = { exitCode: 2, sent: [] };

// In process generation of a small document of a line; the diagnostics of a refused run are the
// refusal's.
const members = (line: Line, extra: Members): Members => ({
  info: { title: "Cookie and querystring rows", version: "1.0.0" },
  openapi: line,
  ...extra,
});

const ok: Members = { "200": { description: "ok" } };

const text: Members = { type: "string" };

const list: Members = { items: text, type: "array" };

const withParameters = (line: Line, parameters: readonly Json[]): Members =>
  members(line, { paths: { "/a": { get: { parameters, responses: ok } } } });

const jsonContent: Members = { "application/json": { schema: text } };

const querystringParameter = (name: string, extra: Members = {}): Members => ({
  content: jsonContent,
  in: "querystring",
  name,
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

// A refusal by the line's official schema, which runs before the STY rule: its code is the schema
// row of the line (VAL-02, VAL-03 or VAL-04), so only severity, scope and pointer are stable here.
const schemaRefusals = (found: Generated) =>
  found.diagnostics.map((diagnostic) => [
    diagnostic.severity,
    diagnostic.scope,
    String(diagnostic.pointer),
  ]);

const parameterPointer = "/paths/~1a/get/parameters/0";

describe("STY cookie rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`STY-33: a form cookie is name=value, RFC 6570 encoded, with no ? prefix (${line})`, async () => {
        const observed = await run(line, ["cookies-get", "--session", "a b/c"]);

        expect(observed).toEqual({
          exitCode: 0,
          sent: [{ cookies: ["session=a%20b%2Fc"], target: "/cookies" }],
        });
      }, 60_000);

      test(`STY-33: an absent optional cookie sends no Cookie header (${line})`, async () => {
        const observed = await run(line, ["cookies-get"]);

        expect(observed).toEqual({ exitCode: 0, sent: [{ cookies: [], target: "/cookies" }] });
      }, 60_000);

      test(`STY-33: the cookie parameter and the apiKey cookie share one Cookie header (${line})`, async () => {
        const observed = await run(line, ["auth-cookies-get", "--session", "s1"], {
          STYCQ_COOKIE_KEY: "k-secret",
        });

        expect(observed).toEqual({
          exitCode: 0,
          sent: [{ cookies: ["session=s1; token=k-secret"], target: "/auth-cookies" }],
        });
      }, 60_000);

      test(`STY-41: the query gets exactly one ?, and a cookie carries no prefix (${line})`, async () => {
        const query = await run(line, ["search-get", "--q", "x y"]);
        const none = await run(line, ["search-get"]);
        const cookie = await run(line, ["cookies-get", "--session", "v"]);

        expect([query.sent, none.sent, cookie.sent]).toEqual([
          [{ cookies: [], target: "/search?q=x%20y" }],
          [{ cookies: [], target: "/search" }],
          [{ cookies: ["session=v"], target: "/cookies" }],
        ]);
      }, 60_000);
    });
  }

  for (const line of ["3.0.4", "3.1.2"] as const) {
    test(`STY-34: an explode false form cookie over a primitive is name=value, after the explode true one (${line})`, async () => {
      const observed = await run(line, ["cookies-get", "--session", "s", "--theme", "dark mode"]);

      expect(observed).toEqual({
        exitCode: 0,
        sent: [{ cookies: ["session=s; theme=dark%20mode"], target: "/cookies" }],
      });
    }, 60_000);
  }

  test("STY-36: a 3.2 form cookie with allowReserved passes reserved characters but ; and space", async () => {
    const reserved = await run("3.2.1", ["cookies-get", "--reserved", "a/b:c;d e"]);
    const strict = await run("3.2.1", ["cookies-get", "--session", "a/b:c"]);

    expect([reserved.sent, strict.sent]).toEqual([
      [{ cookies: ["reserved=a/b:c%3Bd%20e"], target: "/cookies" }],
      [{ cookies: ["session=a%2Fb%3Ac"], target: "/cookies" }],
    ]);
  }, 60_000);

  test("STY-38: a 3.2 cookie-style value passes unencoded; an array repeats the name", async () => {
    const string = await run("3.2.1", ["cookies-get", "--prefs", "a/b%2C"]);
    const array = await run("3.2.1", ["cookies-get", "--tags", "blue", "--tags", "black"]);
    const all = await run("3.2.1", [
      "cookies-get",
      "--session",
      "s",
      "--prefs",
      "p",
      "--tags",
      "t",
    ]);

    expect([string.sent, array.sent, all.sent]).toEqual([
      [{ cookies: ["prefs=a/b%2C"], target: "/cookies" }],
      [{ cookies: ["tags=blue; tags=black"], target: "/cookies" }],
      [{ cookies: ["session=s; prefs=p; tags=t"], target: "/cookies" }],
    ]);
  }, 60_000);

  test("STY-38: a cookie-style value outside cookie-octet is a usage error before any request", async () => {
    const space = await run("3.2.1", ["cookies-get", "--prefs", "a b"]);
    const semicolon = await run("3.2.1", ["cookies-get", "--prefs", "a;b"]);
    const quote = await run("3.2.1", ["cookies-get", "--tags", 'x"y']);

    expect([space, semicolon, quote]).toEqual([
      refusedBeforeSending,
      refusedBeforeSending,
      refusedBeforeSending,
    ]);
  }, 60_000);
});

describe("STY querystring rows through the built CLI", () => {
  test("STY-42: the querystring value is the entire query, and an absent one adds no ?", async () => {
    const given = await run("3.2.1", ["qs-json-get", "--selector", '{"color":"red"}']);
    const absent = await run("3.2.1", ["qs-json-get"]);

    expect([given.sent, absent.sent]).toEqual([
      [{ cookies: [], target: "/qs-json?%7B%22color%22%3A%22red%22%7D" }],
      [{ cookies: [], target: "/qs-json" }],
    ]);
  }, 60_000);

  test("STY-43: form-urlencoded querystring content is form encoded once", async () => {
    const observed = await run("3.2.1", [
      "qs-form-get",
      "--filter",
      '{"color":"dark blue&red","size":3}',
    ]);

    expect(observed).toEqual({
      exitCode: 0,
      sent: [{ cookies: [], target: "/qs-form?color=dark+blue%26red&size=3" }],
    });
  }, 60_000);

  test("STY-43: JSON querystring content is serialized compact, then percent-encoded whole", async () => {
    const observed = await run("3.2.1", [
      "qs-json-get",
      "--selector",
      '{ "color": "a b", "size": 3 }',
    ]);

    expect(observed).toEqual({
      exitCode: 0,
      sent: [
        {
          cookies: [],
          target: "/qs-json?%7B%22color%22%3A%22a%20b%22%2C%22size%22%3A3%7D",
        },
      ],
    });
  }, 60_000);
});

describe("STY rows through generate()", () => {
  for (const line of lines) {
    test(`STY-33: a form cookie over an array is refused, exploded or not (PRM-34) (${line})`, async () => {
      const exploded = await inProcess(
        withParameters(line, [{ in: "cookie", name: "c", schema: list }]),
      );

      expect(summary(exploded)).toEqual([
        ["PRM-34/cookie-form-multiple", "refusal", "element", parameterPointer],
      ]);
    }, 60_000);

    test(`STY-40: style matrix on a query parameter is refused (${line})`, async () => {
      const found = await inProcess(
        withParameters(line, [{ in: "query", name: "q", schema: text, style: "matrix" }]),
      );

      // The official schema of every line refuses the style before the STY rule runs; 3.0's
      // schema also reports the `in` its parameter variants could not match.
      expect(schemaRefusals(found)).toContainEqual([
        "refusal",
        "document",
        `${parameterPointer}/style`,
      ]);
      expect(found.diagnostics.every((diagnostic) => diagnostic.severity === "refusal")).toBe(true);
    }, 60_000);
  }

  for (const line of ["3.0.4", "3.1.2"] as const) {
    test(`STY-34: an explode false form cookie over a primitive generates; over an array it is refused (${line})`, async () => {
      const primitive = await inProcess(
        withParameters(line, [{ explode: false, in: "cookie", name: "c", schema: text }]),
      );
      const array = await inProcess(
        withParameters(line, [{ explode: false, in: "cookie", name: "c", schema: list }]),
      );

      expect([summary(primitive), summary(array)]).toEqual([
        [],
        [["PRM-34/cookie-form-multiple", "refusal", "element", parameterPointer]],
      ]);
    }, 60_000);
  }

  test("STY-35: a 3.2 explode false form cookie is refused, over an array by its STY row alone", async () => {
    const primitive = await inProcess(
      withParameters("3.2.1", [{ explode: false, in: "cookie", name: "c", schema: text }]),
    );
    const array = await inProcess(
      withParameters("3.2.1", [{ explode: false, in: "cookie", name: "c", schema: list }]),
    );

    expect([summary(primitive), summary(array)]).toEqual([
      [["STY-35/cookie-explode-false", "refusal", "element", parameterPointer]],
      [["STY-35/cookie-explode-false", "refusal", "element", parameterPointer]],
    ]);
  }, 60_000);

  test("STY-37: a 3.2 explode false form cookie with allowReserved is refused", async () => {
    const found = await inProcess(
      withParameters("3.2.1", [
        { allowReserved: true, explode: false, in: "cookie", name: "c", schema: text },
      ]),
    );

    expect(summary(found)).toEqual([
      ["STY-37/cookie-explode-false", "refusal", "element", parameterPointer],
    ]);
  }, 60_000);

  test("STY-39: a 3.2 explode false cookie-style cookie is refused", async () => {
    const found = await inProcess(
      withParameters("3.2.1", [
        { explode: false, in: "cookie", name: "c", schema: text, style: "cookie" },
      ]),
    );

    expect(summary(found)).toEqual([
      ["STY-39/cookie-explode-false", "refusal", "element", parameterPointer],
    ]);
  }, 60_000);

  test("STY-44: querystring with query, or twice, across the Path Item, the Operation and $ref is refused", async () => {
    const pathItemQuery = await inProcess(
      members("3.2.1", {
        paths: {
          "/a": {
            get: { parameters: [querystringParameter("a")], responses: ok },
            parameters: [{ in: "query", name: "q", schema: text }],
          },
        },
      }),
    );
    const pathItemQuerystring = await inProcess(
      members("3.2.1", {
        paths: {
          "/a": {
            get: { parameters: [{ in: "query", name: "q", schema: text }], responses: ok },
            parameters: [querystringParameter("a")],
          },
        },
      }),
    );
    const split = await inProcess(
      members("3.2.1", {
        paths: {
          "/a": {
            get: { parameters: [querystringParameter("b")], responses: ok },
            parameters: [querystringParameter("a")],
          },
        },
      }),
    );
    const throughRef = await inProcess(
      members("3.2.1", {
        components: { parameters: { qs: querystringParameter("a") } },
        paths: {
          "/a": {
            get: {
              parameters: [{ $ref: "#/components/parameters/qs" }, querystringParameter("b")],
              responses: ok,
            },
          },
        },
      }),
    );

    const conflict = [["STY-44/querystring-conflict", "refusal", "operation", "/paths/~1a/get"]];
    expect([
      summary(pathItemQuery),
      summary(pathItemQuerystring),
      summary(split),
      summary(throughRef),
    ]).toEqual([conflict, conflict, conflict, conflict]);
  }, 60_000);

  test("STY-44: two querystring parameters in one list are refused", async () => {
    const found = await inProcess(
      withParameters("3.2.1", [querystringParameter("a"), querystringParameter("b")]),
    );

    // The 3.2 schema's `contains` bound refuses the list before the STY rule runs.
    expect(schemaRefusals(found)).toEqual([["refusal", "document", "/paths/~1a/get/parameters"]]);
  }, 60_000);

  test("STY-45: a querystring parameter with schema, style, explode or allowReserved is refused", async () => {
    const schema = await inProcess(
      withParameters("3.2.1", [{ in: "querystring", name: "a", schema: text }]),
    );
    const fields = await Promise.all(
      (
        [
          ["style", "form"],
          ["explode", true],
          ["allowReserved", true],
        ] as const
      ).map(async ([field, value]) => {
        const found = await inProcess(
          withParameters("3.2.1", [querystringParameter("a", { [field]: value })]),
        );

        return schemaRefusals(found);
      }),
    );

    // The 3.2 schema refuses each before the STY rule runs.
    expect([schemaRefusals(schema), ...fields]).toEqual([
      [["refusal", "document", parameterPointer]],
      [["refusal", "document", `${parameterPointer}/style`]],
      [["refusal", "document", `${parameterPointer}/explode`]],
      [["refusal", "document", `${parameterPointer}/allowReserved`]],
    ]);
  }, 60_000);
});
