import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Cause, Console, Effect, Exit, Layer, Runtime, Stdio } from "effect";
import { CliConfig, CliOutput, Command, Flag } from "effect/cli";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import { runCredentialsLayer } from "../../src/runtime-src/runtime/redact.ts";

// A string flag value that starts with "-" (operator decision A on the dash-led value defect):
// with the entry's built-in list there is no -h or -v alias, so `--p -bad_.host-` is a usage
// error (exit 2) that never runs the handler, never built-in help. `--p=-value` carries the value.

interface Run {
  readonly exit: Exit.Exit<unknown, unknown>;
  readonly seen: readonly string[];
  readonly stderr: string;
  readonly stdout: string;
}

// The generated entry's shape (see deprecated-flag.test.ts), with bin.ts's built-in list and
// main.ts's formatter. The handler records the value it would send.
const run = (args: readonly string[]): Promise<Run> =>
  Effect.runPromise(
    Effect.suspend(() => {
      const seen: string[] = [];
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
      const command = Command.make("example", { p: Flag.String("p") }, ({ p }) =>
        Effect.sync(() => {
          seen.push(p);
        }),
      );

      return Command.runWith(command, { renderErrors: false, version: "1.2.3" })(args).pipe(
        Output.exitForHelp,
        Output.finalCatch([]),
        Effect.provide(Layer.merge(Stdio.layerTest({}), runCredentialsLayer)),
        Effect.provide(CliOutput.layer(Output.formatter(command))),
        Effect.provide(CliOutput.layerPresenter(Output.presenter)),
        Effect.provide(CliConfig.layer({ builtIns: Output.builtIns })),
        Effect.provide(BunServices.layer),
        Effect.provideService(Console.Console, console),
        Effect.exit,
        Effect.map((exit) => ({ exit, seen, stderr: err.join(""), stdout: out.join("") })),
      );
    }),
  );

const exitCode = (exit: Exit.Exit<unknown, unknown>): number =>
  Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause));

describe("a flag value that starts with a dash", () => {
  for (const args of [
    ["--p", "-bad_.host-"],
    ["--p", "-xh"],
  ]) {
    test(`${args.join(" ")} exits 2 without running the handler or printing help`, async () => {
      const { exit, seen, stdout } = await run(args);

      expect(exitCode(exit)).toBe(2);
      expect(seen).toEqual([]);
      expect(stdout).toBe("");
    });
  }

  test("--p=-bad_.host- exits 0 and the handler sees the value", async () => {
    const { exit, seen } = await run(["--p=-bad_.host-"]);

    expect(exitCode(exit)).toBe(0);
    expect(seen).toEqual(["-bad_.host-"]);
  });

  test("--help exits 0 and the root help names the --flag=-value escape", async () => {
    const { exit, seen, stdout } = await run(["--help"]);

    expect(exitCode(exit)).toBe(0);
    expect(seen).toEqual([]);
    expect(stdout).toContain("USAGE");
    expect(stdout).toContain(Output.dashValueEscape);
    expect(stdout).not.toContain(", -h");
    expect(stdout).not.toContain(", -v");
  });

  test("--version exits 0 and prints the version", async () => {
    const { exit, seen, stdout } = await run(["--version"]);

    expect(exitCode(exit)).toBe(0);
    expect(seen).toEqual([]);
    expect(stdout).toContain("1.2.3");
  });

  test("-h is no longer an alias: it exits 2", async () => {
    const { exit, seen, stdout } = await run(["-h"]);

    expect(exitCode(exit)).toBe(2);
    expect(seen).toEqual([]);
    expect(stdout).toBe("");
  });
});
