import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Path, Result, Runtime, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

/**
 * Row trace: prove every implemented or refused inventory row has a test titled with its id.
 * After the row lines it prints `total <status> <count>` for every status; a split row counts
 * once, under its worst half.
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

const rowId = "[A-Z][A-Z0-9]*-\\d+";

/**
 * Matches a whole inventory row id: capitals and digits from a leading capital, a hyphen, digits.
 */
export const rowIdPattern = new RegExp(`^${rowId}$`, "u");

const titlePattern = new RegExp(`^(?<id>${rowId})(?: \\((?<half>[a-z0-9-]+)\\))?: `, "u");

/**
 * A lexical token of a test file. Comments are dropped; a string or template literal is one
 * `text` token holding its source text up to the first `${`, so nothing inside it reads as code.
 */
type Token =
  | { readonly kind: "name"; readonly text: string; readonly at: number }
  | { readonly kind: "punct"; readonly text: string; readonly at: number }
  | { readonly kind: "text"; readonly text: string; readonly at: number }
  | { readonly kind: "other"; readonly at: number };

/**
 * A `/` after one of these starts a regular expression, not a division.
 */
const beforeRegex = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const identifierStart = /[\p{ID_Start}$_]/u;

const identifierPart = /[\p{ID_Continue}$‌‍]/u;

const lineOf = (source: string, at: number): number => source.slice(0, at).split("\n").length;

/**
 * The lexer's state while it reads one source.
 */
interface Lexer {
  readonly source: string;
  readonly tokens: Token[];
  /**
   * For each open template substitution, the brace depth its `${` opened at.
   */
  readonly substitutions: number[];
  braces: number;
}

/**
 * What a rule did at an index: read up to `next`, found no end for a construct, or did not apply.
 */
type Step =
  | { readonly kind: "read"; readonly next: number }
  | { readonly kind: "unterminated"; readonly what: string }
  | { readonly kind: "pass" };

const read = (next: number): Step => ({ kind: "read", next });

const unterminated = (what: string): Step => ({ kind: "unterminated", what });

const pass: Step = { kind: "pass" };

type Rule = (lexer: Lexer, at: number) => Step;

const wordEnd = (source: string, at: number, part: RegExp): number => {
  let index = at;

  while (part.test(source[index] ?? "")) {
    index += 1;
  }

  return index;
};

const whitespace: Rule = (lexer, at) => (/\s/u.test(lexer.source[at] ?? "") ? read(at + 1) : pass);

const comment: Rule = ({ source }, at) => {
  if (source.startsWith("//", at)) {
    const end = source.indexOf("\n", at);

    return read(end === -1 ? source.length : end);
  }

  if (!source.startsWith("/*", at)) {
    return pass;
  }

  const end = source.indexOf("*/", at + 2);

  return end === -1 ? unterminated("block comment") : read(end + 2);
};

/**
 * A `/` starts a regular expression at the start of an expression: after punctuation other than
 * a closing bracket, or after a keyword that takes an operand.
 */
const regexAllowed = (tokens: readonly Token[]): boolean => {
  const last = tokens.at(-1);

  if (last?.kind === "name") {
    return beforeRegex.has(last.text);
  }

  return last === undefined || (last.kind === "punct" && !")]}".includes(last.text));
};

const regex: Rule = (lexer, at) => {
  if (lexer.source[at] !== "/" || !regexAllowed(lexer.tokens)) {
    return pass;
  }

  let inClass = false;

  for (let index = at + 1; index < lexer.source.length; index += 1) {
    const char = lexer.source[index];

    if (char === "\n") {
      break;
    }

    if (char === "\\") {
      index += 1;
    } else if (char === "/" && !inClass) {
      lexer.tokens.push({ at, kind: "other" });

      return read(wordEnd(lexer.source, index + 1, identifierPart));
    } else if (char === "[" || char === "]") {
      inClass = char === "[";
    }
  }

  return unterminated("regular expression");
};

const quoted: Rule = (lexer, at) => {
  const quote = lexer.source[at];

  if (quote !== '"' && quote !== "'") {
    return pass;
  }

  for (let index = at + 1; index < lexer.source.length; index += 1) {
    const char = lexer.source[index];

    if (char === quote) {
      lexer.tokens.push({ at, kind: "text", text: lexer.source.slice(at + 1, index) });

      return read(index + 1);
    }

    if (char === "\n") {
      break;
    }

    if (char === "\\") {
      index += 1;
    }
  }

  return unterminated("string literal");
};

/**
 * Template text from a backtick, or from the `}` closing a substitution, to the closing backtick
 * or the next `${`. Only the head (the text before the first `${`) becomes a token.
 */
const template: Rule = (lexer, at) => {
  const { source, substitutions } = lexer;
  const head = source[at] === "`";

  if (!head && (source[at] !== "}" || substitutions.at(-1) !== lexer.braces - 1)) {
    return pass;
  }

  if (!head) {
    substitutions.pop();
    lexer.braces -= 1;
  }

  for (let index = at + 1; index < source.length; index += 1) {
    const char = source[index];
    const opens = char === "$" && source[index + 1] === "{";

    if (char === "`" || opens) {
      if (head) {
        lexer.tokens.push({ at, kind: "text", text: source.slice(at + 1, index) });
      }

      if (char === "`") {
        return read(index + 1);
      }

      substitutions.push(lexer.braces);
      lexer.braces += 1;

      return read(index + 2);
    }

    if (char === "\\") {
      index += 1;
    }
  }

  return unterminated("template literal");
};

const name: Rule = (lexer, at) => {
  if (!identifierStart.test(lexer.source[at] ?? "")) {
    return pass;
  }

  const end = wordEnd(lexer.source, at + 1, identifierPart);

  lexer.tokens.push({ at, kind: "name", text: lexer.source.slice(at, end) });

  return read(end);
};

const numeric: Rule = (lexer, at) => {
  if (!/^\.?\d/u.test(lexer.source.slice(at, at + 2))) {
    return pass;
  }

  lexer.tokens.push({ at, kind: "other" });

  return read(wordEnd(lexer.source, at + 1, /[\w.]/u));
};

const punct: Rule = (lexer, at) => {
  const char = lexer.source[at] ?? "";

  if (char === "{") {
    lexer.braces += 1;
  } else if (char === "}") {
    lexer.braces -= 1;
  }

  lexer.tokens.push({ at, kind: "punct", text: char });

  return read(at + 1);
};

/**
 * In order: the first rule that applies at an index reads it; `punct` always applies.
 */
const rules: readonly Rule[] = [whitespace, comment, regex, quoted, template, name, numeric, punct];

/**
 * Tokenize a test file. This is not a TypeScript parser (typescript@7.0.2 exposes no compiler
 * API): it knows comments, string, template and regular expression literals well enough that no
 * text inside them reads as a call, and refuses a source it cannot close rather than guess.
 */
const tokenize = (source: string): Result.Result<readonly Token[], string> => {
  const lexer: Lexer = { braces: 0, source, substitutions: [], tokens: [] };
  let at = source.startsWith("#!") ? source.indexOf("\n") : 0;

  while (at !== -1 && at < source.length) {
    let step: Step = pass;

    for (const rule of rules) {
      step = rule(lexer, at);

      if (step.kind !== "pass") {
        break;
      }
    }

    if (step.kind === "unterminated") {
      return Result.fail(`unterminated ${step.what} at line ${String(lineOf(source, at))}`);
    }

    // `punct` always reads, so a step that passed every rule cannot occur.
    at = step.kind === "read" ? step.next : source.length;
  }

  return Result.succeed(lexer.tokens);
};

const isPunct = (token: Token | undefined, text: string): boolean =>
  token?.kind === "punct" && token.text === text;

/**
 * The index of the `)` closing each `(`, or the line of the first parenthesis left unpaired.
 */
const closers = (
  source: string,
  tokens: readonly Token[],
): Result.Result<ReadonlyMap<number, number>, string> => {
  const closer = new Map<number, number>();
  const open: number[] = [];

  for (const [index, token] of tokens.entries()) {
    if (isPunct(token, "(")) {
      open.push(index);
    } else if (isPunct(token, ")")) {
      const from = open.pop();

      if (from === undefined) {
        return Result.fail(`unbalanced parentheses at line ${String(lineOf(source, token.at))}`);
      }

      closer.set(from, index);
    }
  }

  const unclosed = open[0] === undefined ? undefined : tokens[open[0]];

  return unclosed === undefined
    ? Result.succeed(closer)
    : Result.fail(`unbalanced parentheses at line ${String(lineOf(source, unclosed.at))}`);
};

/**
 * The callee `a.b.c` whose name starts at `index` and the index of its call's `(`, when `index`
 * starts a call that is not itself a member of something else.
 */
const callAt = (
  tokens: readonly Token[],
  index: number,
): { readonly callee: string; readonly open: number } | undefined => {
  const first = tokens[index];

  if (first?.kind !== "name" || isPunct(tokens[index - 1], ".")) {
    return undefined;
  }

  const chain = [first.text];
  let next = index + 1;

  for (let member = tokens[next + 1]; isPunct(tokens[next], "."); member = tokens[next + 1]) {
    if (member?.kind !== "name") {
      break;
    }

    chain.push(member.text);
    next += 2;
  }

  return isPunct(tokens[next], "(") ? { callee: chain.join("."), open: next } : undefined;
};

/**
 * The `describe` forms whose tests run whenever the file runs. Any other modifier (`skip`, `todo`,
 * `if`, `skipIf`, `only`, ...) may keep its tests from running, so the tests under it cover no row.
 */
const runningDescribe = new Set(["describe", "describe.each"]);

/**
 * The titles of the `test(`, `it(`, `test.todo(` and `it.todo(` calls in one test file, excluding
 * calls under a `describe` that may not run; a source it cannot tokenize fails with the reason.
 */
export const titlesOf = (source: string): Result.Result<readonly Title[], string> =>
  Result.flatMap(tokenize(source), (tokens) =>
    Result.map(closers(source, tokens), (closer) => {
      const titles: Title[] = [];
      // The last token of the `describe` that may not run, while inside one.
      let offUntil = -1;

      for (let index = 0; index < tokens.length; index += 1) {
        const call = index > offUntil ? callAt(tokens, index) : undefined;

        if (
          call !== undefined &&
          /^describe\b/u.test(call.callee) &&
          !runningDescribe.has(call.callee)
        ) {
          // `describe.if(cond)(name, fn)`: every chained call belongs to the block.
          offUntil = closer.get(call.open) ?? call.open;
          while (isPunct(tokens[offUntil + 1], "(")) {
            offUntil = closer.get(offUntil + 1) ?? offUntil + 1;
          }
        } else if (call !== undefined && /^(?:test|it)(?:\.todo)?$/u.test(call.callee)) {
          const first = tokens[call.open + 1];
          const parsed = first?.kind === "text" ? titlePattern.exec(first.text)?.groups : undefined;

          if (parsed?.id !== undefined) {
            titles.push({ half: parsed.half, id: parsed.id, todo: call.callee.endsWith(".todo") });
          }
        }
      }

      return titles;
    }),
  );

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

/**
 * The statuses, in the order the totals lines print them.
 */
const totalsOrder: readonly Status[] = [
  "covered",
  "partial",
  "todo",
  "missing",
  "informational",
  "deferred",
  "delegated",
];

/**
 * Worst first: a split row counts once, under the worst status among its halves.
 */
const severity: readonly Status[] = [
  "missing",
  "delegated",
  "todo",
  "partial",
  "deferred",
  "covered",
  "informational",
];

/**
 * Count each inventory row once, in `totalsOrder`, with zero for a status no row has.
 */
export const totalsOf = (reports: readonly Report[]): readonly (readonly [Status, number])[] => {
  const worst = new Map<string, Status>();

  for (const report of reports) {
    const seen = worst.get(report.id);

    if (seen === undefined || severity.indexOf(report.status) < severity.indexOf(seen)) {
      worst.set(report.id, report.status);
    }
  }

  const statuses = [...worst.values()];

  return totalsOrder.map((status) => [status, statuses.filter((s) => s === status).length]);
};

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
  const titles = yield* Effect.forEach(
    entries.filter((entry) => entry.endsWith(".test.ts")),
    (entry) => {
      const file = path.join("tests", entry);

      return fs.readFileString(path.join(testsDir, entry)).pipe(
        Effect.mapError(
          (cause: PlatformError) => new TraceInputError({ file, reason: cause.message }),
        ),
        Effect.flatMap((source) =>
          Result.match(titlesOf(source), {
            onFailure: (reason) =>
              Effect.fail(
                new TraceInputError({
                  file,
                  reason: `${reason}; the trace cannot read its test titles`,
                }),
              ),
            onSuccess: Effect.succeed,
          }),
        ),
      );
    },
  );
  const reports = traceRows({
    deferred,
    only: options.only,
    rows,
    splits,
    titles: titles.flat(),
  });

  for (const report of reports) {
    console.log(line(report));
  }

  for (const [status, count] of totalsOf(reports)) {
    console.log(`total ${status} ${count}`);
  }

  if (options.check && reports.some((report) => unresolved(report.status, options.allowTodo))) {
    yield* new TraceCheckFailed();
  }
});

if (import.meta.main) {
  BunRuntime.runMain(trace.pipe(Effect.provide(BunServices.layer)));
}
