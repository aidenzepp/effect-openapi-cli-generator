/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Cause, Console, Effect, Exit, Layer, Runtime, Sink, Stdio } from "effect";
import { CliError, CliOutput, Command, Flag } from "effect/cli";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import { runCredentialsLayer } from "../../src/runtime-src/runtime/redact.ts";

const canary = "CANARY-SECRET-123";

const login = Command.make(
  "login",
  { port: Flag.Int("port").pipe(Flag.withDescription("Callback port.")) },
  () => Effect.void,
).pipe(Command.withDescription("Sign in."));

const cli = Command.make("example").pipe(
  Command.withDescription("Example CLI."),
  Command.withSubcommands([login]),
);

interface Run {
  readonly exit: Exit.Exit<unknown, unknown>;
  readonly stderr: string;
  readonly stdout: string;
}

interface Options {
  readonly formatter?: CliOutput.Formatter;
  readonly renderErrors?: boolean;
}

// The generated entry's shape: the presenter and formatter in context, `exitForHelp` inside
// `finalCatch`, `renderErrors: false`. Console carries the presenter's text; Stdio carries
// finalCatch's. Both land in the same two buffers.
const run = (args: readonly string[], options: Options = {}): Promise<Run> =>
  Effect.runPromise(
    Effect.suspend(() => {
      const out: string[] = [];
      const err: string[] = [];
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
      const stdio = Stdio.layerTest({
        stderr: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.sync(() => {
              err.push(Buffer.from(chunk).toString("utf-8"));
            }),
          ),
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.sync(() => {
              out.push(Buffer.from(chunk).toString("utf-8"));
            }),
          ),
      });

      return Command.runWith(cli, {
        renderErrors: options.renderErrors ?? false,
        version: "1.2.3",
      })(args).pipe(
        Output.exitForHelp,
        Output.finalCatch([]),
        Effect.provide(Layer.merge(stdio, runCredentialsLayer)),
        Effect.provide(CliOutput.layer(options.formatter ?? Output.valueFreeFormatter)),
        Effect.provide(CliOutput.layerPresenter(Output.presenter)),
        Effect.provide(BunServices.layer),
        Effect.provideService(Console.Console, console),
        Effect.exit,
        Effect.map((exit) => ({ exit, stderr: err.join(""), stdout: out.join("") })),
      );
    }),
  );

const exitCode = (exit: Exit.Exit<unknown, unknown>): number =>
  Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause));

describe("Output.presenter routing", () => {
  test("requested help goes to stdout and exits 0", async () => {
    const { exit, stderr, stdout } = await run(["login", "--help"]);

    expect(stdout).toContain("Callback port.");
    expect(stderr).toBe("");
    expect(exitCode(exit)).toBe(0);
  });

  test("version goes to stdout and exits 0", async () => {
    const { exit, stderr, stdout } = await run(["--version"]);

    expect(stdout).toContain("1.2.3");
    expect(stderr).toBe("");
    expect(exitCode(exit)).toBe(0);
  });

  test("a group run without a subcommand prints implicit help on stderr and exits 0", async () => {
    const { exit, stderr, stdout } = await run([]);

    expect(stderr).toContain("login");
    expect(stderr).toContain("Example CLI.");
    expect(stdout).toBe("");
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("an invalid invocation goes to stderr, value-free", async () => {
    const { stderr, stdout } = await run(["login", "--port", canary], { renderErrors: true });

    expect(stderr).toContain("Callback port.");
    expect(stderr).toContain("--port");
    expect(stdout).toBe("");
    expect(`${stdout}${stderr}`).not.toContain(canary);
  });

  test("the text comes from the Formatter in context", async () => {
    const formatter: CliOutput.Formatter = {
      formatCliError: Output.valueFreeFormatter.formatCliError,
      formatError: Output.valueFreeFormatter.formatError,
      formatErrors: Output.valueFreeFormatter.formatErrors,
      formatHelpDoc: () => "custom help",
      formatVersion: () => "custom version",
    };
    const help = await run(["login", "--help"], { formatter });
    const version = await run(["--version"], { formatter });
    const implicit = await run([], { formatter });

    expect(help.stdout).toBe("custom help\n");
    expect(version.stdout).toBe("custom version\n");
    expect(implicit.stderr).toBe("custom help\n");
  });
});

describe("Output.presenter sanitizing", () => {
  const hostile = "\u001B[31mred\u009B2Jx\u0085y";
  const hostileFormatter: CliOutput.Formatter = {
    formatCliError: Output.valueFreeFormatter.formatCliError,
    formatError: Output.valueFreeFormatter.formatError,
    formatErrors: () => `bad${hostile}`,
    formatHelpDoc: () => `help${hostile}`,
    formatVersion: () => `v${hostile}`,
  };
  const neutral = "[31mred2Jxy";

  test("requested help and version reach stdout with control characters removed", async () => {
    const help = await run(["login", "--help"], { formatter: hostileFormatter });
    const version = await run(["--version"], { formatter: hostileFormatter });

    expect(help.stdout).toBe(`help${neutral}\n`);
    expect(help.stderr).toBe("");
    expect(version.stdout).toBe(`v${neutral}\n`);
    expect(version.stderr).toBe("");
  });

  test("implicit help reaches stderr with control characters removed", async () => {
    const { stderr, stdout } = await run([], { formatter: hostileFormatter });

    expect(stderr).toBe(`help${neutral}\n`);
    expect(stdout).toBe("");
  });

  test("an invalid invocation reaches stderr with control characters removed", async () => {
    const { stderr, stdout } = await run(["login", "--port", "x"], {
      formatter: hostileFormatter,
      renderErrors: true,
    });

    expect(stderr).toContain(`help${neutral}\n`);
    expect(stderr).toContain(`bad${neutral}\n`);
    expect(stderr.includes("\u001B")).toBe(false);
    expect(stderr.includes("\u009B")).toBe(false);
    expect(stdout).toBe("");
  });
});

describe("Output.exitForHelp", () => {
  test("a parse error exits 2 and finalCatch reports it once", async () => {
    const { exit, stderr, stdout } = await run(["login", "--port", canary]);
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

    expect(CliError.isCliError(error) && error._tag).toBe("ShowHelp");
    expect(Runtime.getErrorExitCode(error)).toBe(2);
    expect(Runtime.getErrorReported(error)).toBe(false);
    expect(stderr.match(/Invalid value for flag --port/gu)).toHaveLength(1);
    expect(stdout).toBe("");
    expect(`${stdout}${stderr}`).not.toContain(canary);
  });

  test("ShowHelp with errors fails with exit 2", async () => {
    const invalid = new CliError.InvalidValue({
      expected: "port",
      kind: "flag",
      option: "port",
      value: "x",
    });
    const exit = await Effect.runPromise(
      Effect.exit(
        Output.exitForHelp(
          Effect.fail(new CliError.ShowHelp({ commandPath: [], errors: [invalid] })),
        ),
      ),
    );

    expect(exitCode(exit)).toBe(2);
  });

  test("ShowHelp without errors exits 0", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Output.exitForHelp(Effect.fail(new CliError.ShowHelp({ commandPath: [], errors: [] }))),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("any other failure passes through untouched", async () => {
    const other = new Output.InternalError();
    const exit = await Effect.runPromise(Effect.exit(Output.exitForHelp(Effect.fail(other))));

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(other);
    expect(exitCode(exit)).toBe(70);
  });
});
