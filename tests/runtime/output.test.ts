/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Layer, Option, Path, Sink, Stdio, Stream } from "effect";
import type { GlobalFlag } from "effect/cli";
import { systemError } from "effect/PlatformError";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import type { OutputError } from "../../src/runtime-src/domain/errors.ts";
import { Force, OutputPath, writeBody } from "../../src/runtime-src/runtime/output.ts";
import type { ResponseBody } from "../../src/runtime-src/runtime/output.ts";

type Env =
  | FileSystem.FileSystem
  | Path.Path
  | Stdio.Stdio
  | GlobalFlag.Setting.Identifier<"force">
  | GlobalFlag.Setting.Identifier<"output">;

const chunkA = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);

const chunkB = new Uint8Array([0xfe, 0x01, 0x80]);

const bytes = new Uint8Array([...chunkA, ...chunkB]);

const brokenPipe = systemError({
  _tag: "Unknown",
  cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
  method: "stdout",
  module: "Stdio",
});

const diskFull = systemError({
  _tag: "Unknown",
  cause: Object.assign(new Error("write ENOSPC"), { code: "ENOSPC" }),
  method: "stdout",
  module: "Stdio",
});

interface Settings {
  readonly force?: boolean;
  readonly isTerminal?: boolean;
  readonly output?: string;
  readonly stdout?: Stdio.Stdio["stdout"];
}

/**
 * A two-chunk body that counts how many chunks were pulled.
 */
const countedBody = (
  mediaType: string | undefined,
  onChunk?: (n: number) => Effect.Effect<void, never, Env>,
) => {
  const pulled = { count: 0 };
  const body: ResponseBody<never, Env> = {
    bytes: Stream.fromIterable([chunkA, chunkB]).pipe(
      Stream.tap(() =>
        Effect.suspend(() => {
          pulled.count += 1;

          return onChunk?.(pulled.count) ?? Effect.void;
        }),
      ),
    ),
    mediaType,
  };

  return { body, pulled };
};

const run = <A, E>(settings: Settings, program: Effect.Effect<A, E, Env>) => {
  const captured: Buffer[] = [];
  const layer = Layer.mergeAll(
    BunFileSystem.layer,
    BunPath.layer,
    Stdio.layerTest({
      stdout:
        settings.stdout ??
        (() =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.sync(() => {
              captured.push(Buffer.from(chunk));
            }),
          )),
      stdoutIsTerminal: Effect.succeed(settings.isTerminal ?? false),
    }),
    Layer.succeed(OutputPath, Option.fromNullishOr(settings.output)),
    Layer.succeed(Force, settings.force ?? false),
  );

  return Effect.runPromise(Effect.exit(program).pipe(Effect.provide(layer))).then((exit) => ({
    exit,
    stdout: new Uint8Array(Buffer.concat(captured)),
  }));
};

const inDir = <A>(use: (dir: string, fs: FileSystem.FileSystem, path: Path.Path) => Promise<A>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* step1() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "rt6a-" });

        return yield* Effect.promise(() => use(dir, fs, path));
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  );

const failure = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Option.getOrUndefined(Exit.findErrorOption(exit));

const reasonOf = (error: OutputError | UsageError | undefined) =>
  error?._tag === "OutputError" ? error.reason : undefined;

describe("stdout sink", () => {
  test("raw bytes reach stdout unchanged", async () => {
    const { body } = countedBody("application/json");
    const result = await run({}, writeBody(body));
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.stdout).toEqual(bytes);
  });

  test("a text body to a terminal is allowed", async () => {
    const { body } = countedBody("text/plain; charset=utf-8");
    const result = await run({ isTerminal: true }, writeBody(body));
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.stdout).toEqual(bytes);
  });

  test("--output - sends a binary body to a terminal", async () => {
    const { body } = countedBody("image/png");
    const result = await run({ isTerminal: true, output: "-" }, writeBody(body));
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.stdout).toEqual(bytes);
  });

  test("binary media to a terminal is refused with UsageError and zero body bytes read", async () => {
    const mediaTypes = ["image/png", "application/octet-stream", undefined];
    const outcomes = await Promise.all(
      mediaTypes.map(async (mediaType) => {
        const { body, pulled } = countedBody(mediaType);
        const result = await run({ isTerminal: true }, writeBody(body));

        return { error: failure(result.exit), pulled: pulled.count, written: result.stdout.length };
      }),
    );

    for (const outcome of outcomes) {
      expect(outcome.error).toBeInstanceOf(UsageError);
      expect(outcome.pulled).toBe(0);
      expect(outcome.written).toBe(0);
    }
  });

  test("--force does not let binary media reach a terminal", async () => {
    const { body, pulled } = countedBody("image/png");
    const result = await run({ force: true, isTerminal: true }, writeBody(body));
    expect(failure(result.exit)).toBeInstanceOf(UsageError);
    expect(pulled.count).toBe(0);
  });

  test("EPIPE on stdout stops the stream and succeeds", async () => {
    const { body, pulled } = countedBody("application/json");
    const result = await run(
      { stdout: () => Sink.forEach(() => Effect.fail(brokenPipe)) },
      writeBody(body),
    );
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(pulled.count).toBeLessThan(2);
  });

  test("another stdout write failure is OutputError write", async () => {
    const { body } = countedBody("application/json");
    const result = await run(
      { stdout: () => Sink.forEach(() => Effect.fail(diskFull)) },
      writeBody(body),
    );
    expect(reasonOf(failure(result.exit))).toBe("write");
  });
});

describe("--output file", () => {
  test("bytes land through a temp sibling renamed into place", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.bin");
      const listings: (readonly string[])[] = [];
      const { body } = countedBody("image/png", (n) =>
        n === 2
          ? fs.readDirectory(dir).pipe(
              Effect.orDie,
              Effect.tap((names) =>
                Effect.sync(() => {
                  listings.push(names);
                }),
              ),
              Effect.asVoid,
            )
          : Effect.void,
      );
      const result = await run({ isTerminal: true, output: target }, writeBody(body));
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(result.stdout.length).toBe(0);
      expect(listings).toHaveLength(1);
      expect(listings[0]?.includes("out.bin")).toBe(false);
      expect(listings[0]).toHaveLength(1);
      expect(
        new Uint8Array(
          await Effect.runPromise(fs.readFile(target).pipe(Effect.provide(BunFileSystem.layer))),
        ),
      ).toEqual(bytes);
      expect(
        await Effect.runPromise(fs.readDirectory(dir).pipe(Effect.provide(BunFileSystem.layer))),
      ).toEqual(["out.bin"]);
    });
  });

  test("an existing path is refused without --force, untouched, with no body read and no temp left", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.bin");
      await Effect.runPromise(
        fs.writeFileString(target, "keep").pipe(Effect.provide(BunFileSystem.layer)),
      );
      const { body, pulled } = countedBody("application/json");
      const result = await run({ output: target }, writeBody(body));
      expect(reasonOf(failure(result.exit))).toBe("exists");
      expect(pulled.count).toBe(0);
      expect(
        await Effect.runPromise(
          fs.readFileString(target).pipe(Effect.provide(BunFileSystem.layer)),
        ),
      ).toBe("keep");
      expect(
        await Effect.runPromise(fs.readDirectory(dir).pipe(Effect.provide(BunFileSystem.layer))),
      ).toEqual(["out.bin"]);
    });
  });

  test("--force replaces an existing file", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.bin");
      await Effect.runPromise(
        fs.writeFileString(target, "old").pipe(Effect.provide(BunFileSystem.layer)),
      );
      const { body } = countedBody("application/json");
      const result = await run({ force: true, output: target }, writeBody(body));
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(
        new Uint8Array(
          await Effect.runPromise(fs.readFile(target).pipe(Effect.provide(BunFileSystem.layer))),
        ),
      ).toEqual(bytes);
      expect(
        await Effect.runPromise(fs.readDirectory(dir).pipe(Effect.provide(BunFileSystem.layer))),
      ).toEqual(["out.bin"]);
    });
  });

  test("a path created while the body streams is not overwritten without --force", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.bin");
      const { body } = countedBody("application/json", (n) =>
        n === 2 ? fs.writeFileString(target, "racer").pipe(Effect.orDie) : Effect.void,
      );
      const result = await run({ output: target }, writeBody(body));
      expect(reasonOf(failure(result.exit))).toBe("exists");
      expect(
        await Effect.runPromise(
          fs.readFileString(target).pipe(Effect.provide(BunFileSystem.layer)),
        ),
      ).toBe("racer");
      expect(
        await Effect.runPromise(fs.readDirectory(dir).pipe(Effect.provide(BunFileSystem.layer))),
      ).toEqual(["out.bin"]);
    });
  });

  test("a failing body leaves no target and no temp file", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.bin");
      const failing: ResponseBody<"boom"> = {
        bytes: Stream.concat(Stream.make(chunkA), Stream.fail("boom" as const)),
        mediaType: "application/json",
      };
      const result = await run({ output: target }, writeBody(failing));
      expect(failure(result.exit)).toBe("boom");
      expect(
        await Effect.runPromise(fs.readDirectory(dir).pipe(Effect.provide(BunFileSystem.layer))),
      ).toEqual([]);
    });
  });

  test("an unwritable directory is OutputError write", async () => {
    await inDir(async (dir, _fs, path) => {
      const { body } = countedBody("application/json");
      const result = await run({ output: path.join(dir, "missing", "out.bin") }, writeBody(body));
      expect(reasonOf(failure(result.exit))).toBe("write");
    });
  });
});
