/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import {
  Cause,
  ConfigProvider,
  Console,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Runtime,
  Sink,
  Stdio,
  Terminal,
} from "effect";
import { CliOutput, Command, Flag } from "effect/cli";
import { ChildProcessSpawner } from "effect/process";
import * as Client from "../../src/runtime-src/runtime/client.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import { runCredentialsLayer } from "../../src/runtime-src/runtime/redact.ts";

// Integer and number parameters (PRM-14, design 6.1): the flag or argument checks the operator's
// text against the JSON number grammar and hands it on unchanged, so no digit is lost or reformatted.
// A text outside the grammar is exit 2 before the handler runs, and the error names the flag only.

interface Seen {
  readonly id: string;
  readonly ids: readonly string[];
  readonly limit: Option.Option<string>;
  readonly ratio: Option.Option<string>;
}

interface Run {
  readonly exit: Exit.Exit<unknown, unknown>;
  readonly seen: readonly Seen[];
  readonly stderr: string;
}

// The generated entry's shape (see presenter.test.ts): `exitForHelp` inside `finalCatch`, errors
// rendered once to stderr. The handler stands in for the request: a refused value never reaches it.
const run = (args: readonly string[]): Promise<Run> =>
  Effect.runPromise(
    Effect.suspend(() => {
      const seen: Seen[] = [];
      const err: string[] = [];
      const capture = () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.sync(() => {
            err.push(Buffer.from(chunk).toString("utf-8"));
          }),
        );
      // Object.assign keeps the host console methods; spreading a Console instance drops its prototype.
      // oxlint-disable-next-line prefer-object-spread
      const console: Console.Console = Object.assign({}, globalThis.console, {
        error: (...parts: readonly unknown[]) => {
          err.push(`${parts.join(" ")}\n`);
        },
        log: (...parts: readonly unknown[]) => {
          err.push(`${parts.join(" ")}\n`);
        },
      });
      const command = Command.make(
        "list",
        {
          id: Input.numericArgument("id", "integer"),
          ids: Input.numericFlag("ids", "integer").pipe(Flag.atLeast(0)),
          limit: Input.numericFlag("limit", "integer").pipe(Flag.optional),
          ratio: Input.numericFlag("ratio", "number").pipe(Flag.optional),
        },
        (values) =>
          Effect.sync(() => {
            seen.push(values);
          }),
      );

      return Command.runWith(command, { renderErrors: false, version: "0" })(args).pipe(
        Output.exitForHelp,
        Output.finalCatch([]),
        Effect.provide(
          Layer.merge(Stdio.layerTest({ stderr: capture, stdout: capture }), runCredentialsLayer),
        ),
        Effect.provide(CliOutput.layer(Output.valueFreeFormatter)),
        Effect.provide(CliOutput.layerPresenter(Output.presenter)),
        Effect.provide(BunServices.layer),
        Effect.provideService(Console.Console, console),
        Effect.exit,
        Effect.map((exit) => ({ exit, seen, stderr: err.join("") })),
      );
    }),
  );

const exitCode = (exit: Exit.Exit<unknown, unknown>): number =>
  Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause));

const accepted = async (args: readonly string[]): Promise<Seen> => {
  const { exit, seen, stderr } = await run(args);

  expect(exitCode(exit), stderr).toBe(0);
  expect(seen).toHaveLength(1);

  const [values] = seen;
  if (values === undefined) {
    throw new Error("the handler did not run");
  }

  return values;
};

const refused = async (args: readonly string[]): Promise<string> => {
  const { exit, seen, stderr } = await run(args);

  expect(exitCode(exit)).toBe(2);
  expect(seen).toHaveLength(0);

  return stderr;
};

describe("Input.numericFlag", () => {
  test("an integer past 2^53 is handed on as its exact digits", async () => {
    const values = await accepted(["7", "--limit", "9007199254740993"]);

    expect(values.limit).toEqual(Option.some("9007199254740993"));
  });

  test("a number keeps its text: 1.50 stays 1.50", async () => {
    const values = await accepted(["7", "--ratio", "1.50", "--limit", "-3"]);

    expect(values.ratio).toEqual(Option.some("1.50"));
    expect(values.limit).toEqual(Option.some("-3"));
  });

  test("a number accepts exponent text unchanged", async () => {
    const values = await accepted(["7", "--ratio", "-2.5e-3"]);

    expect(values.ratio).toEqual(Option.some("-2.5e-3"));
  });

  test("a non-integer value is exit 2, names the flag and never the value", async () => {
    const stderr = await refused(["7", "--limit", "abc"]);

    expect(stderr).toContain("--limit");
    expect(stderr).not.toContain("abc");
  });

  test.each(["007", "1.0", "1e2", "+1", " 1", ""])(
    "an integer refuses %p, which the JSON integer grammar does not admit",
    async (text) => {
      await refused(["7", "--limit", text]);
    },
  );

  test.each(["1.", ".5", "NaN", "Infinity", "0x10", "1,5"])("a number refuses %p", async (text) => {
    const stderr = await refused(["7", "--ratio", text]);

    expect(stderr).toContain("--ratio");
  });

  test("a repeated integer flag checks every item: --ids 1 --ids x is exit 2", async () => {
    const stderr = await refused(["7", "--ids", "1", "--ids", "x-secret"]);

    expect(stderr).toContain("--ids");
    expect(stderr).not.toContain("x-secret");
  });

  test("a repeated integer flag hands on every item unchanged", async () => {
    const values = await accepted(["7", "--ids", "1", "--ids", "9007199254740993"]);

    expect(values.ids).toEqual(["1", "9007199254740993"]);
  });
});

describe("Input.numericArgument", () => {
  test("an integer argument is handed on as its exact digits", async () => {
    const values = await accepted(["9007199254740993"]);

    expect(values.id).toBe("9007199254740993");
  });

  test("a non-integer argument is exit 2, names the argument and never the value", async () => {
    const stderr = await refused(["x-secret"]);

    expect(stderr).toContain("<id>");
    expect(stderr).not.toContain("x-secret");
  });
});

// The help text of a command whose values only `--help` reaches: the label each numeric input
// shows in the ARGUMENTS and FLAGS sections.
const help = (): Promise<string> =>
  Effect.runPromise(
    Effect.suspend(() => {
      const out: string[] = [];
      // oxlint-disable-next-line prefer-object-spread
      const console: Console.Console = Object.assign({}, globalThis.console, {
        log: (...parts: readonly unknown[]) => {
          out.push(`${parts.join(" ")}\n`);
        },
      });
      const command = Command.make(
        "get",
        {
          id: Input.numericArgument("id", "number"),
          limit: Input.numericFlag("limit", "integer").pipe(Flag.optional),
          total: Input.int64Flag("total").pipe(Flag.optional),
        },
        () => Effect.void,
      );

      return Command.runWith(command, { version: "0" })(["--help"]).pipe(
        Effect.provide(BunServices.layer),
        Effect.provideService(Console.Console, console),
        Effect.map(() => out.join("")),
      );
    }),
  );

describe("numeric help labels", () => {
  test("a number argument, an integer flag and an int64 flag show their kind, never string", async () => {
    const text = await help();

    expect(text).toMatch(/\bid number\b/u);
    expect(text).toMatch(/--limit integer\b/u);
    expect(text).toMatch(/--total integer\b/u);
    expect(text).not.toMatch(/\bstring\b/u);
  });
});

// The whole-number flags and variables (A5-17, A5-35 neutral part): the exact usage text for a
// non-digit and an out-of-range value, from the flag and from the environment.
const flagEnvironment = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      display: () => Effect.void,
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      rows: Effect.succeed(24),
      size: Effect.die("unused"),
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused")),
  ),
);

const envProvider = (env: Record<string, string>) =>
  Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));

type MessageKey = "message" | "userMessage";

const expectFailure = (exit: Exit.Exit<unknown, unknown>, key: MessageKey, text: string): void => {
  if (Exit.isSuccess(exit)) {
    throw new Error("expected a failure");
  }

  expect(Cause.squash(exit.cause)).toMatchObject({ [key]: text });
};

const flagRefused = async (
  setting: typeof Client.timeoutSetting | typeof Client.retriesSetting,
  name: string,
  raw: string,
  userMessage: string,
): Promise<void> => {
  expectFailure(
    await Effect.runPromiseExit(
      setting.flag
        .parse({ arguments: [], flags: { [name]: [raw] } })
        .pipe(Effect.provide(flagEnvironment)),
    ),
    "userMessage",
    userMessage,
  );
};

const envRefused = async (
  read: Effect.Effect<number, unknown, ConfigProvider.ConfigProvider>,
  env: Record<string, string>,
  message: string,
): Promise<void> => {
  expectFailure(
    await Effect.runPromiseExit(read.pipe(Effect.provide(envProvider(env)))),
    "message",
    message,
  );
};

describe("whole-number flag and variable messages", () => {
  const timeout = "--timeout must be a whole number of seconds, 0 or more";
  const retries = "--retries must be a whole number from 0 to 10";
  const idle = "ACME_IDLE_TIMEOUT must be a whole number of seconds, 1 or more";

  test.each(["abc", "1.5", "-1", "99999999999999999999"])("--timeout %p", async (raw) => {
    await flagRefused(Client.timeoutSetting, "timeout", raw, timeout);
  });

  test.each(["abc", "-1", "11"])("--retries %p", async (raw) => {
    await flagRefused(Client.retriesSetting, "retries", raw, retries);
  });

  test.each(["abc", "-1", "99999999999999999999"])("ACME_TIMEOUT %p", async (raw) => {
    await envRefused(Client.effectiveTimeoutSeconds("ACME"), { ACME_TIMEOUT: raw }, timeout);
  });

  test.each(["abc", "-1", "11"])("ACME_RETRIES %p", async (raw) => {
    await envRefused(Client.effectiveRetries("ACME"), { ACME_RETRIES: raw }, retries);
  });

  test.each(["abc", "0", "-1", "99999999999999999999"])("ACME_IDLE_TIMEOUT %p", async (raw) => {
    await envRefused(Output.effectiveIdleTimeoutSeconds("ACME"), { ACME_IDLE_TIMEOUT: raw }, idle);
  });
});
