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

// Design 6.1 Scalar switch through the built CLI and the capture server (ruling D92 = C). The
// switch is explicit and never default: with it off, a covered deepObject union is refused as
// before; with it on, the scalar branch is sent as `name=value` and every element it changes is
// marked non-standard (`PRM-27/scalar-author-choice`) in help, the report and the verdict. With both
// switches, a nested object goes `name[a][b]=v` and a scalar `name=value`. One package per mode,
// each built once with its own `tsc` run.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(repoRoot, "tests/fixtures/deep-object-scalars");

const specPath = nodePath.join(fixture, "3.1.2.json");

const bothConfigPath = nodePath.join(fixture, "author-config.json");

// Generated packages live under the worktree's git-ignored `work/`, never the system temp directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "deep-object-scalars-program-"));

const restoreTmpdir = setEnv("TMPDIR", work);

// The other two modes are the committed author config with its `nonStandard` switches replaced,
// written at test time: the scalar switch alone, and neither (strict).
const scalarsConfigPath = nodePath.join(work, "scalars", "author-config.json");

const neitherConfigPath = nodePath.join(work, "neither", "author-config.json");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const scope = Effect.runSync(Scope.make());

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

// The URI `generateFixture` names the spec by, so the report and the resolution agree.
const document = Schema.decodeUnknownSync(DocumentUri)("file:///fixture/3.1.2.json");

const formMedia = "application/x-www-form-urlencoded";

const createMedia = "/paths/~1charges/post/requestBody/content/application~1x-www-form-urlencoded";

const createdPointer = "/paths/~1charges/get/parameters/0";

const encodingOf = (name: string): string => `${createMedia}/encoding/${name}`;

type Mode = "both" | "neither" | "scalars";

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

const writeConfig = (path: string, config: Readonly<Record<string, Schema.Json>>) => {
  nodeFs.mkdirSync(nodePath.dirname(path), { recursive: true });
  nodeFs.writeFileSync(path, JSON.stringify(config));
};

beforeAll(async () => {
  const { nonStandard: _switches, ...strictConfig } = decodeConfig(
    nodeFs.readFileSync(bothConfigPath, "utf-8"),
  );
  writeConfig(neitherConfigPath, strictConfig);
  writeConfig(scalarsConfigPath, { ...strictConfig, nonStandard: { deepObjectScalars: true } });
  capture.script("/charges", { status: 204 });

  // One package at a time: each build is a heavy step.
  await Effect.runPromise(
    Effect.forEach(
      [
        ["neither", neitherConfigPath],
        ["scalars", scalarsConfigPath],
        ["both", bothConfigPath],
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

const onlyRequest = (sent: Exchange): RecordedRequest => {
  expect(sent.result.exitCode, decode(sent.result.stderr)).toBe(0);
  expect(sent.requests).toHaveLength(1);

  const [seen] = sent.requests;
  if (seen === undefined) {
    throw new Error("the capture server saw no request");
  }

  return seen;
};

type Pairs = readonly (readonly [string, string])[];

// The WHATWG form serialization of the pairs: the bytes a form body or a query of plain pairs
// carries (design 6.1 Scalar switch, Value and flag).
const serialized = (pairs: Pairs): string =>
  new URLSearchParams(pairs.map(([name, value]): [string, string] => [name, value])).toString();

// The form body's bytes and its decoded pairs, compared both ways.
const expectBody = async (mode: Mode, args: readonly string[], pairs: Pairs) => {
  const seen = onlyRequest(await exchange(mode, ["charges", "create", ...args]));

  expect(seen.method).toBe("POST");
  expect([...new URLSearchParams(decode(seen.body))]).toEqual(pairs.map((pair) => [...pair]));
  expect(decode(seen.body)).toBe(serialized(pairs));
};

// The query's decoded pairs, and the request target exactly when given.
const expectQuery = async (mode: Mode, args: readonly string[], pairs: Pairs, target?: string) => {
  const seen = onlyRequest(await exchange(mode, ["charges", "list", ...args]));
  const url = new URL(seen.target, origin);

  expect(seen.method).toBe("GET");
  expect(url.pathname).toBe("/charges");
  expect([...url.searchParams]).toEqual(pairs.map((pair) => [...pair]));
  if (target !== undefined) {
    expect(seen.target).toBe(target);
  }
};

const helpOf = async (mode: Mode, command: "create" | "list"): Promise<string> => {
  const help = await run(mode, ["charges", command, "--help"]);

  expect(help.exitCode, decode(help.stderr)).toBe(0);

  return decode(help.stdout);
};

// The flag names help lists, `--name` from `--name <value>  body /name`.
const flagNames = (help: string): readonly string[] =>
  [...help.matchAll(/^\s+(?<flag>--[^\s,=]+)/gmu)].map((match) => match.groups?.flag ?? "");

// The help line of one flag, through its notes.
const flagLine = (help: string, flag: string): string =>
  help.split("\n").find((candidate) => new RegExp(`^\\s+${flag}[\\s,=]`, "u").test(candidate)) ??
  "";

// The config key each flag note names, in note order: the switch identity, not its prose.
const notedKeys = (line: string): readonly string[] =>
  [...line.matchAll(/author config (?<key>nonStandard\.\w+)/gu)].map(
    (match) => match.groups?.key ?? "",
  );

// The NON-STANDARD line as `{ choice: flags }`: `--a, --b (choice); --c (other)`.
const nonStandardGroups = (help: string): Readonly<Record<string, readonly string[]>> => {
  const line = help.split("\n").find((candidate) => candidate.startsWith("NON-STANDARD"));
  if (line === undefined) {
    return {};
  }

  return Object.fromEntries(
    line
      .replace(/^NON-STANDARD\s+/u, "")
      .split("; ")
      .map((group) => {
        const match = /^(?<flags>.+) \((?<choice>\w+)\)$/u.exec(group);

        return [match?.groups?.choice ?? group, (match?.groups?.flags ?? "").split(", ")];
      }),
  );
};

// The wire names on the REFUSED line: `<wire>: <reason>; ...`. A reason may itself hold "; ", so
// an entry is a space-free name followed by ": " at the line start or after "; ".
const refusedNames = (help: string): readonly string[] | undefined => {
  const line = help.split("\n").find((candidate) => candidate.startsWith("REFUSED"));

  return line === undefined
    ? undefined
    : [...line.replace(/^REFUSED\s+/u, "").matchAll(/(?:^|; )(?<name>[^\s:;]+): /gu)].map(
        (match) => match.groups?.name ?? "",
      );
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

const expectCoverage = async (mode: Mode) => {
  const { text } = await describeOf(mode);
  const coverage = Effect.runSync(
    coverageOf({ describe: text, report: built(mode).reportText, resolution }).pipe(Effect.orDie),
  );

  expect(coverage.missing).toEqual([]);
  expect(coverage.invented).toEqual([]);
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

const scalarNotice = (pointer: string) => ({
  code: "PRM-27/scalar-author-choice",
  pointer,
  row: "PRM-27",
  scope: "element",
});

const bracketNotice = (pointer: string) => ({
  code: "PRM-27/bracket-author-choice",
  pointer,
  row: "PRM-27",
  scope: "element",
});

const scalarEntry = (pointer: string) =>
  ({
    choice: "deepObjectScalars",
    configKey: "nonStandard.deepObjectScalars",
    pointer,
    row: "PRM-27",
  }) as const;

const bracketEntry = (pointer: string) =>
  ({
    choice: "deepObjectBrackets",
    configKey: "nonStandard.deepObjectBrackets",
    pointer,
    row: "PRM-27",
  }) as const;

const entries = (report: GenerationReportValue) =>
  report.nonStandard.map(({ choice, configKey, pointer, row }) => ({
    choice,
    configKey,
    pointer: String(pointer),
    row,
  }));

const verdictOf = (report: GenerationReportValue) =>
  makeVerdict({
    commandNames: report.commandNames,
    corpusVersion: 1,
    coverage: { byNotice: [], checked: false, invented: [], missing: [] },
    diagnostics: [...report.refusals, ...report.notices],
    generator: {
      config: "tests/fixtures/deep-object-scalars/author-config.json",
      configSha256: "0".repeat(64),
      version: report.generator.version,
    },
    informational: 0,
    nonStandard: report.nonStandard,
    operations: { generated: report.commandNames.length, total: 2 },
    spec: { id: "deep-object-scalars", openapi: "3.1.2", sha256: "0".repeat(64) },
    twinEquality: { checked: false, equal: false },
  });

const verdictEntries = (report: GenerationReportValue) =>
  verdictOf(report).nonStandard.map(({ choice, pointer, row }) => ({
    choice,
    pointer: String(pointer),
    row,
  }));

const scalarKey = "nonStandard.deepObjectScalars";

const bracketKey = "nonStandard.deepObjectBrackets";

describe("deepObject scalars, both switches: the built CLI", () => {
  test("a nested object is sent in brackets and the empty string as metadata=", async () => {
    await expectBody(
      "both",
      ["--active-from", "1", "--metadata", '{"a":{"b":"c"}}'],
      [
        ["active_from", "1"],
        ["metadata[a][b]", "c"],
      ],
    );
    await expectBody(
      "both",
      ["--active-from", "1", "--metadata", '""'],
      [
        ["active_from", "1"],
        ["metadata", ""],
      ],
    );
  }, 60_000);

  test("a scalar union sends each scalar as one pair", async () => {
    await expectBody("both", ["--active-from", '"now"'], [["active_from", "now"]]);
    await expectBody("both", ["--active-from", "1700000000"], [["active_from", "1700000000"]]);
    await expectBody(
      "both",
      ["--active-from", "1", "--description", '""'],
      [
        ["active_from", "1"],
        ["description", ""],
      ],
    );
  }, 60_000);

  test("the query parameter sends its object as created[gt]=1 and its scalar as created=5", async () => {
    await expectQuery("both", ["--created", '{"gt":1}'], [["created[gt]", "1"]]);
    await expectQuery("both", ["--created", "5"], [["created", "5"]], "/charges?created=5");
  }, 60_000);

  test("help marks each flag with its switch notes and the command line names the choices", async () => {
    const create = await helpOf("both", "create");

    expect(notedKeys(flagLine(create, "--active-from"))).toEqual([scalarKey]);
    expect(notedKeys(flagLine(create, "--description"))).toEqual([scalarKey]);
    expect(notedKeys(flagLine(create, "--metadata"))).toEqual([bracketKey, scalarKey]);
    expect(nonStandardGroups(create)).toEqual({
      deepObjectBrackets: ["--metadata"],
      deepObjectScalars: ["--active-from", "--description", "--metadata"],
    });
    expect(refusedNames(create)).toBeUndefined();

    const list = await helpOf("both", "list");

    expect(notedKeys(flagLine(list, "--created"))).toEqual([scalarKey]);
    expect(nonStandardGroups(list)).toEqual({ deepObjectScalars: ["--created"] });
  }, 60_000);

  test("the report lists each choice per element with its notice", () => {
    const { report } = built("both");

    expect(rows(report.refusals)).toEqual([]);
    expect(rows(report.notices)).toEqual([
      scalarNotice(createdPointer),
      scalarNotice(encodingOf("active_from")),
      scalarNotice(encodingOf("description")),
      bracketNotice(encodingOf("metadata")),
      scalarNotice(encodingOf("metadata")),
    ]);
    expect(entries(report)).toEqual([
      scalarEntry(createdPointer),
      scalarEntry(encodingOf("active_from")),
      scalarEntry(encodingOf("description")),
      bracketEntry(encodingOf("metadata")),
      scalarEntry(encodingOf("metadata")),
    ]);
  });

  test("the verdict counts and lists the non-standard entries", () => {
    const { report } = built("both");
    const verdict = verdictOf(report);

    expect(verdict.counts.nonStandard).toBe(5);
    expect(verdictEntries(report)).toEqual(
      entries(report).map(({ choice, pointer, row }) => ({ choice, pointer, row })),
    );
    expect(rows(verdict.refusals)).toEqual([]);
  });

  test("coverageOf reports missing 0 and invented 0", async () => {
    await expectCoverage("both");
  }, 60_000);
});

describe("deepObject scalars, the scalar switch alone: the built CLI", () => {
  test("metadata stays refused at field scope: no flag, on the REFUSED line and in --describe", async () => {
    const help = await helpOf("scalars", "create");

    expect(flagNames(help)).toContain("--active-from");
    expect(flagNames(help).filter((flag) => flag.startsWith("--metadata"))).toEqual([]);
    expect(refusedNames(help)).toEqual(["metadata"]);
    expect(notedKeys(flagLine(help, "--active-from"))).toEqual([scalarKey]);
    expect(notedKeys(flagLine(help, "--description"))).toEqual([scalarKey]);
    expect(nonStandardGroups(help)).toEqual({
      deepObjectScalars: ["--active-from", "--description"],
    });

    const { description } = await describeOf("scalars");

    expect(description.commands.flatMap((command) => command.refusedFields)).toEqual([
      { mediaType: formMedia, name: "metadata" },
    ]);
  }, 60_000);

  test("the rest is sent as name=value and the one-level object as created[gt]=1", async () => {
    await expectBody("scalars", ["--active-from", '"now"'], [["active_from", "now"]]);
    await expectBody(
      "scalars",
      ["--active-from", "1700000000", "--description", '""'],
      [
        ["active_from", "1700000000"],
        ["description", ""],
      ],
    );
    await expectQuery("scalars", ["--created", '{"gt":1}'], [["created[gt]", "1"]]);
    await expectQuery("scalars", ["--created", "5"], [["created", "5"]], "/charges?created=5");
  }, 60_000);

  test("the report refuses metadata at field scope and marks the rest", () => {
    const { report } = built("scalars");

    expect(rows(report.refusals)).toEqual([
      {
        code: "PRM-27/compound-nested",
        pointer: encodingOf("metadata"),
        row: "PRM-27",
        scope: "field",
      },
    ]);
    expect(rows(report.notices)).toEqual([
      scalarNotice(createdPointer),
      scalarNotice(encodingOf("active_from")),
      scalarNotice(encodingOf("description")),
    ]);
    expect(entries(report)).toEqual([
      scalarEntry(createdPointer),
      scalarEntry(encodingOf("active_from")),
      scalarEntry(encodingOf("description")),
    ]);

    const verdict = verdictOf(report);

    expect(verdict.counts.nonStandard).toBe(3);
    expect(verdict.counts.refusals).toEqual({ document: 0, element: 0, field: 1, operation: 0 });
  });

  test("coverageOf reports missing 0 and invented 0", async () => {
    await expectCoverage("scalars");
  }, 60_000);
});

describe("deepObject scalars, neither switch: the strict refusals", () => {
  test("the report refuses the union parameter and the required union field, and marks nothing", () => {
    const { report } = built("neither");

    expect(rows(report.refusals)).toEqual([
      {
        code: "PRM-27/non-object-schema",
        pointer: createdPointer,
        row: "PRM-27",
        scope: "element",
      },
      {
        code: "OPR-09/required-body-refused",
        pointer: "/paths/~1charges/post",
        row: "OPR-09",
        scope: "operation",
      },
      { code: "PRM-27/non-object-schema", pointer: createMedia, row: "PRM-27", scope: "element" },
    ]);
    expect(report.notices).toEqual([]);
    expect(report.nonStandard).toEqual([]);
    expect(report.commandNames.map((entry) => entry.path)).toEqual([["charges", "list"]]);

    const verdict = verdictOf(report);

    expect(verdict.counts.nonStandard).toBe(0);
    expect(verdict.nonStandard).toEqual([]);
  });

  test("the list command has no --created flag and names it on the REFUSED line", async () => {
    const help = await helpOf("neither", "list");

    expect(flagNames(help).filter((flag) => flag.startsWith("--created"))).toEqual([]);
    expect(refusedNames(help)).toEqual(["created"]);
    expect(nonStandardGroups(help)).toEqual({});

    const rejected = await exchange("neither", ["charges", "list", "--created", "5"]);

    expect(rejected.result.exitCode).toBe(2);
    expect(rejected.connections).toBe(0);

    const create = await exchange("neither", ["charges", "create", "--active-from", "1"]);

    expect(create.result.exitCode).not.toBe(0);
    expect(create.connections).toBe(0);
  }, 60_000);

  test("coverageOf reports missing 0 and invented 0", async () => {
    await expectCoverage("neither");
  }, 60_000);
});
