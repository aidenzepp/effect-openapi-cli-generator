/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Cause, Effect, Exit, FileSystem, Layer, Path, Ref, Sink, Stdio, Stream } from "effect";
import type { Scope } from "effect";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Multipart from "../../src/runtime-src/runtime/multipart.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import type { ScrubEntry } from "../../src/runtime-src/runtime/redact.ts";

// m3-pwmh: a multipart `format: password` part is a file part (ruling DR4), its flag a path or `-`.
// An operator may pass the secret itself as the value; a read failure for that flag (missing file,
// directory, unreadable file) names the flag and never echoes the given value, in text or in
// `--error-format json`, on stdout or stderr.

const FLAG = "secret";

// The value the operator mistakenly passed: the secret, read as a path.
const MARKER = "hunter2-PWMH";

const capture = (into: Buffer[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(Buffer.from(chunk));
    }),
  );

// The part's bytes are drained so a failure past the path check would surface too.
const readPart = (given: string) =>
  Multipart.fileBody(FLAG, given).pipe(Effect.flatMap((bytes) => Stream.runDrain(bytes)));

// Run the read for the path `given` builds through the real final catch, in `format`.
const runPart = async (
  format: Output.ErrorFormat,
  given: Effect.Effect<string, unknown, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => {
  const stderr: Buffer[] = [];
  const stdout: Buffer[] = [];
  const program = Effect.gen(function* run() {
    const path = yield* given;

    return yield* Output.finalCatch([])(readPart(path)).pipe(
      Effect.provideServiceEffect(Output.RunRecord, Ref.make<Output.RunRecordState>({ format })),
      Effect.as(path),
    );
  }).pipe(Effect.scoped);
  const environment = Layer.mergeAll(
    BunFileSystem.layer,
    BunPath.layer,
    Stdio.layerTest({ stderr: capture(stderr), stdout: capture(stdout) }),
    Input.stdinClaimLayer,
    Layer.effect(Output.RunCredentials)(Ref.make<readonly ScrubEntry[]>([])),
  );
  const exit = await Effect.runPromise(Effect.exit(program).pipe(Effect.provide(environment)));

  return {
    error: Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
    printed: Buffer.concat([...stdout, ...stderr]).toString("utf-8"),
    stderr: Buffer.concat(stderr).toString("utf-8"),
    stdout: Buffer.concat(stdout).toString("utf-8"),
  };
};

const missing = Effect.succeed(MARKER);

const directory = Effect.gen(function* dir() {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.makeTempDirectoryScoped({ prefix: `${MARKER}-dir-` });
});

const unreadable = Effect.gen(function* file() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = yield* fs.makeTempDirectoryScoped({ prefix: "pwmh-" });
  const target = path.join(parent, `${MARKER}-file`);

  yield* fs.writeFileString(target, "the secret");
  yield* fs.chmod(target, 0o000);
  yield* Effect.addFinalizer(() => Effect.ignore(fs.chmod(target, 0o600)));

  return target;
});

const cases = [
  ["a missing file", missing],
  ["a directory", directory],
  ["an unreadable file", unreadable],
] as const;

describe("a multipart password part's read failure", () => {
  for (const [name, given] of cases) {
    test(`${name} names the flag and never echoes the value in text`, async () => {
      const { error, printed, stderr, stdout } = await runPart("text", given);

      expect(error).toBeDefined();
      expect(stderr).toContain(`--${FLAG}`);
      expect(stdout).toBe("");
      expect(printed).not.toContain(MARKER);
    });

    test(`${name} names the flag and never echoes the value in --error-format json`, async () => {
      const { error, printed, stderr, stdout } = await runPart("json", given);
      const lines = stderr.trimEnd().split("\n");
      const parsed: unknown = JSON.parse(lines[0] ?? "null");

      expect(error).toBeDefined();
      expect(lines).toHaveLength(1);
      expect(parsed).toMatchObject({ error: { kind: "UsageError" } });
      expect(stderr).toContain(`--${FLAG}`);
      expect(stdout).toBe("");
      expect(printed).not.toContain(MARKER);
    });
  }

  test("the failure is a UsageError naming the flag, with no path in its fields", async () => {
    const { error } = await runPart("text", missing);

    expect(error).toMatchObject({ _tag: "UsageError", flag: FLAG });
    expect(JSON.stringify(error)).not.toContain(MARKER);
    expect(String(error)).not.toContain(MARKER);
  });
});
