import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { acquireRunLock, RunLockHeld, runLockFileName } from "../../src/write/lock.ts";

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const inTempDir = <A, E>(
  body: (
    dir: string,
    fs: FileSystem.FileSystem,
    path: Path.Path,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* step1() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "wr1a-" });

        return yield* body(dir, fs, path);
      }),
    ).pipe(Effect.provide(layer)),
  );

const claim = (dir: string) => Effect.scoped(acquireRunLock(dir).pipe(Effect.andThen(Effect.void)));

describe("run lock", () => {
  test("two concurrent claimants: one holds, the other fails with RunLockHeld and the lock path", async () => {
    const outcome = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step2() {
        const lockPath = path.join(dir, runLockFileName);
        const holdOpen = Effect.scoped(
          Effect.gen(function* step3() {
            yield* acquireRunLock(dir);
            yield* Effect.sleep("50 millis");

            return yield* fs.exists(lockPath);
          }),
        );
        const exits = yield* Effect.all([Effect.exit(holdOpen), Effect.exit(holdOpen)], {
          concurrency: "unbounded",
        });

        return { exits, leftover: yield* fs.exists(lockPath), lockPath };
      }),
    );
    const failures = outcome.exits.filter((e) => Exit.isFailure(e));
    const successes = outcome.exits.filter((e) => Exit.isSuccess(e)).map((e) => e.value);
    expect(successes).toEqual([true]);
    expect(failures).toHaveLength(1);

    const [failure] = failures;

    if (failure === undefined) {
      return;
    }

    const error = Option.getOrUndefined(Exit.findErrorOption(failure));

    expect(error?._tag).toBe("RunLockHeld");
    expect(error instanceof RunLockHeld ? error.lockPath : undefined).toBe(outcome.lockPath);
    expect(outcome.leftover).toBe(false);
  });

  test("a refused claimant leaves the holder's lock in place", async () => {
    const stillHeld = await inTempDir((dir, fs, path) =>
      Effect.scoped(
        Effect.gen(function* step4() {
          yield* acquireRunLock(dir);

          const refused = yield* Effect.exit(claim(dir));
          expect(Exit.isFailure(refused)).toBe(true);

          return yield* fs.exists(path.join(dir, runLockFileName));
        }),
      ),
    );
    expect(stillHeld).toBe(true);
  });

  test("a failed scope removes the lock and the registered temp siblings", async () => {
    const outcome = await inTempDir((dir, fs, path) =>
      Effect.gen(function* step5() {
        const tempA = path.join(dir, ".a.tmp");
        const tempB = path.join(dir, ".b.tmp");
        const unrelated = path.join(dir, "keep.txt");
        yield* fs.writeFileString(unrelated, "keep");

        const exit = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* step6() {
              const lock = yield* acquireRunLock(dir);
              yield* fs.writeFileString(tempA, "a");
              yield* lock.registerTemp(tempA);
              yield* fs.writeFileString(tempB, "b");
              yield* lock.registerTemp(tempB);

              return yield* Effect.fail("boom" as const);
            }),
          ),
        );

        return {
          exit,
          lock: yield* fs.exists(path.join(dir, runLockFileName)),
          tempA: yield* fs.exists(tempA),
          tempB: yield* fs.exists(tempB),
          unrelated: yield* fs.exists(unrelated),
        };
      }),
    );
    expect(Exit.isFailure(outcome.exit)).toBe(true);
    expect(outcome.lock).toBe(false);
    expect(outcome.tempA).toBe(false);
    expect(outcome.tempB).toBe(false);
    expect(outcome.unrelated).toBe(true);
  });

  test("a registered temp that was already renamed away does not fail the release", async () => {
    const exit = await inTempDir((dir, _fs, path) =>
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* step7() {
            const lock = yield* acquireRunLock(dir);
            yield* lock.registerTemp(path.join(dir, ".gone.tmp"));
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
