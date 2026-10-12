import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, FileSystem, Fiber } from "effect";
import { NodeServices } from "@effect/platform-node";
import { writeApplication } from "../src/cli/write.js";

const app = { files: [{ content: "hello", path: "src/main.ts" }] };

const run = (output: string, application = app) =>
  Effect.runPromise(writeApplication(application, output).pipe(Effect.provide(NodeServices.layer)));

test("writes nested files and refuses existing targets including symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "writer-"));
  try {
    const output = path.join(root, "out");
    await run(output);
    expect(await readFile(path.join(output, "src/main.ts"), "utf-8")).toBe("hello");
    expect(
      await run(output).then(
        () => "succeeded",
        () => "rejected",
      ),
    ).toBe("rejected");
    await writeFile(path.join(root, "file"), "keep");
    expect(
      await run(path.join(root, "file")).then(
        () => "succeeded",
        () => "rejected",
      ),
    ).toBe("rejected");
    await symlink(path.join(root, "missing"), path.join(root, "link"));
    expect(
      await run(path.join(root, "link")).then(
        () => "succeeded",
        () => "rejected",
      ),
    ).toBe("rejected");

    const link = await lstat(path.join(root, "link"));
    expect(link.isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(root, "file"), "utf-8")).toBe("keep");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("one concurrent claimant wins", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "writer-"));
  try {
    const results = await Promise.allSettled([
      run(path.join(root, "out")),
      run(path.join(root, "out")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("unsafe paths fail before claiming and write failures clean only owned output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "writer-"));
  try {
    await Effect.runPromise(
      Effect.forEach(
        ["../escape", "/absolute", "a/../b", "a\\b", "", "a//b"],
        (filePath) =>
          Effect.promise(async () => {
            expect(
              await run(path.join(root, "out"), { files: [{ content: "x", path: filePath }] }).then(
                () => "succeeded",
                () => "rejected",
              ),
            ).toBe("rejected");
            expect(await lstat(path.join(root, "out")).catch(() => {})).toBeUndefined();
          }),
        { concurrency: 1, discard: true },
      ),
    );
    expect(
      await run(path.join(root, "out"), {
        files: [
          { content: "x", path: "a" },
          { content: "x", path: "a/b" },
        ],
      }).then(
        () => "succeeded",
        () => "rejected",
      ),
    ).toBe("rejected");
    expect(await lstat(path.join(root, "out")).catch(() => {})).toBeUndefined();
    expect(
      await run(path.join(root, "missing/out")).then(
        () => "succeeded",
        () => "rejected",
      ),
    ).toBe("rejected");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("interrupted writes remove the claimed directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "writer-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* interruptClaimedWrite() {
        const fs = yield* FileSystem.FileSystem;
        const fiber = yield* writeApplication(app, path.join(root, "out")).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: () => Effect.never,
          }),
          Effect.forkChild,
        );
        while (!(yield* fs.exists(path.join(root, "out/src")))) {
          yield* Effect.yieldNow;
        }
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    expect(await lstat(path.join(root, "out")).catch(() => {})).toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
