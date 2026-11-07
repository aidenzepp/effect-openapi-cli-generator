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
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The Milestone 2 witness for the 3.0 schema keyword rows S30-02 to S30-36 and the Schema Object
// rule rows SCO-02 to SCO-10: one generated package per version line, built once, run against the
// capture server; the generation rows call `generate()` in process. A row the product gets wrong
// is a `test.todo` with what was observed. SCO-01 (keyword rows), S30-26 (FMT-*) and S30-29
// (DSC-*) are delegated and S30-01, S30-25, S30-34, S30-35 and SCO-06 are informational, so none
// of them gets a test here.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixtures = nodePath.join(repoRoot, "corpus/fixtures/rows/s30");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const laterLines = ["3.1.2", "3.2.1"] as const;

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// Generated packages live under the worktree's git-ignored `work/`, never the system temp
// directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "wt-s30-"));

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

const xmlText = '<item a="x"><b>1</b></item>';

// Files the operator names on the command line, written once under the scratch directory.
const inputs = { xml: nodePath.join(work, "item.xml") };

beforeAll(async () => {
  nodeFs.writeFileSync(inputs.xml, xmlText);
  capture.script("/write-only", {
    body: '{"id":"1"}',
    headers: [["content-type", "application/json"]],
    status: 200,
  });
  capture.script("/xml-response", {
    body: xmlText,
    headers: [["content-type", "application/xml"]],
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

const run = async (line: Line, args: readonly string[]): Promise<Outcome> => {
  const invoked = await invoke(line, args);

  return {
    exitCode: invoked.exitCode,
    sent: invoked.requests.map((request) => [request.target, text(request.body)] as const),
  };
};

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

// The help lines of a command that describe one flag.
const helpRows = async (line: Line, command: string, flag: string): Promise<readonly string[]> => {
  const help = await invoke(line, [command, "--help"]);

  return help.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${flag} `));
};

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

// An S30-09 element notice at a command's body schema `pattern`.
const patternNotice = (command: string, code: string) => [
  `S30-09/${code}`,
  "notice",
  "element",
  `${schemaAt(command)}/pattern`,
];

const ok: Members = { "200": { description: "ok" } };

// A one-operation document of a line whose optional request body has the given schema.
const withBody = (line: Line, schema: Json, schemas: Members = {}): Members => ({
  components: { schemas },
  info: { title: "S30 rows", version: "1.0.0" },
  openapi: line,
  paths: {
    "/a": {
      post: {
        operationId: "a",
        requestBody: { content: { "application/json": { schema } }, required: false },
        responses: ok,
      },
    },
  },
});

const bodySchema = "/paths/~1a/post/requestBody/content/application~1json/schema";

const rowDiagnostics = (found: Generated, row: string) =>
  summary(found.diagnostics.filter((diagnostic) => diagnostic.row === row));

// The validation row that reports a schema outside a line's own meta-schema.
const validationRow = { "3.0.4": "VAL-02", "3.1.2": "VAL-03", "3.2.1": "VAL-04" } as const;

describe("S30-02 to S30-36 through the built 3.0.4 CLI and generate()", () => {
  const line = "3.0.4";

  test("S30-02: input violating multipleOf is rejected before send (3.0.4)", async () => {
    const multiple = await send(line, "multiple-of", "6");
    const other = await send(line, "multiple-of", "7");

    expect([multiple, other]).toEqual([sentAsGiven("multiple-of", "6"), rejectedBeforeSending]);
  }, 60_000);

  test("S30-03: input violating maximum is rejected before send (3.0.4)", async () => {
    const bound = await send(line, "maximum", "10");
    const above = await send(line, "maximum", "11");

    expect([bound, above]).toEqual([sentAsGiven("maximum", "10"), rejectedBeforeSending]);
  }, 60_000);

  test("S30-04: a boolean exclusiveMaximum makes maximum exclusive, rejected before send (3.0.4)", async () => {
    const below = await send(line, "exclusive-maximum", "9.5");
    const bound = await send(line, "exclusive-maximum", "10");

    expect([below, bound]).toEqual([
      sentAsGiven("exclusive-maximum", "9.5"),
      rejectedBeforeSending,
    ]);
  }, 60_000);

  test("S30-05: input violating minimum is rejected before send (3.0.4)", async () => {
    const bound = await send(line, "minimum", "1");
    const below = await send(line, "minimum", "0");

    expect([bound, below]).toEqual([sentAsGiven("minimum", "1"), rejectedBeforeSending]);
  }, 60_000);

  test("S30-06: a boolean exclusiveMinimum makes minimum exclusive, rejected before send (3.0.4)", async () => {
    const above = await send(line, "exclusive-minimum", "1.5");
    const bound = await send(line, "exclusive-minimum", "1");

    expect([above, bound]).toEqual([
      sentAsGiven("exclusive-minimum", "1.5"),
      rejectedBeforeSending,
    ]);
  }, 60_000);

  test("S30-07: input violating maxLength is rejected before send (3.0.4)", async () => {
    const bound = await send(line, "max-length", '"abc"');
    const longer = await send(line, "max-length", '"abcd"');

    expect([bound, longer]).toEqual([sentAsGiven("max-length", '"abc"'), rejectedBeforeSending]);
  }, 60_000);

  test("S30-08: input violating minLength is rejected before send (3.0.4)", async () => {
    const bound = await send(line, "min-length", '"ab"');
    const shorter = await send(line, "min-length", '"a"');

    expect([bound, shorter]).toEqual([sentAsGiven("min-length", '"ab"'), rejectedBeforeSending]);
  }, 60_000);

  test("S30-09: pattern is not asserted, a violating value is sent as given, and a pattern that does not compile with the u flag is an element notice (3.0.4)", async () => {
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
    expect(noticesOf(line, "S30-09")).toEqual({
      diagnostics: expected,
      reported: expected,
      verdict: "accepted",
    });
  }, 60_000);

  test("S30-10: input violating maxItems is rejected before send (3.0.4)", async () => {
    const bound = await send(line, "max-items", "[1,2]");
    const more = await send(line, "max-items", "[1,2,3]");

    expect([bound, more]).toEqual([sentAsGiven("max-items", "[1,2]"), rejectedBeforeSending]);
  }, 60_000);

  test("S30-11: input violating minItems is rejected before send (3.0.4)", async () => {
    const bound = await send(line, "min-items", "[1]");
    const empty = await send(line, "min-items", "[]");

    expect([bound, empty]).toEqual([sentAsGiven("min-items", "[1]"), rejectedBeforeSending]);
  }, 60_000);

  test("S30-12: input violating uniqueItems is rejected before send (3.0.4)", async () => {
    const unique = await send(line, "unique-items", "[1,2]");
    const repeated = await send(line, "unique-items", "[1,1]");

    expect([unique, repeated]).toEqual([
      sentAsGiven("unique-items", "[1,2]"),
      rejectedBeforeSending,
    ]);
  }, 60_000);

  test("S30-13: input violating maxProperties is rejected before send (3.0.4)", async () => {
    const bound = await send(line, "max-properties", '{"a":1}');
    const more = await send(line, "max-properties", '{"a":1,"b":2}');

    expect([bound, more]).toEqual([
      sentAsGiven("max-properties", '{"a":1}'),
      rejectedBeforeSending,
    ]);
  }, 60_000);

  test("S30-14: input violating minProperties is rejected before send (3.0.4)", async () => {
    const bound = await send(line, "min-properties", '{"a":1}');
    const empty = await send(line, "min-properties", "{}");

    expect([bound, empty]).toEqual([
      sentAsGiven("min-properties", '{"a":1}'),
      rejectedBeforeSending,
    ]);
  }, 60_000);

  test("S30-15: input violating required is rejected before send (3.0.4)", async () => {
    const present = await send(line, "required", '{"a":"x"}');
    const missing = await send(line, "required", "{}");

    expect([present, missing]).toEqual([
      sentAsGiven("required", '{"a":"x"}'),
      rejectedBeforeSending,
    ]);
  }, 60_000);

  test("S30-16: a scalar enum is asserted; an object enum is a notice and sent as given (3.0.4)", async () => {
    const member = await send(line, "enum-scalar", '"a"');
    const outside = await send(line, "enum-scalar", '"c"');
    const flagged = await run(line, ["enum-flag", "--color", "green"]);
    const object = await send(line, "enum-object", '{"a": 2}');

    expect([member, outside, flagged, object]).toEqual([
      sentAsGiven("enum-scalar", '"a"'),
      rejectedBeforeSending,
      rejectedBeforeSending,
      sentAsGiven("enum-object", '{"a": 2}'),
    ]);
    expect(noticesOf(line, "S30-16")).toEqual(
      notAsserted("S30-16", `${schemaAt("enum-object")}/enum`),
    );
  }, 60_000);

  test("S30-16: help lists the values of an enum body field (3.0.4)", async () => {
    const rows = await helpRows(line, "enum-flag", "--color");

    expect(rows.map((entry) => entry.endsWith("(body /color; choices: red, blue)"))).toEqual([
      true,
    ]);
  }, 60_000);

  test("S30-17: input violating a single type is rejected before send; a type list is refused by validation (3.0.4)", async () => {
    const integer = await send(line, "integer", "1");
    const word = await send(line, "integer", '"s"');
    const list = await inProcess(withBody(line, { type: ["string", "null"] }));

    expect([integer, word]).toEqual([sentAsGiven("integer", "1"), rejectedBeforeSending]);
    expect(summary(list.diagnostics)).toEqual([
      ["VAL-02/schema-invalid", "refusal", "document", `${bodySchema}/type`],
    ]);
  }, 60_000);

  test("S30-18: input violating allOf is rejected before send (3.0.4)", async () => {
    const valid = await send(line, "all-of", '{"a":"x","b":1}');
    const invalid = await send(line, "all-of", '{"a":"x"}');

    expect([valid, invalid]).toEqual([
      sentAsGiven("all-of", '{"a":"x","b":1}'),
      rejectedBeforeSending,
    ]);
  }, 60_000);

  test("S30-19: input violating oneOf is rejected before send (3.0.4)", async () => {
    const word = await send(line, "one-of", '"x"');
    const neither = await send(line, "one-of", "true");

    expect([word, neither]).toEqual([sentAsGiven("one-of", '"x"'), rejectedBeforeSending]);
  }, 60_000);

  test("S30-20: input violating anyOf is rejected before send (3.0.4)", async () => {
    const word = await send(line, "any-of", '"x"');
    const number = await send(line, "any-of", "1");
    const neither = await send(line, "any-of", "true");

    expect([word, number, neither]).toEqual([
      sentAsGiven("any-of", '"x"'),
      sentAsGiven("any-of", "1"),
      rejectedBeforeSending,
    ]);
  }, 60_000);

  test("S30-21: not {} is asserted; any other not is a notice and the value is sent as given (3.0.4)", async () => {
    const absent = await send(line, "not-empty", "{}");
    const present = await send(line, "not-empty", '{"never":1}');
    const violating = await send(line, "not-other", '{"value": 1}');

    expect([absent, present, violating]).toEqual([
      sentAsGiven("not-empty", "{}"),
      rejectedBeforeSending,
      sentAsGiven("not-other", '{"value": 1}'),
    ]);
    expect(noticesOf(line, "S30-21")).toEqual(
      notAsserted("S30-21", `${schemaAt("not-other")}/properties/value/not`),
    );
  }, 60_000);

  test("S30-22: input violating items is rejected before send; an array schema without items is refused at element scope (3.0.4)", async () => {
    const valid = await send(line, "items", "[1,2]");
    const invalid = await send(line, "items", '[1,"x"]');
    const bare = await inProcess(withBody(line, { type: "array" }));

    expect([valid, invalid]).toEqual([sentAsGiven("items", "[1,2]"), rejectedBeforeSending]);
    expect(rowDiagnostics(bare, "S30-22")).toEqual([
      ["S30-22/array-without-items", "refusal", "element", `${bodySchema}/items`],
    ]);
  }, 60_000);

  test("S30-23: input violating properties is rejected before send (3.0.4)", async () => {
    const valid = await send(line, "properties", '{"n":1}');
    const invalid = await send(line, "properties", '{"n":"x"}');

    expect([valid, invalid]).toEqual([sentAsGiven("properties", '{"n":1}'), rejectedBeforeSending]);
  }, 60_000);

  test("S30-24: input violating a schema-valued additionalProperties is rejected before send (3.0.4)", async () => {
    const map = await send(line, "additional-map", '{"z":1}');
    const wrongValue = await send(line, "additional-map", '{"z":"x"}');
    const declared = await send(line, "additional-properties", '{"a":"x"}');

    expect([map, wrongValue, declared]).toEqual([
      sentAsGiven("additional-map", '{"z":1}'),
      rejectedBeforeSending,
      sentAsGiven("additional-properties", '{"a":"x"}'),
    ]);
  }, 60_000);

  test("S30-27: an omitted flag with a default sends nothing for it (3.0.4)", async () => {
    const omitted = await run(line, ["annotated", "--name", "x"]);

    expect(omitted).toEqual(sentAsGiven("annotated", '{"name":"x"}'));
  }, 60_000);

  test("S30-28: nullable with a type admits null; an enum without null still forbids it (3.0.4)", async () => {
    const nothing = await send(line, "nullable", "null");
    const word = await send(line, "nullable", '"s"');
    const member = await send(line, "nullable-enum", '"a"');

    expect([nothing, word, member]).toEqual([
      sentAsGiven("nullable", "null"),
      sentAsGiven("nullable", '"s"'),
      sentAsGiven("nullable-enum", '"a"'),
    ]);
  }, 60_000);

  test("S30-24: an undeclared key under additionalProperties false is rejected before send (3.0.4)", async () => {
    const extra = await send(line, "additional-properties", '{"a":"x","z":1}');

    expect(extra).toEqual(rejectedBeforeSending);
  }, 60_000);

  test("S30-27: help shows a body field's default (3.0.4)", async () => {
    const rows = await helpRows(line, "annotated", "--size");

    expect(rows.map((entry) => entry.endsWith("(body /size; default: 10)"))).toEqual([true]);
  }, 60_000);

  test('S30-27: a default "x" on an integer schema is refused at element scope (3.0.4)', async () => {
    const found = await inProcess(
      withBody(line, { properties: { n: { default: "x", type: "integer" } }, type: "object" }),
    );

    expect(rowDiagnostics(found, "S30-27")).toEqual([
      ["S30-27/nonconforming-default", "refusal", "element", `${bodySchema}/properties/n`],
    ]);
  });

  test("S30-28: null for a nullable enum without null is rejected before send (3.0.4)", async () => {
    const nothing = await send(line, "nullable-enum", "null");

    expect(nothing).toEqual(rejectedBeforeSending);
  }, 60_000);

  test("S30-31: a read-only body property is not offered as a flag (3.0.4)", async () => {
    const rows = await helpRows(line, "read-only", "--id");
    const flagged = await run(line, ["read-only", "--id", "1", "--name", "x"]);

    expect([rows, flagged]).toEqual([[], rejectedBeforeSending]);
  }, 60_000);

  test("S30-36: help marks a deprecated body field (3.0.4)", async () => {
    const rows = await helpRows(line, "annotated", "--legacy");

    expect(rows.map((entry) => entry.endsWith("(body /legacy; deprecated)"))).toEqual([true]);
  }, 60_000);

  test("S30-30: readOnly and writeOnly both true is refused at element scope (3.0.4)", async () => {
    const found = await inProcess(
      withBody(line, { readOnly: true, type: "string", writeOnly: true }),
    );

    expect(rowDiagnostics(found, "S30-30")).toEqual([
      ["S30-30/read-and-write-only", "refusal", "element", bodySchema],
    ]);
  });

  test("S30-31: a required read-only property is not required in a request (3.0.4)", async () => {
    const omitted = await send(line, "read-only", '{"name":"x"}');
    const flags = await run(line, ["read-only", "--name", "x"]);

    expect([omitted, flags]).toEqual([
      sentAsGiven("read-only", '{"name":"x"}'),
      sentAsGiven("read-only", '{"name":"x"}'),
    ]);
  }, 60_000);

  test("S30-32: a required writeOnly property absent from a response is not an error (3.0.4)", async () => {
    const fetched = await invoke(line, ["write-only"]);

    expect([fetched.exitCode, JSON.parse(fetched.stdout)]).toEqual([0, { id: "1" }]);
  }, 60_000);

  test("S30-33: an XML body is opaque, so its schema's xml is never consulted and the file is sent byte for byte (3.0.4)", async () => {
    const uploaded = await invoke(line, ["xml", "--body-file", inputs.xml]);
    const [request] = uploaded.requests;

    expect([
      uploaded.exitCode,
      uploaded.requests.length,
      request === undefined ? undefined : header(request, "content-type"),
      request === undefined ? undefined : text(request.body),
    ]).toEqual([0, 1, "application/xml", xmlText]);
  }, 60_000);

  test.todo("S30-33: INCONCLUSIVE: no request body is ever built from its schema as XML (XML bodies are opaque, D-SCH3), so the schema-driven XML refusal has no site (3.0.4)", () =>
    Promise.resolve());

  test("SCO-02: const in a 3.0 schema is refused at its pointer (3.0.4)", async () => {
    const found = await inProcess(withBody(line, { const: "x", type: "string" }));

    expect(summary(found.diagnostics)).toEqual([
      ["VAL-02/schema-invalid", "refusal", "document", `${bodySchema}/const`],
    ]);
  });
});

describe("SCO-03 to SCO-10 through the built CLIs and generate()", () => {
  for (const line of laterLines) {
    test(`SCO-03: a true schema admits any body and a false property schema rejects its key before send (${line})`, async () => {
      const anything = await send(line, "boolean-true", '{"any":[1]}');
      const absent = await send(line, "boolean-false", "{}");
      const present = await send(line, "boolean-false", '{"never":1}');

      expect([anything, absent, present]).toEqual([
        sentAsGiven("boolean-true", '{"any":[1]}'),
        sentAsGiven("boolean-false", "{}"),
        rejectedBeforeSending,
      ]);
    }, 60_000);

    test(`SCO-04: a schema whose $schema names another dialect is refused at its pointer (${line})`, async () => {
      const found = await inProcess(
        withBody(line, { $schema: "https://json-schema.org/draft-07/schema#", type: "string" }),
      );

      expect(summary(found.diagnostics)).toEqual([
        [`${validationRow[line]}/schema-invalid`, "refusal", "document", `${bodySchema}/$schema`],
      ]);
    });

    test(`SCO-07: $dynamicRef and $dynamicAnchor are refused at element scope (${line})`, async () => {
      const found = await inProcess(
        withBody(
          line,
          { $dynamicRef: "#node" },
          { Node: { $dynamicAnchor: "node", type: "object" } },
        ),
      );

      expect([rowDiagnostics(found, "SCH-05"), rowDiagnostics(found, "SCH-06")]).toEqual([
        [["SCH-05/dynamic-ref", "refusal", "element", bodySchema]],
        [["SCH-06/dynamic-anchor", "refusal", "element", "/components/schemas/Node"]],
      ]);
    });

    test(`SCO-08: a value not matching format is sent unchanged (${line})`, async () => {
      const violating = await send(line, "format", '"not a date"');

      expect(violating).toEqual(sentAsGiven("format", '"not a date"'));
      expect(noticesOf(line, "SCH-54")).toEqual(
        notAsserted("SCH-54", `${schemaAt("format")}/format`),
      );
    }, 60_000);
  }

  for (const line of lines) {
    test(`SCO-05: 1.0 is accepted for integer and sent as given (${line})`, async () => {
      const whole = await send(line, "integer", "1.0");
      const fraction = await send(line, "integer", "1.5");

      expect([whole, fraction]).toEqual([sentAsGiven("integer", "1.0"), rejectedBeforeSending]);
    }, 60_000);

    test(`SCO-09: input violating an allOf composition through a $ref is rejected before send (${line})`, async () => {
      const valid = await send(line, "composition", '{"a":"x","b":1}');
      const noBase = await send(line, "composition", '{"b":1}');
      const noOwn = await send(line, "composition", '{"a":"x"}');

      expect([valid, noBase, noOwn]).toEqual([
        sentAsGiven("composition", '{"a":"x","b":1}'),
        rejectedBeforeSending,
        rejectedBeforeSending,
      ]);
    }, 60_000);

    test(`SCO-10: an opaque XML body is sent and an XML response is written byte for byte (${line})`, async () => {
      const uploaded = await invoke(line, ["xml", "--body-file", inputs.xml]);
      const fetched = await invoke(line, ["xml-response"]);
      const [request] = uploaded.requests;

      expect([
        uploaded.exitCode,
        request === undefined ? undefined : header(request, "content-type"),
        request === undefined ? undefined : text(request.body),
        fetched.exitCode,
        fetched.stdout,
      ]).toEqual([0, "application/xml", xmlText, 0, xmlText]);
    }, 60_000);
  }
});
