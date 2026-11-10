import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunCrypto, BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, Exit, Layer, Order, Schema, Scope } from "effect";
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
import { setEnv } from "../support/env.ts";

// The Milestone 2 witness for the format value rows FMT-01 to FMT-28: one generated package per
// version line, built once, run against the capture server; the tier of each format value comes
// from the in-process generation of the same fixture. A format value other than 3.0 binary and byte
// is server-validated (design D-AD12): removed from the validation copy with one `not-asserted`
// notice (S30-26 in 3.0, SCH-54 in 3.1 and 3.2) and the value sent as given; `int64` adds the
// FMT-02 range notice; 3.1 and 3.2 binary and byte are annotations with no notice. FMT-05 is
// deferred, and FMT-06 and FMT-07 are delegated to BIN-02 and BIN-01, so none of them gets a test
// here. A row the product gets wrong is a `test.todo` with what was observed.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixtures = nodePath.join(repoRoot, "corpus/fixtures/rows/fmt");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

// The lines whose format vocabulary is JSON Schema 2020-12 (FMT-10 to FMT-27).
const modernLines: readonly Line[] = ["3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layerDigest);

// Generated packages live under the worktree's git-ignored `work/`, never the system temp
// directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "wt-fmt-"));

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

// In process generation of a line's fixture; the diagnostics of a refused run are the refusal's.
const inProcess = async (line: Line): Promise<Generated> => {
  const dir = nodePath.join(work, `case-${line}`);
  nodeFs.mkdirSync(dir, { recursive: true });

  const exit = await Effect.runPromiseExit(
    generate(
      {
        document: decodeDocument("file:///fixture/openapi.json"),
        generator,
        outDir: nodePath.join(dir, "out"),
        source: { _tag: "File", path: nodePath.join(fixtures, `${line}.json`) },
        strict: false,
      },
      {
        document: decodeDocument("file:///fixture/author-config.json"),
        path: nodePath.join(fixtures, "author-config.json"),
      },
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
        Effect.promise(() => inProcess(line)).pipe(Effect.map((found) => [line, found] as const)),
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
  restoreTmpdir();
});

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf-8");

// What one invocation did: its exit code and the target and body of every request it sent.
interface Outcome {
  readonly exitCode: number | null;
  readonly sent: readonly (readonly [target: string, body: string])[];
}

// One invocation of the line's built CLI against the capture server. `runBin` is asynchronous, so
// the in-process server keeps answering.
const invoke = async (
  line: Line,
  args: readonly string[],
): Promise<readonly [exitCode: number | null, requests: readonly RecordedRequest[]]> => {
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

  return [result.exitCode, capture.requests().slice(before)];
};

const run = async (line: Line, args: readonly string[]): Promise<Outcome> => {
  const [exitCode, requests] = await invoke(line, args);

  return {
    exitCode,
    sent: requests.map((request) => [request.target, text(request.body)] as const),
  };
};

// The request went out once, with this target and body.
const sentOnce = (target: string, body = ""): Outcome => ({ exitCode: 0, sent: [[target, body]] });

// A usage error before anything was sent.
const rejectedBeforeSending: Outcome = { exitCode: 2, sent: [] };

// The decoded value of one query parameter in each request one invocation sent, with its exit code.
const queryValues = async (
  line: Line,
  command: string,
  name: string,
  value: string,
): Promise<readonly [exitCode: number | null, values: readonly (string | null)[]]> => {
  const [exitCode, requests] = await invoke(line, [command, `--${name}`, value]);

  return [
    exitCode,
    requests.map((request) => new URL(request.target, origin).searchParams.get(name)),
  ];
};

type Notice = readonly [code: string, severity: string, scope: string, pointer: string];

// Diagnostics in pointer order, then code order.
const byPointer = Order.mapInput(Order.String, (notice: Notice) => `${notice[3]} ${notice[0]}`);

const summary = (diagnostics: readonly Diagnostic[]): readonly Notice[] =>
  Arr.sort(
    diagnostics.map((diagnostic): Notice => [
      diagnostic.code,
      diagnostic.severity,
      diagnostic.scope,
      String(diagnostic.pointer),
    ]),
    byPointer,
  );

const fixtureRun = (line: Line): Generated => {
  const found = fixtureRuns.get(line);
  if (found === undefined) {
    throw new Error(`no in-process generation for ${line}`);
  }

  return found;
};

// The fixture's diagnostics at a schema or below it, the same diagnostics in the report's notice
// list, and the verdict, which notices never change.
const noticesAt = (line: Line, schema: string) => {
  const found = fixtureRun(line);
  const under = (diagnostic: Diagnostic): boolean => {
    const pointer = String(diagnostic.pointer);

    return pointer === schema || pointer.startsWith(`${schema}/`);
  };

  return {
    diagnostics: summary(found.diagnostics.filter(under)),
    reported: summary(found.reported.filter(under)),
    verdict: classifyVerdict(found.diagnostics),
  };
};

// The server-validated tier: one element notice at the `format` keyword, under the line's row.
const notAsserted = (line: Line, schema: string): Notice => [
  `${line === "3.0.4" ? "S30-26" : "SCH-54"}/not-asserted`,
  "notice",
  "element",
  `${schema}/format`,
];

const int64Range = (schema: string): Notice => ["FMT-02/int64-range", "notice", "element", schema];

const tier = (...notices: readonly Notice[]) => ({
  diagnostics: notices,
  reported: notices,
  verdict: "accepted" as const,
});

const parameterSchema = (path: string, index: number): string =>
  `/paths/~1${path}/get/parameters/${String(index)}/schema`;

const bodySchema = (path: string): string =>
  `/paths/~1${path}/post/requestBody/content/application~1json/schema`;

// The `numbers` operation's query parameters, in fixture order.
const i32 = parameterSchema("numbers", 0);

const i64 = parameterSchema("numbers", 1);

const float = parameterSchema("numbers", 2);

const double = parameterSchema("numbers", 3);

const countField = `${bodySchema("count")}/properties/count`;

const ratioField = `${bodySchema("count")}/properties/ratio`;

// The `strings` operation has one string query parameter per format, named after it, in this
// order; 3.0 declares the first two only.
const stringFormats = [
  "date",
  "date-time",
  "time",
  "duration",
  "email",
  "idn-email",
  "hostname",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "iri",
  "iri-reference",
  "uuid",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
  "regex",
] as const;

type StringFormat = (typeof stringFormats)[number];

// Per format, a value that conforms and one that does not; both are sent as given.
const stringValues: Readonly<Record<StringFormat, readonly [conforming: string, other: string]>> = {
  date: ["2026-11-06", "06/11/2026"],
  "date-time": ["2026-11-06T10:00:00+01:00", "yesterday"],
  duration: ["P1DT2H", "two days"],
  email: ["a+b@example.com", "not an email"],
  hostname: ["api.example.com", "under_score..example"],
  "idn-email": ["用户@例子.广告", "用户"],
  "idn-hostname": ["例子.广告", "例子..广告"],
  ipv4: ["192.0.2.1", "999.0.0.1"],
  ipv6: ["2001:db8::1", "2001:::1"],
  iri: ["https://例子.广告/路径?q=值", "路径"],
  "iri-reference": ["/路径?q=值#片段", "<路径>"],
  "json-pointer": ["/a~1b/0", "a/b"],
  regex: ["^[a-z]+(?:-[a-z]+)*$", "[unclosed"],
  "relative-json-pointer": ["1/a~0b", "/a"],
  time: ["10:00:00+01:00", "ten o'clock"],
  uri: ["https://example.com/a?b=c&d=e#f", "no scheme"],
  "uri-reference": ["../a?b=c", "a b"],
  "uri-template": ["/users/{id}{?fields}", "/users/{id"],
  uuid: ["123e4567-e89b-12d3-a456-426614174000", "not-a-uuid"],
};

// A string format row through the built CLI and the fixture's generation: what each of its two
// values reached the server as, and the notices at its parameter schema.
const stringRow = async (line: Line, format: StringFormat) => {
  const [conforming, other] = stringValues[format];
  const schema = parameterSchema("strings", stringFormats.indexOf(format));

  return {
    notices: noticesAt(line, schema),
    sent: [
      await queryValues(line, "strings", format, conforming),
      await queryValues(line, "strings", format, other),
    ],
  };
};

// What a string format row should show: both values sent once, unchanged, and the
// server-validated tier at the parameter schema.
const sentAsGiven = (line: Line, format: StringFormat) => {
  const [conforming, other] = stringValues[format];
  const schema = parameterSchema("strings", stringFormats.indexOf(format));

  return {
    notices: tier(notAsserted(line, schema)),
    sent: [[0, [conforming]] as const, [0, [other]] as const],
  };
};

// 2^53 + 1, which a JavaScript number rounds to 2^53.
const beyondSafe = "9007199254740993";

describe("FMT-01 to FMT-28 through the built CLI and generate()", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`FMT-01: an int32 integer flag sends a value beyond the int32 range as given, refuses a non-integer before send, and the format is server-validated with a notice (${line})`, async () => {
        const beyond = await run(line, ["numbers", "--i32", "2147483648"]);
        const fraction = await run(line, ["numbers", "--i32", "1.5"]);

        expect([beyond, fraction, noticesAt(line, i32)]).toEqual([
          sentOnce("/numbers?i32=2147483648"),
          rejectedBeforeSending,
          tier(notAsserted(line, i32)),
        ]);
      }, 60_000);

      test(`FMT-02: an int64 value beyond 2^53 keeps its digits in the query and in a JSON body, a non-integer is refused before send, and the range is a notice (${line})`, async () => {
        const query = await run(line, ["numbers", "--i64", beyondSafe]);
        const body = await run(line, ["count", "--count", beyondSafe]);
        const fraction = await run(line, ["numbers", "--i64", "1.5"]);

        expect([query, body, fraction, noticesAt(line, i64), noticesAt(line, countField)]).toEqual([
          sentOnce(`/numbers?i64=${beyondSafe}`),
          sentOnce("/count", `{"count":${beyondSafe}}`),
          rejectedBeforeSending,
          tier(int64Range(i64), notAsserted(line, i64)),
          tier(int64Range(countField), notAsserted(line, countField)),
        ]);
      }, 60_000);

      test(`FMT-03: a float number flag sends its text unchanged, refuses a non-number before send, and the format is server-validated with a notice (${line})`, async () => {
        const decimal = await run(line, ["numbers", "--float", "1.50"]);
        const word = await run(line, ["numbers", "--float", "abc"]);

        expect([decimal, word, noticesAt(line, float)]).toEqual([
          sentOnce("/numbers?float=1.50"),
          rejectedBeforeSending,
          tier(notAsserted(line, float)),
        ]);
      }, 60_000);

      test(`FMT-04: a double number flag keeps every digit in the query, a non-number is refused before send, and the format is server-validated with a notice (${line})`, async () => {
        const query = await run(line, ["numbers", "--double", "12345678901234567890.5"]);
        const word = await run(line, ["numbers", "--double", "abc"]);

        expect([query, word, noticesAt(line, double), noticesAt(line, ratioField)]).toEqual([
          sentOnce("/numbers?double=12345678901234567890.5"),
          rejectedBeforeSending,
          tier(notAsserted(line, double)),
          tier(notAsserted(line, ratioField)),
        ]);
      }, 60_000);

      test(`FMT-04: a double JSON body field flag sends --ratio 0.10000000000000000001 with its digits unchanged (${line})`, async () => {
        const body = await run(line, ["count", "--ratio", "0.10000000000000000001"]);

        expect(body).toEqual(sentOnce("/count", '{"ratio":0.10000000000000000001}'));
      }, 60_000);

      test(`FMT-08: a date value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "date")).toEqual(sentAsGiven(line, "date"));
      }, 60_000);

      test(`FMT-09: a date-time value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "date-time")).toEqual(sentAsGiven(line, "date-time"));
      }, 60_000);

      test(`FMT-28: an unrecognized string format and a registry integer format fall back to their type: the string is sent as given, the integer stays a numeric flag, and each format is a notice (${line})`, async () => {
        const color = parameterSchema("registry", 0);
        const small = parameterSchema("registry", 1);
        const string = await queryValues(line, "registry", "color", "#zz 1");
        const beyond = await run(line, ["registry", "--small", "300"]);
        const word = await run(line, ["registry", "--small", "abc"]);

        expect([string, beyond, word, noticesAt(line, color), noticesAt(line, small)]).toEqual([
          [0, ["#zz 1"]],
          sentOnce("/registry?small=300"),
          rejectedBeforeSending,
          tier(notAsserted(line, color)),
          tier(notAsserted(line, small)),
        ]);
      }, 60_000);
    });
  }

  for (const line of modernLines) {
    describe(`${line}: JSON Schema 2020-12 formats`, () => {
      test(`FMT-10: format binary is an annotation; the property stays a string sent as given, and neither binary nor byte has a notice (${line})`, async () => {
        const body = await run(line, ["annotated", "--blob", "not a path"]);

        expect([body, noticesAt(line, bodySchema("annotated"))]).toEqual([
          sentOnce("/annotated", '{"blob":"not a path"}'),
          tier(),
        ]);
      }, 60_000);

      test(`FMT-10: a format byte JSON body property is a string sent as given (${line})`, async () => {
        const body = await run(line, ["annotated", "--encoded", "not base64!"]);

        expect(body).toEqual(sentOnce("/annotated", '{"encoded":"not base64!"}'));
      }, 60_000);

      test(`FMT-11: a time value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "time")).toEqual(sentAsGiven(line, "time"));
      }, 60_000);

      test(`FMT-12: a duration value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "duration")).toEqual(sentAsGiven(line, "duration"));
      }, 60_000);

      test(`FMT-13: an email value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "email")).toEqual(sentAsGiven(line, "email"));
      }, 60_000);

      test(`FMT-14: an idn-email value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "idn-email")).toEqual(sentAsGiven(line, "idn-email"));
      }, 60_000);

      test(`FMT-15: a hostname value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "hostname")).toEqual(sentAsGiven(line, "hostname"));
      }, 60_000);

      test(`FMT-16: an idn-hostname value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "idn-hostname")).toEqual(sentAsGiven(line, "idn-hostname"));
      }, 60_000);

      test(`FMT-17: an ipv4 value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "ipv4")).toEqual(sentAsGiven(line, "ipv4"));
      }, 60_000);

      test(`FMT-18: an ipv6 value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "ipv6")).toEqual(sentAsGiven(line, "ipv6"));
      }, 60_000);

      test(`FMT-19: a uri value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "uri")).toEqual(sentAsGiven(line, "uri"));
      }, 60_000);

      test(`FMT-20: a uri-reference value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "uri-reference")).toEqual(sentAsGiven(line, "uri-reference"));
      }, 60_000);

      test(`FMT-21: an iri value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "iri")).toEqual(sentAsGiven(line, "iri"));
      }, 60_000);

      test(`FMT-22: an iri-reference value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "iri-reference")).toEqual(sentAsGiven(line, "iri-reference"));
      }, 60_000);

      test(`FMT-23: a uuid value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "uuid")).toEqual(sentAsGiven(line, "uuid"));
      }, 60_000);

      test(`FMT-24: a uri-template value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "uri-template")).toEqual(sentAsGiven(line, "uri-template"));
      }, 60_000);

      test(`FMT-25: a json-pointer value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "json-pointer")).toEqual(sentAsGiven(line, "json-pointer"));
      }, 60_000);

      test(`FMT-26: a relative-json-pointer value, conforming or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "relative-json-pointer")).toEqual(
          sentAsGiven(line, "relative-json-pointer"),
        );
      }, 60_000);

      test(`FMT-27: a regex value, compiling or not, is sent as given and the format is server-validated with a notice (${line})`, async () => {
        expect(await stringRow(line, "regex")).toEqual(sentAsGiven(line, "regex"));
      }, 60_000);
    });
  }
});
