import { Effect, pipe } from "effect";
import { Command } from "effect/cli";

/**
 * The long names of the flags that walk the whole run root (`runtime/describe.ts` `describeFlag`
 * and `effect`'s built-in `--completions`). Any of them in argv loads every group.
 */
export const describeTrigger = "describe";

export const completionsTrigger = "completions";

const triggers = [describeTrigger, completionsTrigger].map((name) => `--${name}`);

/**
 * A top-level group command. `E` and `R` are the error and requirement types the generated
 * `services` layer provides, so a group needing anything else fails to type-check in the table.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Command's name is invariant and its input contravariant; only E and R are checked
export type Group<E, R> = Command.Command<any, any, any, E, R>;

/**
 * The header fields a group's `Command.make` sets: the only fields root help reads of a child.
 */
export interface Header {
  readonly name: string;
  readonly alias?: string;
  readonly description?: string;
  readonly shortDescription?: string;
  readonly unlisted?: boolean;
}

/**
 * One row of the group table in `cli/root.ts`: the group's header and a thunk importing its module.
 */
export interface Entry<E, R> extends Header {
  readonly load: () => Promise<{ readonly group: Group<E, R> }>;
}

const isTrigger = (arg: string) =>
  triggers.some((trigger) => arg === trigger || arg.startsWith(`${trigger}=`));

const loadsAll = (args: readonly string[]) => args.some(isTrigger);

/**
 * Whether argv can select the group: its name or alias equals a whole element, or any element is a
 * whole-tree trigger. A superset of what the parser selects; no global-flag table, no `--` rule.
 */
export const selected = (header: Header, args: readonly string[]): boolean =>
  loadsAll(args) ||
  args.some((arg) => arg === header.name || (header.alias !== undefined && arg === header.alias));

const stub = (header: Header): Group<never, never> =>
  pipe(
    Command.make(header.name),
    (command) => (header.alias === undefined ? command : Command.withAlias(command, header.alias)),
    (command) =>
      header.description === undefined
        ? command
        : Command.withDescription(command, header.description),
    (command) =>
      header.shortDescription === undefined
        ? command
        : Command.withShortDescription(command, header.shortDescription),
    (command) => (header.unlisted === true ? Command.unlisted(command) : command),
  );

/**
 * Builds the root: every table entry in order, the loaded group module for a selected entry and a
 * header-only stub elsewhere, handed to `header`, which places them before the root's other
 * commands and adds its global flags.
 */
export const root = <E, R, C>(
  table: readonly Entry<E, R>[],
  header: (groups: readonly Group<E, R>[]) => C,
  args: readonly string[],
): Effect.Effect<C> =>
  pipe(
    table,
    Effect.forEach((entry) =>
      selected(entry, args)
        ? Effect.promise(() => entry.load()).pipe(Effect.map((module) => module.group))
        : Effect.succeed(stub(entry)),
    ),
    Effect.map(header),
  );
