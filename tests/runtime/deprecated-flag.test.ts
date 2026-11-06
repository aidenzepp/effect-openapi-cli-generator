/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Cause, Console, Effect, Exit, Layer, Option, Runtime, Sink, Stdio, Stream } from "effect";
import { Argument, CliOutput, Command, Flag } from "effect/cli";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";

// A deprecated parameter (PRM-07): when the operator gives its flag, one stderr notice names the
// flag, never the value, and the value reaches the request unchanged. An absent flag prints nothing,
// and stdout stays the command result.

interface Run {
  readonly exit: Exit.Exit<unknown, unknown>;
  readonly sent: readonly unknown[];
  readonly stderr: string;
  readonly stdout: string;
}

const result = "the command result\n";

const notice = (name: string): string => `Notice: the parameter ${name} is deprecated\n`;

// One flag of each presence shape, deprecated, beside a flag that is not.
const flags = {
  fresh: Flag.String("fresh").pipe(Flag.optional),
  old: Flag.String("old").pipe(Flag.optional, Input.deprecated("old")),
  olds: Flag.String("olds").pipe(Flag.atLeast(0), Input.deprecated("olds")),
  quiet: Flag.Boolean("quiet").pipe(Flag.optional, Input.deprecated("quiet")),
};

const positional = { id: Argument.String("id").pipe(Input.deprecatedArgument("id")) };

// A Stdio stream that appends what it is given to `lines`.
const into = (lines: string[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      lines.push(Buffer.from(chunk).toString("utf-8"));
    }),
  );

// The generated entry's shape (see numeric-flag.test.ts). The handler stands in for the request:
// it records the values it would send and writes the result to stdout.
const run = (
  args: readonly string[],
  config: typeof flags | typeof positional = flags,
): Promise<Run> =>
  Effect.runPromise(
    Effect.suspend(() => {
      const sent: unknown[] = [];
      const err: string[] = [];
      const out: string[] = [];
      // Object.assign keeps the host console methods; spreading a Console instance drops its prototype.
      // oxlint-disable-next-line prefer-object-spread
      const console: Console.Console = Object.assign({}, globalThis.console, {
        error: (...parts: readonly unknown[]) => {
          err.push(`${parts.join(" ")}\n`);
        },
        log: (...parts: readonly unknown[]) => {
          out.push(`${parts.join(" ")}\n`);
        },
      });
      const command = Command.make("list", config, (values) =>
        Effect.gen(function* send() {
          const stdio = yield* Stdio.Stdio;
          sent.push(values);
          yield* Stream.run(Stream.make(result), stdio.stdout());
        }),
      );

      return Command.runWith(command, { renderErrors: false, version: "0" })(args).pipe(
        Output.exitForHelp,
        Output.finalCatch([]),
        Effect.provide(
          Layer.merge(
            Stdio.layerTest({ stderr: into(err), stdout: into(out) }),
            Output.runCredentialsLayer,
          ),
        ),
        Effect.provide(CliOutput.layer(Output.valueFreeFormatter)),
        Effect.provide(CliOutput.layerPresenter(Output.presenter)),
        Effect.provide(BunServices.layer),
        Effect.provideService(Console.Console, console),
        Effect.exit,
        Effect.map((exit) => ({ exit, sent, stderr: err.join(""), stdout: out.join("") })),
      );
    }),
  );

const exitCode = (exit: Exit.Exit<unknown, unknown>): number =>
  Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause));

describe("Input.deprecated", () => {
  test("--old v writes one notice naming --old, and the value is sent unchanged", async () => {
    const { exit, sent, stderr, stdout } = await run(["--old", "v-secret"]);

    expect(exitCode(exit)).toBe(0);
    expect(stderr).toBe(notice("--old"));
    expect(stdout).toBe(result);
    expect(sent).toEqual([
      { fresh: Option.none(), old: Option.some("v-secret"), olds: [], quiet: Option.none() },
    ]);
  });

  test("a repeated --olds a --olds b writes one notice", async () => {
    const { exit, sent, stderr, stdout } = await run(["--olds", "a", "--olds", "b"]);

    expect(exitCode(exit)).toBe(0);
    expect(stderr).toBe(notice("--olds"));
    expect(stdout).toBe(result);
    expect(sent).toHaveLength(1);
  });

  test("a deprecated boolean flag given as --quiet writes one notice", async () => {
    const { stderr } = await run(["--quiet"]);

    expect(stderr).toBe(notice("--quiet"));
  });

  test("no deprecated flag given writes no notice", async () => {
    const { exit, sent, stderr, stdout } = await run(["--fresh", "x"]);

    expect(exitCode(exit)).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe(result);
    expect(sent).toHaveLength(1);
  });

  test("two deprecated flags write one notice each", async () => {
    const { stderr } = await run(["--old", "v", "--olds", "a"]);

    expect(stderr).toBe(notice("--old") + notice("--olds"));
  });

  test.each([[["--help"]], [["--old", "v", "--help"]]])(
    "%p writes no notice and sends nothing",
    async (args) => {
      const { exit, sent, stderr } = await run(args);

      expect(exitCode(exit)).toBe(0);
      expect(stderr).not.toContain("Notice");
      expect(sent).toHaveLength(0);
    },
  );
});

describe("Input.deprecatedArgument", () => {
  test("a deprecated path argument writes one notice naming <id>, never the value", async () => {
    const { exit, sent, stderr, stdout } = await run(["7-secret"], positional);

    expect(exitCode(exit)).toBe(0);
    expect(stderr).toBe(notice("<id>"));
    expect(stdout).toBe(result);
    expect(sent).toEqual([{ id: "7-secret" }]);
  });
});
