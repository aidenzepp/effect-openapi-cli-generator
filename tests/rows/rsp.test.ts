import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, Exit, Layer, Order, Schema, Scope } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate, GenerateRefused } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Json } from "../../src/model/pointer.ts";
import { partOptions } from "../../src/runtime-src/runtime/input.ts";
import { dispatchResponse } from "../../src/runtime-src/runtime/negotiate.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { HeaderList } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";
import { setEnv } from "../support/env.ts";

// The Milestone 2 witness for the Responses, Response and Header Object rows (RSS-*, RSP-*,
// HDR-*): one generated package per version line, built once, run against the capture server; the
// generation rows call `generate()` in process. A row the product gets wrong is a `test.todo` with
// what was observed. RSP-04's Retry-After half is deferred to Milestone 3. Responses are not
// schema-decoded and response headers do not change output (design §2.3), so the response-header
// rows observe the body, the exit code and the request id, the one header the runtime reads.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixtures = nodePath.join(repoRoot, "corpus/fixtures/rows/rsp");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// Generated packages and output files live under the worktree's git-ignored `work/`, never the
// system temp directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "wt-rsp-"));

const restoreTmpdir = setEnv("TMPDIR", work);

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

const file = (name: string): string => nodePath.join(work, name);

beforeAll(async () => {
  // The port is known only once the capture server listens, so the bound origin is added here.
  const configPath = file("author-config.json");
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
  restoreTmpdir();
});

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf-8");

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

interface Exchange {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: Uint8Array;
}

// One invocation of the line's built CLI against the bound server. `runBin` is asynchronous, so
// the in-process capture server keeps answering.
const run = async (line: Line, args: readonly string[]): Promise<Exchange> => {
  const generated = packages.get(line);
  if (generated === undefined) {
    throw new Error(`no package built for ${line}`);
  }

  const result = await Effect.runPromise(
    runBin(generated, {
      args: ["--server", "0", "--server-variable", `port=${port}`, ...args],
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );

  return { exitCode: result.exitCode, stderr: text(result.stderr), stdout: result.stdout };
};

// The server answers `path` with this status, body and headers until scripted again.
const answer = (path: string, status: number, body = "", headers: HeaderList = []): void => {
  capture.script(path, { body, headers, status });
};

// Answer `path` once as scripted and run `command` against it.
const respond = (
  line: Line,
  command: string,
  path: string,
  status: number,
  body = "",
  headers: HeaderList = [],
): Promise<Exchange> => {
  answer(path, status, body, headers);

  return run(line, [command]);
};

const stderrLines = (exchange: Exchange): readonly string[] =>
  exchange.stderr.split("\n").filter((entry) => entry !== "");

// The `matched` key of a rendered `ApiResponseError`, read from its `(matched <key>)` suffix.
const matchedOf = (exchange: Exchange): string | undefined =>
  /\(matched (?<key>[^)]+)\)$/u.exec(
    stderrLines(exchange).find((entry) => entry.startsWith("Error: ")) ?? "",
  )?.groups?.key;

// The rendered `ApiResponseError.requestId`, read from its `Request ID: ` line.
const requestIdOf = (exchange: Exchange): string | undefined =>
  stderrLines(exchange)
    .find((entry) => entry.startsWith("Request ID: "))
    ?.slice("Request ID: ".length);

// What a status decides: the exit code, the matched key of an error and what reached stdout.
const decided = (exchange: Exchange) => ({
  exitCode: exchange.exitCode,
  matched: matchedOf(exchange),
  stdout: text(exchange.stdout),
});

// A success: the body on stdout as received, nothing on stderr.
const succeeded = (stdout: string) => ({ exitCode: 0, matched: undefined, stdout });

// An error response: nothing on stdout, the matched key on stderr.
const failed = (exitCode: number, matched: string) => ({ exitCode, matched, stdout: "" });

const plainText: HeaderList = [["content-type", "text/plain"]];

// In process generation of a small document of a line; the diagnostics of a refused run are the
// refusal's, and the emitted code of an accepted run is kept for comparison.
interface Generated {
  readonly diagnostics: readonly Diagnostic[];
  readonly code: readonly (readonly [string, string])[];
}

let counter = 0;

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

// The emitted files under `src/`, sorted by path. The report and the manifest record the source's
// sha256, so they are left out.
const emittedCode = (dir: string): readonly (readonly [string, string])[] =>
  Arr.sort(
    nodeFs
      .readdirSync(dir, { encoding: "utf-8", recursive: true })
      .filter((path) => path.startsWith(`src${nodePath.sep}`))
      .filter((path) => nodeFs.statSync(nodePath.join(dir, path)).isFile()),
    Order.String,
  ).map((path) => [path, nodeFs.readFileSync(nodePath.join(dir, path), "utf-8")] as const);

const inProcess = async (source: string): Promise<Generated> => {
  counter += 1;
  const dir = nodePath.join(work, `case-${counter}`);
  nodeFs.mkdirSync(dir, { recursive: true });

  const specPath = nodePath.join(dir, "openapi");
  const configPath = nodePath.join(dir, "author-config.json");
  const outDir = nodePath.join(dir, "out");

  nodeFs.writeFileSync(specPath, source);
  nodeFs.writeFileSync(configPath, JSON.stringify(authorConfig));

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
    return { code: emittedCode(outDir), diagnostics: exit.value.diagnostics };
  }

  const [failure] = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" && reason.error instanceof GenerateRefused ? [reason.error] : [],
  );
  if (failure === undefined) {
    throw new Error(`generate failed for a reason other than a refusal: ${String(exit.cause)}`);
  }

  return { code: [], diagnostics: failure.diagnostics };
};

const summary = (found: Generated) =>
  found.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.severity,
    diagnostic.scope,
    String(diagnostic.pointer),
  ]);

// The summary of one row's diagnostics only, so another row's finding on the same document (such
// as a 3.0 header's HDR-15 notice) does not move the witness.
const rowSummary = (found: Generated, row: string) =>
  summary({
    ...found,
    diagnostics: found.diagnostics.filter((diagnostic) => diagnostic.row === row),
  });

// A refusal by the line's official schema, which runs before the generator's own rules: its code
// is the schema row of the line (VAL-02, VAL-03 or VAL-04), so only severity, scope and pointer are
// stable here.
const schemaRefusals = (found: Generated) =>
  found.diagnostics.map((diagnostic) => [
    diagnostic.severity,
    diagnostic.scope,
    String(diagnostic.pointer),
  ]);

const schemaRefusal = (pointer: string) => ["refusal", "document", pointer];

const withResponses = (line: Line, responses: Members): string =>
  JSON.stringify({
    info: { title: "Responses rows", version: "1.0.0" },
    openapi: line,
    paths: { "/a": { get: { operationId: "a-get", responses } } },
  });

const responsesPointer = "/paths/~1a/get/responses";

const withHeader = (line: Line, header: Members): string =>
  withResponses(line, { "200": { description: "ok", headers: { "X-H": header } } });

const headerPointer = `${responsesPointer}/200/headers/X-H`;

// A multipart body whose part `a` declares `headers` in its Encoding Object.
const withPartHeaders = (line: Line, headers: Members): string =>
  JSON.stringify({
    info: { title: "Responses rows", version: "1.0.0" },
    openapi: line,
    paths: {
      "/a": {
        post: {
          operationId: "a-post",
          requestBody: {
            content: {
              "multipart/form-data": {
                encoding: { a: { headers } },
                schema: { properties: { a: { type: "string" } }, type: "object" },
              },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });

// The emitted command module of an accepted run.
const rootModule = (found: Generated): string =>
  found.code.find(([path]) => path === nodePath.join("src", "cli", "root.ts"))?.[1] ?? "";

const text200 = { "200": { description: "ok" } };

const stringSchema = { type: "string" };

describe("RSS, RSP and HDR rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`RSS-01: the status class decides success and the exit code; stdout carries only a success body (${line})`, async () => {
        const ok = await respond(line, "sparse-get", "/sparse", 200, "fine", plainText);
        const notModified = await respond(line, "sparse-get", "/sparse", 304);
        const unauthorized = await respond(line, "sparse-get", "/sparse", 401, "who");
        const forbidden = await respond(line, "sparse-get", "/sparse", 403, "no");
        const missing = await respond(line, "sparse-get", "/sparse", 404, "gone");
        const broken = await respond(line, "sparse-get", "/sparse", 500, "boom");

        expect([ok, notModified, unauthorized, forbidden, missing, broken].map(decided)).toEqual([
          succeeded("fine"),
          failed(1, "undeclared"),
          failed(3, "undeclared"),
          failed(3, "undeclared"),
          failed(1, "undeclared"),
          failed(1, "undeclared"),
        ]);
      }, 60_000);

      test(`RSS-02: an undocumented 500 is handled by default, its body on stderr (${line})`, async () => {
        const observed = await respond(line, "fallback-get", "/fallback", 500, '{"error":"boom"}', [
          ["content-type", "application/json"],
        ]);

        expect([decided(observed), stderrLines(observed).at(-1)]).toEqual([
          failed(1, "default"),
          '{"error":"boom"}',
        ]);
      }, 60_000);

      test(`RSS-03: 201 is matched by its explicit key and its body written as received, not schema-decoded (${line})`, async () => {
        // The 201 schema is an integer; the body is an object with spacing a re-serializer drops.
        const observed = await respond(line, "explicit-get", "/explicit", 201, '{"b": 1,"a":[2]}', [
          ["content-type", "application/json"],
        ]);

        expect([decided(observed), observed.stderr]).toEqual([succeeded('{"b": 1,"a":[2]}'), ""]);
      }, 60_000);

      test(`RSS-06: 404 is matched by 4XX when no explicit 404 is declared (${line})`, async () => {
        const observed = await respond(line, "unregistered-get", "/unregistered", 404, "gone");

        expect(decided(observed)).toEqual(failed(1, "4XX"));
      }, 60_000);

      test(`RSS-07: an explicit 404 beats 4XX (${line})`, async () => {
        const observed = await respond(line, "ranked-get", "/ranked", 404, "gone");

        expect(decided(observed)).toEqual(failed(1, "404"));
      }, 60_000);

      test(`RSS-08: default covers codes not covered individually, and a 2xx it matches succeeds (${line})`, async () => {
        const accepted = await respond(line, "default-only-get", "/default-only", 202, "queued");
        const unavailable = await respond(line, "default-only-get", "/default-only", 503, "later");

        expect([decided(accepted), decided(unavailable)]).toEqual([
          succeeded("queued"),
          failed(1, "default"),
        ]);
      }, 60_000);

      test(`RSS-09: explicit code beats range beats default (${line})`, async () => {
        const explicit = await respond(line, "ranked-get", "/ranked", 404);
        const range = await respond(line, "ranked-get", "/ranked", 418);
        const fallback = await respond(line, "ranked-get", "/ranked", 503);

        expect([explicit, range, fallback].map(matchedOf)).toEqual(["404", "4XX", "default"]);
      }, 60_000);

      test(`RSS-11: an undocumented status prints its body on stderr with the status and exits non-zero (${line})`, async () => {
        const conflict = await respond(line, "sparse-get", "/sparse", 409, "conflict");
        const unavailable = await respond(line, "sparse-get", "/sparse", 503, "later");

        expect([
          [decided(conflict), stderrLines(conflict).at(-1)],
          [decided(unavailable), stderrLines(unavailable).at(-1)],
        ]).toEqual([
          [failed(1, "undeclared"), "conflict"],
          [failed(1, "undeclared"), "later"],
        ]);
      }, 60_000);

      test(`RSS-12: an unregistered code within 100 to 599 is handled like any explicit code (${line})`, async () => {
        const observed = await respond(line, "unregistered-get", "/unregistered", 499, "odd");

        expect(decided(observed)).toEqual(failed(1, "499"));
      }, 60_000);

      test(`RSP-01: a Response Object's body reaches stdout on its status (${line})`, async () => {
        const observed = await respond(line, "sparse-get", "/sparse", 200, "line one\n", plainText);

        expect([decided(observed), observed.stderr]).toEqual([succeeded("line one\n"), ""]);
      }, 60_000);

      test(`RSP-04 (request-id): a declared x-request-id header feeds the Request ID line of an error, never stdout (${line})`, async () => {
        const failure = await respond(line, "traced-get", "/traced", 404, "gone", [
          ["x-request-id", "req-404"],
        ]);
        const success = await respond(line, "traced-get", "/traced", 200, "body", [
          ["x-request-id", "req-200"],
          ["x-rate", "7"],
          ["content-type", "text/plain"],
        ]);

        expect([
          [decided(failure), requestIdOf(failure)],
          [decided(success), success.stderr],
        ]).toEqual([
          [failed(1, "4XX"), "req-404"],
          [succeeded("body"), ""],
        ]);
      }, 60_000);

      test(`RSP-04 (request-id): x-correlation-id counts as the request-id header; an operation declaring none reads none (${line})`, async () => {
        const correlated = await respond(line, "correlated-get", "/correlated", 503, "", [
          ["X-Correlation-ID", "corr-9"],
        ]);
        const untraced = await respond(line, "untraced-get", "/untraced", 404, "", [
          ["x-request-id", "req-404"],
        ]);

        expect([
          [matchedOf(correlated), requestIdOf(correlated)],
          [matchedOf(untraced), requestIdOf(untraced)],
        ]).toEqual([
          ["5XX", "corr-9"],
          ["4XX", undefined],
        ]);
      }, 60_000);

      test(`RSP-04 (request-id): a request id longer than 256 characters is bounded to 256 (${line})`, async () => {
        const observed = await respond(line, "traced-get", "/traced", 400, "", [
          ["x-request-id", "r".repeat(300)],
        ]);

        expect(requestIdOf(observed)).toBe("r".repeat(256));
      }, 60_000);

      test(`RSP-05: the body is written as received whichever declared or undeclared media type the server sends (${line})`, async () => {
        const bodies: readonly (readonly [string, string])[] = [
          ["application/json", '{"b": 1,"a":[2]}'],
          ["text/plain; charset=utf-8", "two  spaces\r\nand CRLF"],
          ["application/xml", "<a>\n  <b/>\n</a>"],
          ["application/octet-stream", "ÿ\u0000\u0001\u007F"],
          ["image/png", "\u0089PNG\u0000"],
        ];
        const observed: string[] = [];
        for (const [type, body] of bodies) {
          // oxlint-disable-next-line no-await-in-loop -- the server is scripted per answer
          const exchange = await respond(line, "media-get", "/media", 200, body, [
            ["content-type", type],
          ]);
          observed.push(`${String(exchange.exitCode)} ${hex(exchange.stdout)}`);
        }

        expect(observed).toEqual(bodies.map(([, body]) => `0 ${hex(Buffer.from(body))}`));
      }, 60_000);

      test(`RSP-05: --output writes the body as received to the file, not stdout (${line})`, async () => {
        const target = file(`media-${line}.bin`);
        answer("/media", 200, "ÿ\u0000raw", [["content-type", "application/octet-stream"]]);

        const observed = await run(line, ["media-get", "--output", target]);

        expect([observed.exitCode, hex(observed.stdout), hex(nodeFs.readFileSync(target))]).toEqual(
          [0, "", hex(Buffer.from("ÿ\u0000raw"))],
        );
      }, 60_000);

      test(`RSP-07: a 204 with no content prints nothing and exits 0 (${line})`, async () => {
        const observed = await respond(line, "empty-delete", "/empty", 204);

        expect([decided(observed), observed.stderr]).toEqual([succeeded(""), ""]);
      }, 60_000);

      test(`RSP-08: a body matching text/plain and text/* passes unchanged under either (${line})`, async () => {
        const exact = await respond(line, "specific-get", "/specific", 200, "plain", plainText);
        const ranged = await respond(line, "specific-get", "/specific", 200, "<p>", [
          ["content-type", "text/html"],
        ]);

        expect([decided(exact), decided(ranged)]).toEqual([succeeded("plain"), succeeded("<p>")]);
      }, 60_000);

      test(`RSP-09: a declared Content-Type header definition is ignored; the body passes as the server types it (${line})`, async () => {
        // The definition says application/json; the server sends text/plain.
        const observed = await respond(line, "ignored-get", "/ignored", 200, "not json", plainText);

        expect([decided(observed), observed.stderr]).toEqual([succeeded("not json"), ""]);
      }, 60_000);

      test(`RSP-09: response header names match case-insensitively: X-Request-Id is read from x-request-id (${line})`, async () => {
        const lower = await respond(line, "traced-get", "/traced", 404, "", [
          ["x-request-id", "lower"],
        ]);
        const upper = await respond(line, "traced-get", "/traced", 404, "", [
          ["X-REQUEST-ID", "upper"],
        ]);

        expect([requestIdOf(lower), requestIdOf(upper)]).toEqual(["lower", "upper"]);
      }, 60_000);

      test(`HDR-01: declared response Header Objects leave the output unchanged (${line})`, async () => {
        const observed = await respond(line, "typed-get", "/typed", 200, "typed", [
          ["x-count", "7"],
          ["x-required", "here"],
          ["content-type", "text/plain"],
        ]);

        expect([decided(observed), observed.stderr]).toEqual([succeeded("typed"), ""]);
      }, 60_000);

      test(`HDR-05: a simple-style array header a,b is accepted as sent and does not change output (${line})`, async () => {
        const observed = await respond(line, "typed-get", "/typed", 200, "list", [
          ["x-list", "a,b"],
          ["x-required", "r"],
          ["content-type", "text/plain"],
        ]);

        expect([decided(observed), observed.stderr]).toEqual([succeeded("list"), ""]);
      }, 60_000);

      test(`HDR-06: an exploded object header R=100,G=200 is accepted as sent and does not change output (${line})`, async () => {
        const observed = await respond(line, "typed-get", "/typed", 200, "color", [
          ["x-color", "R=100,G=200"],
          ["x-required", "r"],
          ["content-type", "text/plain"],
        ]);

        expect([decided(observed), observed.stderr]).toEqual([succeeded("color"), ""]);
      }, 60_000);

      test(`HDR-07: a header with an integer schema, even when its value is not an integer, does not change output (${line})`, async () => {
        const observed = await respond(line, "typed-get", "/typed", 200, "count", [
          ["x-count", "seven"],
          ["x-required", "r"],
          ["content-type", "text/plain"],
        ]);

        expect([decided(observed), observed.stderr]).toEqual([succeeded("count"), ""]);
      }, 60_000);

      test(`HDR-08: a header described by content is accepted and does not change output (${line})`, async () => {
        const observed = await respond(line, "typed-get", "/typed", 200, "meta", [
          ["x-meta", '{"a":1}'],
          ["x-required", "r"],
          ["content-type", "text/plain"],
        ]);

        expect([decided(observed), observed.stderr]).toEqual([succeeded("meta"), ""]);
      }, 60_000);

      test(`HDR-03: typed-get answered without its required X-Required header warns on stderr, output and exit unchanged (${line})`, async () => {
        const observed = await respond(line, "typed-get", "/typed", 200, "typed", plainText);

        expect([decided(observed), stderrLines(observed)]).toEqual([
          succeeded("typed"),
          ["Warning: the response is missing the required header X-Required"],
        ]);
      }, 60_000);

      test(`HDR-04: typed-get help lists its response headers with X-Required marked required and X-Deprecated marked deprecated (${line})`, async () => {
        const help = await run(line, ["typed-get", "--help"]);

        expect(text(help.stdout)).toContain(
          "200: X-Color, X-Count, X-Deprecated (deprecated), X-List, X-Meta, X-Required (required)",
        );
      }, 60_000);
    });
  }

  test('HDR-15: a 3.0 header value is not percent-decoded: the request id W/"a%20b" is kept verbatim', async () => {
    const observed = await respond("3.0.4", "traced-get", "/traced", 404, "", [
      ["x-request-id", 'W/"a%20b"'],
    ]);

    expect(requestIdOf(observed)).toBe('W/"a%20b"');
  }, 60_000);

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`HDR-16: a header value is neither percent-decoded nor unquoted: the request id W/"x"%22 is kept verbatim (${line})`, async () => {
      const observed = await respond(line, "traced-get", "/traced", 404, "", [
        ["x-request-id", 'W/"x"%22'],
      ]);

      expect(requestIdOf(observed)).toBe('W/"x"%22');
    }, 60_000);
  }

  test("HDR-17: a Link header declared with application/linkset is not parsed; the body passes unchanged (3.2.1)", async () => {
    const observed = await respond("3.2.1", "linked-get", "/linked", 200, "linked", [
      ["link", '<https://example.com/a>; rel="next", <https://example.com/b>; rel="prev"'],
      ["content-type", "text/plain"],
    ]);

    expect([decided(observed), observed.stderr]).toEqual([succeeded("linked"), ""]);
  }, 60_000);

  test("HDR-18: several Set-Cookie headers are accepted and do not change output (3.2.1)", async () => {
    const observed = await respond("3.2.1", "linked-get", "/linked", 200, "cookies", [
      ["set-cookie", "a=1; Path=/"],
      ["set-cookie", "b=2, c=3"],
      ["content-type", "text/plain"],
    ]);

    expect([decided(observed), observed.stderr]).toEqual([succeeded("cookies"), ""]);
  }, 60_000);
});

describe("RSP-08 in the runtime's response dispatch", () => {
  test("RSP-08: text/plain beats text/*, which still takes the other text types", () => {
    const declared = ["text/*", "text/plain"];

    expect([
      dispatchResponse(declared, "text/plain; charset=utf-8"),
      dispatchResponse(declared, "TEXT/PLAIN"),
      dispatchResponse(declared, "text/html"),
      dispatchResponse(declared, "application/json"),
    ]).toEqual(["text/plain", "text/plain", "text/*", undefined]);
  });
});

describe("RSS, RSP and HDR rows in generation", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`RSS-04: an empty Responses Object is refused; default alone is a response code (${line})`, async () => {
        const empty = await inProcess(withResponses(line, {}));
        const fallback = await inProcess(withResponses(line, { default: { description: "any" } }));

        expect([schemaRefusals(empty), summary(fallback)]).toEqual([
          [schemaRefusal(responsesPointer)],
          [],
        ]);
      }, 60_000);

      test(`RSS-05: JSON keys and YAML integer keys of the same description yield the same responses (${line})`, async () => {
        const json = await inProcess(
          withResponses(line, {
            "200": { description: "ok" },
            "404": { description: "missing" },
            default: { description: "other" },
          }),
        );
        const yaml = await inProcess(
          [
            `openapi: ${line}`,
            "info:",
            "  title: Responses rows",
            "  version: 1.0.0",
            "paths:",
            "  /a:",
            "    get:",
            "      operationId: a-get",
            "      responses:",
            "        200:",
            "          description: ok",
            "        404:",
            "          description: missing",
            "        default:",
            "          description: other",
            "",
          ].join("\n"),
        );

        expect([summary(yaml), yaml.code.length > 0, yaml.code]).toEqual([[], true, json.code]);
      }, 60_000);

      test(`RSS-06: a lowercase range key 4xx is refused with its pointer (${line})`, async () => {
        const found = await inProcess(
          withResponses(line, { ...text200, "4xx": { description: "client error" } }),
        );

        expect(schemaRefusals(found)).toEqual([schemaRefusal(`${responsesPointer}/4xx`)]);
      }, 60_000);

      test(`RSS-10: status code keys 600 and 099 are refused with their pointers (${line})`, async () => {
        const high = await inProcess(
          withResponses(line, { ...text200, "600": { description: "x" } }),
        );
        const low = await inProcess(
          withResponses(line, { ...text200, "099": { description: "x" } }),
        );

        expect([schemaRefusals(high), schemaRefusals(low)]).toEqual([
          [schemaRefusal(`${responsesPointer}/600`)],
          [schemaRefusal(`${responsesPointer}/099`)],
        ]);
      }, 60_000);

      test(`RSP-09: a response header named Content-Type is ignored with a notice at its pointer (${line})`, async () => {
        const found = await inProcess(
          withResponses(line, {
            "200": {
              description: "ok",
              headers: {
                "Content-Type": { schema: stringSchema },
                "X-Rate": { schema: stringSchema },
              },
            },
          }),
        );

        expect(rowSummary(found, "RSP-09")).toEqual([
          [
            "RSP-09/ignored-content-type",
            "notice",
            "element",
            `${responsesPointer}/200/headers/Content-Type`,
          ],
        ]);
      }, 60_000);

      test(`HDR-08: a header content map with two entries is refused (${line})`, async () => {
        const found = await inProcess(
          withHeader(line, { content: { "application/json": {}, "text/plain": {} } }),
        );

        expect(schemaRefusals(found)).toEqual([schemaRefusal(`${headerPointer}/content`)]);
      }, 60_000);

      test(`HDR-11: name and in on a Header Object are refused (${line})`, async () => {
        const found = await inProcess(
          withHeader(line, { in: "header", name: "X-H", schema: stringSchema }),
        );

        expect(schemaRefusals(found)).toEqual([
          schemaRefusal(`${headerPointer}/in`),
          schemaRefusal(`${headerPointer}/name`),
        ]);
      }, 60_000);

      test(`HDR-12: style form on a Header Object is refused (${line})`, async () => {
        const found = await inProcess(withHeader(line, { schema: stringSchema, style: "form" }));

        expect(schemaRefusals(found)).toEqual([schemaRefusal(`${headerPointer}/style`)]);
      }, 60_000);

      test(`HDR-14: a Header Object with both schema and content, or neither, is refused (${line})`, async () => {
        const both = await inProcess(
          withHeader(line, { content: { "text/plain": {} }, schema: stringSchema }),
        );
        const neither = await inProcess(withHeader(line, { description: "no value" }));

        expect([schemaRefusals(both), schemaRefusals(neither)]).toEqual([
          [schemaRefusal(headerPointer)],
          [schemaRefusal(headerPointer)],
        ]);
      }, 60_000);

      // The built CLI sending the header values in the part's head is tests/emit/phdr.test.ts.
      test(`HDR-01: a multipart part Header Object is a --<part>-<header> flag serialized as a header parameter with the part (${line})`, async () => {
        const found = await inProcess(
          withPartHeaders(line, { "X-Trace": { schema: stringSchema } }),
        );
        const cli = rootModule(found);

        expect(summary(found)).toEqual([]);
        expect(cli).toContain('["a-x-trace", Option.isSome(flags.aXTrace), false]');
        expect(cli).toContain(
          'Serialize.header("X-Trace", Option.getOrUndefined(flags.aXTrace), {',
        );
      }, 60_000);

      test(`HDR-03: a required multipart part header is required when its part is sent (${line})`, async () => {
        const found = await inProcess(
          withPartHeaders(line, { "X-Trace": { required: true, schema: stringSchema } }),
        );
        const missing = Effect.runSyncExit(partOptions("a", true, [["a-x-trace", false, true]]));
        const unsent = Effect.runSyncExit(partOptions("a", false, [["a-x-trace", false, true]]));

        expect(summary(found)).toEqual([]);
        expect(rootModule(found)).toContain('["a-x-trace", Option.isSome(flags.aXTrace), true]');
        expect([Exit.isFailure(missing), Exit.isSuccess(unsent)]).toEqual([true, true]);
      }, 60_000);
    });
  }

  for (const line of ["3.0.4", "3.1.2"] as const) {
    test(`RSP-09: a response header name that is not an RFC 9110 token is refused at element scope (${line})`, async () => {
      const found = await inProcess(
        withResponses(line, {
          "200": { description: "ok", headers: { "X Rate": { schema: stringSchema } } },
        }),
      );

      expect(rowSummary(found, "RSP-09")).toEqual([
        [
          "RSP-09/invalid-header-name",
          "refusal",
          "element",
          `${responsesPointer}/200/headers/X Rate`,
        ],
      ]);
    }, 60_000);
  }

  test("RSP-09: a response header name that is not a token is refused by the 3.2 schema", async () => {
    const found = await inProcess(
      withResponses("3.2.1", {
        "200": { description: "ok", headers: { "X Rate": { schema: stringSchema } } },
      }),
    );

    expect(schemaRefusals(found)).toEqual([
      schemaRefusal(`${responsesPointer}/200/headers/X Rate`),
    ]);
  }, 60_000);

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`RSS-04: x- keys alone are not a response code and are refused (${line})`, async () => {
      const found = await inProcess(withResponses(line, { "x-note": "only an extension" }));

      expect(schemaRefusals(found)).toEqual([schemaRefusal(responsesPointer)]);
    }, 60_000);

    test(`HDR-13: allowEmptyValue and allowReserved on a Header Object are refused (${line})`, async () => {
      const empty = await inProcess(
        withHeader(line, { allowEmptyValue: true, schema: stringSchema }),
      );
      const reserved = await inProcess(
        withHeader(line, { allowReserved: true, schema: stringSchema }),
      );

      expect([schemaRefusals(empty), schemaRefusals(reserved)]).toEqual([
        [schemaRefusal(`${headerPointer}/allowEmptyValue`)],
        [schemaRefusal(`${headerPointer}/allowReserved`)],
      ]);
    }, 60_000);
  }

  // The 3.0 schema permits both a Responses Object of `x-` keys and the two fields on a Header
  // Object, so the generator's own check refuses them (D-OC3).
  test("RSS-04: a 3.0.4 Responses Object of x- keys alone is refused (3.0.4)", async () => {
    const found = await inProcess(withResponses("3.0.4", { "x-note": "only an extension" }));

    expect(rowSummary(found, "RSS-04")).toEqual([
      ["RSS-04/no-response-code", "refusal", "document", responsesPointer],
    ]);
  }, 60_000);

  test("HDR-13: allowEmptyValue and allowReserved on a 3.0.4 Header Object are refused (3.0.4)", async () => {
    const empty = await inProcess(
      withHeader("3.0.4", { allowEmptyValue: true, schema: stringSchema }),
    );
    const reserved = await inProcess(
      withHeader("3.0.4", { allowReserved: true, schema: stringSchema }),
    );

    expect([rowSummary(empty, "HDR-13"), rowSummary(reserved, "HDR-13")]).toEqual([
      [["HDR-13/parameter-only-field", "refusal", "document", `${headerPointer}/allowEmptyValue`]],
      [["HDR-13/parameter-only-field", "refusal", "document", `${headerPointer}/allowReserved`]],
    ]);
  }, 60_000);

  test("HDR-15: each schema-serialized response header in a 3.0.4 document carries a notice that header values are not percent-decoded; a content-based one does not (3.0.4)", async () => {
    const found = await inProcess(
      withResponses("3.0.4", {
        "200": {
          description: "ok",
          headers: {
            "X-A": { schema: stringSchema },
            "X-B": { schema: stringSchema },
            "X-C": { content: { "text/plain": { schema: stringSchema } } },
          },
        },
      }),
    );

    expect(rowSummary(found, "HDR-15")).toEqual([
      [
        "HDR-15/header-percent-encoding",
        "notice",
        "element",
        `${responsesPointer}/200/headers/X-A`,
      ],
      [
        "HDR-15/header-percent-encoding",
        "notice",
        "element",
        `${responsesPointer}/200/headers/X-B`,
      ],
    ]);
  }, 60_000);
});
