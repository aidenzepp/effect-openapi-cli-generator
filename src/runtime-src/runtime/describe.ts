import { Array as Arr, Console, Context, Effect, Option, Order, Schema } from "effect";
import type { Command } from "effect/cli";
import { Flag, GlobalFlag } from "effect/cli";
import { Servers } from "./base-url.ts";

const Location = Schema.Literals(["body", "cookie", "header", "path", "query", "querystring"]);

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
    readonly media: {
      readonly request: readonly string[];
      readonly responses: { readonly [responseKey: string]: readonly string[] };
    };
    readonly method: string;
    readonly origin: { readonly document: string; readonly pointer: string };
    readonly pathTemplate: string;
    readonly security: readonly (readonly string[])[];
    /**
     * Present only when the operation or its path item overrides the root servers.
     */
    readonly servers?: { readonly servers: readonly { readonly url: string }[] };
  };
  readonly parameters: { readonly [flag: string]: ParameterBinding };
}

/**
 * The `Command.annotate` key under which a generated command carries its binding.
 */
export const Binding = Context.Service<CommandBinding>("openapi-cli/runtime/describe/Binding");

/**
 * The `--describe` document. Fields are alphabetical, and `describeVersion` only gains fields.
 * `requestMedia` and `responses` are the spec's keys as spelled, in order; `security` is the
 * effective requirement's alternatives; `servers` are the effective server URLs (the operation's or
 * path item's override, else the root's from `Servers`, empty when that service is absent).
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
      requestMedia: Schema.Array(Schema.String),
      responses: Schema.Array(Schema.String),
      security: Schema.Array(Schema.Array(Schema.String)),
      servers: Schema.Array(Schema.String),
    }),
  ),
  describeVersion: Schema.Literal(1),
});

type Entry = (typeof Description.Type)["commands"][number];

const byName = Order.mapInput(Order.String, (flag: Entry["flags"][number]) => flag.name);

const entryOf = (
  path: readonly string[],
  binding: CommandBinding,
  rootServers: readonly string[],
): Entry => ({
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
  requestMedia: binding.operation.media.request,
  responses: Object.keys(binding.operation.media.responses),
  security: binding.operation.security,
  servers: binding.operation.servers?.servers.map((server) => server.url) ?? rootServers,
});

const walk = (
  command: Command.Command.Any,
  path: readonly string[],
  rootServers: readonly string[],
): readonly Entry[] => [
  ...Option.match(Context.getOption(command.annotations, Binding), {
    onNone: () => [],
    onSome: (binding) => [entryOf(path, binding, rootServers)],
  }),
  ...command.subcommands.flatMap((group) =>
    group.commands.flatMap((child) => walk(child, [...path, child.name], rootServers)),
  ),
];

/**
 * Describes a command tree: every bound command in tree order, with its flags sorted by name.
 * Paths are relative to the root command, and unbound commands (groups) are not listed.
 * `rootServers` are the root level's server URLs, which commands without an override inherit.
 */
export const describeTree = (
  root: Command.Command.Any,
  rootServers: readonly string[],
): typeof Description.Type => ({
  commands: walk(root, [], rootServers),
  describeVersion: 1,
});

// The root servers from the `Servers` service `main.ts` provides around `Command.run`. An action's
// type admits no requirement, so the service is read optionally; absent, the list is empty.
const rootServerUrls = Effect.serviceOption(Servers).pipe(
  Effect.map(
    Option.match({
      onNone: () => [],
      onSome: ({ table }) => table.servers.map((server) => server.url),
    }),
  ),
);

/**
 * `--describe`: prints the live command tree as one `Description` JSON document and stops.
 */
export const describeFlag = GlobalFlag.Action({
  flag: Flag.Boolean("describe").pipe(
    Flag.withDescription("Print the command tree and its operation bindings as JSON"),
    Flag.withDefault(false),
  ),
  run: (_, { command }) =>
    rootServerUrls.pipe(
      Effect.flatMap((rootServers) =>
        Console.log(
          JSON.stringify(
            Schema.encodeSync(Description)(describeTree(command, rootServers)),
            null,
            2,
          ),
        ),
      ),
    ),
});
