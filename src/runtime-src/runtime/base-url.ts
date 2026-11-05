import { Config, Context, Effect, Layer, Option } from "effect";
import { CliError, Flag, GlobalFlag } from "effect/cli";
import { UsageError } from "../domain/errors.ts";

/**
 * One server variable of the OpenAPI Server Object. `enum` is optional.
 */
export interface ServerVariable {
  readonly default: string;
  readonly enum?: readonly string[];
}

/**
 * One server of the table. `name` is the OpenAPI 3.2 server name.
 */
export interface ServerEntry {
  readonly name?: string;
  readonly url: string;
  readonly variables?: Readonly<Record<string, ServerVariable>>;
}

/**
 * The table the emitted `api/servers.ts` satisfies: the servers, the accepted default (an index,
 * absent when the author accepted none) and the bound origin set.
 */
export interface ServersTable {
  readonly boundOrigins: readonly string[];
  readonly defaultServer?: number;
  readonly servers: readonly ServerEntry[];
}

/**
 * The generated servers table and the environment prefix, provided by `cli/root.ts`.
 */
export class Servers extends Context.Service<
  Servers,
  { readonly table: ServersTable; readonly envPrefix: string }
>()("runtime/Servers") {}

export const layer = (table: ServersTable, envPrefix: string): Layer.Layer<Servers> =>
  Layer.succeed(Servers, { envPrefix, table });

/**
 * Who chose the base: the operator (`--base-url`, `<PREFIX>_BASE_URL`) or the server table.
 */
export type Provenance = "operator" | "server";

/**
 * The chosen base. A server selection carries the server and its variables (defaults overlaid
 * with `--server-variable`); expanding the template is `m1-rt9b`'s work.
 */
export type Selection =
  | { readonly provenance: "operator"; readonly baseUrl: string }
  | {
      readonly provenance: "server";
      readonly server: ServerEntry;
      readonly variables: Readonly<Record<string, string>>;
    };

export interface ServerVariableAssignment {
  readonly name: string;
  readonly value: string;
}

export interface SelectionInput {
  readonly baseUrl: Option.Option<string>;
  readonly server: Option.Option<string>;
  readonly serverVariables: readonly ServerVariableAssignment[];
}

const usage = (flag: string, cause: string): UsageError =>
  new UsageError({ flag, message: `${flag}: ${cause}` });

const authorityOf = (raw: string): string => {
  const start = raw.indexOf("://") + 3;
  const end = raw.slice(start).search(/[/?#]/u);

  return end === -1 ? raw.slice(start) : raw.slice(start, start + end);
};

/**
 * Check an operator-chosen base URL. `label` names the flag or env variable in the error. The
 * error names the cause and never the value.
 */
export const validateBaseUrl = (label: string, raw: string): Effect.Effect<string, UsageError> => {
  if (!URL.canParse(raw)) {
    return Effect.fail(usage(label, "not an absolute URL"));
  }

  const parsed = new URL(raw);
  const { protocol } = parsed;
  if (protocol !== "http:" && protocol !== "https:") {
    return Effect.fail(usage(label, "the scheme must be http or https"));
  }

  if (authorityOf(raw).includes("@") || parsed.username !== "" || parsed.password !== "") {
    return Effect.fail(usage(label, "the URL must not contain userinfo"));
  }

  if (raw.includes("?")) {
    return Effect.fail(usage(label, "the URL must not contain a query"));
  }

  if (raw.includes("#")) {
    return Effect.fail(usage(label, "the URL must not contain a fragment"));
  }

  return Effect.succeed(raw);
};

/**
 * Split `name=value` at the first `=`. A missing `=` or an empty name is malformed.
 */
export const parseServerVariable = (
  raw: string,
): Effect.Effect<ServerVariableAssignment, UsageError> => {
  const at = raw.indexOf("=");

  return at < 1
    ? Effect.fail(usage("--server-variable", "expected name=value"))
    : Effect.succeed({ name: raw.slice(0, at), value: raw.slice(at + 1) });
};

const lookupServer = (table: ServersTable, raw: string): Effect.Effect<ServerEntry, UsageError> => {
  const byName = table.servers.find((entry) => entry.name === raw);
  const byIndex = /^\d+$/u.test(raw) ? table.servers[Number(raw)] : undefined;
  const found = byName ?? byIndex;

  return found === undefined
    ? Effect.fail(usage("--server", "unknown server"))
    : Effect.succeed(found);
};

const expandVariables = (
  server: ServerEntry,
  assignments: readonly ServerVariableAssignment[],
): Effect.Effect<Readonly<Record<string, string>>, UsageError> =>
  Effect.gen(function* expandAll() {
    const declared = server.variables ?? {};
    const values = new Map(
      Object.entries(declared).map(([name, variable]) => [name, variable.default] as const),
    );
    const seen = new Set<string>();
    for (const { name, value } of assignments) {
      const variable = Object.hasOwn(declared, name) ? declared[name] : undefined;
      if (variable === undefined) {
        return yield* usage("--server-variable", "unknown server variable");
      }

      if (seen.has(name)) {
        return yield* usage("--server-variable", "a server variable was given more than once");
      }

      if (variable.enum !== undefined && !variable.enum.includes(value)) {
        return yield* usage("--server-variable", "value outside the variable's allowed values");
      }

      seen.add(name);
      values.set(name, value);
    }

    return Object.fromEntries(values);
  });

/**
 * Choose the base: `--base-url`, then `<PREFIX>_BASE_URL`, then `--server` with
 * `--server-variable`, then the accepted default. With none of them the error names `--base-url`.
 * Table-dependent causes are checked here, not in the flags, because a flag's `mapEffect` cannot
 * read the `Servers` service.
 */
export const select = (input: SelectionInput): Effect.Effect<Selection, UsageError, Servers> =>
  Effect.gen(function* choose() {
    const { table, envPrefix } = yield* Servers;
    if (Option.isSome(input.baseUrl)) {
      const baseUrl = yield* validateBaseUrl("--base-url", input.baseUrl.value);

      return { baseUrl, provenance: "operator" } as const;
    }

    const envName = `${envPrefix}_BASE_URL`;
    const env = yield* Config.option(Config.String(envName)).pipe(
      Effect.mapError(() => usage(envName, "the environment could not be read")),
    );
    if (Option.isSome(env)) {
      const baseUrl = yield* validateBaseUrl(envName, env.value);

      return { baseUrl, provenance: "operator" } as const;
    }

    const server = Option.isSome(input.server)
      ? yield* lookupServer(table, input.server.value)
      : table.servers[table.defaultServer ?? -1];
    if (server === undefined) {
      return yield* usage("--base-url", "no server is accepted as a default; give a base URL");
    }

    const variables = yield* expandVariables(server, input.serverVariables);

    return { provenance: "server", server, variables } as const;
  });

// A flag's mapEffect fails in CliError; the UsageError rides as the cause with its own message.
const asCliError = (error: UsageError): CliError.CliError =>
  new CliError.UserError({ cause: error, userMessage: error.message });

export const baseUrlSetting = GlobalFlag.Setting("base-url")({
  flag: Flag.String("base-url").pipe(
    Flag.withMetavar("url"),
    Flag.withDescription("Base URL of the API; overrides the spec's servers"),
    Flag.mapEffect((raw) => validateBaseUrl("--base-url", raw).pipe(Effect.mapError(asCliError))),
    Flag.optional,
  ),
});

export const serverSetting = GlobalFlag.Setting("server")({
  flag: Flag.String("server").pipe(
    Flag.withMetavar("name|index"),
    Flag.withDescription("Server from the spec to use"),
    Flag.optional,
  ),
});

export const serverVariableSetting = GlobalFlag.Setting("server-variable")({
  flag: Flag.String("server-variable").pipe(
    Flag.withMetavar("name=value"),
    Flag.withDescription("Server variable value; repeatable"),
    Flag.mapEffect((raw) => parseServerVariable(raw).pipe(Effect.mapError(asCliError))),
    Flag.atLeast(0),
  ),
});
