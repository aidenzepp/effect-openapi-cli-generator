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

// The Milestone 2 witness for the 3.1 and 3.2 dialect keyword rows SCH-01 to SCH-33: one generated
// package per version line, built once, run against the capture server with `--body`; the
// generation rows call `generate()` in process and the reference rows call the resolver. A row the
// product gets wrong is a `test.todo` with what was observed. SCH-01 is delegated (DOC-05, SCO-04)
// and SCH-08 is informational, so neither gets a test here.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixtures = nodePath.join(repoRoot, "corpus/fixtures/rows/sch-a");

type Line = "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.1.2", "3.2.1"];

const resolverLine = { "3.1.2": "3.1", "3.2.1": "3.2" } as const;

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// Generated packages live under the worktree's git-ignored `work/`, never the system temp
// directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "wt-sch-a-"));

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

// What one invocation did: its exit code and the target and body of every request it sent.
interface Outcome {
  readonly exitCode: number | null;
  readonly sent: readonly (readonly [target: string, body: string])[];
}

const outcomeOf = (exitCode: number | null, requests: readonly RecordedRequest[]): Outcome => ({
  exitCode,
  sent: requests.map((request) => [request.target, text(request.body)] as const),
});

// One invocation of the line's built CLI with `--body`, against the capture server. `runBin` is
// asynchronous, so the in-process server keeps answering.
const send = async (line: Line, command: string, body: string): Promise<Outcome> => {
  const generated = packages.get(line);
  if (generated === undefined) {
    throw new Error(`no package built for ${line}`);
  }

  const before = capture.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, {
      args: ["--base-url", origin, command, "--body", body],
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );

  return outcomeOf(result.exitCode, capture.requests().slice(before));
};

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

// A one-operation document of a line whose request body has the given schema and components.
const withBody = (
  line: Line,
  required: boolean,
  schema: Members,
  schemas: Members = {},
): Members => ({
  components: { schemas },
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

const dynamicNode: Members = { Node: { $dynamicAnchor: "node", type: "object" } };

const bodySchema = "/paths/~1a/post/requestBody/content/application~1json/schema";

describe("SCH-02 to SCH-33 through the built CLI, the resolver and generate()", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`SCH-02: a $ref by $id targets the resource's schema, which then applies (${line})`, async () => {
        const target = targetOf(line, "id");
        const object = await send(line, "id", "{}");
        const array = await send(line, "id", "[]");

        expect(target).toBe("/components/schemas/Holder");
        expect([object, array]).toEqual([sentAsGiven("id", "{}"), rejectedBeforeSending]);
      }, 60_000);

      test(`SCH-03: a schema $ref resolves to its target, whose type applies (${line})`, async () => {
        const target = targetOf(line, "ref-siblings");
        const inside = await send(line, "ref-siblings", "5");
        const wrongType = await send(line, "ref-siblings", '"x"');

        expect(target).toBe("/components/schemas/Count");
        expect([inside, wrongType]).toEqual([
          sentAsGiven("ref-siblings", "5"),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test.todo(`SCH-03: a sibling maximum 5 beside $ref is not asserted and 7 is sent vs rejected before send (${line})`, () =>
        Promise.resolve());

      test(`SCH-04: a plain-name fragment targets the schema whose $anchor it names (${line})`, async () => {
        const target = targetOf(line, "anchor");
        const inside = await send(line, "anchor", "5");
        const above = await send(line, "anchor", "6");

        expect(target).toBe("/components/schemas/Holder/$defs/Small");
        expect([inside, above]).toEqual([sentAsGiven("anchor", "5"), rejectedBeforeSending]);
      }, 60_000);

      test(`SCH-05: $dynamicRef is refused at element scope at the referencing site (${line})`, async () => {
        const found = await inProcess(withBody(line, false, { $dynamicRef: "#node" }, dynamicNode));

        expect(
          summary(found.diagnostics.filter((diagnostic) => diagnostic.row === "SCH-05")),
        ).toEqual([["SCH-05/dynamic-ref", "refusal", "element", bodySchema]]);
      });

      test.todo(`SCH-05: a $dynamicRef that a required body depends on is refused at element scope only vs raised to operation scope (${line})`, () =>
        Promise.resolve());

      test(`SCH-06: a $dynamicAnchor a $dynamicRef targets is refused at element scope (${line})`, async () => {
        const found = await inProcess(withBody(line, false, { $dynamicRef: "#node" }, dynamicNode));

        expect(
          summary(found.diagnostics.filter((diagnostic) => diagnostic.row === "SCH-06")),
        ).toEqual([["SCH-06/dynamic-anchor", "refusal", "element", "/components/schemas/Node"]]);
      });

      test.todo(`SCH-06: a $dynamicAnchor that a required body depends on is refused at element scope only vs raised to operation scope (${line})`, () =>
        Promise.resolve());

      test.todo(`SCH-07: a request schema declaring $vocabulary generates with no diagnostic vs refused (${line})`, () =>
        Promise.resolve());

      test(`SCH-09: a $ref into $defs targets that definition, which then applies (${line})`, async () => {
        const target = targetOf(line, "defs");
        const inside = await send(line, "defs", "5");
        const above = await send(line, "defs", "6");

        expect(target).toBe("/components/schemas/Holder/$defs/Small");
        expect([inside, above]).toEqual([sentAsGiven("defs", "5"), rejectedBeforeSending]);
      }, 60_000);

      test(`SCH-10: input violating prefixItems is rejected before send (${line})`, async () => {
        const valid = await send(line, "prefix-items", '["a",1]');
        const first = await send(line, "prefix-items", "[1,1]");
        const second = await send(line, "prefix-items", '["a","b"]');

        expect([valid, first, second]).toEqual([
          sentAsGiven("prefix-items", '["a",1]'),
          rejectedBeforeSending,
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`SCH-11: input violating items is rejected before send (${line})`, async () => {
        const valid = await send(line, "items", "[1,2]");
        const invalid = await send(line, "items", '[1,"x"]');

        expect([valid, invalid]).toEqual([sentAsGiven("items", "[1,2]"), rejectedBeforeSending]);
      }, 60_000);

      test(`SCH-12: contains is not asserted; a violating value is sent exactly as given (${line})`, async () => {
        const violating = await send(line, "contains", '[ "y" ]');

        expect(violating).toEqual(sentAsGiven("contains", '[ "y" ]'));
        expect(noticesOf(line, "SCH-12")).toEqual(
          notAsserted("SCH-12", `${schemaAt("contains")}/contains`),
        );
      }, 60_000);

      test(`SCH-13: a schema-valued additionalProperties is asserted; beside properties it is a notice (${line})`, async () => {
        const map = await send(line, "additional-map", '{"z":1}');
        const wrongValue = await send(line, "additional-map", '{"z":"x"}');
        const declared = await send(line, "additional-properties", '{"a":"x"}');
        const besideProperties = await send(
          line,
          "additional-with-properties",
          '{"a":"x", "z":"not an integer"}',
        );

        expect([map, wrongValue, declared, besideProperties]).toEqual([
          sentAsGiven("additional-map", '{"z":1}'),
          rejectedBeforeSending,
          sentAsGiven("additional-properties", '{"a":"x"}'),
          sentAsGiven("additional-with-properties", '{"a":"x", "z":"not an integer"}'),
        ]);
        expect(noticesOf(line, "SCH-13")).toEqual(
          notAsserted("SCH-13", schemaAt("additional-with-properties")),
        );
      }, 60_000);

      test.todo(`SCH-13: an undeclared key under additionalProperties false is sent vs rejected before send (${line})`, () =>
        Promise.resolve());

      test(`SCH-14: input violating properties is rejected before send (${line})`, async () => {
        const valid = await send(line, "properties", '{"n":1}');
        const invalid = await send(line, "properties", '{"n":"x"}');

        expect([valid, invalid]).toEqual([
          sentAsGiven("properties", '{"n":1}'),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test.todo(`SCH-15: any patternProperties in a request schema fails generation with DomainEmitError import-failed vs input violating it rejected before send (${line})`, () =>
        Promise.resolve());

      test(`SCH-16: dependentSchemas is not asserted; a violating value is sent exactly as given (${line})`, async () => {
        const violating = await send(line, "dependent-schemas", '{"a": 1}');

        expect(violating).toEqual(sentAsGiven("dependent-schemas", '{"a": 1}'));
        expect(noticesOf(line, "SCH-16")).toEqual(
          notAsserted("SCH-16", `${schemaAt("dependent-schemas")}/dependentSchemas`),
        );
      }, 60_000);

      test(`SCH-17: input violating propertyNames is rejected before send (${line})`, async () => {
        const valid = await send(line, "property-names", '{"abc":1}');
        const invalid = await send(line, "property-names", '{"abcd":1}');

        expect([valid, invalid]).toEqual([
          sentAsGiven("property-names", '{"abc":1}'),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`SCH-18: if is not asserted; a value it selects is sent exactly as given (${line})`, async () => {
        const selected = await send(line, "conditional", '{"k": "a"}');

        expect(selected).toEqual(sentAsGiven("conditional", '{"k": "a"}'));
        expect(noticesOf(line, "SCH-18")).toEqual(
          notAsserted("SCH-18", `${schemaAt("conditional")}/if`),
        );
      }, 60_000);

      test(`SCH-19: then is not asserted; a value violating it is sent exactly as given (${line})`, async () => {
        const violating = await send(line, "conditional", '{"k": "a"}');

        expect(violating).toEqual(sentAsGiven("conditional", '{"k": "a"}'));
        expect(noticesOf(line, "SCH-19")).toEqual(
          notAsserted("SCH-19", `${schemaAt("conditional")}/then`),
        );
      }, 60_000);

      test(`SCH-20: else is not asserted; a value violating it is sent exactly as given (${line})`, async () => {
        const violating = await send(line, "conditional", '{"k": "b"}');

        expect(violating).toEqual(sentAsGiven("conditional", '{"k": "b"}'));
        expect(noticesOf(line, "SCH-20")).toEqual(
          notAsserted("SCH-20", `${schemaAt("conditional")}/else`),
        );
      }, 60_000);

      test(`SCH-21: input violating allOf is rejected before send (${line})`, async () => {
        const valid = await send(line, "all-of", '{"a":"x","b":1}');
        const invalid = await send(line, "all-of", '{"a":"x"}');

        expect([valid, invalid]).toEqual([
          sentAsGiven("all-of", '{"a":"x","b":1}'),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`SCH-22: input violating anyOf is rejected before send, an all-constant anyOf as an enum (${line})`, async () => {
        const word = await send(line, "any-of", '"x"');
        const number = await send(line, "any-of", "1");
        const neither = await send(line, "any-of", "true");
        const member = await send(line, "any-of-const", '"b"');
        const outside = await send(line, "any-of-const", '"c"');

        expect([word, number, neither, member, outside]).toEqual([
          sentAsGiven("any-of", '"x"'),
          sentAsGiven("any-of", "1"),
          rejectedBeforeSending,
          sentAsGiven("any-of-const", '"b"'),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`SCH-23: input violating oneOf is rejected before send, an all-constant oneOf as an enum (${line})`, async () => {
        const word = await send(line, "one-of", '"x"');
        const neither = await send(line, "one-of", "true");
        const member = await send(line, "one-of-const", '"a"');
        const outside = await send(line, "one-of-const", '"c"');

        expect([word, neither, member, outside]).toEqual([
          sentAsGiven("one-of", '"x"'),
          rejectedBeforeSending,
          sentAsGiven("one-of-const", '"a"'),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`SCH-24: not {} is asserted; any other not is a notice and the value is sent as given (${line})`, async () => {
        const absent = await send(line, "not-empty", "{}");
        const present = await send(line, "not-empty", '{"never":1}');
        const violating = await send(line, "not-other", '{"value": "s"}');

        expect([absent, present, violating]).toEqual([
          sentAsGiven("not-empty", "{}"),
          rejectedBeforeSending,
          sentAsGiven("not-other", '{"value": "s"}'),
        ]);
        expect(noticesOf(line, "SCH-24")).toEqual(
          notAsserted("SCH-24", `${schemaAt("not-other")}/properties/value/not`),
        );
      }, 60_000);

      test(`SCH-25: unevaluatedItems is not asserted; a violating value is sent exactly as given (${line})`, async () => {
        const violating = await send(line, "unevaluated-items", '["a", 1]');

        expect(violating).toEqual(sentAsGiven("unevaluated-items", '["a", 1]'));
        expect(noticesOf(line, "SCH-25")).toEqual(
          notAsserted("SCH-25", `${schemaAt("unevaluated-items")}/unevaluatedItems`),
        );
      }, 60_000);

      test(`SCH-26: unevaluatedProperties is not asserted; a violating value is sent exactly as given (${line})`, async () => {
        const violating = await send(line, "unevaluated-properties", '{"a":"x", "z":1}');

        expect(violating).toEqual(sentAsGiven("unevaluated-properties", '{"a":"x", "z":1}'));
        expect(noticesOf(line, "SCH-26")).toEqual(
          notAsserted("SCH-26", `${schemaAt("unevaluated-properties")}/unevaluatedProperties`),
        );
      }, 60_000);

      test(`SCH-27: a type list including null admits its types and rejects others before send (${line})`, async () => {
        const nothing = await send(line, "type", "null");
        const string = await send(line, "type", '"s"');
        const number = await send(line, "type", "1");

        expect([nothing, string, number]).toEqual([
          sentAsGiven("type", "null"),
          sentAsGiven("type", '"s"'),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`SCH-28: a scalar const is asserted; an object const is a notice and sent as given (${line})`, async () => {
        const equal = await send(line, "const-scalar", '"x"');
        const other = await send(line, "const-scalar", '"y"');
        const object = await send(line, "const-object", '{"a": 2}');

        expect([equal, other, object]).toEqual([
          sentAsGiven("const-scalar", '"x"'),
          rejectedBeforeSending,
          sentAsGiven("const-object", '{"a": 2}'),
        ]);
        expect(noticesOf(line, "SCH-28")).toEqual(
          notAsserted("SCH-28", `${schemaAt("const-object")}/const`),
        );
      }, 60_000);

      test(`SCH-29: a scalar enum is asserted; an object enum is a notice and sent as given (${line})`, async () => {
        const member = await send(line, "enum-scalar", '"a"');
        const outside = await send(line, "enum-scalar", '"c"');
        const flagged = await send(line, "enum-flag", '{"color":"green"}');
        const object = await send(line, "enum-object", '{"a": 2}');

        expect([member, outside, flagged, object]).toEqual([
          sentAsGiven("enum-scalar", '"a"'),
          rejectedBeforeSending,
          rejectedBeforeSending,
          sentAsGiven("enum-object", '{"a": 2}'),
        ]);
        expect(noticesOf(line, "SCH-29")).toEqual(
          notAsserted("SCH-29", `${schemaAt("enum-object")}/enum`),
        );
      }, 60_000);

      test.todo(`SCH-29: help for an enum body field shows "--color string (body /color)" with no values vs listing red and blue (${line})`, () =>
        Promise.resolve());

      test(`SCH-30: input violating multipleOf is rejected before send (${line})`, async () => {
        const multiple = await send(line, "multiple-of", "6");
        const other = await send(line, "multiple-of", "7");

        expect([multiple, other]).toEqual([sentAsGiven("multiple-of", "6"), rejectedBeforeSending]);
      }, 60_000);

      test(`SCH-31: input violating maximum is rejected before send (${line})`, async () => {
        const bound = await send(line, "maximum", "10");
        const above = await send(line, "maximum", "11");

        expect([bound, above]).toEqual([sentAsGiven("maximum", "10"), rejectedBeforeSending]);
      }, 60_000);

      test(`SCH-32: input violating a numeric exclusiveMaximum is rejected before send (${line})`, async () => {
        const below = await send(line, "exclusive-maximum", "9.5");
        const bound = await send(line, "exclusive-maximum", "10");

        expect([below, bound]).toEqual([
          sentAsGiven("exclusive-maximum", "9.5"),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`SCH-33: input violating minimum is rejected before send (${line})`, async () => {
        const bound = await send(line, "minimum", "1");
        const below = await send(line, "minimum", "0");

        expect([bound, below]).toEqual([sentAsGiven("minimum", "1"), rejectedBeforeSending]);
      }, 60_000);
    });
  }
});
