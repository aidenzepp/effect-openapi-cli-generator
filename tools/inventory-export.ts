import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Data, Effect, FileSystem, Runtime, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { printJson } from "../src/emit/printer.ts";
import { JsonLiteral } from "../src/model/brands.ts";

/**
 * Inventory export: the element table of `oas-inventory.md` as the tracked `rows.json`.
 *
 * Bun tools/inventory-export.ts [--check] <inventory.md> <rows.json>
 */

const usage = "usage: bun tools/inventory-export.ts [--check] <inventory.md> <rows.json>";

/**
 * A bad command line: exit 2.
 */
export class ExportUsageError extends Data.TaggedError("ExportUsageError")<{
  readonly reason: string;
}> {
  readonly [Runtime.errorExitCode] = 2;

  readonly [Runtime.errorReported] = true;

  override get message(): string {
    return `${this.reason}\n${usage}`;
  }
}

/**
 * A file that cannot be read or written: exit 1.
 */
export class ExportFileError extends Data.TaggedError("ExportFileError")<{
  readonly file: string;
  readonly reason: string;
}> {
  readonly [Runtime.errorExitCode] = 1;

  readonly [Runtime.errorReported] = true;

  override get message(): string {
    return `${this.file}: ${this.reason}`;
  }
}

/**
 * A row the export refuses; `row` is the inventory id: exit 1.
 */
export class ExportRowError extends Data.TaggedError("ExportRowError")<{
  readonly row: string;
  readonly reason: string;
}> {
  readonly [Runtime.errorExitCode] = 1;

  readonly [Runtime.errorReported] = true;

  override get message(): string {
    return `${this.row}: ${this.reason}`;
  }
}

/**
 * `--check` found the rows file different from the inventory: exit 1.
 */
export class ExportCheckFailed extends Data.TaggedError("ExportCheckFailed")<{
  readonly file: string;
  readonly reason: string;
}> {
  readonly [Runtime.errorExitCode] = 1;

  readonly [Runtime.errorReported] = true;

  override get message(): string {
    return `${this.file}: ${this.reason}`;
  }
}

const dispositions = ["implemented", "refused", "informational"] as const;

type Disposition = (typeof dispositions)[number];

export interface ExportRow {
  readonly coveredBy: readonly string[];
  readonly disposition: Disposition;
  readonly id: string;
  readonly versions: readonly string[];
}

const idPattern = "[A-Z][A-Z0-9]*-[0-9]+";

const rowLine = /^\| `(?<id>[A-Z][A-Z0-9]*-[0-9]+)` /u;

const idList = new RegExp(`^${idPattern}(?:, ${idPattern})*$`, "u");

const idStart = new RegExp(`^${idPattern}`, "u");

const globOrRange = new RegExp(`[A-Z][A-Z0-9]*-\\*|${idPattern}\\.\\.`, "u");

const coveredMarker = "covered by: ";

const isDisposition = (cell: string): cell is Disposition =>
  dispositions.some((value) => value === cell);

/**
 * The text of a `covered by:` clause: up to the first `;`, or the `. src:` that closes the cell.
 */
const coveredClause = (reason: string): string | undefined => {
  const at = reason.indexOf(coveredMarker);

  if (at === -1) {
    return undefined;
  }

  const rest = reason.slice(at + coveredMarker.length);
  const semicolon = rest.indexOf(";");
  const source = rest.indexOf(". src:");
  const ends = [semicolon, source].filter((end) => end >= 0);

  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
};

/**
 * Whether every `see` clause of the reason starts with a row id and holds no glob or range.
 */
const badSeeClause = (reason: string): string | undefined =>
  [...reason.matchAll(/\bsee (?<clause>[^;]*)/gu)]
    .map((match) => (match.groups?.clause ?? "").split(". src:")[0] ?? "")
    .find((clause) => !idStart.test(clause) || globOrRange.test(clause));

interface Parsed {
  readonly row: ExportRow;
  readonly clause: string | undefined;
}

const parseRow = (line: string): Effect.Effect<Parsed | null, ExportRowError> => {
  const id = rowLine.exec(line)?.groups?.id;

  if (id === undefined) {
    return Effect.succeed(null);
  }

  const cells = line
    .trimEnd()
    .replace(/^\| /u, "")
    .replace(/ \|$/u, "")
    .split(" | ")
    .map((cell) => cell.trim());

  if (cells.length !== 6) {
    return Effect.succeed(null);
  }

  const versions = cells[1] ?? "";
  const disposition = cells[4] ?? "";
  const reason = cells[5] ?? "";

  if (!isDisposition(disposition)) {
    return Effect.fail(
      new ExportRowError({ reason: `unknown disposition \`${disposition}\``, row: id }),
    );
  }

  const clause = coveredClause(reason);

  if (clause !== undefined && !idList.test(clause)) {
    return Effect.fail(
      new ExportRowError({ reason: "a `covered by:` clause holds only row ids", row: id }),
    );
  }

  if (disposition !== "informational" && badSeeClause(reason) !== undefined) {
    return Effect.fail(
      new ExportRowError({
        reason: "a `see` clause names row ids, never a glob, a range or prose",
        row: id,
      }),
    );
  }

  return Effect.succeed({
    clause,
    row: {
      coveredBy: clause === undefined ? [] : clause.split(", "),
      disposition,
      id,
      versions: versions.split(", "),
    },
  });
};

/**
 * Parses the element table; a `covered by:` target must be an implemented or refused row.
 */
export const parseInventory = (text: string): Effect.Effect<readonly ExportRow[], ExportRowError> =>
  Effect.gen(function* parse() {
    const parsed: Parsed[] = [];

    for (const line of text.split("\n")) {
      const row = yield* parseRow(line);

      if (row !== null) {
        parsed.push(row);
      }
    }

    const covering = new Set(
      parsed.filter((p) => p.row.disposition !== "informational").map((p) => p.row.id),
    );

    for (const { row } of parsed) {
      const target = row.coveredBy.find((id) => !covering.has(id));

      if (target !== undefined) {
        return yield* new ExportRowError({
          reason: `\`covered by:\` names ${target}, which is not an implemented or refused row`,
          row: row.id,
        });
      }
    }

    return parsed.map((p) => p.row);
  });

interface Options {
  readonly check: boolean;
  readonly inventory: string;
  readonly rows: string;
}

const parseArgs = (args: readonly string[]): Effect.Effect<Options, ExportUsageError> => {
  const check = args.includes("--check");
  const positional = args.filter((arg) => arg !== "--check");
  const [inventory, rows] = positional;

  if (positional.length !== 2 || inventory === undefined || rows === undefined) {
    return Effect.fail(new ExportUsageError({ reason: "expected <inventory.md> and <rows.json>" }));
  }

  return Effect.succeed({ check, inventory, rows });
};

const fileError =
  (file: string) =>
  (cause: PlatformError): ExportFileError =>
    new ExportFileError({ file, reason: cause.message });

const exportInventory = Effect.gen(function* run() {
  const fs = yield* FileSystem.FileSystem;
  const options = yield* parseArgs(Bun.argv.slice(2));
  const text = yield* fs
    .readFileString(options.inventory)
    .pipe(Effect.mapError(fileError(options.inventory)));
  const rows = yield* parseInventory(text);
  const output = printJson(
    yield* Schema.decodeUnknownEffect(JsonLiteral)(rows).pipe(
      Effect.mapError(
        () => new ExportFileError({ file: options.inventory, reason: "rows are not JSON" }),
      ),
    ),
  );

  if (options.check) {
    const current = yield* fs
      .readFileString(options.rows)
      .pipe(Effect.mapError(fileError(options.rows)));

    if (current !== output) {
      yield* new ExportCheckFailed({
        file: options.rows,
        reason: "differs from the inventory; rerun without --check",
      });
    }
  } else {
    yield* fs
      .writeFileString(options.rows, output)
      .pipe(
        Effect.mapError(fileError(options.rows)),
        Effect.andThen(Console.log(`${options.rows}: ${rows.length} rows`)),
      );
  }
});

if (import.meta.main) {
  BunRuntime.runMain(
    exportInventory.pipe(
      Effect.tapError((failure) => Console.error(failure.message)),
      Effect.provide(BunServices.layer),
    ),
  );
}
