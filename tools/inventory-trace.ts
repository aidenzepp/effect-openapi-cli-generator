import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Array as Arr, Data, Effect, FileSystem, Path, Runtime, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

/**
 * Row trace: prove every implemented or refused inventory row has a test titled with its id.
 *
 * Bun tools/inventory-trace.ts [--check [--allow-todo]] [--only <regex>] [--root <dir>]
 */

const usage =
  "usage: bun tools/inventory-trace.ts [--check [--allow-todo]] [--only <regex>] [--root <dir>]";

/**
 * A bad command line: exit 2.
 */
export class TraceUsageError extends Data.TaggedError("TraceUsageError")<{
  readonly reason: string;
}> {
  readonly [Runtime.errorExitCode] = 2;

  override get message(): string {
    return `${this.reason}\n${usage}`;
  }
}

/**
 * A tracked input that cannot be read or decoded: exit 1.
 */
export class TraceInputError extends Data.TaggedError("TraceInputError")<{
  readonly file: string;
  readonly reason: string;
}> {
  readonly [Runtime.errorExitCode] = 1;

  override get message(): string {
    return `${this.file}: ${this.reason}`;
  }
}

/**
 * `--check` found a row that is not traced; the report is already printed: exit 1.
 */
export class TraceCheckFailed extends Data.TaggedError("TraceCheckFailed") {
  readonly [Runtime.errorExitCode] = 1;

  readonly [Runtime.errorReported] = true;
}

const Rows = Schema.Array(
  Schema.Struct({
    coveredBy: Schema.Array(Schema.String),
    disposition: Schema.Literals(["implemented", "refused", "informational"]),
    id: Schema.String,
  }),
);

const Deferred = Schema.Array(Schema.Struct({ deferred: Schema.String, row: Schema.String }));

const SplitRows = Schema.Array(
  Schema.Struct({ halves: Schema.Array(Schema.String), row: Schema.String }),
);

export type Status =
  | "covered"
  | "partial"
  | "todo"
  | "missing"
  | "delegated"
  | "deferred"
  | "informational";

/**
 * One reported line: a row, or one half of a split row.
 */
export interface Report {
  readonly id: string;
  readonly half?: string;
  readonly status: Status;
  readonly via?: readonly string[];
  /**
   * Passing test count, set on `partial` rows.
   */
  readonly passing?: number;
  /**
   * `test.todo` count, set on `partial` rows.
   */
  readonly todo?: number;
}

/**
 * A titled test: the row id, the half it names, and whether it is a `test.todo`.
 */
interface Title {
  readonly id: string;
  readonly half?: string | undefined;
  readonly todo: boolean;
}

const callPattern =
  /(?:^|[^\w.$])(?:test|it)(?<todo>\.todo)?\(\s*(?<quote>["'`])(?<text>(?:\\.|(?!\k<quote>).)*)\k<quote>/gu;

const rowId = "[A-Z][A-Z0-9]*-\\d+";

/**
 * Matches a whole inventory row id: capitals and digits from a leading capital, a hyphen, digits.
 */
export const rowIdPattern = new RegExp(`^${rowId}$`, "u");

const titlePattern = new RegExp(`^(?<id>${rowId})(?: \\((?<half>[a-z0-9-]+)\\))?: `, "u");

const stripComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^\s*\/\/.*$/gmu, "");

/**
 * The titles of the `test(`, `it(` and `test.todo(` calls in one test file.
 */
export const titlesOf = (source: string): readonly Title[] =>
  Arr.flatMap([...stripComments(source).matchAll(callPattern)], (match) => {
    const parsed = titlePattern.exec(match.groups?.text ?? "")?.groups;

    return parsed?.id === undefined
      ? []
      : [{ half: parsed.half, id: parsed.id, todo: match.groups?.todo !== undefined }];
  });

type Judgement = Pick<Report, "status" | "passing" | "todo">;

/**
 * A remaining `test.todo` keeps a row from being covered, even when other tests for it pass.
 */
const judge = (titles: readonly Title[]): Judgement => {
  if (titles.length === 0) {
    return { status: "missing" };
  }

  const todo = titles.filter((title) => title.todo).length;

  if (todo === 0) {
    return { status: "covered" };
  }

  return todo === titles.length
    ? { status: "todo" }
    : { passing: titles.length - todo, status: "partial", todo };
};

interface TraceInput {
  readonly rows: typeof Rows.Type;
  readonly deferred: typeof Deferred.Type;
  readonly splits: typeof SplitRows.Type;
  readonly titles: readonly Title[];
  readonly only?: RegExp | undefined;
}

/**
 * How a delegation target resolves: covered, passed through (whole-deferred), or not resolved.
 */
type Outcome = "covered" | "pass" | "unresolved" | "cycle";

interface Target {
  readonly outcome: Outcome;
  readonly target: string;
}

interface Resolution {
  readonly outcome: Outcome;
  readonly passed: readonly string[];
}

/**
 * Report every row, in `rows.json` order, by the rulings of task fe518093. `only` filters the
 * rows reported; delegation targets resolve over every row and every test.
 */
export const traceRows = (input: TraceInput): readonly Report[] => {
  const wholeDeferred = (id: string): boolean =>
    input.deferred.some((entry) => entry.row === id && entry.deferred === "whole");

  const base = (row: (typeof Rows.Type)[number]): readonly Report[] => {
    if (row.disposition === "informational") {
      return [{ id: row.id, status: "informational" }];
    }

    const entry = input.deferred.find((candidate) => candidate.row === row.id);

    if (entry?.deferred === "whole") {
      return [{ id: row.id, status: "deferred" }];
    }

    const own = input.titles.filter((title) => title.id === row.id);
    const split = input.splits.find((candidate) => candidate.row === row.id);

    if (split !== undefined) {
      return split.halves.map((half) =>
        half === entry?.deferred
          ? { half, id: row.id, status: "deferred" }
          : { half, id: row.id, ...judge(own.filter((title) => title.half === half)) },
      );
    }

    const judged = judge(own.filter((title) => title.half === undefined));

    return [
      {
        id: row.id,
        ...judged,
        status:
          judged.status === "missing" && row.coveredBy.length > 0 ? "delegated" : judged.status,
      },
    ];
  };

  const byId = new Map(input.rows.map((row) => [row.id, row]));

  const resolve = (row: (typeof Rows.Type)[number], stack: readonly string[]): Resolution => {
    const outcomes = row.coveredBy.map((target): Target => {
      if (wholeDeferred(target)) {
        return { outcome: "pass", target };
      }

      const next = byId.get(target);

      if (next === undefined) {
        return { outcome: "unresolved", target };
      }

      if (stack.includes(target)) {
        return { outcome: "cycle", target };
      }

      const reports = base(next);

      if (reports.some((report) => report.status === "delegated")) {
        return { outcome: resolve(next, [...stack, target]).outcome, target };
      }

      return {
        outcome: reports.every((r) => r.status === "covered" || r.status === "deferred")
          ? "covered"
          : "unresolved",
        target,
      };
    });
    const passed = outcomes
      .filter((entry) => entry.outcome === "pass")
      .map((entry) => entry.target);

    if (outcomes.some((entry) => entry.outcome === "cycle")) {
      return { outcome: "cycle", passed };
    }

    if (!outcomes.every((entry) => entry.outcome === "covered" || entry.outcome === "pass")) {
      return { outcome: "unresolved", passed };
    }

    if (passed.length < outcomes.length) {
      return { outcome: "covered", passed };
    }

    return {
      outcome: input.deferred.some((entry) => entry.row === row.id) ? "pass" : "unresolved",
      passed,
    };
  };

  return input.rows
    .filter((row) => input.only?.test(row.id) ?? true)
    .flatMap((row): readonly Report[] => {
      const reports = base(row);

      if (!reports.some((report) => report.status === "delegated")) {
        return reports;
      }

      const resolved = resolve(row, [row.id]);

      if (resolved.outcome === "covered" && resolved.passed.length > 0) {
        return [{ id: row.id, status: "covered", via: resolved.passed }];
      }

      if (resolved.outcome === "covered") {
        return [{ id: row.id, status: "covered" }];
      }

      if (resolved.outcome === "pass") {
        return [{ id: row.id, status: "deferred" }];
      }

      // A cycle, or every target whole-deferred with the row unlisted, is missing.
      const allPassed = resolved.passed.length === row.coveredBy.length;

      return [
        { id: row.id, status: resolved.outcome === "cycle" || allPassed ? "missing" : "delegated" },
      ];
    });
};

const unresolved = (status: Status, allowTodo: boolean): boolean =>
  status === "missing" ||
  (!allowTodo && (status === "todo" || status === "partial" || status === "delegated"));

interface Options {
  readonly check: boolean;
  readonly allowTodo: boolean;
  readonly only: RegExp | undefined;
  readonly root: string | undefined;
}

export const parseArgs = (args: readonly string[]): Effect.Effect<Options, TraceUsageError> =>
  Effect.gen(function* parse() {
    let check = false;
    let allowTodo = false;
    let only: RegExp | undefined;
    let root: string | undefined;

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const value = args[index + 1];

      if (arg === "--check") {
        check = true;
      } else if (arg === "--allow-todo") {
        allowTodo = true;
      } else if (arg === "--root" && value !== undefined) {
        root = value;
        index += 1;
      } else if (arg === "--only" && value !== undefined) {
        only = yield* Effect.try({
          catch: () => new TraceUsageError({ reason: "--only: not a regular expression" }),
          try: () => new RegExp(value, "u"),
        });
        index += 1;
      } else {
        return yield* new TraceUsageError({ reason: `unknown or incomplete argument: ${arg}` });
      }
    }

    if (allowTodo && !check) {
      return yield* new TraceUsageError({ reason: "--allow-todo needs --check" });
    }

    return { allowTodo, check, only, root };
  });

const readJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  fs: FileSystem.FileSystem,
  file: string,
  schema: S,
): Effect.Effect<S["Type"], TraceInputError> =>
  fs.readFileString(file).pipe(
    Effect.mapError((cause: PlatformError) => new TraceInputError({ file, reason: cause.message })),
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
        Effect.mapError(() => new TraceInputError({ file, reason: "not the expected JSON shape" })),
      ),
    ),
  );

const line = (report: Report): string =>
  `${report.id}${report.half === undefined ? "" : ` (${report.half})`} ${report.status}${
    report.status === "partial" ? ` (${report.passing} passing, ${report.todo} todo)` : ""
  }${report.via === undefined ? "" : ` (deferred: ${report.via.join(", ")})`}`;

const trace = Effect.gen(function* run() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const options = yield* parseArgs(Bun.argv.slice(2));
  const root = path.resolve(options.root ?? ".");
  const inventory = path.join(root, "tests", "inventory");
  const rows = yield* readJson(fs, path.join(inventory, "rows.json"), Rows);
  const deferred = yield* readJson(fs, path.join(inventory, "deferred.json"), Deferred);
  const splits = yield* readJson(fs, path.join(inventory, "split-rows.json"), SplitRows);
  const testsDir = path.join(root, "tests");
  const entries = yield* fs
    .readDirectory(testsDir, { recursive: true })
    .pipe(
      Effect.mapError(
        (cause: PlatformError) => new TraceInputError({ file: testsDir, reason: cause.message }),
      ),
    );
  const sources = yield* Effect.forEach(
    entries.filter((entry) => entry.endsWith(".test.ts")),
    (entry) =>
      fs
        .readFileString(path.join(testsDir, entry))
        .pipe(
          Effect.mapError(
            (cause: PlatformError) => new TraceInputError({ file: entry, reason: cause.message }),
          ),
        ),
  );
  const reports = traceRows({
    deferred,
    only: options.only,
    rows,
    splits,
    titles: sources.flatMap(titlesOf),
  });

  for (const report of reports) {
    console.log(line(report));
  }

  if (options.check && reports.some((report) => unresolved(report.status, options.allowTodo))) {
    yield* new TraceCheckFailed();
  }
});

if (import.meta.main) {
  BunRuntime.runMain(trace.pipe(Effect.provide(BunServices.layer)));
}
