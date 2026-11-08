import { homedir } from "node:os";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Array as Arr, Data, Effect, FileSystem, Path, Runtime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import generatorPackage from "../../package.json" with { type: "json" };
import { GenerateRefused } from "../../src/generate.ts";
import { loadBytes } from "../../src/load/index.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { collectInformational } from "../../src/normalize/informational.ts";
import { VerdictCoverage } from "../../src/model/verdict.ts";
import { makeVerdict, printVerdict } from "../../src/report/verdict.ts";
import type { VerdictValue } from "../../src/report/verdict.ts";
import { resolve } from "../../src/resolve/index.ts";
import { Description } from "../../src/runtime-src/runtime/describe.ts";
import { lineOf } from "../../src/validate/dispatch.ts";
import { sha256Hex } from "../../src/write/manifest.ts";
import { coverageOf } from "./coverage.ts";
import type { Coverage, Invented } from "./coverage.ts";
import { Corpus, fetchPinned, githubSource } from "./fetch.ts";
import type { CorpusEntry, Pin } from "./fetch.ts";
import { Generation, GenerationRequest, reportFile } from "./generate.ts";
import { walk } from "./walk.ts";
import type { WalkElement } from "./walk.ts";

// The corpus run (design 8.2, CP-2): for each `ci` spec with an author config, generate from the
// pinned bytes, compare the YAML twin, build, run `--describe`, join coverage and print the
// verdict. `--check` compares the printed verdict with the committed one byte for byte.
// Generation runs in its own process (`generate.ts`) that exits before the build, so the build
// never shares the memory ceiling with what generation held.

type Entry = typeof CorpusEntry.Type;

const { version } = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
  generatorPackage,
);

const decodeDocument = Schema.decodeUnknownEffect(DocumentUri);

const decodeCorpus = Schema.decodeUnknownEffect(Schema.fromJsonString(Corpus));

const decodeDescription = Schema.decodeUnknownEffect(Schema.fromJsonString(Description));

const decodeGeneration = Schema.decodeUnknownEffect(Schema.fromJsonString(Generation));

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(GenerationRequest));

const generateEntry = new URL("generate.ts", import.meta.url).pathname;

const decoder = new TextDecoder();

/**
 * A step of the run that cannot produce a verdict: a build step that exited non-zero, a bin that
 * did not describe itself, a spec the generator could not read.
 */
export class CorpusRunFailed extends Data.TaggedError("CorpusRunFailed")<{
  readonly id: string;
  readonly output: string;
  readonly step: string;
}> {}

/**
 * The generation process for one spec ended without writing its result: a defect of the generator
 * or of its input that the process has already logged. The run stops, as it does for any failure
 * of generation other than a refusal.
 */
export class CorpusGenerateFailed extends Data.TaggedError("CorpusGenerateFailed")<{
  readonly exitCode: number | null;
  readonly id: string;
}> {
  override get message(): string {
    return `${this.id}: generation exited ${String(this.exitCode)} without a result`;
  }
}

/**
 * What the run found that a verdict records but the gate does not accept, other than a coverage
 * gap: a refused spec, an unequal twin, a verdict that differs from the committed file, bad
 * arguments. The process exits 1.
 */
export class CorpusFindings extends Data.TaggedError("CorpusFindings")<{
  readonly findings: readonly string[];
}> {
  readonly [Runtime.errorExitCode] = 1;

  override get message(): string {
    return this.findings.join("\n");
  }
}

/**
 * The only thing the run found is coverage: the join reports an element nothing accounts for, or a
 * claim nothing in the spec stands behind. The process exits 3, so a caller can tell a coverage
 * proof that failed from a spec that did not build or was refused.
 */
export class CorpusCoverageGaps extends Data.TaggedError("CorpusCoverageGaps")<{
  readonly findings: readonly string[];
}> {
  readonly [Runtime.errorExitCode] = 3;

  override get message(): string {
    return this.findings.join("\n");
  }
}

interface Context {
  readonly cacheDir: string;
  // Where verdicts are written; `corpus/verdicts/` under `root` unless `--out` names a directory.
  readonly out: string | undefined;
  readonly root: string;
  readonly work: string;
}

// What a run found, by cause: `coverage` is read from the `Coverage` value, never from verdict text.
export interface Findings {
  readonly coverage: readonly string[];
  readonly other: readonly string[];
}

const noFindings: Findings = { coverage: [], other: [] };

interface Run {
  readonly findings: Findings;
  readonly summary: string;
  readonly verdict: VerdictValue;
}

// A blocking spawn, so heavy steps never overlap. `env` is the whole environment: proxy variables
// never reach the generated CLI (design C6).
const spawn = (
  id: string,
  step: string,
  command: readonly string[],
  options: { readonly cwd: string; readonly env?: Record<string, string> },
): Effect.Effect<string, CorpusRunFailed> =>
  Effect.suspend(() => {
    const result = Bun.spawnSync([...command], {
      cwd: options.cwd,
      env: options.env ?? { ...process.env },
      stderr: "pipe",
      stdout: "pipe",
      timeout: 600_000,
    });
    const stdout = decoder.decode(result.stdout);

    return result.exitCode === 0
      ? Effect.succeed(stdout)
      : Effect.fail(
          new CorpusRunFailed({
            id,
            output: `exit ${String(result.exitCode)}\n${stdout}${decoder.decode(result.stderr)}`,
            step,
          }),
        );
  });

const describeElement = (element: WalkElement): string => {
  if (element.kind === "parameter") {
    return `parameter ${element.pointer} ${element.in} ${element.name}`;
  }

  if (element.kind === "requestMedia") {
    return `requestMedia ${element.pointer} ${element.mediaType}`;
  }

  if (element.kind === "response") {
    return `response ${element.pointer} ${element.key}`;
  }

  if (element.kind === "securityAlternative") {
    return `securityAlternative ${element.pointer} ${JSON.stringify(element.schemes)}`;
  }

  return element.kind === "server"
    ? `server ${element.pointer} ${element.url}`
    : `operation ${element.pointer}`;
};

const describeInvented = (invented: Invented): string => {
  const head = `invented ${invented.kind} ${invented.document} ${invented.pointer}`;

  if (invented.kind === "requestMedia") {
    return `${head} ${invented.mediaType}`;
  }

  if (invented.kind === "response") {
    return `${head} ${invented.key}`;
  }

  if (invented.kind === "securityAlternative") {
    return `${head} ${JSON.stringify(invented.schemes)}`;
  }

  return invented.kind === "server" ? `${head} ${invented.url}` : head;
};

type CoverageEntries = typeof VerdictCoverage.Encoded;

// A walk element as the verdict lists it: its use site, its kind and the kind's value.
const elementEntry = (element: WalkElement): CoverageEntries["missing"][number] => {
  const site = { document: element.document, pointer: element.pointer };

  if (element.kind === "parameter") {
    return { ...site, in: element.in, kind: element.kind, name: element.name };
  }

  if (element.kind === "requestMedia") {
    return { ...site, kind: element.kind, mediaType: element.mediaType };
  }

  if (element.kind === "response") {
    return { ...site, key: element.key, kind: element.kind };
  }

  if (element.kind === "securityAlternative") {
    return { ...site, kind: element.kind, schemes: element.schemes };
  }

  return element.kind === "server"
    ? { ...site, kind: element.kind, url: element.url }
    : { ...site, kind: element.kind };
};

// A claim as the verdict lists it: its kind, the command's path and the value.
const inventedEntry = (invented: Invented): CoverageEntries["invented"][number] => {
  const { path } = invented;

  if (invented.kind === "requestMedia") {
    return { kind: invented.kind, mediaType: invented.mediaType, path };
  }

  if (invented.kind === "response") {
    return { key: invented.key, kind: invented.kind, path };
  }

  if (invented.kind === "securityAlternative") {
    return { kind: invented.kind, path, schemes: invented.schemes };
  }

  return invented.kind === "server"
    ? { kind: invented.kind, path, url: invented.url }
    : { kind: invented.kind, path };
};

const decodeCoverage = Schema.decodeEffect(VerdictCoverage);

// The verdict's coverage (design 8.2): each list typed, none of them text.
const coverageEntries = (coverage: Coverage) =>
  decodeCoverage({
    byNotice: coverage.byNotice.map(elementEntry),
    checked: true,
    invented: coverage.invented.map(inventedEntry),
    missing: coverage.missing.map(elementEntry),
  });

/**
 * The causes a coverage join reports, one line each naming the spec id and the element: what
 * nothing accounts for, and what nothing in the spec stands behind. Elements accounted only by a
 * notice are not causes.
 */
export const coverageFindings = (id: string, coverage: Coverage): readonly string[] => [
  ...coverage.missing.map((element) => `${id}: missing ${describeElement(element)}`),
  ...coverage.invented.map((invented) => `${id}: ${describeInvented(invented)}`),
];

interface Twin {
  readonly checked: boolean;
  readonly differing: readonly string[];
}

const twinState = (twin: Twin): string => {
  if (!twin.checked) {
    return "unchecked";
  }

  return twin.differing.length === 0 ? "equal" : "unequal";
};

// Generates the package (and the twin) in a child process and reads back what the verdict needs.
// The child's output and logs are the run's own; a refusal fails here as `generate` would.
const generateApart = (id: string, request: typeof GenerationRequest.Type) =>
  Effect.gen(function* generateRun() {
    const fs = yield* FileSystem.FileSystem;
    const result = Bun.spawnSync(
      [process.execPath, ...process.execArgv, generateEntry, yield* encodeRequest(request)],
      { env: { ...process.env }, stderr: "inherit", stdout: "inherit" },
    );
    if (result.exitCode !== 0 || !(yield* fs.exists(request.result))) {
      return yield* new CorpusGenerateFailed({ exitCode: result.exitCode, id });
    }

    const generation = yield* decodeGeneration(yield* fs.readFileString(request.result));

    return generation._tag === "Refused"
      ? yield* new GenerateRefused({
          diagnostics: generation.diagnostics,
          reason: generation.reason,
        })
      : generation;
  });

// One spec through generation, twin, build, `--describe` and the coverage join. The spec is read
// in this process only after the build, so the build runs beside nothing generation held.
const runEntry = (entry: Entry, corpusVersion: number, context: Context) =>
  Effect.gen(function* runOne() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configName = `corpus/config/${entry.id}.json`;
    const configPath = path.join(context.root, configName);
    const fetch = (pin: Pin) =>
      fetchPinned(pin, context.cacheDir, githubSource).pipe(Effect.provide(FetchHttpClient.layer));
    const specPath = yield* fetch(entry);
    // The spec is named by its pinned source URL and the config by its repository path, never by
    // a host path (C8); the twin is named as the JSON is, so only the format differs.
    const document = yield* decodeDocument(entry.sourceUrl);
    const configDocument = yield* decodeDocument(`file:///${configName}`);

    yield* fs.makeDirectory(context.work, { recursive: true });

    const scratch = yield* fs.makeTempDirectoryScoped({
      directory: context.work,
      prefix: `corpus-${entry.id}-`,
    });
    const jsonDir = path.join(scratch, "json");
    const request = {
      config: { document: configDocument, path: configPath },
      document,
      json: { outDir: jsonDir, specPath },
      result: path.join(scratch, "generation.json"),
    };
    const twinPin = entry.twin;
    const generated = yield* generateApart(
      entry.id,
      twinPin === undefined
        ? request
        : {
            ...request,
            twin: { outDir: path.join(scratch, "yaml"), specPath: yield* fetch(twinPin) },
          },
    );
    const { twin } = generated;

    const bun = process.execPath;
    yield* spawn(
      entry.id,
      "install",
      [bun, "install", "--prefer-offline", "--no-save", "--ignore-scripts"],
      {
        cwd: jsonDir,
      },
    );
    yield* spawn(entry.id, "build", [bun, "run", "build"], { cwd: jsonDir });

    const manifest = yield* fs.readFileString(path.join(jsonDir, "package.json"));
    const { bin } = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ bin: Schema.Record(Schema.String, Schema.String) })),
    )(manifest);
    const binPaths = Object.values(bin);
    const [binPath] = binPaths;
    if (binPath === undefined || binPaths.length !== 1) {
      return yield* new CorpusRunFailed({ id: entry.id, output: manifest, step: "bin" });
    }

    const configBytes = yield* fs.readFile(configPath);
    const loaded = yield* loadBytes(yield* fs.readFile(specPath), { document });
    const resolution = yield* resolve({
      document,
      line: yield* lineOf(loaded.value),
      value: loaded.value,
    });
    const openapi = yield* Schema.decodeUnknownEffect(Schema.Struct({ openapi: Schema.String }))(
      loaded.value,
    );
    const informational = (yield* collectInformational(resolution)).length;
    const elements = yield* walk(resolution);
    const total = elements.filter((element) => element.kind === "operation").length;

    const describe = yield* spawn(
      entry.id,
      "describe",
      [bun, path.join(jsonDir, ...binPath.split("/")), "--describe"],
      { cwd: jsonDir, env: {} },
    );
    const report = yield* fs.readFileString(path.join(jsonDir, reportFile));
    const coverage = yield* coverageOf({ describe, report, resolution });
    const { commands } = yield* decodeDescription(describe);
    const inventedCommands = new Set(
      coverage.invented.flatMap((invented) =>
        invented.kind === "command" ? [`${invented.document}\u0000${invented.pointer}`] : [],
      ),
    );
    const bound = Arr.dedupe(
      commands.map((command) => `${command.document}\u0000${command.pointer}`),
    );
    const operations = {
      generated: bound.filter((site) => !inventedCommands.has(site)).length,
      total,
    };

    const { commandNames, nonStandard } = generated;
    const verdict = makeVerdict({
      commandNames,
      corpusVersion,
      coverage: yield* coverageEntries(coverage),
      diagnostics: generated.diagnostics,
      generator: { config: configName, configSha256: sha256Hex(configBytes), version },
      informational,
      nonStandard,
      operations,
      spec: { id: entry.id, openapi: openapi.openapi, sha256: entry.sha256 },
      twinEquality: { checked: twin.checked, equal: twin.checked && twin.differing.length === 0 },
    });

    const findings: Findings = {
      coverage: coverageFindings(entry.id, coverage),
      other: [
        ...(verdict.verdict === "refused" ? [`${entry.id}: verdict is refused`] : []),
        ...twin.differing.map((file) => `${entry.id}: YAML twin differs at ${file}`),
      ],
    };
    const summary = [
      `${entry.id}: ${String(commands.length)} commands, ${String(operations.generated)}/${String(total)} operations generated`,
      `refusals ${String(verdict.refusals.length)}, notices ${String(verdict.notices.length)}`,
      `coverage missing ${String(coverage.missing.length)} invented ${String(coverage.invented.length)} byNotice ${String(coverage.byNotice.length)}`,
      `twin ${twinState(twin)}`,
    ].join("; ");
    const byNotice = coverage.byNotice.map(
      (element) => `${entry.id}: by notice ${describeElement(element)}`,
    );

    const result: Run = { findings, summary: [summary, ...byNotice].join("\n"), verdict };

    return result;
  });

// The first line where two different texts differ, each side shown as JSON.
const firstDifference = (committed: string, regenerated: string) => {
  const left = committed.split("\n");
  const right = regenerated.split("\n");
  const index = left.findIndex((text, at) => text !== right[at]);
  const at = index === -1 ? left.length : index;

  return {
    committed: JSON.stringify(left[at] ?? "(end of file)"),
    number: at + 1,
    regenerated: JSON.stringify(right[at] ?? "(end of file)"),
  };
};

// A refused document writes no package, so there is no verdict to build: the run names the codes.
const refusedFinding = (id: string, refused: GenerateRefused): Findings => ({
  coverage: [],
  other: [
    `${id}: refused (${refused.reason}): ${refused.diagnostics.map((diagnostic) => diagnostic.code).join(", ")}`,
  ],
});

// Runs one `ci` entry and writes its verdict, or with `check` compares it with the committed file.
// An entry without an author config is listed as skipped, and is a finding under `check`: every
// `ci` entry has a config and a verdict (design 8.2). Returns the run's findings.
const verdictFor = (entry: Entry, corpusVersion: number, context: Context, check: boolean) =>
  Effect.gen(function* verdictOne() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { root } = context;
    const configName = `corpus/config/${entry.id}.json`;
    if (!(yield* fs.exists(path.join(root, ...configName.split("/"))))) {
      if (check) {
        return { coverage: [], other: [`${entry.id}: no author config at ${configName}`] };
      }

      yield* Effect.log(`${entry.id}: skipped, no ${configName}`);

      return noFindings;
    }

    const attempt = yield* Effect.scoped(runEntry(entry, corpusVersion, context)).pipe(
      Effect.map((run): Run | Findings => run),
      Effect.catchTag("GenerateRefused", (refused) =>
        refused.reason === "document"
          ? Effect.succeed(refusedFinding(entry.id, refused))
          : Effect.fail(refused),
      ),
      // A failed step is a finding, so the other selected specs still run and are reported.
      Effect.catchTag("CorpusRunFailed", (failure) =>
        Effect.logError(`${failure.id}: ${failure.step} failed\n${failure.output}`).pipe(
          Effect.as({ coverage: [], other: [`${failure.id}: ${failure.step} failed`] }),
        ),
      ),
    );
    if (!("verdict" in attempt)) {
      return attempt;
    }

    const result = attempt;
    yield* Effect.log(result.summary);

    const printed = yield* printVerdict(result.verdict);
    const name = `${entry.id}@${entry.sha256.slice(0, 12)}.json`;
    const relative = `corpus/verdicts/${name}`;
    const target =
      !check && context.out !== undefined
        ? path.join(context.out, name)
        : path.join(root, ...relative.split("/"));

    if (!check) {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, printed);
      yield* Effect.log(
        `${entry.id}: wrote ${context.out === undefined ? relative : path.join(context.out, name)}`,
      );

      return result.findings;
    }

    const other = (text: string): Findings => ({
      coverage: result.findings.coverage,
      other: [...result.findings.other, text],
    });

    if (!(yield* fs.exists(target))) {
      return other(`${entry.id}: no committed verdict at ${relative}`);
    }

    const committed = yield* fs.readFileString(target);
    if (committed !== printed) {
      const line = firstDifference(committed, printed);

      return other(
        `${entry.id}: ${relative} differs from the regenerated verdict at line ${String(line.number)}: committed ${line.committed}, regenerated ${line.regenerated}`,
      );
    }

    return result.findings;
  });

interface Options {
  readonly check: boolean;
  readonly listCi: boolean;
  readonly only: readonly string[];
  readonly out: string | undefined;
  readonly root: string | undefined;
}

/**
 * Turns the findings of every selected spec into the run's outcome: success, `CorpusFindings`
 * (exit 1) when anything but coverage failed, or `CorpusCoverageGaps` (exit 3) when coverage is the
 * only failure.
 */
export const settle = (found: readonly Findings[]) =>
  Effect.gen(function* settled() {
    const other = found.flatMap((findings) => findings.other);
    const coverage = found.flatMap((findings) => findings.coverage);

    if (other.length > 0) {
      yield* new CorpusFindings({ findings: [...other, ...coverage] });
    }

    if (coverage.length > 0) {
      yield* new CorpusCoverageGaps({ findings: coverage });
    }
  });

const run = (options: Options) =>
  Effect.gen(function* corpusRun() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // `--root` moves the corpus manifest, author configs, verdicts and scratch; the generator and
    // its pinned cache stay where they are.
    const root =
      options.root === undefined
        ? path.resolve(import.meta.dir, "../..")
        : path.resolve(options.root);
    const context: Context = {
      cacheDir:
        process.env.CORPUS_CACHE ?? path.join(homedir(), ".cache/effect-openapi-cli-generator"),
      out: options.out === undefined ? undefined : path.resolve(options.out),
      root,
      work: path.join(root, "work"),
    };
    const corpus = yield* decodeCorpus(
      yield* fs.readFileString(path.join(root, "corpus/corpus.json")),
    );
    const ci = corpus.specs.filter((spec) => spec.tier === "ci");

    if (options.listCi) {
      yield* Effect.forEach(
        ci,
        (entry) =>
          Effect.sync(() => {
            console.log(entry.id);
          }),
        { discard: true },
      );

      return;
    }

    const unknownIds = options.only.filter((id) => !ci.some((entry) => entry.id === id));
    if (unknownIds.length > 0) {
      yield* new CorpusFindings({
        findings: unknownIds.map((id) => `--only ${id}: no ci entry with that id`),
      });
    }

    const selected = options.only.length === 0 ? ci : ci.filter((e) => options.only.includes(e.id));
    const found = yield* Effect.all(
      selected.map((entry) => verdictFor(entry, corpus.version, context, options.check)),
    );

    yield* settle(found);
  });

// `--only` repeats; `--only`, `--out` and `--root` each take a value. Anything else is refused.
const parseArguments = (
  args: readonly string[],
): { readonly options: Options } | { readonly problems: readonly string[] } => {
  const only: string[] = [];
  const problems: string[] = [];
  let check = false;
  let listCi = false;
  let out: string | undefined;
  let root: string | undefined;

  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? "";
    const value = args[at + 1];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--list-ci") {
      listCi = true;
    } else if (arg === "--only" || arg === "--out" || arg === "--root") {
      if (value === undefined || value.startsWith("--")) {
        problems.push(`${arg} needs a value`);
      } else {
        at += 1;
        if (arg === "--only") {
          only.push(value);
        } else if (arg === "--out") {
          out = value;
        } else {
          root = value;
        }
      }
    } else {
      problems.push(`unknown argument: ${arg}`);
    }
  }

  if (check && out !== undefined) {
    problems.push("--out cannot be used with --check: --check compares committed verdicts");
  }

  return problems.length > 0 ? { problems } : { options: { check, listCi, only, out, root } };
};

if (import.meta.main) {
  const parsed = parseArguments(process.argv.slice(2));
  const program =
    "problems" in parsed
      ? Effect.fail(new CorpusFindings({ findings: parsed.problems }))
      : run(parsed.options);

  BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
}
