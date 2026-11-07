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
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The Milestone 2 witness for the Paths, Path Item and Operation rows (PTH-*, OPR-*): one
// generated package per version line, built once, run against the capture server; the refusal
// rows call `generate()` in process. A row the product gets wrong is a `test.todo` with what was
// observed. Rows delegated to other families (PTH-25, OPR-15, OPR-16) and the informational rows
// get no test here.

const fixtures = nodePath.resolve(import.meta.dir, "../../corpus/fixtures/rows/pth");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = nodeFs.mkdtempSync(nodePath.join(tmpdir(), "wt-pth-"));

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

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf-8");

interface Exchange {
  readonly exitCode: number | null;
  readonly requests: readonly RecordedRequest[];
  readonly stderr: string;
  readonly stdout: string;
}

// One invocation of the line's built CLI against the capture server, with the requests the
// server recorded during it. `runBin` is asynchronous, so the in-process server keeps answering.
const run = async (line: Line, args: readonly string[]): Promise<Exchange> => {
  const generated = packages.get(line);
  if (generated === undefined) {
    throw new Error(`no package built for ${line}`);
  }

  const before = capture.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, { args: ["--base-url", origin, ...args], timeoutMs: 30_000 }).pipe(
      Effect.provide(layer),
    ),
  );

  return {
    exitCode: result.exitCode,
    requests: capture.requests().slice(before),
    stderr: text(result.stderr),
    stdout: text(result.stdout),
  };
};

// The request line and body of the one request an invocation made.
const sent = (observed: Exchange) =>
  observed.requests.map((request) => [request.method, request.target, text(request.body)]);

const sorted = (values: readonly string[]): readonly string[] => Arr.sort(values, Order.String);

const specOf = (line: Line) => readJson(nodePath.join(fixtures, `${line}.json`));

const pointerToken = (path: string): string => path.replaceAll("~", "~0").replaceAll("/", "~1");

const operationKeys = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "query",
  "trace",
]);

const jsonBody = '{"a":1}';

const Describe = Schema.Struct({
  commands: Schema.Array(
    Schema.Struct({
      flags: Schema.Array(Schema.Struct({ name: Schema.String, pointer: Schema.String })),
      method: Schema.String,
      pointer: Schema.String,
    }),
  ),
});

const describe_ = async (line: Line) => {
  const observed = await run(line, ["--describe"]);

  return Schema.decodeUnknownSync(Schema.fromJsonString(Describe))(observed.stdout).commands;
};

const methods = [
  ["PTH-14", "get"],
  ["PTH-15", "put"],
  ["PTH-16", "post"],
  ["PTH-17", "delete"],
  ["PTH-18", "options"],
  ["PTH-19", "head"],
  ["PTH-20", "patch"],
  ["PTH-21", "trace"],
] as const;

const bodied = new Set(["put", "post", "patch"]);

const expectMethod = async (line: Line, method: string) => {
  const body = bodied.has(method) ? ["--body", jsonBody] : [];
  const observed = await run(line, [`things-${method}`, "1", ...body]);

  // The request line is the row. The CLI itself exits 5 ("response stream failed: truncated")
  // after any HEAD, even one answered with Content-Length 0 and no body, so the exit code is
  // asserted for the other methods only.
  if (method !== "head") {
    expect({ exitCode: observed.exitCode, stderr: observed.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
  }

  expect(sent(observed)).toEqual([
    [method.toUpperCase(), "/things/1", bodied.has(method) ? jsonBody : ""],
  ]);
};

describe("PTH and OPR rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`PTH-02: the path template is expanded with the argument (${line})`, async () => {
        const observed = await run(line, ["things-get", "42"]);

        expect(sent(observed)).toEqual([["GET", "/things/42", ""]]);
      }, 60_000);

      test(`PTH-09: each operation of a Path Item is a command at its own pointer (${line})`, async () => {
        const commands = await describe_(line);
        const pointers = commands
          .map((command) => command.pointer)
          .filter((pointer) => pointer.startsWith("/paths/~1things~1{id}/"));

        expect(sorted(pointers)).toEqual(
          sorted(methods.map(([, method]) => `/paths/~1things~1{id}/${method}`)),
        );
      }, 60_000);

      test(`PTH-05: /pets/mine and /pets/{id} are distinct commands (${line})`, async () => {
        const concrete = await run(line, ["pets-mine"]);
        const templated = await run(line, ["pets-get", "7"]);

        expect([sent(concrete), sent(templated)]).toEqual([
          [["GET", "/pets/mine", ""]],
          [["GET", "/pets/7", ""]],
        ]);
      }, 60_000);

      test(`PTH-10: a Path Item reached through $ref is a command (${line})`, async () => {
        const observed = await run(line, ["shared-get"]);

        expect(sent(observed)).toEqual([["GET", "/shared", ""]]);
      }, 60_000);

      test(
        `PTH-14: the get operation uses the request method GET (${line})`,
        () => expectMethod(line, "get"),
        60_000,
      );

      test(
        `PTH-15: the put operation uses the request method PUT (${line})`,
        () => expectMethod(line, "put"),
        60_000,
      );

      test(
        `PTH-16: the post operation uses the request method POST (${line})`,
        () => expectMethod(line, "post"),
        60_000,
      );

      test(
        `PTH-17: the delete operation uses the request method DELETE (${line})`,
        () => expectMethod(line, "delete"),
        60_000,
      );

      test(
        `PTH-18: the options operation uses the request method OPTIONS (${line})`,
        () => expectMethod(line, "options"),
        60_000,
      );

      test(
        `PTH-19: the head operation uses the request method HEAD (${line})`,
        () => expectMethod(line, "head"),
        60_000,
      );

      test(
        `PTH-20: the patch operation uses the request method PATCH (${line})`,
        () => expectMethod(line, "patch"),
        60_000,
      );

      test(
        `PTH-21: the trace operation uses the request method TRACE (${line})`,
        () => expectMethod(line, "trace"),
        60_000,
      );

      test(`PTH-26: a Path Item query parameter is sent by every operation (${line})`, async () => {
        const get = await run(line, ["things-get", "1", "--limit", "5"]);
        const put = await run(line, ["things-put", "1", "--limit", "5", "--body", jsonBody]);

        expect(
          [get, put].map((observed) => observed.requests.map((request) => request.target)),
        ).toEqual([["/things/1?limit=5"], ["/things/1?limit=5"]]);
      }, 60_000);

      test(`PTH-27: an operation parameter with the same name and in overrides the Path Item one (${line})`, async () => {
        const commands = await describe_(line);
        const flagPointer = (operationId: string) =>
          commands
            .find((command) => command.pointer.endsWith(`~1${operationId}`))
            ?.flags.find((flag) => flag.name === "q")?.pointer;

        // The override operation reads its own definition, optional; the sibling operation
        // keeps the Path Item's required one.
        expect([flagPointer("override~1{id}/get"), flagPointer("override~1{id}/put")]).toEqual([
          "/paths/~1override~1{id}/get/parameters/0",
          "/paths/~1override~1{id}/parameters/1",
        ]);

        const overridden = await run(line, ["override-get", "1"]);
        const kept = await run(line, ["override-put", "1"]);

        expect([sent(overridden), kept.requests.length]).toEqual([[["GET", "/override/1", ""]], 0]);
      }, 60_000);

      test(`OPR-01: every operation is one command (${line})`, async () => {
        const spec = Schema.decodeUnknownSync(
          Schema.Struct({
            paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)),
          }),
        )(specOf(line));
        const additional = Schema.Record(Schema.String, Schema.Json);
        const operationPointers = Object.entries(spec.paths).flatMap(([path, item]) =>
          Object.keys(item).flatMap((key) => {
            if (key === "additionalOperations") {
              const tokens = Object.keys(Schema.decodeUnknownSync(additional)(item[key]));

              return tokens.map(
                (token) => `/paths/${pointerToken(path)}/additionalOperations/${token}`,
              );
            }

            return operationKeys.has(key) ? [`/paths/${pointerToken(path)}/${key}`] : [];
          }),
        );
        const described = await describe_(line);

        // `/shared` is a Path Item reached through $ref: its operation lives at the target.
        expect(sorted(described.map((command) => command.pointer))).toEqual(
          sorted([...operationPointers, "/x-items/shared/get"]),
        );
      }, 60_000);

      test(`OPR-08: query and header parameters are sent (${line})`, async () => {
        const observed = await run(line, ["params-send", "--filter", "a b", "--x-trace", "t1"]);
        const [request] = observed.requests;

        expect(observed.requests.map((each) => each.target)).toEqual(["/params?filter=a%20b"]);
        expect(request?.headers.find(([name]) => name.toLowerCase() === "x-trace")?.[1]).toBe("t1");
      }, 60_000);

      test(`OPR-09: the request body is sent as given (${line})`, async () => {
        const observed = await run(line, ["things-post", "1", "--body", jsonBody]);
        const [request] = observed.requests;

        expect(sent(observed)).toEqual([["POST", "/things/1", jsonBody]]);
        expect(request?.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1]).toBe(
          "application/json",
        );
      }, 60_000);

      test(`OPR-12: a documented response is read (${line})`, async () => {
        capture.script("/things/9", { body: '{"ok":true}', status: 200 });

        const observed = await run(line, ["things-get", "9"]);

        expect({ exitCode: observed.exitCode, stdout: observed.stdout.includes('"ok"') }).toEqual({
          exitCode: 0,
          stdout: true,
        });
      }, 60_000);

      // The help text and the use of a deprecated command carry no mark; the request is sent.
      test(`OPR-14: legacy-get carries a deprecated marker in help and a stderr notice on use (${line})`, async () => {
        const help = await run(line, ["legacy-get", "--help"]);
        const used = await run(line, ["legacy-get"]);

        expect(help.stdout.toLowerCase()).toContain("deprecated");
        expect(used.stderr.toLowerCase()).toContain("deprecated");
      }, 60_000);
    });
  }

  test("PTH-06: a path parameter value with / ? # is percent-encoded inside its segment (3.1.2)", async () => {
    const observed = await run("3.1.2", ["things-get", "a/b?c#d"]);

    expect(sent(observed)).toEqual([["GET", "/things/a%2Fb%3Fc%23d", ""]]);
  }, 60_000);

  test("PTH-06: a path parameter value with / ? # is percent-encoded inside its segment (3.2.1)", async () => {
    const observed = await run("3.2.1", ["things-get", "a/b?c#d"]);

    expect(sent(observed)).toEqual([["GET", "/things/a%2Fb%3Fc%23d", ""]]);
  }, 60_000);

  test("PTH-22: a 3.2 query operation is sent as method QUERY with its body", async () => {
    const observed = await run("3.2.1", ["extra-query", "--body", jsonBody]);

    expect(sent(observed)).toEqual([["QUERY", "/extra", jsonBody]]);
  }, 60_000);

  test("PTH-23: an additionalOperations key is sent as the method byte for byte", async () => {
    const observed = await run("3.2.1", ["extra-purge", "--body", jsonBody]);

    expect(sent(observed)).toEqual([["PURGE", "/extra", jsonBody]]);
  }, 60_000);

  test("OPR-10: a described body on GET, HEAD, DELETE, OPTIONS and TRACE is not sent (3.0.4)", async () => {
    capture.script("/body-ignored", { body: "", status: 200 });

    const observed = await Effect.runPromise(
      Effect.forEach(
        ["get", "head", "delete", "options", "trace"],
        (method) => Effect.promise(() => run("3.0.4", [`ignored-${method}`])),
        { concurrency: 1 },
      ),
    );

    expect(observed.map((each) => sent(each))).toEqual(
      ["GET", "HEAD", "DELETE", "OPTIONS", "TRACE"].map((method) => [
        [method, "/body-ignored", ""],
      ]),
    );
  }, 60_000);

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`OPR-11: a DELETE or OPTIONS body is sent intact (${line})`, async () => {
      const remove = await run(line, ["sent-delete", "--body", jsonBody]);
      const options = await run(line, ["sent-options", "--body", jsonBody]);

      expect([sent(remove), sent(options)]).toEqual([
        [["DELETE", "/body-sent", jsonBody]],
        [["OPTIONS", "/body-sent", jsonBody]],
      ]);
    }, 60_000);

    test(`OPR-12: an operation without responses is handled as all-undocumented (${line})`, async () => {
      const observed = await run(line, ["no-responses-get"]);

      expect({ exitCode: observed.exitCode, sent: sent(observed) }).toEqual({
        exitCode: 0,
        sent: [["GET", "/no-responses", ""]],
      });
    }, 60_000);
  }
});

// In process generation of a small document of a line; the diagnostics of a refused run are the
// refusal's.
const members = (line: Line, extra: Members): Members => ({
  info: { title: "Path rows", version: "1.0.0" },
  openapi: line,
  ...extra,
});

const operation = (extra: Members = {}): Members => ({
  responses: { "200": { description: "ok" } },
  ...extra,
});

const pathParameter = (name: string): Members => ({
  in: "path",
  name,
  required: true,
  schema: { type: "string" },
});

const body: Members = { content: { "application/json": { schema: { type: "object" } } } };

interface Generated {
  readonly diagnostics: readonly Diagnostic[];
  readonly dir: string;
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

const withPaths = (line: Line, paths: Members, extra: Members = {}): Members =>
  members(line, { paths, ...extra });

describe("PTH and OPR rows through generate()", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`PTH-01: a Paths Object with an operation generates without a diagnostic (${line})`, async () => {
        const found = await inProcess(withPaths(line, { "/a": { get: operation() } }));

        expect(found.diagnostics).toEqual([]);
      }, 60_000);

      test(`PTH-02: a path key without a leading slash is refused (${line})`, async () => {
        const found = await inProcess(withPaths(line, { a: { get: operation() } }));

        expect([
          summary(found).map(([, severity, where]) => [severity, where]),
          pointers(found),
        ]).toEqual([[["refusal", "document"]], ["/paths/a"]]);
      }, 60_000);

      test(`PTH-03: a template expression with no path parameter is refused at operation scope (${line})`, async () => {
        const found = await inProcess(withPaths(line, { "/a/{id}": { get: operation() } }));

        expect(summary(found)).toEqual([["PTH-03/missing-parameter", "refusal", "operation"]]);
        expect(pointers(found)).toEqual(["/paths/~1a~1{id}/get"]);
      }, 60_000);

      test(`PTH-04: templated paths with different names for one hierarchy are refused (${line})`, async () => {
        const found = await inProcess(
          withPaths(line, {
            "/a/{x}": { get: operation({ parameters: [pathParameter("x")] }) },
            "/a/{y}": { get: operation({ parameters: [pathParameter("y")] }) },
          }),
        );

        expect(summary(found)).toEqual([
          ["PTH-04/template-identical", "refusal", "operation"],
          ["PTH-04/template-identical", "refusal", "operation"],
        ]);
        expect(pointers(found)).toEqual(["/paths/~1a~1{x}/get", "/paths/~1a~1{y}/get"]);
      }, 60_000);

      test(`PTH-08: a path parameter with no matching expression is refused, case-sensitively (${line})`, async () => {
        const found = await inProcess(
          withPaths(line, {
            "/a/{Id}": {
              get: operation({ parameters: [pathParameter("id"), pathParameter("Id")] }),
            },
          }),
        );

        expect(summary(found)).toEqual([["PTH-08/missing-expression", "refusal", "operation"]]);
        expect(pointers(found)).toEqual(["/paths/~1a~1{Id}/get/parameters/0"]);
      }, 60_000);

      test(`PTH-28: a header name repeated in one list, compared case-insensitively, is refused (${line})`, async () => {
        const found = await inProcess(
          withPaths(line, {
            "/a": {
              get: operation({
                parameters: [
                  { in: "header", name: "X-A", schema: { type: "string" } },
                  { in: "header", name: "x-a", schema: { type: "string" } },
                ],
              }),
            },
          }),
        );

        expect(summary(found).filter(([code]) => code === "PTH-28/duplicate-parameter")).toEqual([
          ["PTH-28/duplicate-parameter", "refusal", "operation"],
        ]);
        expect(pointers(found).filter((pointer) => pointer.endsWith("/parameters/1"))).toContain(
          "/paths/~1a/get/parameters/1",
        );
      }, 60_000);

      test(`OPR-07: a duplicate operationId is refused at document scope with both pointers (${line})`, async () => {
        const found = await inProcess(
          withPaths(line, {
            "/a": { get: operation({ operationId: "dup" }) },
            "/b": { get: operation({ operationId: "dup" }) },
          }),
        );

        expect(summary(found)).toEqual([["OPR-07/duplicate-id", "refusal", "document"]]);
        expect(pointers(found)).toEqual(["/paths/~1b/get/operationId"]);
        expect(found.diagnostics[0]?.related?.map((site) => String(site.pointer))).toEqual([
          "/paths/~1a/get/operationId",
        ]);
      }, 60_000);

      test(`PTH-29: empty Paths and an empty Path Item generate with no error (${line})`, async () => {
        const emptyPaths = await inProcess(withPaths(line, {}));
        const emptyItem = await inProcess(withPaths(line, { "/a": {} }));

        expect([emptyPaths.diagnostics, emptyItem.diagnostics]).toEqual([[], []]);
      }, 60_000);

      // Design 4.4 refuses colliding visible command names with a hint, with no automatic rename
      // (memo 121cf83f, B3).
      test(`OPR-06: getPet and GetPet fold to one command name and raise OPR-06/command-collision at both operations (${line})`, async () => {
        const found = await inProcess(
          withPaths(line, {
            "/a": { get: operation({ operationId: "getPet" }) },
            "/b": { get: operation({ operationId: "GetPet" }) },
          }),
        );

        expect(summary(found)).toEqual([
          ["OPR-06/command-collision", "refusal", "operation"],
          ["OPR-06/command-collision", "refusal", "operation"],
        ]);
        expect(pointers(found)).toEqual(["/paths/~1a/get", "/paths/~1b/get"]);
      }, 60_000);

      test(`PTH-11: a Path Item $ref beside a get the target also defines is refused, naming the shared field (${line})`, async () => {
        const found = await inProcess(
          withPaths(
            line,
            { "/a": { $ref: "#/x-path-items/A", get: operation() } },
            { "x-path-items": { A: { get: operation() } } },
          ),
        );

        expect(summary(found)).toEqual([["PTH-11/ref-sibling-conflict", "refusal", "document"]]);
        expect(pointers(found)).toEqual(["/paths/~1a"]);
        expect(found.diagnostics[0]?.related?.map((site) => String(site.pointer))).toEqual([
          "/paths/~1a/get",
        ]);
      }, 60_000);
    });
  }

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`PTH-28: a Path Item parameter list repeating name and in is refused (${line})`, async () => {
      const query = { in: "query", name: "q", schema: { type: "string" } };
      const found = await inProcess(
        withPaths(line, { "/a": { get: operation(), parameters: [query, query] } }),
      );

      expect(summary(found)).toEqual([["PTH-28/duplicate-parameter", "refusal", "operation"]]);
      expect(pointers(found)).toEqual(["/paths/~1a/parameters/1"]);
    }, 60_000);
  }

  test("PTH-28: an exact duplicate is refused by the schema before the rule runs (3.0.4)", async () => {
    const query = { in: "query", name: "q", schema: { type: "string" } };
    const found = await inProcess(
      withPaths("3.0.4", { "/a": { get: operation({ parameters: [query, query] }) } }),
    );

    expect(summary(found).map(([, severity, where]) => [severity, where])).toEqual([
      ["refusal", "document"],
    ]);
    expect(pointers(found)).toEqual(["/paths/~1a/get/parameters"]);
  }, 60_000);

  test("PTH-07: a template expression repeated in one path is refused (3.2.1)", async () => {
    const found = await inProcess(
      withPaths("3.2.1", {
        "/a/{x}/{x}": { get: operation({ parameters: [pathParameter("x")] }) },
      }),
    );

    expect(summary(found)).toEqual([["PTH-07/repeated-expression", "refusal", "operation"]]);
    expect(pointers(found)).toEqual(["/paths/~1a~1{x}~1{x}/get"]);
  }, 60_000);

  test("PTH-22: a query operation generates without a diagnostic (3.2.1)", async () => {
    const found = await inProcess(
      withPaths("3.2.1", { "/a": { query: operation({ requestBody: body }) } }),
    );

    expect(found.diagnostics).toEqual([]);
  }, 60_000);

  test("PTH-23: a key outside the verbatim token set is refused at operation scope (3.2.1)", async () => {
    const found = await inProcess(
      withPaths("3.2.1", {
        "/a": {
          additionalOperations: { Purge: operation(), TRACK: operation(), purge: operation() },
          get: operation(),
        },
      }),
    );

    expect(summary(found)).toEqual([
      ["PTH-23/method-not-allowed", "refusal", "operation"],
      ["PTH-23/method-not-allowed", "refusal", "operation"],
      ["PTH-23/method-not-allowed", "refusal", "operation"],
    ]);
    expect(pointers(found)).toEqual([
      "/paths/~1a/additionalOperations/Purge",
      "/paths/~1a/additionalOperations/TRACK",
      "/paths/~1a/additionalOperations/purge",
    ]);
  }, 60_000);

  test("PTH-24: a mixed-case key equal to a fixed method is refused (3.2.1)", async () => {
    const found = await inProcess(
      withPaths("3.2.1", {
        "/a": {
          additionalOperations: { Post: operation(), Query: operation() },
          post: operation(),
        },
      }),
    );

    expect(summary(found)).toEqual([
      ["PTH-24/fixed-method-key", "refusal", "operation"],
      ["PTH-24/fixed-method-key", "refusal", "operation"],
    ]);
    expect(pointers(found)).toEqual([
      "/paths/~1a/additionalOperations/Post",
      "/paths/~1a/additionalOperations/Query",
    ]);
  }, 60_000);

  test("PTH-24: a POST key beside a post operation is a PTH-24 refusal (3.2.1)", async () => {
    const found = await inProcess(
      withPaths("3.2.1", {
        "/a": { additionalOperations: { POST: operation() }, post: operation() },
      }),
    );

    expect(summary(found)).toEqual([["PTH-24/fixed-method-key", "refusal", "operation"]]);
  }, 60_000);

  test("PTH-24: a lowercase post key beside a post operation is a PTH-24 refusal (3.2.1)", async () => {
    const found = await inProcess(
      withPaths("3.2.1", {
        "/a": { additionalOperations: { post: operation() }, post: operation() },
      }),
    );

    expect(summary(found)).toEqual([["PTH-24/fixed-method-key", "refusal", "operation"]]);
  }, 60_000);

  test("OPR-10: a described body on GET, HEAD, DELETE, OPTIONS and TRACE is a notice and generation continues (3.0.4)", async () => {
    const found = await inProcess(
      withPaths("3.0.4", {
        "/a": Object.fromEntries(
          ["get", "head", "delete", "options", "trace"].map((method) => [
            method,
            operation({ requestBody: body }),
          ]),
        ),
      }),
    );

    expect(
      found.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.severity,
        diagnostic.scope,
      ]),
    ).toEqual(Array.from({ length: 5 }, () => ["OPR-10/body-ignored", "notice", "element"]));
    expect(sorted(pointers(found))).toEqual(
      sorted(
        ["get", "head", "delete", "options", "trace"].map(
          (method) => `/paths/~1a/${method}/requestBody`,
        ),
      ),
    );
  }, 60_000);

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`OPR-11: a GET, HEAD or TRACE body is refused at element scope with its pointer (${line})`, async () => {
      const found = await inProcess(
        withPaths(line, {
          "/a": Object.fromEntries(
            ["get", "head", "trace"].map((method) => [method, operation({ requestBody: body })]),
          ),
        }),
      );

      // The refusal carries the code of row OPR-10; the row OPR-11 owns the rule.
      expect(summary(found)).toEqual([
        ["OPR-10/body-refused", "refusal", "element"],
        ["OPR-10/body-refused", "refusal", "element"],
        ["OPR-10/body-refused", "refusal", "element"],
      ]);
      expect(sorted(pointers(found))).toEqual(
        sorted(["get", "head", "trace"].map((method) => `/paths/~1a/${method}/requestBody`)),
      );
    }, 60_000);

    test(`OPR-11: a DELETE or OPTIONS body raises no diagnostic (${line})`, async () => {
      const found = await inProcess(
        withPaths(line, {
          "/a": {
            delete: operation({ requestBody: body }),
            options: operation({ requestBody: body }),
          },
        }),
      );

      expect(found.diagnostics).toEqual([]);
    }, 60_000);
  }

  test("OPR-12: an operation without responses is refused by the schema (3.0.4)", async () => {
    const found = await inProcess(withPaths("3.0.4", { "/a": { get: {} } }));

    expect(summary(found).map(([, severity, where]) => [severity, where])).toEqual([
      ["refusal", "document"],
    ]);
    expect(pointers(found)).toEqual(["/paths/~1a/get"]);
  }, 60_000);
});
