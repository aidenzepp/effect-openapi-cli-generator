/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Redacted,
  Sink,
  Stdio,
  Stream,
  Terminal,
} from "effect";
import { TerminalCapabilities } from "effect/cli";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";

const table: Auth.SecurityTable = {
  schemes: {
    apiKey: { in: "header", kind: "apiKey", name: "X-Key" },
    bearerAuth: { kind: "http", scheme: "bearer" },
  },
};

const secret = "pr0mpt-s3cr3t";

const bytes = (text: string) => new TextEncoder().encode(text);

interface World {
  readonly answer?: string;
  readonly claimedBy?: string;
  readonly env?: Record<string, string>;
  readonly files?: Record<string, string>;
  readonly given?: Record<string, string>;
  readonly quit?: boolean;
  readonly stdin?: string;
  readonly stdinTty: boolean;
  readonly stdoutTty: boolean;
}

const key = (name: string, input: Option.Option<string>): Terminal.UserInput => ({
  input,
  key: { ctrl: false, meta: false, name, shift: false },
});

const run = async (world: World, requirement: Auth.SecurityRequirement) => {
  const rendered: string[] = [];
  let asked = 0;
  const capture = Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      rendered.push(Buffer.from(chunk).toString("utf-8"));
    }),
  );
  const terminal = Terminal.make({
    columns: Effect.succeed(80),
    display: (text) =>
      Effect.sync(() => {
        rendered.push(text);
      }),
    readInput: Effect.gen(function* readInput() {
      asked += 1;
      const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
      const typed: Terminal.UserInput[] = [];
      for (const char of world.answer ?? "") {
        typed.push(key(char, Option.some(char)));
      }

      yield* Queue.offerAll(
        queue,
        world.quit === true ? typed : [...typed, key("enter", Option.none())],
      );
      if (world.quit === true) {
        yield* Queue.end(queue);
      }

      return queue;
    }),
    readLine: Effect.die("unused"),
    rows: Effect.succeed(24),
    size: Effect.die("unused"),
  });
  const files = world.files ?? {};
  const stdio = Stdio.layerTest({
    stderr: () => capture,
    stdin: Stream.make(bytes(world.stdin ?? "")),
    stdinIsTerminal: Effect.succeed(world.stdinTty),
    stdout: () => capture,
    stdoutIsTerminal: Effect.succeed(world.stdoutTty),
  });
  const { claimedBy } = world;
  let program =
    claimedBy === undefined
      ? Auth.evaluate("users-update", requirement)
      : Effect.service(Input.StdinClaim).pipe(
          Effect.flatMap((claim) => claim.claim(claimedBy)),
          Effect.flatMap(() => Auth.evaluate("users-update", requirement)),
        );
  for (const [scheme, path] of Object.entries(world.given ?? {})) {
    program = program.pipe(
      Effect.provideService(Auth.credentialFileSetting(scheme), Option.some(path)),
    );
  }

  const exit = await Effect.runPromise(
    Effect.exit(program).pipe(
      Effect.provide(
        Layer.mergeAll(
          Auth.layer(table, "EXAMPLE"),
          FileSystem.layerNoop({ stream: (path) => Stream.make(bytes(files[path] ?? "")) }),
          stdio,
          TerminalCapabilities.layer.pipe(Layer.provide(stdio)),
          Layer.succeed(Terminal.Terminal, terminal),
          Path.layer,
          Input.stdinClaimLayer,
        ),
      ),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(world.env ?? {}))),
    ),
  );

  return { asked, exit, rendered: rendered.join("") };
};

const credentials = (exit: Exit.Exit<readonly Auth.Credential[], unknown>) =>
  Exit.isSuccess(exit)
    ? exit.value.map((credential) => [credential.scheme, Redacted.value(credential.value)])
    : ["failed"];

const failureTag = (exit: Exit.Exit<readonly Auth.Credential[], { readonly _tag: string }>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit))?._tag : undefined;

const tty = { stdinTty: true, stdoutTty: true } as const;

describe("TTY password prompt", () => {
  test("with both streams a TTY and no flag or env, the answer is the credential", async () => {
    const { asked, exit, rendered } = await run({ ...tty, answer: secret }, [["bearerAuth"]]);

    expect(credentials(exit)).toEqual([["bearerAuth", secret]]);
    expect(Exit.isSuccess(exit) && Redacted.isRedacted(exit.value[0]?.value)).toBe(true);
    expect(asked).toBe(1);
    expect(rendered).toContain("bearerAuth");
    expect(rendered).not.toContain(secret);
  });

  test("a flag or the env wins over the prompt", async () => {
    const flag = await run(
      { ...tty, answer: secret, files: { "/token": "from-file" }, given: { bearerAuth: "/token" } },
      [["bearerAuth"]],
    );
    const env = await run({ ...tty, answer: secret, env: { EXAMPLE_BEARER_AUTH: "from-env" } }, [
      ["bearerAuth"],
    ]);

    expect(credentials(flag.exit)).toEqual([["bearerAuth", "from-file"]]);
    expect(flag.asked).toBe(0);
    expect(credentials(env.exit)).toEqual([["bearerAuth", "from-env"]]);
    expect(env.asked).toBe(0);
  });

  test("a configured later alternative is chosen without a prompt", async () => {
    const { asked, exit } = await run({ ...tty, answer: secret, env: { EXAMPLE_API_KEY: "k" } }, [
      ["bearerAuth"],
      ["apiKey"],
    ]);

    expect(credentials(exit)).toEqual([["apiKey", "k"]]);
    expect(asked).toBe(0);
  });

  test("a stdin file flag in the same alternative is read before the prompt", async () => {
    const { asked, exit } = await run(
      { ...tty, answer: secret, given: { apiKey: "-" }, stdin: "k" },
      [["bearerAuth", "apiKey"]],
    );

    expect(failureTag(exit)).toBe("CredentialMissing");
    expect(asked).toBe(0);
  });

  test("off a TTY the prompt is skipped and the credential is missing", async () => {
    const pipe = await run({ answer: secret, stdinTty: false, stdoutTty: true }, [["bearerAuth"]]);
    const redirected = await run({ answer: secret, stdinTty: true, stdoutTty: false }, [
      ["bearerAuth"],
    ]);

    expect(failureTag(pipe.exit)).toBe("CredentialMissing");
    expect(pipe.asked).toBe(0);
    expect(failureTag(redirected.exit)).toBe("CredentialMissing");
    expect(redirected.asked).toBe(0);
  });

  test("with --body-file - reading stdin, no prompt", async () => {
    const { asked, exit } = await run({ ...tty, answer: secret, claimedBy: "body-file" }, [
      ["bearerAuth"],
    ]);

    expect(failureTag(exit)).toBe("CredentialMissing");
    expect(asked).toBe(0);
  });

  test("an empty answer is no credential", async () => {
    const { asked, exit } = await run({ ...tty, answer: "" }, [["bearerAuth"]]);

    expect(failureTag(exit)).toBe("CredentialMissing");
    expect(asked).toBe(1);
  });

  test("a quit prompt interrupts the run", async () => {
    const { exit } = await run({ ...tty, answer: "par", quit: true }, [["bearerAuth"]]);

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  });

  test("no prompt when anonymous access is allowed", async () => {
    const { asked, exit } = await run({ ...tty, answer: secret }, [["bearerAuth"], []]);

    expect(credentials(exit)).toEqual([]);
    expect(asked).toBe(0);
  });
});
