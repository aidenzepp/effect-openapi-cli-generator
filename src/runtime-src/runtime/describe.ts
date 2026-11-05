import { Array as Arr, Console, Context, Option, Order, Schema } from "effect";
import type { Command } from "effect/cli";
import { Flag, GlobalFlag } from "effect/cli";

const Location = Schema.Literals(["body", "cookie", "header", "path", "query"]);

/**
 * The per-flag binding a generated command declares: where the value goes on the wire.
 */
export interface ParameterBinding {
  readonly location: typeof Location.Type;
  readonly pointer: string;
  readonly wireName: string;
}

/**
 * The structural subset of a command's operation binding that `--describe` reads. The generated
 * operation metadata satisfies it and carries more.
 */
export interface CommandBinding {
  readonly operation: {
    readonly method: string;
    readonly origin: { readonly document: string; readonly pointer: string };
    readonly pathTemplate: string;
  };
  readonly parameters: { readonly [flag: string]: ParameterBinding };
}

/**
 * The `Command.annotate` key under which a generated command carries its binding.
 */
export const Binding = Context.Service<CommandBinding>("runtime/describe/Binding");

/**
 * The `--describe` document. Fields are alphabetical, and `describeVersion` only gains fields.
 */
export const Description = Schema.Struct({
  commands: Schema.Array(
    Schema.Struct({
      document: Schema.String,
      flags: Schema.Array(
        Schema.Struct({
          location: Location,
          name: Schema.String,
          pointer: Schema.String,
          wireName: Schema.String,
        }),
      ),
      method: Schema.String,
      path: Schema.Array(Schema.String),
      pathTemplate: Schema.String,
      pointer: Schema.String,
    }),
  ),
  describeVersion: Schema.Literal(1),
});

type Entry = (typeof Description.Type)["commands"][number];

const byName = Order.mapInput(Order.String, (flag: Entry["flags"][number]) => flag.name);

const entryOf = (path: readonly string[], binding: CommandBinding): Entry => ({
  document: binding.operation.origin.document,
  flags: Arr.sort(
    Object.entries(binding.parameters).map(([name, parameter]) => ({
      location: parameter.location,
      name,
      pointer: parameter.pointer,
      wireName: parameter.wireName,
    })),
    byName,
  ),
  method: binding.operation.method,
  path,
  pathTemplate: binding.operation.pathTemplate,
  pointer: binding.operation.origin.pointer,
});

const walk = (command: Command.Command.Any, path: readonly string[]): readonly Entry[] => [
  ...Option.match(Context.getOption(command.annotations, Binding), {
    onNone: () => [],
    onSome: (binding) => [entryOf(path, binding)],
  }),
  ...command.subcommands.flatMap((group) =>
    group.commands.flatMap((child) => walk(child, [...path, child.name])),
  ),
];

/**
 * Describes a command tree: every bound command in tree order, with its flags sorted by name.
 * Paths are relative to the root command, and unbound commands (groups) are not listed.
 */
export const describeTree = (root: Command.Command.Any): typeof Description.Type => ({
  commands: walk(root, []),
  describeVersion: 1,
});

/**
 * `--describe`: prints the live command tree as one `Description` JSON document and stops.
 */
export const describeFlag = GlobalFlag.Action({
  flag: Flag.Boolean("describe").pipe(
    Flag.withDescription("Print the command tree and its operation bindings as JSON"),
    Flag.withDefault(false),
  ),
  run: (_, { command }) =>
    Console.log(JSON.stringify(Schema.encodeSync(Description)(describeTree(command)), null, 2)),
});
