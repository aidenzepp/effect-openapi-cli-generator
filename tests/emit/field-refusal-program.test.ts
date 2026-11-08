import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { coverageOf } from "../../corpus/tools/coverage.ts";
import { loadBytes } from "../../src/load/index.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { GenerationReport } from "../../src/report/index.ts";
import type { GenerationReportValue } from "../../src/report/index.ts";
import { makeVerdict } from "../../src/report/verdict.ts";
import { resolve } from "../../src/resolve/index.ts";
import { Description } from "../../src/runtime-src/runtime/describe.ts";
import { lineOf } from "../../src/validate/dispatch.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { BinRun, GeneratedPackage } from "../support/generated-cli.ts";
import { setEnv } from "../support/env.ts";

// Design 8.5 through the built CLI and the capture server: in an optional form body, a property
// whose Encoding entry the form rule refuses is refused at `field` scope and the alternative
// stays, so the plain property's flag still sends it; the refused property has no flag, appears on
// the help REFUSED line, in `--describe` `refusedFields` and in the report and verdict at its
// Encoding entry, and `--body` cannot carry it. A required refused property drops the alternative
// and the operation is refused with OPR-09. With the bracket switch on, the nested-object property
// is sent in brackets and the non-object one stays refused with no bracket notice. One package per
// mode, each built once with its own `tsc` run.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(repoRoot, "tests/fixtures/field-refusal");

const specPath = nodePath.join(fixture, "3.1.2.json");

const bracketConfigPath = nodePath.join(fixture, "author-config.json");

// Generated packages live under the worktree's git-ignored `work/`, never the system temp directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "field-refusal-program-"));

const restoreTmpdir = setEnv("TMPDIR", work);

// Strict mode is the committed author config without its `nonStandard` switch, written at test time.
const strictConfigPath = nodePath.join(work, "strict", "author-config.json");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const scope = Effect.runSync(Scope.make());

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

// The URI `generateFixture` names the spec by, so the report and the resolution agree.
const document = Schema.decodeUnknownSync(DocumentUri)("file:///fixture/3.1.2.json");

const formMedia = "application/x-www-form-urlencoded";

const updateMedia =
  "/paths/~1customers~1{id}/post/requestBody/content/application~1x-www-form-urlencoded";

const createMedia =
  "/paths/~1customers/post/requestBody/content/application~1x-www-form-urlencoded";

type Mode = "brackets" | "strict";

interface Built {
  readonly generated: GeneratedPackage;
  readonly report: GenerationReportValue;
  readonly reportText: string;
}

const builds = new Map<Mode, Built>();

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(GenerationReport));

const decodeDescription = Schema.decodeUnknownSync(Schema.fromJsonString(Description));

const decodeConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const build = (configPath: string) =>
  generateFixture({ configPath, specPath }).pipe(
    Effect.tap(preparePackage),
    Scope.provide(scope),
    Effect.provide(layer),
  );

beforeAll(async () => {
  const { nonStandard: _switch, ...strictConfig } = decodeConfig(
    nodeFs.readFileSync(bracketConfigPath, "utf-8"),
  );
  nodeFs.mkdirSync(nodePath.dirname(strictConfigPath), { recursive: true });
  nodeFs.writeFileSync(strictConfigPath, JSON.stringify(strictConfig));
  capture.script("/customers/c1", { status: 204 });

  // One package at a time: each build is a heavy step.
  await Effect.runPromise(
    Effect.forEach(
      [
        ["strict", strictConfigPath],
        ["brackets", bracketConfigPath],
      ] as const,
      ([mode, configPath]) =>
        build(configPath).pipe(
          Effect.tap((generated) =>
            Effect.sync(() => {
              const reportText = nodeFs.readFileSync(
                nodePath.join(generated.dir, "generation-report.json"),
                "utf-8",
              );
              builds.set(mode, { generated, report: decodeReport(reportText), reportText });
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    ),
  );
}, 900_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  nodeFs.rmSync(work, { force: true, recursive: true });
  restoreTmpdir();
});

const built = (mode: Mode): Built => {
  const found = builds.get(mode);
  if (found === undefined) {
    throw new Error(`the ${mode} package was not built`);
  }

  return found;
};

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const run = (mode: Mode, args: readonly string[]): Promise<BinRun> =>
  Effect.runPromise(
    runBin(built(mode).generated, { args, timeoutMs: 30_000 }).pipe(Effect.provide(layer)),
  );

interface Exchange {
  readonly connections: number;
  readonly requests: readonly RecordedRequest[];
  readonly result: BinRun;
}

const exchange = async (mode: Mode, args: readonly string[]): Promise<Exchange> => {
  const before = capture.requests().length;
  const opened = capture.connections();
  const result = await run(mode, ["--base-url", origin, ...args]);

  return {
    connections: capture.connections() - opened,
    requests: capture.requests().slice(before),
    result,
  };
};

const sentPairs = (sent: Exchange): readonly (readonly [string, string])[] => {
  expect(sent.result.exitCode, decode(sent.result.stderr)).toBe(0);
  expect(sent.requests).toHaveLength(1);

  const [seen] = sent.requests;
  if (seen === undefined) {
    throw new Error("the capture server saw no request");
  }

  return [...new URLSearchParams(decode(seen.body))];
};

// Exit 2 before any connection, the refused field named on stderr (never the value).
const expectGuarded = (refusedRun: Exchange, field: string, value: string) => {
  const stderr = decode(refusedRun.result.stderr);

  expect(refusedRun.result.exitCode).toBe(2);
  expect(stderr).toContain(field);
  expect(stderr).not.toContain(value);
  expect(refusedRun.connections).toBe(0);
  expect(refusedRun.requests).toEqual([]);
};

const helpOf = async (mode: Mode): Promise<string> => {
  const help = await run(mode, ["customers", "update", "--help"]);

  expect(help.exitCode, decode(help.stderr)).toBe(0);

  return decode(help.stdout);
};

// The flag names help lists, `--name` from `--name <value>  body /name`.
const flagNames = (help: string): readonly string[] =>
  [...help.matchAll(/^\s+(?<flag>--[^\s,=]+)/gmu)].map((match) => match.groups?.flag ?? "");

// The entry names of the REFUSED line: `<wire or element>: <reason>; ...`.
const refusedNames = (help: string): readonly string[] | undefined => {
  const line = help.split("\n").find((candidate) => candidate.startsWith("REFUSED"));

  return line
    ?.replace(/^REFUSED\s+/u, "")
    .split("; ")
    .map((entry) => entry.split(": ")[0] ?? "");
};

const describeOf = async (mode: Mode) => {
  const described = await run(mode, ["--describe"]);

  expect(described.exitCode, decode(described.stderr)).toBe(0);

  return {
    description: decodeDescription(decode(described.stdout)),
    text: decode(described.stdout),
  };
};

const resolution = Effect.runSync(
  Effect.gen(function* resolved() {
    const loaded = yield* loadBytes(new Uint8Array(nodeFs.readFileSync(specPath)), { document });

    return yield* resolve({ document, line: yield* lineOf(loaded.value), value: loaded.value });
  }),
);

const coverageFor = async (mode: Mode) => {
  const { text } = await describeOf(mode);

  return Effect.runSync(
    coverageOf({ describe: text, report: built(mode).reportText, resolution }).pipe(Effect.orDie),
  );
};

// The compared fields only (C5): row, code, scope and pointer, never message text.
const rows = (
  entries: readonly {
    readonly code: string;
    readonly pointer: string;
    readonly row: string;
    readonly scope?: string;
  }[],
) => entries.map(({ code, pointer, row, scope: at }) => ({ code, pointer, row, scope: at }));

const fieldRefusal = (code: string, name: string) => ({
  code,
  pointer: `${updateMedia}/encoding/${name}`,
  row: "PRM-27",
  scope: "field",
});

// The second operation: its required property refused, the alternative drops at the media type
// and the required body left with none refuses the operation.
const createRefusals = [
  {
    code: "OPR-09/required-body-refused",
    pointer: "/paths/~1customers/post",
    row: "OPR-09",
    scope: "operation",
  },
  { code: "PRM-27/non-object-schema", pointer: createMedia, row: "PRM-27", scope: "element" },
];

const verdictOf = (report: GenerationReportValue) =>
  makeVerdict({
    commandNames: report.commandNames,
    corpusVersion: 1,
    coverage: { byNotice: [], checked: false, invented: [], missing: [] },
    diagnostics: [...report.refusals, ...report.notices],
    generator: {
      config: "tests/fixtures/field-refusal/author-config.json",
      configSha256: "0".repeat(64),
      version: report.generator.version,
    },
    informational: 0,
    nonStandard: report.nonStandard,
    operations: { generated: report.commandNames.length, total: 2 },
    spec: { id: "field-refusal", openapi: "3.1.2", sha256: "0".repeat(64) },
    twinEquality: { checked: false, equal: false },
  });

describe("field refusal, strict: the built CLI", () => {
  test("the refused fields have no flag and the plain field's flag sends it", async () => {
    const help = await helpOf("strict");

    expect(flagNames(help)).toContain("--name");
    expect(flagNames(help).filter((flag) => /^--(?:filters|metadata)/u.test(flag))).toEqual([]);
    expect(
      sentPairs(await exchange("strict", ["customers", "update", "c1", "--name", "Ann"])),
    ).toEqual([["name", "Ann"]]);

    const unknown = await exchange("strict", ["customers", "update", "c1", "--metadata", "{}"]);

    expect(unknown.result.exitCode).toBe(2);
    expect(unknown.connections).toBe(0);
  }, 60_000);

  // C14: the product is wrong here, so the assertion is recorded, not fixed. The emitted help
  // reads only the names plan's diagnostics (`src/emit/cli.ts` passes `plan.diagnostics` to
  // `operationHelp`), never normalize's, so no REFUSED line is printed.
  test.todo("help REFUSED line: no REFUSED line in `customers update --help` (refusedNames undefined) vs a REFUSED line listing filters and metadata", async () => {
    expect(refusedNames(await helpOf("strict"))).toEqual(["filters", "metadata"]);
  }, 60_000);

  test("--body holding a refused key is exit 2 naming the field, with no connection", async () => {
    expectGuarded(
      await exchange("strict", [
        "customers",
        "update",
        "c1",
        "--body",
        '{"filters":{"status":"secret-a"}}',
      ]),
      "filters",
      "secret-a",
    );
    expectGuarded(
      await exchange("strict", [
        "customers",
        "update",
        "c1",
        "--body",
        '{"metadata":{"owner":{"id":"secret-b"}}}',
      ]),
      "metadata",
      "secret-b",
    );
  }, 60_000);

  test("the report carries field refusals at the Encoding entries", () => {
    expect(rows(built("strict").report.refusals)).toEqual([
      ...createRefusals,
      fieldRefusal("PRM-27/non-object-schema", "filters"),
      fieldRefusal("PRM-27/compound-nested", "metadata"),
    ]);
    expect(built("strict").report.notices).toEqual([]);
    expect(built("strict").report.nonStandard).toEqual([]);
  });

  test("the verdict carries field refusals at the Encoding entries", () => {
    const verdict = verdictOf(built("strict").report);

    expect(verdict.verdict).toBe("partly-refused");
    expect(verdict.counts.refusals).toEqual({ document: 0, element: 1, field: 2, operation: 1 });
    expect(rows(verdict.refusals.filter((entry) => entry.scope === "field"))).toEqual([
      fieldRefusal("PRM-27/non-object-schema", "filters"),
      fieldRefusal("PRM-27/compound-nested", "metadata"),
    ]);
  });

  test("--describe lists refusedFields", async () => {
    const { description } = await describeOf("strict");
    const update = description.commands.find(
      (command) => command.pointer === "/paths/~1customers~1{id}/post",
    );

    expect(update?.requestMedia).toEqual([formMedia]);
    expect(update?.refusedFields).toEqual([
      { mediaType: formMedia, name: "filters" },
      { mediaType: formMedia, name: "metadata" },
    ]);
  }, 60_000);

  test("coverageOf reports missing 0 and invented 0", async () => {
    const coverage = await coverageFor("strict");

    expect(coverage.missing).toEqual([]);
    expect(coverage.invented).toEqual([]);
  }, 60_000);

  test("the required refused property drops the alternative and refuses the operation with OPR-09", async () => {
    const { description } = await describeOf("strict");
    const refusals = rows(built("strict").report.refusals);

    expect(refusals.filter((entry) => entry.pointer.startsWith("/paths/~1customers/"))).toEqual(
      createRefusals,
    );
    expect(description.commands.map((command) => command.pointer)).toEqual([
      "/paths/~1customers~1{id}/post",
    ]);
  }, 60_000);
});

describe("field refusal, bracket switch on: the built CLI", () => {
  test("the nested-object field is sent in brackets", async () => {
    const pairs = sentPairs(
      await exchange("brackets", [
        "customers",
        "update",
        "c1",
        "--body",
        '{"metadata":{"owner":{"id":"u1"}}}',
        "--name",
        "Ann",
      ]),
    );

    expect(pairs).toEqual([
      ["metadata[owner][id]", "u1"],
      ["name", "Ann"],
    ]);
  }, 60_000);

  test("the non-object field stays refused, with no bracket notice and no nonStandard entry", async () => {
    const { report } = built("brackets");
    const filters = `${updateMedia}/encoding/filters`;
    const metadata = `${updateMedia}/encoding/metadata`;

    expect(rows(report.refusals)).toEqual([
      ...createRefusals,
      fieldRefusal("PRM-27/non-object-schema", "filters"),
    ]);
    expect(rows(report.notices)).toEqual([
      { code: "PRM-27/bracket-author-choice", pointer: metadata, row: "PRM-27", scope: "element" },
    ]);
    expect(report.nonStandard.map((entry) => String(entry.pointer))).toEqual([metadata]);
    expect(report.notices.map((entry) => String(entry.pointer))).not.toContain(filters);
    expect(
      flagNames(await helpOf("brackets")).filter((flag) => flag.startsWith("--filters")),
    ).toEqual([]);
    expectGuarded(
      await exchange("brackets", [
        "customers",
        "update",
        "c1",
        "--body",
        '{"filters":{"status":"secret-c"}}',
      ]),
      "filters",
      "secret-c",
    );

    const { description } = await describeOf("brackets");

    expect(description.commands.flatMap((command) => command.refusedFields)).toEqual([
      { mediaType: formMedia, name: "filters" },
    ]);

    const coverage = await coverageFor("brackets");

    expect(coverage.missing).toEqual([]);
    expect(coverage.invented).toEqual([]);
  }, 60_000);
});
