import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Fiber } from "effect";
import { NodeServices } from "@effect/platform-node";
import { writeApplication } from "../src/write.js";
const app = { files: [{ path: "src/main.ts", content: "hello" }] };
const run = (output: string, application = app) =>
  Effect.runPromise(writeApplication(application, output).pipe(Effect.provide(NodeServices.layer)));

test("writes nested files and refuses existing targets including symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "writer-"));
  try {
    const output = join(root, "out");
    await run(output);
    expect(await readFile(join(output, "src/main.ts"), "utf8")).toBe("hello");
    await expect(run(output)).rejects.toThrow();
    await writeFile(join(root, "file"), "keep");
    await expect(run(join(root, "file"))).rejects.toThrow();
    await symlink(join(root, "missing"), join(root, "link"));
    await expect(run(join(root, "link"))).rejects.toThrow();
    expect((await lstat(join(root, "link"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(root, "file"), "utf8")).toBe("keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("one concurrent claimant wins", async () => {
  const root = await mkdtemp(join(tmpdir(), "writer-"));
  try {
    const results = await Promise.allSettled([run(join(root, "out")), run(join(root, "out"))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("unsafe paths fail before claiming and write failures clean only owned output", async () => {
  const root = await mkdtemp(join(tmpdir(), "writer-"));
  try {
    for (const path of ["../escape", "/absolute", "a/../b", "a\\b", "", "a//b"]) {
      await expect(run(join(root, "out"), { files: [{ path, content: "x" }] })).rejects.toThrow();
      expect(await lstat(join(root, "out")).catch(() => undefined)).toBeUndefined();
    }
    await expect(
      run(join(root, "out"), {
        files: [
          { path: "a", content: "x" },
          { path: "a/b", content: "x" },
        ],
      }),
    ).rejects.toThrow();
    expect(await lstat(join(root, "out")).catch(() => undefined)).toBeUndefined();
    await expect(run(join(root, "missing/out"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("interrupted writes remove the claimed directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "writer-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fiber = yield* writeApplication(app, join(root, "out")).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: () => Effect.never,
          }),
          Effect.forkChild,
        );
        while (!(yield* fs.exists(join(root, "out/src")))) {
          yield* Effect.yieldNow;
        }
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    expect(await lstat(join(root, "out")).catch(() => undefined)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
