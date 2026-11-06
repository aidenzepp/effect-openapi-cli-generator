import { describe, expect, test } from "bun:test";
import { Context, Effect } from "effect";
import { Command, Completions, GlobalFlag } from "effect/cli";
import type { Flag } from "effect/cli";
import * as Describe from "../../src/runtime-src/runtime/describe.ts";
import * as Groups from "../../src/runtime-src/runtime/groups.ts";

class Provided extends Context.Service<Provided, { readonly value: string }>()(
  "openapi-cli/test/Provided",
) {}

class Missing extends Context.Service<Missing, { readonly value: string }>()(
  "openapi-cli/test/Missing",
) {}

const needs = <S>(service: Context.Key<S, { readonly value: string }>) =>
  Effect.gen(function* handler() {
    yield* service;
  });

const usersGroup = Command.make("users").pipe(
  Command.withSubcommands([Command.make("list", {}, () => needs(Provided))]),
);

const teamsGroup = Command.make("teams").pipe(
  Command.withSubcommands([Command.make("list", {}, () => needs(Provided))]),
);

const billingGroup = Command.make("billing").pipe(
  Command.withSubcommands([Command.make("show", {}, () => needs(Provided))]),
);

const counting = <A>(module: A) => {
  const calls = { count: 0 };
  const load = () => {
    calls.count += 1;

    return Promise.resolve(module);
  };

  return { calls, load };
};

const table = () => {
  const users = counting({ group: usersGroup });
  const teams = counting({ group: teamsGroup });
  const billing = counting({ group: billingGroup });
  const entries: readonly Groups.Entry<never, Provided>[] = [
    { load: users.load, name: "users" },
    {
      alias: "t",
      description: "Teams and their members",
      load: teams.load,
      name: "teams",
      shortDescription: "Teams",
    },
    { load: billing.load, name: "billing", unlisted: true },
  ];

  return { billing: billing.calls, entries, teams: teams.calls, users: users.calls };
};

const untagged = Command.make("ping", {}, () => needs(Provided));

const author = Command.make("hello", {}, () => needs(Provided));

const header = (groups: readonly Groups.Group<never, Provided>[]) =>
  Command.make("cli").pipe(Command.withSubcommands([...groups, untagged, author]));

const selectedNames = (args: readonly string[]) =>
  table()
    .entries.filter((entry) => Groups.selected(entry, args))
    .map((entry) => entry.name);

const flagNames = <A>(flag: Flag.Flag<A>) =>
  Completions.fromCommand(Command.make("probe", { flag })).flags.map((each) => each.name);

const fieldsOf = (command: Command.Command.Any) => ({
  alias: command.alias,
  description: command.description,
  name: command.name,
  shortDescription: command.shortDescription,
  unlisted: command.unlisted,
});

describe("Groups.selected", () => {
  test("a group token first selects that group", () => {
    expect(selectedNames(["users", "list"])).toEqual(["users"]);
  });

  test("a group token after global flags selects that group", () => {
    expect(selectedNames(["--base-url", "x", "users", "list"])).toEqual(["users"]);
  });

  test("a flag value equal to another group's name selects both groups", () => {
    expect(selectedNames(["--output", "users", "teams", "list"])).toEqual(["users", "teams"]);
  });

  test("an alias token selects its group", () => {
    expect(selectedNames(["t", "list"])).toEqual(["teams"]);
  });

  test("a token that only contains a group name selects nothing", () => {
    expect(selectedNames(["--users", "users-list", "--name=users"])).toEqual([]);
  });

  test("--describe in any spelling selects every group", () => {
    const all = ["users", "teams", "billing"];
    expect(selectedNames(["--describe"])).toEqual(all);
    expect(selectedNames(["--describe=true"])).toEqual(all);
    expect(selectedNames(["users", "list", "--describe"])).toEqual(all);
  });

  test("--completions in any spelling selects every group", () => {
    const all = ["users", "teams", "billing"];
    expect(selectedNames(["--completions", "bash"])).toEqual(all);
    expect(selectedNames(["--completions=zsh"])).toEqual(all);
  });

  test("no group token selects no group", () => {
    expect(selectedNames([])).toEqual([]);
    expect(selectedNames(["--help"])).toEqual([]);
    expect(selectedNames(["ping", "--version"])).toEqual([]);
  });

  test("the trigger names are the describe flag and the built-in completions flag", () => {
    expect(flagNames(Describe.describeFlag.flag)).toEqual([Groups.describeTrigger]);
    expect(flagNames(GlobalFlag.Completions.flag)).toEqual([Groups.completionsTrigger]);
  });
});

describe("Groups.root", () => {
  test("keeps table order, splices the loaded group and stubs the rest", async () => {
    const { billing, entries, teams, users } = table();
    const built = await Effect.runPromise(Groups.root(entries, header, ["users", "list"]));
    const children = built.subcommands.flatMap((group) => group.commands);

    expect(built.name).toBe("cli");
    expect(children.map((child) => child.name)).toEqual([
      "users",
      "teams",
      "billing",
      "ping",
      "hello",
    ]);
    expect(children[0]).toBe(usersGroup);
    for (const [index, entry] of entries.entries()) {
      const stub = children[index];
      if (index === 0 || stub === undefined) {
        continue;
      }

      expect(fieldsOf(stub)).toEqual({
        alias: entry.alias,
        description: entry.description,
        name: entry.name,
        shortDescription: entry.shortDescription,
        unlisted: entry.unlisted ?? false,
      });
      expect(stub.subcommands).toEqual([]);
    }
    expect([users.count, teams.count, billing.count]).toEqual([1, 0, 0]);
  });

  test("loads every group when --describe is present", async () => {
    const { billing, entries, teams, users } = table();
    const built = await Effect.runPromise(Groups.root(entries, header, ["--describe"]));
    const children = built.subcommands.flatMap((group) => group.commands);

    expect(children.slice(0, 3)).toEqual([usersGroup, teamsGroup, billingGroup]);
    expect([users.count, teams.count, billing.count]).toEqual([1, 1, 1]);
  });

  test("loads no group when no group is named", async () => {
    const { billing, entries, teams, users } = table();
    const built = await Effect.runPromise(Groups.root(entries, header, ["--version"]));
    const children = built.subcommands.flatMap((group) => group.commands);

    expect(children.map((child) => child.name)).toEqual([
      "users",
      "teams",
      "billing",
      "ping",
      "hello",
    ]);
    expect([users.count, teams.count, billing.count]).toEqual([0, 0, 0]);
  });

  test("an entry whose group needs a service outside its requirement type does not type-check", () => {
    const needsMissing = Command.make("audit").pipe(
      Command.withSubcommands([Command.make("list", {}, () => needs(Missing))]),
    );
    const entry: Groups.Entry<never, Provided> = {
      // @ts-expect-error the group requires Missing, which the entry's requirement type excludes
      load: () => Promise.resolve({ group: needsMissing }),
      name: "audit",
    };
    expect(entry.name).toBe("audit");
  });
});
