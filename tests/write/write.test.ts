import { describe, expect, test } from "bun:test";
import { BunCrypto, BunFileSystem, BunPath } from "@effect/platform-bun";
import {
  Array as Arr,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Order,
  Path,
  Stream,
} from "effect";
import type { Digest } from "effect/crypto";
import * as PlatformError from "effect/PlatformError";
import { writeFiles } from "../../src/write/index.ts";
import type { GeneratedFile } from "../../src/write/index.ts";
import { runLockFileName } from "../../src/write/lock.ts";
import { decodeManifest, manifestFileName, sha256Hex } from "../../src/write/manifest.ts";

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layerDigest);

type Env = FileSystem.FileSystem | Path.Path | Digest.Digest;

const hex = (content: string | Uint8Array) =>
  Effect.runSync(sha256Hex(content).pipe(Effect.provide(BunCrypto.layerDigest)));

const inTempDir = <A, E>(
  body: (dir: string, fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E, Env>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* step1() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "wr1c-" });

        return yield* body(dir, fs, path);
      }),
    ).pipe(Effect.provide(layer)),
  );

const file = (path: string, content = "x"): GeneratedFile => ({ content, path });

const failureOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E, Env>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => ({
      reason: "reason" in error ? error.reason : undefined,
      tag: error._tag,
    })),
  );

const tree = (fs: FileSystem.FileSystem, dir: string) =>
  fs.readDirectory(dir, { recursive: true }).pipe(Effect.map((all) => Arr.sort(all, Order.String)));

const manifestOf = (fs: FileSystem.FileSystem, path: Path.Path, dir: string) =>
  fs.readFileString(path.join(dir, manifestFileName)).pipe(Effect.flatMap(decodeManifest));

const withFs = <A, E>(
  patch: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
  effect: Effect.Effect<A, E, Env>,
) =>
  Effect.gen(function* step2() {
    const fs = yield* FileSystem.FileSystem;

    return yield* effect.pipe(
      Effect.provideService(FileSystem.FileSystem, { ...fs, ...patch(fs) }),
    );
  });

const interruptAtRename = (
  output: string,
  when: (target: string) => boolean,
  files: readonly GeneratedFile[],
) =>
  Effect.gen(function* stepInterrupt() {
    const started = yield* Deferred.make<boolean>();
    const fiber = yield* Effect.forkChild(
      withFs(
        (real) => ({
          rename: (from, to) =>
            when(to)
              ? Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never))
              : real.rename(from, to),
        }),
        writeFiles(output, files),
      ),
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
  });

const seed = (
  dir: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  files: readonly GeneratedFile[],
) =>
  Effect.gen(function* stepSeed() {
    yield* writeFiles(dir, files);
    yield* fs.writeFileString(path.join(dir, "author.ts"), "mine");
  });

describe("writer: happy paths", () => {
  test("creates the output directory and nested files, manifest listing each, no lock or temp left", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step3() {
        const output = path.join(dir, "out");
        const notices = yield* writeFiles(output, [file("src/main.ts", "hello")]);

        return {
          content: yield* fs.readFileString(path.join(output, "src/main.ts")),
          manifest: yield* manifestOf(fs, path, output),
          notices,
          tree: yield* tree(fs, output),
        };
      }),
    );
    expect(out.content).toBe("hello");
    expect(out.manifest).toEqual([{ path: "src/main.ts", sha256: hex("hello") }]);
    expect(out.notices).toEqual([]);
    expect(out.tree).toEqual([manifestFileName, "src", "src/main.ts"]);
  });

  test("an existing directory keeps author files; a generated file is replaced even when hand-edited", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step5() {
        yield* fs.makeDirectory(path.join(dir, "src"));
        yield* fs.makeDirectory(path.join(dir, "dist"));
        yield* fs.makeDirectory(path.join(dir, "node_modules"));
        yield* fs.writeFileString(path.join(dir, "dist/x.js"), "dist");
        yield* fs.writeFileString(path.join(dir, "node_modules/.keep"), "");
        yield* fs.writeFileString(path.join(dir, "src/commands.ts"), "mine");
        yield* writeFiles(dir, [file("src/main.ts", "old")]);
        yield* fs.writeFileString(path.join(dir, "src/main.ts"), "hand edit");

        const inode = String((yield* fs.stat(dir)).ino);
        yield* writeFiles(dir, [file("src/main.ts", "hello")]);

        return {
          author: yield* fs.readFileString(path.join(dir, "src/commands.ts")),
          dist: yield* fs.readFileString(path.join(dir, "dist/x.js")),
          inodeKept: inode === String((yield* fs.stat(dir)).ino),
          main: yield* fs.readFileString(path.join(dir, "src/main.ts")),
          tree: yield* tree(fs, dir),
        };
      }),
    );
    expect(out.main).toBe("hello");
    expect(out.author).toBe("mine");
    expect(out.dist).toBe("dist");
    expect(out.inodeKept).toBe(true);
    expect(out.tree).toEqual([
      manifestFileName,
      "dist",
      "dist/x.js",
      "node_modules",
      "node_modules/.keep",
      "src",
      "src/commands.ts",
      "src/main.ts",
    ]);
  });

  test("each file is a temp sibling renamed into place and the manifest is renamed last", async () => {
    const renames = await inTempDir((dir, _fs, path) =>
      Effect.gen(function* step6() {
        const seen: { from: string; to: string }[] = [];
        yield* withFs(
          (fs) => ({
            rename: (from, to) => {
              seen.push({ from: path.relative(dir, from), to: path.relative(dir, to) });

              return fs.rename(from, to);
            },
          }),
          writeFiles(dir, [file("b.ts", "2"), file("a.ts", "1")]),
        );

        return seen;
      }),
    );
    expect(renames.map((r) => r.to)).toEqual(["a.ts", "b.ts", manifestFileName]);
    expect(renames.every((r) => r.from !== r.to && r.from.endsWith(".tmp"))).toBe(true);
  });
});

describe("writer: refusals", () => {
  const unsafe: readonly (readonly [string, readonly string[]])[] = [
    ["parent escape", ["../escape"]],
    ["absolute", ["/absolute"]],
    ["inner dot-dot", ["a/../b"]],
    ["leading dot", ["./a"]],
    ["backslash", ["a\\b"]],
    ["empty", [""]],
    ["empty segment", ["a//b"]],
    ["trailing slash", ["a/"]],
    ["nul", ["a\u0000b"]],
    ["manifest name", [manifestFileName]],
    ["lock name", [runLockFileName.toUpperCase()]],
    ["exact duplicate", ["a.ts", "a.ts"]],
    ["case-insensitive collision", ["A.ts", "a.ts"]],
    ["file and directory", ["a", "a/b"]],
  ];

  for (const [name, paths] of unsafe) {
    test(`${name}: refused before the output directory or lock exists`, async () => {
      const out = await inTempDir((dir, fs, path) =>
        Effect.gen(function* step7() {
          const output = path.join(dir, "out");
          const error = yield* failureOf(
            writeFiles(
              output,
              paths.map((p) => file(p)),
            ),
          );

          return { error, exists: yield* fs.exists(output), parent: yield* tree(fs, dir) };
        }),
      );
      expect(out.error.tag).toBe("WriteRefused");
      expect(out.exists).toBe(false);
      expect(out.parent).toEqual([]);
    });
  }

  test("an output that is a regular file is refused and left unchanged", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step8() {
        const output = path.join(dir, "out");
        yield* fs.writeFileString(output, "keep");

        const error = yield* failureOf(writeFiles(output, [file("src/main.ts")]));

        return { content: yield* fs.readFileString(output), error, parent: yield* tree(fs, dir) };
      }),
    );
    expect(out.error).toEqual({ reason: "output-not-directory", tag: "WriteRefused" });
    expect(out.content).toBe("keep");
    expect(out.parent).toEqual(["out"]);
  });

  test("an output that is a dangling symlink or a symlink to a directory is refused; nothing is written through it", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step9() {
        yield* fs.makeDirectory(path.join(dir, "real"));
        yield* fs.symlink(path.join(dir, "missing"), path.join(dir, "dangling"));
        yield* fs.symlink(path.join(dir, "real"), path.join(dir, "linked"));

        const dangling = yield* failureOf(writeFiles(path.join(dir, "dangling"), [file("a.ts")]));
        const linked = yield* failureOf(writeFiles(path.join(dir, "linked"), [file("a.ts")]));

        return {
          dangling,
          linked,
          missingCreated: yield* fs.exists(path.join(dir, "missing")),
          real: yield* tree(fs, path.join(dir, "real")),
        };
      }),
    );
    expect(out.dangling).toEqual({ reason: "symlink", tag: "WriteRefused" });
    expect(out.linked).toEqual({ reason: "symlink", tag: "WriteRefused" });
    expect(out.missingCreated).toBe(false);
    expect(out.real).toEqual([]);
  });

  test("a symlinked directory inside the output is refused; nothing lands outside", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step10() {
        const output = path.join(dir, "out");
        const outside = path.join(dir, "outside");
        yield* fs.makeDirectory(output);
        yield* fs.makeDirectory(outside);
        yield* fs.symlink(outside, path.join(output, "src"));

        const error = yield* failureOf(writeFiles(output, [file("src/main.ts")]));

        return { error, output: yield* tree(fs, output), outside: yield* tree(fs, outside) };
      }),
    );
    expect(out.error).toEqual({ reason: "symlink", tag: "WriteRefused" });
    expect(out.outside).toEqual([]);
    expect(out.output).toEqual(["src"]);
  });

  test("a symlinked target file is refused and its destination is untouched", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step11() {
        const output = path.join(dir, "out");
        yield* fs.makeDirectory(output);
        yield* fs.writeFileString(path.join(dir, "victim"), "victim");
        yield* fs.symlink(path.join(dir, "victim"), path.join(output, "a.ts"));

        const error = yield* failureOf(writeFiles(output, [file("a.ts", "new")]));

        return { error, victim: yield* fs.readFileString(path.join(dir, "victim")) };
      }),
    );
    expect(out.error).toEqual({ reason: "symlink", tag: "WriteRefused" });
    expect(out.victim).toBe("victim");
  });

  test("an on-disk file where a generated directory belongs is refused with the author file, previous files and manifest intact", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step12() {
        yield* writeFiles(dir, [file("keep.ts", "old")]);
        yield* fs.writeFileString(path.join(dir, "a"), "author");

        const before = yield* fs.readFileString(path.join(dir, manifestFileName));
        const error = yield* failureOf(writeFiles(dir, [file("a/b.ts"), file("keep.ts", "new")]));

        return {
          author: yield* fs.readFileString(path.join(dir, "a")),
          error,
          keep: yield* fs.readFileString(path.join(dir, "keep.ts")),
          manifestKept: before === (yield* fs.readFileString(path.join(dir, manifestFileName))),
          tree: yield* tree(fs, dir),
        };
      }),
    );
    expect(out.error).toEqual({ reason: "path-conflict", tag: "WriteRefused" });
    expect(out.author).toBe("author");
    expect(out.keep).toBe("old");
    expect(out.manifestKept).toBe(true);
    expect(out.tree).toEqual([manifestFileName, "a", "keep.ts"]);
  });

  test("an on-disk directory where a generated file belongs is refused", async () => {
    const error = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step13() {
        yield* fs.makeDirectory(path.join(dir, "a.ts"));

        return yield* failureOf(writeFiles(dir, [file("a.ts")]));
      }),
    );
    expect(error).toEqual({ reason: "path-conflict", tag: "WriteRefused" });
  });

  test("a missing parent of the output directory is refused and nothing is created", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step14() {
        const error = yield* failureOf(
          writeFiles(path.join(dir, "missing-parent", "out"), [file("a.ts")]),
        );

        return { error, tree: yield* tree(fs, dir) };
      }),
    );
    expect(out.error).toEqual({ reason: "output-parent-missing", tag: "WriteRefused" });
    expect(out.tree).toEqual([]);
  });
});

describe("writer: run lock", () => {
  for (const [name, count, preexisting] of [
    ["two claimants, absent directory", 2, false],
    ["eight claimants, absent directory", 8, false],
    ["two claimants, existing directory with a previous manifest", 2, true],
  ] as const) {
    test(`${name}: exactly one succeeds, the rest fail with RunLockHeld naming the lock`, async () => {
      const out = await inTempDir((dir, fs, path) =>
        Effect.gen(function* step15() {
          const output = path.join(dir, "out");

          if (preexisting) {
            yield* writeFiles(output, [file("src/main.ts", "old")]);
          }

          const results = yield* Effect.all(
            Arr.makeBy(count, () =>
              Effect.exit(writeFiles(output, [file("src/main.ts", "hello")])),
            ),
            { concurrency: "unbounded" },
          );

          return {
            content: yield* fs.readFileString(path.join(output, "src/main.ts")),
            results,
            tree: yield* tree(fs, output),
          };
        }),
      );
      const wins = out.results.filter((r) => r._tag === "Success");
      expect(wins).toHaveLength(1);
      expect(out.content).toBe("hello");
      expect(out.tree).toEqual([manifestFileName, "src", "src/main.ts"]);

      for (const result of out.results) {
        if (result._tag === "Failure") {
          expect(JSON.stringify(result.cause)).toContain("RunLockHeld");
          expect(JSON.stringify(result.cause)).toContain(runLockFileName);
        }
      }
    });
  }

  test("the lock is released after success and after a refused write, so a later run proceeds", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step16() {
        const output = path.join(dir, "out");
        yield* writeFiles(output, [file("a.ts")]);

        const afterFirst = yield* fs.exists(path.join(output, runLockFileName));
        yield* fs.writeFileString(path.join(output, "d"), "author");
        yield* failureOf(writeFiles(output, [file("d/x.ts")]));

        const afterRefusal = yield* fs.exists(path.join(output, runLockFileName));
        yield* writeFiles(output, [file("a.ts", "2")]);

        return { afterFirst, afterRefusal };
      }),
    );
    expect(out).toEqual({ afterFirst: false, afterRefusal: false });
  });

  test("a lock left by a killed run refuses the write, is left in place, and nothing is written", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step17() {
        yield* fs.writeFileString(path.join(dir, runLockFileName), "");

        const error = yield* failureOf(writeFiles(dir, [file("a.ts")]));

        return { error, tree: yield* tree(fs, dir) };
      }),
    );
    expect(out.error.tag).toBe("RunLockHeld");
    expect(out.tree).toEqual([runLockFileName]);
  });
});

describe("writer: interrupts", () => {
  test("interrupted before the first rename: temp sibling and lock removed, nothing generated remains", async () => {
    const after = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step18() {
        const output = path.join(dir, "out");
        yield* fs.makeDirectory(output);
        yield* interruptAtRename(output, () => true, [file("src/main.ts", "hello")]);

        return yield* tree(fs, output);
      }),
    );
    expect(after).toEqual(["src"]);
  });

  test("interrupted before the manifest: previous manifest and unrewritten listed files stay, temps and lock go", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step19() {
        yield* writeFiles(dir, [file("src/main.ts", "old"), file("src/old.ts", "old")]);

        const manifestBefore = yield* fs.readFileString(path.join(dir, manifestFileName));
        yield* interruptAtRename(dir, (to) => to.endsWith(manifestFileName), [
          file("src/main.ts", "hello"),
        ]);

        return {
          main: yield* fs.readFileString(path.join(dir, "src/main.ts")),
          manifestKept:
            manifestBefore === (yield* fs.readFileString(path.join(dir, manifestFileName))),
          old: yield* fs.readFileString(path.join(dir, "src/old.ts")),
          tree: yield* tree(fs, dir),
        };
      }),
    );
    expect(out.main).toBe("hello");
    expect(out.old).toBe("old");
    expect(out.manifestKept).toBe(true);
    expect(out.tree).toEqual([manifestFileName, "src", "src/main.ts", "src/old.ts"]);
  });
});

describe("writer: previous manifest", () => {
  test("a listed file the run no longer writes is removed when its sha256 still matches; author files stay", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step21() {
        yield* seed(dir, fs, path, [file("src/main.ts", "m"), file("src/old.ts", "o")]);

        const notices = yield* writeFiles(dir, [file("src/main.ts", "hello")]);

        return { manifest: yield* manifestOf(fs, path, dir), notices, tree: yield* tree(fs, dir) };
      }),
    );
    expect(out.notices).toEqual([]);
    expect(out.tree).toEqual([manifestFileName, "author.ts", "src", "src/main.ts"]);
    expect(out.manifest.map((e) => e.path)).toEqual(["src/main.ts"]);
  });

  test("a hand-edited stale file is kept with a notice and dropped from the manifest", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step22() {
        yield* seed(dir, fs, path, [file("src/main.ts", "m"), file("src/old.ts", "o")]);
        yield* fs.writeFileString(path.join(dir, "src/old.ts"), "edited");

        const notices = yield* writeFiles(dir, [file("src/main.ts", "hello")]);

        return {
          kept: yield* fs.readFileString(path.join(dir, "src/old.ts")),
          manifest: yield* manifestOf(fs, path, dir),
          notices,
        };
      }),
    );
    expect(out.notices).toEqual([{ path: "src/old.ts", reason: "edited" }]);
    expect(out.kept).toBe("edited");
    expect(out.manifest.map((e) => e.path)).toEqual(["src/main.ts"]);
  });

  test("previous-manifest paths that leave the directory are never touched and are reported", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step23() {
        const output = path.join(dir, "out");
        yield* fs.makeDirectory(output);
        yield* fs.writeFileString(path.join(dir, "outside.ts"), "outside");
        yield* fs.writeFileString(
          path.join(output, manifestFileName),
          `{"files": [{"path": "../outside.ts", "sha256": "${hex("outside")}"}, {"path": "/etc/hosts", "sha256": "${hex("outside")}"}]}\n`,
        );

        const notices = yield* writeFiles(output, [file("a.ts")]);

        return { notices, outside: yield* fs.readFileString(path.join(dir, "outside.ts")) };
      }),
    );
    expect(out.outside).toBe("outside");
    expect(out.notices).toEqual([
      { path: "../outside.ts", reason: "unsafe-path" },
      { path: "/etc/hosts", reason: "unsafe-path" },
    ]);
  });

  test("a stale path that is a symlink or a directory is kept with a notice", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step24() {
        yield* seed(dir, fs, path, [file("keep.ts"), file("link.ts", "l"), file("dir.ts", "d")]);
        yield* fs.writeFileString(path.join(dir, "target"), "l");
        yield* fs.remove(path.join(dir, "link.ts"));
        yield* fs.symlink(path.join(dir, "target"), path.join(dir, "link.ts"));
        yield* fs.remove(path.join(dir, "dir.ts"));
        yield* fs.makeDirectory(path.join(dir, "dir.ts"));

        const notices = yield* writeFiles(dir, [file("keep.ts")]);

        return { notices, target: yield* fs.readFileString(path.join(dir, "target")) };
      }),
    );
    expect(out.notices).toEqual([
      { path: "dir.ts", reason: "not-regular-file" },
      { path: "link.ts", reason: "symlink" },
    ]);
    expect(out.target).toBe("l");
  });

  test("a previous path that differs from a new path only by case is not removed", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step25() {
        yield* seed(dir, fs, path, [file("Main.ts", "m")]);

        const notices = yield* writeFiles(dir, [file("main.ts", "new")]);

        return { content: yield* fs.readFileString(path.join(dir, "main.ts")), notices };
      }),
    );
    expect(out.notices).toEqual([]);
    expect(out.content).toBe("new");
  });

  test("a malformed or oversized previous manifest deletes nothing, is reported, and is replaced; a directory in its place is refused", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step26() {
        const manifestPath = path.join(dir, manifestFileName);
        yield* fs.writeFileString(path.join(dir, "old.ts"), "o");

        const results = [];

        for (const text of [
          "not json",
          `{"files": [], "extra": 1}`,
          `{"files": []}${" ".repeat(5 * 1024 * 1024)}`,
        ]) {
          yield* fs.writeFileString(manifestPath, text);
          results.push(yield* writeFiles(dir, [file("a.ts")]));
        }

        yield* fs.remove(manifestPath);
        yield* fs.makeDirectory(manifestPath);

        const blocked = yield* failureOf(writeFiles(dir, [file("a.ts")]));

        return { blocked, old: yield* fs.exists(path.join(dir, "old.ts")), results };
      }),
    );
    expect(out.old).toBe(true);
    expect(out.blocked).toEqual({ reason: "path-conflict", tag: "WriteRefused" });
    expect(out.results).toEqual([
      [{ path: manifestFileName, reason: "manifest-unreadable" }],
      [{ path: manifestFileName, reason: "manifest-unreadable" }],
      [{ path: manifestFileName, reason: "manifest-unreadable" }],
    ]);
  });

  test("an absent previous manifest gives no notice", async () => {
    const notices = await inTempDir((dir) => writeFiles(dir, [file("a.ts")]));
    expect(notices).toEqual([]);
  });
});

const denied = (method: string, target: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    method,
    module: "FileSystem",
    pathOrDescriptor: target,
  });

describe("writer: stale files and failed runs", () => {
  test("an unreadable stale file becomes a notice and the other stale file is still removed", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* stepStaleIo() {
        yield* seed(dir, fs, path, [
          file("keep.ts", "k"),
          file("a-old.ts", "a"),
          file("b-old.ts", "b"),
        ]);

        const unreadablePath = path.join(dir, "a-old.ts");
        const notices = yield* withFs(
          (real) => ({
            lstat: (target) =>
              target === unreadablePath ? Effect.fail(denied("lstat", target)) : real.lstat(target),
            readFile: (target) =>
              target === unreadablePath
                ? Effect.fail(denied("readFile", target))
                : real.readFile(target),
            stream: (target, options) =>
              target === unreadablePath
                ? Stream.fail(denied("stream", target))
                : real.stream(target, options),
          }),
          writeFiles(dir, [file("keep.ts", "k")]),
        );

        return { manifest: yield* manifestOf(fs, path, dir), notices, tree: yield* tree(fs, dir) };
      }),
    );
    expect(out.notices).toEqual([{ path: "a-old.ts", reason: "unreadable" }]);
    expect(out.tree).toEqual([manifestFileName, "a-old.ts", "author.ts", "keep.ts"]);
    expect(out.manifest.map((e) => e.path)).toEqual(["keep.ts"]);
  });

  test("stale files are hashed by streaming, never read whole", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* stepStaleStream() {
        yield* seed(dir, fs, path, [file("keep.ts", "k"), file("old.ts", "o")]);

        const notices = yield* withFs(
          () => ({
            readFile: (target) => Effect.die(new Error(`whole read of ${target}`)),
          }),
          writeFiles(dir, [file("keep.ts", "k")]),
        );

        return { notices, tree: yield* tree(fs, dir) };
      }),
    );
    expect(out.notices).toEqual([]);
    expect(out.tree).toEqual([manifestFileName, "author.ts", "keep.ts"]);
  });

  test("a failed run on a directory it created removes its own files and keeps a file another run placed there", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* stepCreatedFailure() {
        const output = path.join(dir, "out");
        const error = yield* failureOf(
          withFs(
            (real) => ({
              rename: (from, to) =>
                path.basename(to) === manifestFileName
                  ? real
                      .writeFileString(path.join(output, "foreign.txt"), "theirs")
                      .pipe(Effect.andThen(Effect.fail(denied("rename", to))))
                  : real.rename(from, to),
            }),
            writeFiles(output, [file("src/main.ts", "m"), file("top.ts", "t")]),
          ),
        );

        return {
          error,
          foreign: yield* fs.readFileString(path.join(output, "foreign.txt")),
          tree: yield* tree(fs, output),
        };
      }),
    );
    expect(out.error).toEqual({ reason: "io", tag: "WriteRefused" });
    expect(out.foreign).toBe("theirs");
    expect(out.tree).toEqual(["foreign.txt"]);
  });

  test("a failed run on a directory it created removes the directory when nothing else is in it", async () => {
    const out = await inTempDir((dir, fs, path) =>
      Effect.gen(function* stepCreatedEmpty() {
        const output = path.join(dir, "out");
        const error = yield* failureOf(
          withFs(
            (real) => ({
              rename: (from, to) =>
                path.basename(to) === manifestFileName
                  ? Effect.fail(denied("rename", to))
                  : real.rename(from, to),
            }),
            writeFiles(output, [file("src/main.ts", "m")]),
          ),
        );

        return { error, exists: yield* fs.exists(output) };
      }),
    );
    expect(out.error).toEqual({ reason: "io", tag: "WriteRefused" });
    expect(out.exists).toBe(false);
  });
});
