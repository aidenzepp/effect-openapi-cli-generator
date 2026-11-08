import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Console, Effect, Exit } from "effect";
import { Argument, CliOutput, Command, Flag } from "effect/cli";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const golden = nodeFs.readFileSync(
  nodePath.join(root, "tests/fixtures/golden/users-update/expected/help.txt"),
  "utf-8",
);

const canary = "CANARY-SECRET-123";

// Written as the golden fixture's cli/users.ts writes them.
const update = Command.make(
  "update",
  {
    addressCity: Flag.String("address.city").pipe(Flag.optional),
    body: Input.bodyFlag,
    bodyFile: Input.bodyFileFlag,
    id: Argument.String("id").pipe(Argument.withDescription("User id.")),
    ifMatch: Flag.String("if-match").pipe(Flag.optional),
    name: Flag.String("name").pipe(Flag.optional, Flag.withDescription("Display name.")),
    notify: Flag.Boolean("notify").pipe(
      Flag.optional,
      Flag.withDescription("Send a notification email."),
    ),
  },
  () => Effect.void,
).pipe(
  Command.withDescription("Update a user."),
  Command.annotate(Output.Help, {
    arguments: { id: "path id" },
    flags: {
      "address.city": "body /address/city",
      "if-match": "header If-Match",
      name: "body /name",
      notify: "query notify; --no-notify sends false",
    },
    sections: [
      ["REQUEST", "PATCH /users/{id}, body application/json (required), operationId users-update"],
      [
        "AUTH",
        "bearerAuth (http bearer): --bearer-auth-file <path|->, env EXAMPLE_BEARER_AUTH, TTY prompt",
      ],
      [
        "RESPONSES",
        "200 application/json; 404; default application/json. Non-2xx exits 1 (401/403 exit 3)",
      ],
    ],
  }),
);

// An author-owned command: no Output.Help.
const login = Command.make(
  "login",
  {
    port: Flag.Int("port").pipe(Flag.withDescription("Callback port.")),
    token: Flag.String("token").pipe(Flag.optional, Flag.withDescription("Access token.")),
  },
  () => Effect.void,
).pipe(Command.withDescription("Sign in."));

const cli = Command.make("example").pipe(
  Command.withSubcommands([Command.make("users").pipe(Command.withSubcommands([update])), login]),
  Command.withGlobalFlags([Output.Force]),
);

interface Run {
  readonly exit: Exit.Exit<void, unknown>;
  readonly stderr: string;
  readonly stdout: string;
}

const run = (formatter: CliOutput.Formatter, args: readonly string[]): Promise<Run> =>
  Effect.runPromise(
    Effect.suspend(() => {
      const out: string[] = [];
      const err: string[] = [];
      // Object.assign keeps the host console methods; spreading a Console instance drops its prototype.
      // oxlint-disable-next-line prefer-object-spread
      const console: Console.Console = Object.assign({}, globalThis.console, {
        error: (...parts: readonly unknown[]) => {
          err.push(parts.join(" "));
        },
        log: (...parts: readonly unknown[]) => {
          out.push(parts.join(" "));
        },
      });

      return Command.runWith(cli, { version: "0.0.0" })(args).pipe(
        Effect.provide(CliOutput.layer(formatter)),
        Effect.provide(BunServices.layer),
        Effect.provideService(Console.Console, console),
        Effect.exit,
        Effect.map((exit) => ({
          exit,
          stderr: err.map((line) => `${line}\n`).join(""),
          stdout: out.map((line) => `${line}\n`).join(""),
        })),
      );
    }),
  );

const reference = CliOutput.defaultFormatter({ colors: false, globalFlags: "summary" });

describe("Output.formatter", () => {
  test("users update --help equals expected/help.txt byte for byte", async () => {
    const { stdout } = await run(Output.formatter(cli), ["users", "update", "--help"]);

    expect(stdout).toBe(golden);
  });

  test("a command without Output.Help prints what the default formatter prints", async () => {
    const mine = await run(Output.formatter(cli), ["login", "--help"]);
    const theirs = await run(reference, ["login", "--help"]);

    expect(mine.stdout).toContain("Callback port.");
    expect(mine.stdout).toBe(theirs.stdout);
  });

  test("a group without Output.Help prints what the default formatter prints", async () => {
    const mine = await run(Output.formatter(cli), ["users", "--help"]);
    const theirs = await run(reference, ["users", "--help"]);

    expect(mine.stdout).toContain("update");
    expect(mine.stdout).toBe(theirs.stdout);
  });

  test("a canary flag value in a parse error is absent from formatErrors output", async () => {
    const { exit, stderr, stdout } = await run(Output.formatter(cli), ["login", "--port", canary]);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(stderr).toContain("port");
    expect(`${stdout}${stderr}`).not.toContain(canary);
  });
});
