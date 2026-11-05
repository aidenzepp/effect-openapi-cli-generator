import { createHash, randomUUID } from "node:crypto";
import { rmdir } from "node:fs/promises";
import type { Scope } from "effect";
import {
  Array as Arr,
  Data,
  Effect,
  Exit,
  FileSystem,
  Option,
  Order,
  Path,
  Ref,
  Stream,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import { acquireRunLock, runLockFileName } from "./lock.ts";
import type { RunLock, RunLockHeld, RunLockUnavailable } from "./lock.ts";
import type { ManifestEntry } from "./manifest.ts";
import { decodeManifest, manifestFileName, printManifest, sha256Hex } from "./manifest.ts";

/**
 * One generated file: a relative `/`-separated path inside the output directory and its text
 * (written as UTF-8).
 */
export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * The writer refused before or during the write; `subject` names the path involved.
 */
export class WriteRefused extends Data.TaggedError("WriteRefused")<{
  readonly reason:
    | "duplicate-path"
    | "io"
    | "output-not-directory"
    | "output-parent-missing"
    | "path-conflict"
    | "reserved-path"
    | "symlink"
    | "unsafe-path";
  readonly subject: string;
}> {}

/**
 * A previous-manifest path the writer left in place, or a previous manifest it could not use.
 */
export interface WriteNotice {
  readonly reason:
    | "edited"
    | "manifest-unreadable"
    | "not-regular-file"
    | "remove-failed"
    | "symlink"
    | "unreadable"
    | "unsafe-path";
  readonly path: string;
}

/**
 * The largest previous manifest the writer reads (4 MiB); a larger file is reported, not read.
 */
export const maxPreviousManifestBytes = 4 * 1024 * 1024;

type Services = FileSystem.FileSystem | Path.Path;

const fold = (path: string): string => path.normalize("NFC").toLowerCase();

const reserved = new Set([fold(manifestFileName), fold(runLockFileName)]);

const segmentsOf = (path: string): readonly string[] => path.split("/");

const wellFormed = (path: string): boolean =>
  path !== "" &&
  !path.includes("\\") &&
  !path.includes("\u0000") &&
  segmentsOf(path).every((segment) => segment !== "" && segment !== "." && segment !== "..");

const confined = (path: Path.Path, outputDir: string, relative: string): boolean =>
  wellFormed(relative) && Option.isSome(path.resolveWithin(outputDir, relative));

const ancestorsOf = (path: string): readonly string[] =>
  segmentsOf(path)
    .slice(0, -1)
    .map((_, index, parents) => parents.slice(0, index + 1).join("/"));

const refused = (reason: WriteRefused["reason"], subject: string) =>
  Effect.fail(new WriteRefused({ reason, subject }));

const planFault = (
  path: Path.Path,
  outputDir: string,
  files: readonly GeneratedFile[],
): WriteRefused | undefined => {
  const folded = new Set<string>();

  for (const { path: relative } of files) {
    const key = fold(relative);

    if (!confined(path, outputDir, relative)) {
      return new WriteRefused({ reason: "unsafe-path", subject: relative });
    }

    if (reserved.has(key)) {
      return new WriteRefused({ reason: "reserved-path", subject: relative });
    }

    if (folded.has(key)) {
      return new WriteRefused({ reason: "duplicate-path", subject: relative });
    }

    folded.add(key);
  }

  const conflicting = files.find(({ path: relative }) =>
    ancestorsOf(fold(relative)).some((ancestor) => folded.has(ancestor)),
  );

  return conflicting === undefined
    ? undefined
    : new WriteRefused({ reason: "path-conflict", subject: conflicting.path });
};

const ioFailure = (subject: string) => (_error: PlatformError) =>
  new WriteRefused({ reason: "io", subject });

const probe = (fs: FileSystem.FileSystem, target: string, subject: string) =>
  fs.lstat(target).pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
    Effect.mapError(ioFailure(subject)),
  );

/**
 * Walk the existing ancestors of `relative` under `outputDir` (creating the missing ones when
 * `create`), then check the target itself: a symlink anywhere is refused, a non-directory ancestor
 * or a directory at the target is a conflict. Returns the target's type, none when absent.
 */
const walk = (
  outputDir: string,
  relative: string,
  create: boolean,
): Effect.Effect<Option.Option<FileSystem.File.Type>, WriteRefused, Services> =>
  Effect.gen(function* step1() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    for (const ancestor of ancestorsOf(relative)) {
      const info = yield* probe(fs, path.join(outputDir, ancestor), ancestor);

      if (Option.isNone(info)) {
        if (!create) {
          return Option.none();
        }

        yield* fs
          .makeDirectory(path.join(outputDir, ancestor))
          .pipe(Effect.mapError(ioFailure(ancestor)));
      } else if (info.value.type === "SymbolicLink") {
        return yield* refused("symlink", ancestor);
      } else if (info.value.type !== "Directory") {
        return yield* refused("path-conflict", ancestor);
      }
    }

    const target = yield* probe(fs, path.join(outputDir, relative), relative);

    return Option.isSome(target) ? Option.some(target.value.type) : Option.none();
  });

const checkTarget = (outputDir: string, relative: string, create: boolean) =>
  walk(outputDir, relative, create).pipe(
    Effect.flatMap((type) => {
      if (Option.isNone(type) || type.value === "File") {
        return Effect.void;
      }

      return refused(type.value === "SymbolicLink" ? "symlink" : "path-conflict", relative);
    }),
  );

/**
 * Check the output directory and create it (one level) when it is absent; true when created here.
 */
const ensureOutput = (outputDir: string): Effect.Effect<boolean, WriteRefused, Services> =>
  Effect.gen(function* step2() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const existing = yield* probe(fs, outputDir, outputDir);

    if (Option.isSome(existing)) {
      if (existing.value.type === "SymbolicLink") {
        return yield* refused("symlink", outputDir);
      }

      return existing.value.type === "Directory"
        ? false
        : yield* refused("output-not-directory", outputDir);
    }

    const parent = yield* fs.stat(path.dirname(outputDir)).pipe(Effect.option);

    if (Option.isNone(parent) || parent.value.type !== "Directory") {
      return yield* refused("output-parent-missing", outputDir);
    }

    return yield* fs.makeDirectory(outputDir).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.succeed(false),
      ),
      Effect.mapError(ioFailure(outputDir)),
    );
  });

const writeAtomic = (
  outputDir: string,
  lock: RunLock,
  written: Ref.Ref<readonly string[]>,
  relative: string,
  content: string,
): Effect.Effect<void, WriteRefused, Services> =>
  Effect.gen(function* step3() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* checkTarget(outputDir, relative, true);
    yield* Ref.update(written, (all) => [...all, relative]);

    const target = path.join(outputDir, relative);
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    yield* lock.registerTemp(temp);
    yield* fs
      .writeFileString(temp, content, { flag: "wx" })
      .pipe(Effect.mapError(ioFailure(relative)));
    yield* fs.rename(temp, target).pipe(Effect.mapError(ioFailure(relative)));
  });

const unreadable: WriteNotice = { path: manifestFileName, reason: "manifest-unreadable" };

/**
 * The previous manifest's entries; a missing manifest is empty, and one that is a symlink, not a
 * file, over the size bound, unreadable or not the manifest shape yields a notice and no entries.
 */
const readPrevious = (
  outputDir: string,
): Effect.Effect<
  { readonly entries: readonly ManifestEntry[]; readonly notices: readonly WriteNotice[] },
  WriteRefused,
  Services
> =>
  Effect.gen(function* step4() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const location = path.join(outputDir, manifestFileName);
    const info = yield* probe(fs, location, manifestFileName);
    const none = { entries: [], notices: [] };
    const skipped = { entries: [], notices: [unreadable] };

    if (Option.isNone(info)) {
      return none;
    }

    if (info.value.type !== "File" || Number(info.value.size) > maxPreviousManifestBytes) {
      return skipped;
    }

    const entries = yield* fs
      .readFileString(location)
      .pipe(Effect.flatMap(decodeManifest), Effect.option);

    return Option.match(entries, {
      onNone: () => skipped,
      onSome: (all) => ({ entries: all, notices: [] }),
    });
  });

const sha256OfFile = (
  fs: FileSystem.FileSystem,
  target: string,
): Effect.Effect<string, PlatformError> => {
  const hash = createHash("sha256");

  return fs.stream(target).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        hash.update(chunk);
      }),
    ),
    Effect.map(() => hash.digest("hex")),
  );
};

const checkStale = (
  outputDir: string,
  entry: ManifestEntry,
): Effect.Effect<Option.Option<WriteNotice>, WriteRefused, Services> =>
  Effect.gen(function* step5() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const notice = (reason: WriteNotice["reason"]) =>
      Option.some<WriteNotice>({ path: entry.path, reason });

    if (!confined(path, outputDir, entry.path) || reserved.has(fold(entry.path))) {
      return notice("unsafe-path");
    }

    const found = yield* walk(outputDir, entry.path, false).pipe(
      Effect.catchIf(
        (error) => error.reason === "symlink",
        () => Effect.succeed(Option.some<FileSystem.File.Type>("SymbolicLink")),
      ),
      Effect.catchIf(
        (error) => error.reason === "path-conflict",
        () => Effect.succeed(Option.some<FileSystem.File.Type>("Directory")),
      ),
    );

    if (Option.isNone(found)) {
      return Option.none();
    }

    if (found.value === "SymbolicLink") {
      return notice("symlink");
    }

    if (found.value !== "File") {
      return notice("not-regular-file");
    }

    const target = path.join(outputDir, entry.path);
    const current = yield* sha256OfFile(fs, target).pipe(Effect.mapError(ioFailure(entry.path)));

    if (current !== entry.sha256) {
      return notice("edited");
    }

    return yield* fs.remove(target).pipe(
      Effect.as(Option.none<WriteNotice>()),
      Effect.catch(() => Effect.succeed(notice("remove-failed"))),
    );
  });

/**
 * A stale path that cannot be checked or read is left in place with a notice, never a failed run.
 */
const staleNotice = (
  outputDir: string,
  entry: ManifestEntry,
): Effect.Effect<Option.Option<WriteNotice>, never, Services> =>
  checkStale(outputDir, entry).pipe(
    Effect.orElseSucceed(() =>
      Option.some<WriteNotice>({ path: entry.path, reason: "unreadable" }),
    ),
  );

const removeStale = (
  outputDir: string,
  previous: readonly ManifestEntry[],
  written: ReadonlySet<string>,
): Effect.Effect<readonly WriteNotice[], never, Services> =>
  Effect.forEach(
    previous.filter((entry) => !written.has(fold(entry.path))),
    (entry) => staleNotice(outputDir, entry),
  ).pipe(Effect.map((all) => all.filter(Option.isSome).map((some) => some.value)));

const removeEmptyDirectory = (directory: string) =>
  Effect.ignore(Effect.tryPromise(() => rmdir(directory)));

/**
 * Remove what this run wrote, then the directories that emptied; run while the lock is still held.
 * Directories are removed with a non-recursive rmdir, so anything another party placed stays.
 */
const undoWrites = (outputDir: string, written: readonly string[]) =>
  Effect.gen(function* step8() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    for (const relative of Arr.reverse(written)) {
      yield* Effect.ignore(fs.remove(path.join(outputDir, relative), { force: true }));
    }

    const directories = Arr.sort(
      Arr.dedupe(written.flatMap(ancestorsOf)),
      Order.mapInput(Order.flip(Order.Number), (directory: string) => segmentsOf(directory).length),
    );

    for (const directory of directories) {
      yield* removeEmptyDirectory(path.join(outputDir, directory));
    }
  });

const writeUnderLock = (
  outputDir: string,
  sorted: readonly GeneratedFile[],
  manifest: string,
  lock: RunLock,
  written: Ref.Ref<readonly string[]>,
): Effect.Effect<readonly WriteNotice[], WriteRefused, Services> =>
  Effect.gen(function* step9() {
    for (const relative of [...sorted.map((file) => file.path), manifestFileName]) {
      yield* checkTarget(outputDir, relative, false);
    }

    const previous = yield* readPrevious(outputDir);

    for (const file of sorted) {
      yield* writeAtomic(outputDir, lock, written, file.path, file.content);
    }

    yield* writeAtomic(outputDir, lock, written, manifestFileName, manifest);

    const stale = yield* removeStale(
      outputDir,
      previous.entries,
      new Set(sorted.map((file) => fold(file.path))),
    );

    return [...previous.notices, ...stale];
  });

const writeLocked = (
  outputDir: string,
  files: readonly GeneratedFile[],
  created: boolean,
): Effect.Effect<
  readonly WriteNotice[],
  RunLockHeld | RunLockUnavailable | WriteRefused,
  Services | Scope.Scope
> =>
  Effect.gen(function* step6() {
    const sorted = Arr.sort(
      files,
      Order.mapInput(Order.String, (file: GeneratedFile) => file.path),
    );
    const manifest = yield* printManifest(
      sorted.map((file) => ({ path: file.path, sha256: sha256Hex(file.content) })),
    ).pipe(
      Effect.mapError(() => new WriteRefused({ reason: "unsafe-path", subject: manifestFileName })),
    );
    const lock = yield* acquireRunLock(outputDir);
    const written = yield* Ref.make<readonly string[]>([]);

    return yield* writeUnderLock(outputDir, sorted, manifest, lock, written).pipe(
      Effect.onExit((exit) =>
        created && Exit.isFailure(exit)
          ? Ref.get(written).pipe(Effect.flatMap((all) => undoWrites(outputDir, all)))
          : Effect.void,
      ),
    );
  });

/**
 * Write `files` into `outputDir` (design 3.6, Write and Run lock): validate every path before any
 * mutation, claim the run lock, replace each file by temp sibling plus rename, commit the manifest
 * last, then remove previous-manifest files the run no longer writes whose sha256 still matches.
 * Files left in place and a previous manifest that could not be used come back as notices.
 */
export const writeFiles = (
  outputDir: string,
  files: readonly GeneratedFile[],
): Effect.Effect<
  readonly WriteNotice[],
  RunLockHeld | RunLockUnavailable | WriteRefused,
  Services
> =>
  Effect.gen(function* step7() {
    const path = yield* Path.Path;
    const fault = planFault(path, outputDir, files);

    if (fault !== undefined) {
      return yield* fault;
    }

    const created = yield* ensureOutput(outputDir);

    return yield* Effect.scoped(writeLocked(outputDir, files, created)).pipe(
      Effect.onExit((exit) =>
        created && Exit.isFailure(exit) ? removeEmptyDirectory(outputDir) : Effect.void,
      ),
    );
  });
