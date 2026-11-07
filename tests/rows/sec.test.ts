import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Scope, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate, GenerateRefused } from "../../src/generate.ts";
import { makeDocumentSet, parseDocumentPair } from "../../src/load/document-set.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Json } from "../../src/model/pointer.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { HeaderList } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The Milestone 2 witness for the Security Requirement rows (SEC-*): one generated package per
// version line, built once, run against the capture server with fake credentials that must never
// reach stdout or stderr; the diagnostic rows call `generate()` in process. SEC-11 and SEC-13 are
// deferred to Milestone 3 and SEC-14 is covered by PTH-29, so none of them has a test here. A row
// the product gets wrong is a `test.todo` with what was observed.

const fixtures = nodePath.resolve(import.meta.dir, "../../corpus/fixtures/rows/sec");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = nodeFs.mkdtempSync(nodePath.join(tmpdir(), "wt-sec-"));

interface Members {
  readonly [key: string]: Json;
}

const readJson = (file: string): Members =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
    nodeFs.readFileSync(file, "utf-8"),
  );

const authorConfig = readJson(nodePath.join(fixtures, "author-config.json"));

const capture = startCaptureServer();

// An auth failure from the server, for the operation whose requirement is empty.
capture.script("/denied", { body: "{}", status: 401 });

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

// Fake credentials, one per scheme, so the recorded request names the scheme that was chosen.
const headerKey = "fake-sec-header-4d1e";

const queryKey = "fake-sec-query-8b27";

const bearer = "fake-sec-bearer-c95a";

const env = {
  all: { SEC_BEARER_AUTH: bearer, SEC_HEADER_KEY: headerKey, SEC_QUERY_KEY: queryKey },
  bearer: { SEC_BEARER_AUTH: bearer },
  header: { SEC_HEADER_KEY: headerKey },
  headerAndBearer: { SEC_BEARER_AUTH: bearer, SEC_HEADER_KEY: headerKey },
  none: {},
  query: { SEC_QUERY_KEY: queryKey },
  queryAndBearer: { SEC_BEARER_AUTH: bearer, SEC_QUERY_KEY: queryKey },
} satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

interface Sent {
  readonly headers: HeaderList;
  readonly target: string;
}

interface Exchange {
  readonly exitCode: number | null;
  readonly output: string;
  readonly sent: readonly Sent[];
}

// One invocation of the line's built CLI against the bound server, with what the capture server
// recorded during it. `runBin` is asynchronous, so the in-process capture server keeps answering.
const run = async (
  line: Line,
  command: string,
  credentials: Readonly<Record<string, string>>,
): Promise<Exchange> => {
  const generated = packages.get(line);
  if (generated === undefined) {
    throw new Error(`no package built for ${line}`);
  }

  const before = capture.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, {
      args: ["--server", "0", "--server-variable", `port=${port}`, command],
      env: credentials,
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );

  return {
    exitCode: result.exitCode,
    output: `${latin1(result.stdout)}${latin1(result.stderr)}`,
    sent: capture
      .requests()
      .slice(before)
      .map((request) => ({ headers: request.headers, target: request.target })),
  };
};

// What each recorded request carried of the three schemes: the X-Api-Key and Authorization header
// values and the request target, which holds the api_key query credential.
const carried = (exchange: Exchange) =>
  exchange.sent.map((sent) => ({
    authorization: sent.headers.flatMap(([key, value]) =>
      key.toLowerCase() === "authorization" ? [value] : [],
    ),
    key: sent.headers.flatMap(([key, value]) => (key.toLowerCase() === "x-api-key" ? [value] : [])),
    target: sent.target,
  }));

// The recorded request of one call, as `carried` reads it.
const request = (target: string, sent: { authorization?: string; key?: string } = {}) => ({
  authorization: sent.authorization === undefined ? [] : [sent.authorization],
  key: sent.key === undefined ? [] : [sent.key],
  target,
});

const expectNoCredential = (exchange: Exchange) => {
  for (const value of [headerKey, queryKey, bearer]) {
    expect(exchange.output).not.toContain(value);
  }
};

// A refused call: exit 3 before any request (design 6.5 Run-time choice).
const refusedBeforeSend = { exitCode: 3, sent: [] };

const outcome = (exchange: Exchange) => ({ exitCode: exchange.exitCode, sent: exchange.sent });

describe("SEC rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`SEC-01: a Security Requirement Object's scheme credential is sent (${line})`, async () => {
        const observed = await run(line, "root-get", env.header);

        expect(observed.exitCode).toBe(0);
        expect(carried(observed)).toEqual([request("/root", { key: headerKey })]);
        expectNoCredential(observed);
      }, 60_000);

      test(`SEC-02: each requirement name selects the scheme whose credential is sent (${line})`, async () => {
        const query = await run(line, "or-get", env.query);
        const token = await run(line, "override-get", env.bearer);

        expect([query.exitCode, token.exitCode]).toEqual([0, 0]);
        expect([...carried(query), ...carried(token)]).toEqual([
          request(`/or?api_key=${queryKey}`),
          request("/override", { authorization: `Bearer ${bearer}` }),
        ]);
        expectNoCredential(query);
        expectNoCredential(token);
      }, 60_000);

      test(`SEC-03: an operation without security uses the root list (${line})`, async () => {
        const configured = await run(line, "root-get", env.headerAndBearer);
        const unsatisfied = await run(line, "root-get", env.bearer);

        expect(configured.exitCode).toBe(0);
        expect(carried(configured)).toEqual([request("/root", { key: headerKey })]);
        expect(outcome(unsatisfied)).toEqual(refusedBeforeSend);
        expectNoCredential(configured);
      }, 60_000);

      test(`SEC-04: operation security replaces the root list and security: [] sends nothing (${line})`, async () => {
        const replaced = await run(line, "override-get", env.headerAndBearer);
        const removed = await run(line, "none-get", env.all);

        expect([replaced.exitCode, removed.exitCode]).toEqual([0, 0]);
        expect([...carried(replaced), ...carried(removed)]).toEqual([
          request("/override", { authorization: `Bearer ${bearer}` }),
          request("/none"),
        ]);
        expectNoCredential(replaced);
        expectNoCredential(removed);
      }, 60_000);

      test(`SEC-05: every scheme of one alternative is sent, and a partial one is refused (${line})`, async () => {
        const both = await run(line, "and-get", env.headerAndBearer);
        const partial = await run(line, "and-get", env.header);

        expect(both.exitCode).toBe(0);
        expect(carried(both)).toEqual([
          request("/and", { authorization: `Bearer ${bearer}`, key: headerKey }),
        ]);
        expect(outcome(partial)).toEqual(refusedBeforeSend);
        expectNoCredential(both);
        expectNoCredential(partial);
      }, 60_000);

      test(`SEC-06: the first satisfiable alternative is used and none satisfiable exits 3 (${line})`, async () => {
        const first = await run(line, "or-get", env.queryAndBearer);
        const second = await run(line, "or-get", env.bearer);
        const none = await run(line, "or-get", env.none);

        expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
        expect([...carried(first), ...carried(second)]).toEqual([
          request(`/or?api_key=${queryKey}`),
          request("/or", { authorization: `Bearer ${bearer}` }),
        ]);
        expect(outcome(none)).toEqual(refusedBeforeSend);
        expectNoCredential(first);
        expectNoCredential(second);
      }, 60_000);

      test(`SEC-07: {} sends the request without credentials, after a credentialed alternative (${line})`, async () => {
        const anonymous = await run(line, "anon-get", env.none);
        const keyed = await run(line, "anon-get", env.header);

        expect([anonymous.exitCode, keyed.exitCode]).toEqual([0, 0]);
        expect([...carried(anonymous), ...carried(keyed)]).toEqual([
          request("/anon"),
          request("/anon", { key: headerKey }),
        ]);
        expectNoCredential(keyed);
      }, 60_000);

      test(`SEC-08: an empty requirement sends no credentials and a 401 is an HTTP error (${line})`, async () => {
        const observed = await run(line, "denied-get", env.all);

        // The request reached the server, so exit 3 is the 401 (help: 401/403 exit 3), not a
        // credential refusal.
        expect(observed.exitCode).toBe(3);
        expect(carried(observed)).toEqual([request("/denied")]);
        expectNoCredential(observed);
      }, 60_000);
    });
  }

  for (const line of ["3.0.4", "3.1.2"] as const) {
    test(`SEC-09: an undeclared name removes its alternative and the next one is sent (${line})`, async () => {
      const observed = await run(line, "undeclared-get", env.bearer);

      expect(observed.exitCode).toBe(0);
      expect(carried(observed)).toEqual([
        request("/undeclared", { authorization: `Bearer ${bearer}` }),
      ]);
      expectNoCredential(observed);
    }, 60_000);
  }

  test("SEC-10: 3.2 requirement names by fragment URI and by ./ URI reach the component", async () => {
    const fragment = await run("3.2.1", "by-fragment-get", env.query);
    const relative = await run("3.2.1", "by-relative-get", env.query);

    expect([fragment.exitCode, relative.exitCode]).toEqual([0, 0]);
    expect([...carried(fragment), ...carried(relative)]).toEqual([
      request(`/by-fragment?api_key=${queryKey}`),
      request(`/by-relative?api_key=${queryKey}`),
    ]);
    expectNoCredential(fragment);
    expectNoCredential(relative);
  }, 60_000);
});

// In process generation of an entry document, written under the case directory as `entry`, and
// the other documents of its set beside it. Each document's URI is the `file:` URL of its real
// path, as the generator CLI gives it.

interface Generated {
  readonly commands: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  // The emitted `src/api/root.ts`, or undefined when the run wrote no package.
  readonly root: string | undefined;
}

interface Case {
  readonly entry: Members;
  readonly name: string;
  readonly others?: Readonly<Record<string, Members>>;
}

let counter = 0;

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const decodeDocument = Schema.decodeUnknownSync(DocumentUri);

const urlOf = (path: string) => pathToFileURL(nodeFs.realpathSync(path)).href;

const inProcess = async ({ entry, name, others = {} }: Case): Promise<Generated> => {
  counter += 1;
  const dir = nodePath.join(work, `case-${counter}`);
  nodeFs.mkdirSync(dir, { recursive: true });

  const write = (file: string, value: Members) => {
    const path = nodePath.join(dir, file);
    nodeFs.writeFileSync(path, JSON.stringify(value));

    return path;
  };
  const specPath = write(name, entry);
  const configPath = nodePath.join(dir, "author-config.json");
  nodeFs.writeFileSync(configPath, JSON.stringify(authorConfig));

  const pairs = Object.entries(others).map(([file, value]) => {
    const path = write(file, value);

    return parseDocumentPair(`${urlOf(path)}=${path}`);
  });
  const outDir = nodePath.join(dir, "out");

  const exit = await Effect.runPromiseExit(
    Effect.gen(function* generateCase() {
      const documents = yield* makeDocumentSet(pairs, {});

      return yield* generate(
        {
          document: decodeDocument(urlOf(specPath)),
          documents,
          generator,
          outDir,
          source: { _tag: "File", path: specPath },
          strict: false,
        },
        { document: decodeDocument(urlOf(configPath)), path: configPath },
      );
    }).pipe(Effect.provide(layer)),
  );
  const rootPath = nodePath.join(outDir, "src", "api", "root.ts");
  const root = nodeFs.existsSync(rootPath) ? nodeFs.readFileSync(rootPath, "utf-8") : undefined;

  nodeFs.rmSync(dir, { force: true, recursive: true });

  if (Exit.isSuccess(exit)) {
    return {
      commands: exit.value.report.commandNames.map((command) => String(command.pointer)),
      diagnostics: exit.value.diagnostics,
      root,
    };
  }

  const [failure] = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" && reason.error instanceof GenerateRefused ? [reason.error] : [],
  );
  if (failure === undefined) {
    throw new Error(`generate failed for a reason other than a refusal: ${String(exit.cause)}`);
  }

  return { commands: [], diagnostics: failure.diagnostics, root: undefined };
};

// The line's fixture, generated in process under its own file name, so `./3.2.1.json` resolves.
const fixture = (line: Line) =>
  inProcess({ entry: readJson(nodePath.join(fixtures, `${line}.json`)), name: `${line}.json` });

const summary = (diagnostics: readonly Diagnostic[]) =>
  diagnostics.map((diagnostic) => [
    diagnostic.row,
    diagnostic.code,
    diagnostic.severity,
    diagnostic.scope,
    String(diagnostic.pointer),
  ]);

// The diagnostics at one pointer, or under it.
const at = (found: Generated, pointer: string) =>
  summary(
    found.diagnostics.filter(
      (diagnostic) =>
        diagnostic.pointer === pointer || String(diagnostic.pointer).startsWith(`${pointer}/`),
    ),
  );

const ok = { "200": { description: "ok" } };

const keyScheme = { in: "header", name: "X-Api-Key", type: "apiKey" };

// A document of a line with the header scheme, one operation per path, and no root list.
const members = (line: Line, paths: Members): Members => ({
  components: { securitySchemes: { headerKey: keyScheme } },
  info: { title: "Security requirement rows", version: "1.0.0" },
  openapi: line,
  paths,
});

// A path item whose one operation has no `security`.
const unsecured = (operationId: string): Json => ({ get: { operationId, responses: ok } });

// A path item whose one operation has the given `security` list.
const operation = (operationId: string, security: Json): Json => ({
  get: { operationId, responses: ok, security },
});

// The emitted requirement constant of one operation in `src/api/root.ts`.
const requirement = (root: string | undefined, name: string): string | undefined =>
  root
    ?.split("\n")
    .find((text) => text.startsWith(`const ${name}Security: SecurityRequirement = `))
    ?.slice(`const ${name}Security: SecurityRequirement = `.length);

describe("SEC rows through generate()", () => {
  for (const line of lines) {
    test(`SEC-08: absent security is accepted and emits the same empty requirement as [] (${line})`, async () => {
      const found = await inProcess({
        entry: members(line, {
          "/absent": unsecured("absent"),
          "/empty": operation("empty", []),
        }),
        name: "openapi.json",
      });

      // Absent everywhere is `declared: false`, never a refusal (D-OQ10); the built CLI test above
      // shows that the empty requirement sends nothing.
      expect(summary(found.diagnostics)).toEqual([]);
      expect(found.commands).toEqual(["/paths/~1absent/get", "/paths/~1empty/get"]);
      expect([requirement(found.root, "absent"), requirement(found.root, "empty")]).toEqual([
        "[];",
        "[];",
      ]);
    }, 60_000);
  }

  test.todo('SEC-08: help for an operation with absent security shows no AUTH entry (the emitted help sections hold only REQUEST and RESPONSES) vs help says "no authentication documented" (design D-OQ10 (a))', () =>
    Promise.resolve());

  for (const line of ["3.0.4", "3.1.2"] as const) {
    test(`SEC-09: an undeclared name is an element refusal at the name while another alternative remains (${line})`, async () => {
      const found = await fixture(line);
      const refusals = at(found, "/paths/~1undeclared/get/security");

      expect(refusals).toContainEqual([
        "SEC-09",
        "SEC-09/unresolved-scheme",
        "refusal",
        "element",
        "/paths/~1undeclared/get/security/0/missingKey",
      ]);
      expect(refusals.map((entry) => [entry[0], entry[2], entry[3]])).toEqual(
        refusals.map(() => ["SEC-09", "refusal", "element"]),
      );
      expect(found.commands).toContain("/paths/~1undeclared/get");
    }, 60_000);

    test(`SEC-09: with no alternative left the operation is refused and not generated (${line})`, async () => {
      const found = await inProcess({
        entry: members(line, {
          "/kept": unsecured("kept"),
          "/lost": operation("lost", [{ missingKey: [] }]),
        }),
        name: "openapi.json",
      });
      const operationScope = summary(found.diagnostics).filter((entry) => entry[3] === "operation");

      expect(operationScope).toContainEqual([
        "SEC-09",
        "SEC-09/unresolved-scheme",
        "refusal",
        "operation",
        "/paths/~1lost/get/security/0/missingKey",
      ]);
      expect(found.commands).toEqual(["/paths/~1kept/get"]);
    }, 60_000);
  }

  test("SEC-10: a 3.2 name that is neither a component name nor a Security Scheme URI is refused at the name", async () => {
    const found = await fixture("3.2.1");

    expect(at(found, "/paths/~1undeclared/get/security")).toContainEqual([
      "SEC-10",
      "SEC-10/unresolved-scheme",
      "refusal",
      "element",
      "/paths/~1undeclared/get/security/0/missingKey",
    ]);
    // Component names and both URI forms resolve, so they raise nothing.
    expect(at(found, "/paths/~1by-fragment/get")).toEqual([]);
    expect(at(found, "/paths/~1by-relative/get")).toEqual([]);
    expect(found.commands).toContain("/paths/~1by-fragment/get");
    expect(found.commands).toContain("/paths/~1by-relative/get");
  }, 60_000);

  test.todo("SEC-10: a 3.2 undeclared requirement name also raises SEC-09/undeclared-scheme (row SEC-09, a 3.0.4 and 3.1.2 row) at the same pointer, from normalize, beside SEC-10/unresolved-scheme vs only SEC-10-rowed refusals on a 3.2 document", () =>
    Promise.resolve());

  test("SEC-10: names resolve from the entry document, so a URI into another document of the set is refused", async () => {
    const otherSchemes = {
      headerKey: { in: "header", name: "X-Other-Header", type: "apiKey" },
      otherKey: { in: "header", name: "X-Other", type: "apiKey" },
    };
    const found = await inProcess({
      entry: members("3.2.1", {
        "/same-name": operation("same-name", [
          { "other.json#/components/securitySchemes/headerKey": [] },
        ]),
        "/x": operation("x", [
          { "other.json#/components/securitySchemes/otherKey": [] },
          { headerKey: [] },
        ]),
      }),
      name: "openapi.json",
      others: {
        "other.json": {
          components: { securitySchemes: otherSchemes },
          info: { title: "Other", version: "1.0.0" },
          openapi: "3.2.1",
          paths: {},
        },
      },
    });

    expect(at(found, "/paths/~1x/get/security")).toContainEqual([
      "SEC-10",
      "SEC-10/unresolved-scheme",
      "refusal",
      "element",
      "/paths/~1x/get/security/0/other.json#~1components~1securitySchemes~1otherKey",
    ]);
    // A URI to a scheme named like an entry component is not that component.
    expect(at(found, "/paths/~1same-name/get/security")).toContainEqual([
      "SEC-10",
      "SEC-10/unresolved-scheme",
      "refusal",
      "operation",
      "/paths/~1same-name/get/security/0/other.json#~1components~1securitySchemes~1headerKey",
    ]);
    expect(found.commands).toEqual(["/paths/~1x/get"]);
    expect(requirement(found.root, "x")).toBe('[["headerKey"]];');
  }, 60_000);

  test("SEC-12: a 3.0 non-OAuth requirement with values is refused at element scope at the name", async () => {
    const found = await fixture("3.0.4");

    expect(at(found, "/paths/~1roles/get/security")).toEqual([
      [
        "SEC-12",
        "SEC-12/non-empty-scopes",
        "refusal",
        "element",
        "/paths/~1roles/get/security/0/headerKey",
      ],
    ]);
  }, 60_000);

  test("SEC-12: the same values in 3.1 raise no SEC-12 refusal", async () => {
    const found = await inProcess({
      entry: members("3.1.2", { "/roles": operation("roles", [{ headerKey: ["admin"] }]) }),
      name: "openapi.json",
    });

    expect(summary(found.diagnostics).filter(([row]) => row === "SEC-12")).toEqual([]);
  }, 60_000);
});
