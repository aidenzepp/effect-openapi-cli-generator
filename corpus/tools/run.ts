import { homedir } from "node:os";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Array as Arr, Data, Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import { loadBytes } from "../../src/load/index.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { collectInformational } from "../../src/normalize/informational.ts";
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
import { walk } from "./walk.ts";
import type { WalkElement } from "./walk.ts";

// The corpus run (design 8.2, CP-2): for each `ci` spec with an author config, generate from the
// pinned bytes, compare the YAML twin, build, run `--describe`, join coverage and print the
// verdict. `--check` compares the printed verdict with the committed one byte for byte.

type Entry = typeof CorpusEntry.Type;

const reportFile = "generation-report.json";

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const { version } = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
  generatorPackage,
);

const decodeDocument = Schema.decodeUnknownEffect(DocumentUri);

const decodeCorpus = Schema.decodeUnknownEffect(Schema.fromJsonString(Corpus));

const decodeDescription = Schema.decodeUnknownEffect(Schema.fromJsonString(Description));

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
 * What the run found that a verdict records but the gate does not accept: coverage gaps, an
 * unequal twin, or a verdict that differs from the committed file.
 */
export class CorpusFindings extends Data.TaggedError("CorpusFindings")<{
  readonly findings: readonly string[];
}> {}

interface Context {
  readonly cacheDir: string;
  readonly root: string;
  readonly work: string;
}

interface Run {
  readonly findings: readonly string[];
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

// The verdict's `coverage.missing` lists what nothing accounts for and what nothing in the spec
// stands behind; elements accounted only by a notice already appear in `notices`.
const missingOf = (coverage: Coverage): readonly string[] => [
  ...coverage.missing.map(describeElement),
  ...coverage.invented.map(describeInvented),
];

// Every emitted file but the report (which records each input's digest), compared by bytes.
const twinDifferences = (json: string, yaml: string, files: readonly string[]) =>
  Effect.gen(function* compare() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const differing = yield* Effect.forEach(
      files.filter((file) => file !== reportFile),
      (file) =>
        Effect.all([fs.readFile(path.join(json, file)), fs.readFile(path.join(yaml, file))]).pipe(
          Effect.map(([a, b]) => (sha256Hex(a) === sha256Hex(b) ? [] : [file])),
        ),
    );

    return differing.flat();
  });

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

// One spec through generation, twin, build, `--describe` and the coverage join.
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
    const config = {
      document: yield* decodeDocument(`file:///${configName}`),
      path: configPath,
    };
    const configBytes = yield* fs.readFile(configPath);
    const specBytes = yield* fs.readFile(specPath);
    const loaded = yield* loadBytes(specBytes, { document });
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

    yield* fs.makeDirectory(context.work, { recursive: true });

    const scratch = yield* fs.makeTempDirectoryScoped({
      directory: context.work,
      prefix: `corpus-${entry.id}-`,
    });
    const jsonDir = path.join(scratch, "json");
    const generated = yield* generate(
      {
        document,
        generator,
        outDir: jsonDir,
        source: { _tag: "File", path: specPath },
        strict: false,
      },
      config,
    );

    const twinPin = entry.twin;
    const twin: Twin =
      twinPin === undefined
        ? { checked: false, differing: [] }
        : yield* Effect.gen(function* twinRun() {
            const yamlDir = path.join(scratch, "yaml");
            const yaml = yield* generate(
              {
                document,
                generator,
                outDir: yamlDir,
                source: { _tag: "File", path: yield* fetch(twinPin) },
                strict: false,
              },
              config,
            );
            const files = Arr.union(generated.files, yaml.files);

            return { checked: true, differing: yield* twinDifferences(jsonDir, yamlDir, files) };
          });

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

    const verdict = makeVerdict({
      corpusVersion,
      coverage: { checked: true, missing: missingOf(coverage) },
      diagnostics: generated.diagnostics,
      generator: { config: configName, configSha256: sha256Hex(configBytes), version },
      informational,
      operations,
      spec: { id: entry.id, openapi: openapi.openapi, sha256: entry.sha256 },
      twinEquality: { checked: twin.checked, equal: twin.checked && twin.differing.length === 0 },
    });

    const findings = [
      ...coverage.missing.map((element) => `${entry.id}: missing ${describeElement(element)}`),
      ...coverage.invented.map((invented) => `${entry.id}: ${describeInvented(invented)}`),
      ...twin.differing.map((file) => `${entry.id}: YAML twin differs at ${file}`),
    ];
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

// Runs one `ci` entry and writes its verdict, or with `check` compares it with the committed file.
// An entry without an author config is listed as skipped. Returns the run's findings.
const verdictFor = (entry: Entry, corpusVersion: number, context: Context, check: boolean) =>
  Effect.gen(function* verdictOne() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { root } = context;
    if (!(yield* fs.exists(path.join(root, "corpus/config", `${entry.id}.json`)))) {
      yield* Effect.log(`${entry.id}: skipped, no corpus/config/${entry.id}.json`);

      return [];
    }

    const result = yield* Effect.scoped(runEntry(entry, corpusVersion, context));
    yield* Effect.log(result.summary);

    const printed = yield* printVerdict(result.verdict);
    const relative = `corpus/verdicts/${entry.id}@${entry.sha256.slice(0, 12)}.json`;
    const target = path.join(root, ...relative.split("/"));

    if (!check) {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, printed);
      yield* Effect.log(`${entry.id}: wrote ${relative}`);

      return result.findings;
    }

    if (!(yield* fs.exists(target))) {
      return [...result.findings, `${entry.id}: no committed verdict at ${relative}`];
    }

    const committed = yield* fs.readFileString(target);
    if (committed !== printed) {
      const line = firstDifference(committed, printed);

      return [
        ...result.findings,
        `${entry.id}: ${relative} differs from the regenerated verdict at line ${String(line.number)}: committed ${line.committed}, regenerated ${line.regenerated}`,
      ];
    }

    return result.findings;
  });

const run = (check: boolean) =>
  Effect.gen(function* corpusRun() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dir, "../..");
    const context: Context = {
      cacheDir:
        process.env.CORPUS_CACHE ?? path.join(homedir(), ".cache/effect-openapi-cli-generator"),
      root,
      work: path.join(root, "work"),
    };
    const corpus = yield* decodeCorpus(
      yield* fs.readFileString(path.join(root, "corpus/corpus.json")),
    );
    const ci = corpus.specs.filter((spec) => spec.tier === "ci");
    const findings = yield* Effect.all(
      ci.map((entry) => verdictFor(entry, corpus.version, context, check)),
    );

    const all = findings.flat();

    yield* all.length === 0
      ? Effect.void
      : Effect.logError(all.join("\n")).pipe(
          Effect.andThen(Effect.fail(new CorpusFindings({ findings: all }))),
        );
  });

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--check");
  const program =
    unknown.length > 0
      ? Effect.fail(new CorpusFindings({ findings: [`unknown arguments: ${unknown.join(" ")}`] }))
      : run(args.includes("--check"));

  BunRuntime.runMain(
    program.pipe(
      Effect.tapErrorTag("CorpusRunFailed", (failure) =>
        Effect.logError(`${failure.id}: ${failure.step} failed\n${failure.output}`),
      ),
      Effect.provide(BunServices.layer),
    ),
  );
}
