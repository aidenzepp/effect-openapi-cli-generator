import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate, GenerateRefused } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Json } from "../../src/model/pointer.ts";
import { classifyVerdict } from "../../src/report/verdict.ts";
import { referenceAt, resolve } from "../../src/resolve/index.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The Milestone 2 witness for the 3.1 and 3.2 dialect keyword rows SCH-34 to SCH-66: one generated
// package per version line, built once, run against the capture server; the generation rows call
// `generate()` in process and the reference row calls the resolver. A row the product gets wrong is
// a `test.todo` with what was observed. SCH-54 (FMT-*) and SCH-58 (DSC-*) are delegated and SCH-47,
// SCH-48, SCH-53, SCH-60 and SCH-61 are informational, so none of them gets a test here.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixtures = nodePath.join(repoRoot, "corpus/fixtures/rows/sch-b");

type Line = "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.1.2", "3.2.1"];

const resolverLine = { "3.1.2": "3.1", "3.2.1": "3.2" } as const;

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// Generated packages live under the worktree's git-ignored `work/`, never the system temp
// directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "wt-sch-b-"));

const priorTmpdir = process.env.TMPDIR;

process.env.TMPDIR = work;

interface Members {
  readonly [key: string]: Json;
}

const readJson = (file: string): Members =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
    nodeFs.readFileSync(file, "utf-8"),
  );

const authorConfig = readJson(nodePath.join(fixtures, "author-config.json"));

const specOf = (line: Line): Members => readJson(nodePath.join(fixtures, `${line}.json`));

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

const scope = Effect.runSync(Scope.make());

const packages = new Map<Line, GeneratedPackage>();

interface Generated {
  readonly diagnostics: readonly Diagnostic[];
  readonly reported: readonly Diagnostic[];
}

// The in-process generation of each line's fixture: the notices its rows assert.
const fixtureRuns = new Map<Line, Generated>();

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const decodeDocument = Schema.decodeUnknownSync(DocumentUri);

let counter = 0;

// In process generation of a document; the diagnostics of a refused run are the refusal's.
const inProcess = async (document: Members): Promise<Generated> => {
  counter += 1;
  const dir = nodePath.join(work, `case-${counter}`);
  nodeFs.mkdirSync(dir, { recursive: true });

  const specPath = nodePath.join(dir, "openapi.json");
  const configPath = nodePath.join(dir, "author-config.json");

  nodeFs.writeFileSync(specPath, JSON.stringify(document));
  nodeFs.writeFileSync(configPath, JSON.stringify(authorConfig));

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
    return { diagnostics: exit.value.diagnostics, reported: exit.value.report.notices };
  }

  const [failure] = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" && reason.error instanceof GenerateRefused ? [reason.error] : [],
  );
  if (failure === undefined) {
    throw new Error(`generate failed for a reason other than a refusal: ${String(exit.cause)}`);
  }

  return { diagnostics: failure.diagnostics, reported: [] };
};

// Files the operator names on the command line, written once under the scratch directory.
const inputs = {
  bytes: nodePath.join(work, "bytes.bin"),
  png: nodePath.join(work, "picture.bin"),
  xml: nodePath.join(work, "item.xml"),
};

const xmlText = '<item a="x"><b>1</b></item>';

beforeAll(async () => {
  nodeFs.writeFileSync(inputs.bytes, Buffer.from([0xfb, 0xff]));
  nodeFs.writeFileSync(inputs.png, "abc\u0001");
  nodeFs.writeFileSync(inputs.xml, xmlText);
  capture.script("/write-only", {
    body: '{"id":"1"}',
    headers: [["content-type", "application/json"]],
    status: 200,
  });

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

  // The fixtures' in-process generations, also one after the other.
  const runs = await Effect.runPromise(
    Effect.forEach(
      lines,
      (line) =>
        Effect.promise(() => inProcess(specOf(line))).pipe(
          Effect.map((found) => [line, found] as const),
        ),
      { concurrency: 1 },
    ),
  );
  for (const [line, found] of runs) {
    fixtureRuns.set(line, found);
  }
}, 900_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  nodeFs.rmSync(work, { force: true, recursive: true });
  process.env.TMPDIR = priorTmpdir;
});

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf-8");

const header = (request: RecordedRequest, name: string): string | undefined =>
  request.headers.find(([key]) => key.toLowerCase() === name)?.[1];

// What one invocation did: its exit code, stdout and every request it sent.
interface Invoked {
  readonly exitCode: number | null;
  readonly requests: readonly RecordedRequest[];
  readonly stdout: string;
}

// One invocation of the line's built CLI against the capture server. `runBin` is asynchronous, so
// the in-process server keeps answering.
const invoke = async (line: Line, args: readonly string[]): Promise<Invoked> => {
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
    stdout: text(result.stdout),
  };
};

// What one invocation did: its exit code and the target and body of every request it sent.
interface Outcome {
  readonly exitCode: number | null;
  readonly sent: readonly (readonly [target: string, body: string])[];
}

const outcomeOf = (invoked: Invoked): Outcome => ({
  exitCode: invoked.exitCode,
  sent: invoked.requests.map((request) => [request.target, text(request.body)] as const),
});

const run = async (line: Line, args: readonly string[]): Promise<Outcome> =>
  outcomeOf(await invoke(line, args));

// One invocation with `--body`.
const send = (line: Line, command: string, body: string): Promise<Outcome> =>
  run(line, [command, "--body", body]);

// The body went out once, byte for byte as given.
const sentAsGiven = (command: string, body: string): Outcome => ({
  exitCode: 0,
  sent: [[`/${command}`, body]],
});

// A usage error before anything was sent.
const rejectedBeforeSending: Outcome = { exitCode: 2, sent: [] };

const summary = (diagnostics: readonly Diagnostic[]) =>
  diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.severity,
    diagnostic.scope,
    String(diagnostic.pointer),
  ]);

const fixtureRun = (line: Line): Generated => {
  const found = fixtureRuns.get(line);
  if (found === undefined) {
    throw new Error(`no in-process generation for ${line}`);
  }

  return found;
};

// The fixture's diagnostics of one row, and the same diagnostics in the report's notice list,
// which the verdict counts; notices never change the verdict class.
const noticesOf = (line: Line, row: string) => {
  const found = fixtureRun(line);
  const ofRow = (diagnostic: Diagnostic): boolean => diagnostic.row === row;

  return {
    diagnostics: summary(found.diagnostics.filter(ofRow)),
    reported: summary(found.reported.filter(ofRow)),
    verdict: classifyVerdict(found.diagnostics),
  };
};

const schemaAt = (command: string): string =>
  `/paths/~1${command}/post/requestBody/content/application~1json/schema`;

// A server-validated keyword: one notice at the keyword, counted in the report and the verdict.
const notAsserted = (row: string, pointer: string) => {
  const notice = [`${row}/not-asserted`, "notice", "element", pointer];

  return { diagnostics: [notice], reported: [notice], verdict: "accepted" as const };
};

// An SCH-37 element notice at a command's body schema `pattern`.
const patternNotice = (command: string, code: string) => [
  `SCH-37/${code}`,
  "notice",
  "element",
  `${schemaAt(command)}/pattern`,
];

const noNotices = { diagnostics: [], reported: [], verdict: "accepted" as const };

// The target the resolver gives the schema `$ref` of a command's request body.
const targetOf = (line: Line, command: string): string | undefined => {
  const resolution = Effect.runSync(
    resolve({
      document: decodeDocument(`file:///fixture/${line}.json`),
      line: resolverLine[line],
      value: specOf(line),
    }),
  );

  return referenceAt(resolution, schemaAt(command))?.target.pointer;
};

const ok: Members = { "200": { description: "ok" } };

// A one-operation document of a line whose request body has the given schema.
const withBody = (line: Line, required: boolean, schema: Members): Members => ({
  info: { title: "SCH rows", version: "1.0.0" },
  openapi: line,
  paths: {
    "/a": {
      post: {
        operationId: "a",
        requestBody: { content: { "application/json": { schema } }, required },
        responses: ok,
      },
    },
  },
});

const bodySchema = "/paths/~1a/post/requestBody/content/application~1json/schema";

const rowDiagnostics = (found: Generated, row: string) =>
  summary(found.diagnostics.filter((diagnostic) => diagnostic.row === row));

describe("SCH-34 to SCH-66 through the built CLI, the resolver and generate()", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`SCH-34: input violating a numeric exclusiveMinimum is rejected before send (${line})`, async () => {
        const above = await send(line, "exclusive-minimum", "0.5");
        const bound = await send(line, "exclusive-minimum", "0");

        expect([above, bound]).toEqual([
          sentAsGiven("exclusive-minimum", "0.5"),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`SCH-35: input violating maxLength is rejected before send (${line})`, async () => {
        const bound = await send(line, "max-length", '"abc"');
        const longer = await send(line, "max-length", '"abcd"');

        expect([bound, longer]).toEqual([
          sentAsGiven("max-length", '"abc"'),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`SCH-36: input violating minLength is rejected before send (${line})`, async () => {
        const bound = await send(line, "min-length", '"ab"');
        const shorter = await send(line, "min-length", '"a"');

        expect([bound, shorter]).toEqual([
          sentAsGiven("min-length", '"ab"'),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`SCH-37: pattern is not asserted, a violating value is sent as given, and a pattern that does not compile with the u flag is an element notice (${line})`, async () => {
        const violating = await send(line, "pattern", '"b"');
        const unicode = await send(line, "pattern-unicode", '"x"');
        const expected = [
          patternNotice("pattern", "not-asserted"),
          patternNotice("pattern-unicode", "not-asserted"),
          patternNotice("pattern-unicode", "not-unicode-compilable"),
        ];

        expect([violating, unicode]).toEqual([
          sentAsGiven("pattern", '"b"'),
          sentAsGiven("pattern-unicode", '"x"'),
        ]);
        expect(noticesOf(line, "SCH-37")).toEqual({
          diagnostics: expected,
          reported: expected,
          verdict: "accepted",
        });
      }, 60_000);

      test(`SCH-38: input violating maxItems is rejected before send (${line})`, async () => {
        const bound = await send(line, "max-items", "[1,2]");
        const more = await send(line, "max-items", "[1,2,3]");

        expect([bound, more]).toEqual([sentAsGiven("max-items", "[1,2]"), rejectedBeforeSending]);
      }, 60_000);

      test(`SCH-39: input violating minItems is rejected before send (${line})`, async () => {
        const bound = await send(line, "min-items", "[1]");
        const empty = await send(line, "min-items", "[]");

        expect([bound, empty]).toEqual([sentAsGiven("min-items", "[1]"), rejectedBeforeSending]);
      }, 60_000);

      test(`SCH-40: input violating uniqueItems is rejected before send (${line})`, async () => {
        const distinct = await send(line, "unique-items", "[1,2]");
        const repeated = await send(line, "unique-items", "[1,1]");

        expect([distinct, repeated]).toEqual([
          sentAsGiven("unique-items", "[1,2]"),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`SCH-41: maxContains is not asserted; a violating value is sent exactly as given (${line})`, async () => {
        const violating = await send(line, "max-contains", '["a", "b"]');

        expect(violating).toEqual(sentAsGiven("max-contains", '["a", "b"]'));
        expect(noticesOf(line, "SCH-41")).toEqual(
          notAsserted("SCH-41", `${schemaAt("max-contains")}/maxContains`),
        );
      }, 60_000);

      test(`SCH-42: minContains is not asserted; a violating value is sent exactly as given (${line})`, async () => {
        const violating = await send(line, "min-contains", '["a"]');

        expect(violating).toEqual(sentAsGiven("min-contains", '["a"]'));
        expect(noticesOf(line, "SCH-42")).toEqual(
          notAsserted("SCH-42", `${schemaAt("min-contains")}/minContains`),
        );
      }, 60_000);

      test(`SCH-43: input violating maxProperties is rejected before send (${line})`, async () => {
        const bound = await send(line, "max-properties", '{"a":1}');
        const more = await send(line, "max-properties", '{"a":1,"b":2}');

        expect([bound, more]).toEqual([
          sentAsGiven("max-properties", '{"a":1}'),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`SCH-44: input violating minProperties is rejected before send (${line})`, async () => {
        const bound = await send(line, "min-properties", '{"a":1}');
        const empty = await send(line, "min-properties", "{}");

        expect([bound, empty]).toEqual([
          sentAsGiven("min-properties", '{"a":1}'),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`SCH-45: input violating required is rejected before send (${line})`, async () => {
        const present = await send(line, "required", '{"a":"x"}');
        const missing = await send(line, "required", "{}");
        const writableOmitted = await send(line, "read-only", '{"id":"1"}');

        expect([present, missing, writableOmitted]).toEqual([
          sentAsGiven("required", '{"a":"x"}'),
          rejectedBeforeSending,
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test.todo(`SCH-45: a request omitting a required read-only property is rejected before send (exit 2, nothing sent) vs sent as given (${line})`, () =>
        Promise.resolve());

      test(`SCH-46: dependentRequired is not asserted; a violating value is sent exactly as given (${line})`, async () => {
        const violating = await send(line, "dependent-required", '{"a": 1}');

        expect(violating).toEqual(sentAsGiven("dependent-required", '{"a": 1}'));
        expect(noticesOf(line, "SCH-46")).toEqual(
          notAsserted("SCH-46", `${schemaAt("dependent-required")}/dependentRequired`),
        );
      }, 60_000);

      test(`SCH-49: an omitted flag with a default sends nothing for it (${line})`, async () => {
        const omitted = await run(line, ["annotated", "--name", "x"]);

        expect(omitted).toEqual(sentAsGiven("annotated", '{"name":"x"}'));
      }, 60_000);

      test.todo(`SCH-49: help for a body field with default 10 shows "--size integer (body /size)" with no default vs showing 10 (${line})`, () =>
        Promise.resolve());

      test.todo(`SCH-50: help for a deprecated body field shows "--legacy string (body /legacy)" vs marking it deprecated (${line})`, () =>
        Promise.resolve());

      test(`SCH-51: an operator-supplied read-only property is sent (${line})`, async () => {
        const supplied = await send(line, "read-only", '{"id":"1","name":"x"}');

        expect(supplied).toEqual(sentAsGiven("read-only", '{"id":"1","name":"x"}'));
      }, 60_000);

      test.todo(`SCH-51: help for a read-only body field shows "--id string (body /id)" vs noting it is read-only (${line})`, () =>
        Promise.resolve());

      test(`SCH-52: a required writeOnly property absent from a response is not an error (${line})`, async () => {
        const fetched = await invoke(line, ["write-only"]);

        expect([fetched.exitCode, JSON.parse(fetched.stdout)]).toEqual([0, { id: "1" }]);
      }, 60_000);

      test(`SCH-55: a contentEncoding base64 field reads a file and sends its base64 (${line})`, async () => {
        const encoded = await run(line, ["content-encoding", "--data", inputs.bytes]);

        expect(encoded).toEqual(sentAsGiven("content-encoding", '{"data":"+/8="}'));
      }, 60_000);

      test(`SCH-56: a contradicting contentMediaType is ignored; the file is sent as the body media type (${line})`, async () => {
        const uploaded = await invoke(line, ["content-media-type", "--body-file", inputs.png]);
        const [request] = uploaded.requests;

        expect([
          uploaded.exitCode,
          uploaded.requests.length,
          request === undefined ? undefined : header(request, "content-type"),
          request === undefined ? undefined : text(request.body),
        ]).toEqual([0, 1, "application/octet-stream", "abc\u0001"]);
      }, 60_000);

      test(`SCH-57: contentSchema is not asserted; a violating value is sent exactly as given (${line})`, async () => {
        const violating = await send(line, "content-schema", '"{}"');

        expect(violating).toEqual(sentAsGiven("content-schema", '"{}"'));
        expect(noticesOf(line, "SCH-57")).toEqual(
          notAsserted("SCH-57", `${schemaAt("content-schema")}/contentSchema`),
        );
      }, 60_000);

      test(`SCH-59: an XML body is opaque, so its schema's xml is never consulted and the file is sent byte for byte (${line})`, async () => {
        const uploaded = await invoke(line, ["xml", "--body-file", inputs.xml]);
        const [request] = uploaded.requests;

        expect([
          uploaded.exitCode,
          uploaded.requests.length,
          request === undefined ? undefined : header(request, "content-type"),
          request === undefined ? undefined : text(request.body),
        ]).toEqual([0, 1, "application/xml", xmlText]);
        expect(noticesOf(line, "SCH-59")).toEqual(noNotices);
      }, 60_000);

      test.todo(`SCH-59: INCONCLUSIVE: no request body is ever built from its schema as XML (XML bodies are opaque, D-SCH3), so the schema-driven XML refusal has no site (${line})`, () =>
        Promise.resolve());

      test(`SCH-62: an unknown keyword does not change validation (${line})`, async () => {
        const inside = await send(line, "unknown-keyword", "3");
        const bound = await send(line, "unknown-keyword", "5");
        const above = await send(line, "unknown-keyword", "6");

        expect([inside, bound, above]).toEqual([
          sentAsGiven("unknown-keyword", "3"),
          sentAsGiven("unknown-keyword", "5"),
          rejectedBeforeSending,
        ]);
        expect(noticesOf(line, "SCH-62")).toEqual(noNotices);
      }, 60_000);

      test(`SCH-63: a $ref into definitions resolves by JSON Pointer to a schema that then applies (${line})`, async () => {
        const target = targetOf(line, "definitions");
        const inside = await send(line, "definitions", "5");
        const above = await send(line, "definitions", "6");

        expect(target).toBe("/components/schemas/Legacy/definitions/Small");
        expect([inside, above]).toEqual([sentAsGiven("definitions", "5"), rejectedBeforeSending]);
      }, 60_000);

      test.todo(`SCH-64: a request schema declaring dependencies generates with no diagnostic vs refused at element scope (${line})`, () =>
        Promise.resolve());

      test(`SCH-65: $recursiveAnchor is refused at element scope at the schema (${line})`, async () => {
        const found = await inProcess(
          withBody(line, false, { $recursiveAnchor: true, type: "object" }),
        );

        expect(rowDiagnostics(found, "SCH-65")).toEqual([
          ["SCH-65/recursive-anchor", "refusal", "element", bodySchema],
        ]);
      });

      test.todo(`SCH-65: a $recursiveAnchor that a required body depends on is refused at element scope only vs raised to operation scope (${line})`, () =>
        Promise.resolve());

      test(`SCH-66: $recursiveRef is refused at element scope at the schema (${line})`, async () => {
        const found = await inProcess(withBody(line, false, { $recursiveRef: "#" }));

        expect(rowDiagnostics(found, "SCH-66")).toEqual([
          ["SCH-66/recursive-ref", "refusal", "element", bodySchema],
        ]);
      });

      test.todo(`SCH-66: a $recursiveRef that a required body depends on is refused at element scope only vs raised to operation scope (${line})`, () =>
        Promise.resolve());
    });
  }
});
