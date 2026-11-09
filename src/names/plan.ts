import { Array as Arr, Data, Effect, Option, Order, Predicate, Result, Schema } from "effect";
import type { AuthorConfig } from "../model/author-config.ts";
import type {
  MediaAlternative,
  NamingAlias,
  Operation,
  Parameter,
  SecurityScheme,
} from "../model/entities.ts";
import { envName, schemeSlug } from "../runtime-src/runtime/auth.ts";
import type {
  MutualTlsScheme,
  SecurityScheme as RuntimeScheme,
} from "../runtime-src/runtime/auth.ts";
import { defsKeyOf, maxDefsRefHops } from "../model/defs-ref.ts";
import { flattenBody } from "./flatten.ts";
import type { BodyFlag, BodyFlagKind, SkippedProperty } from "./flatten.ts";
import type {
  EmptyFold,
  FoldNote,
  Folded,
  SafeFileSegmentValue,
  SafeIdentifierValue,
} from "./fold.ts";
import { foldKebab, words } from "./fold.ts";
import { reservedCliNames } from "./reserved.ts";
import { escapeToken, formatPointer, parsePointer } from "../model/pointer.ts";
import type { SpecLine } from "../model/spec-section.ts";

/**
 * A path parameter as a positional argument; `name` is its metavar.
 */
export interface PlannedPositional {
  readonly identifier: SafeIdentifierValue;
  readonly name: string;
  readonly pointer: string;
  readonly wireName: string;
}

/**
 * What a multipart part option flag sets on its part: the part's `Content-Type`, one of `choices`,
 * the media types its Encoding `contentType` lists (design 6.3, ENC-10), or the value of its
 * Encoding header `name` (ENC-03).
 */
export type PartOptionKind =
  | { readonly choices: readonly string[]; readonly kind: "content-type" }
  | { readonly kind: "header"; readonly name: string };

/**
 * A body flag's kind in the plan: a flattened kind, or `secret-file` for a `format: password`
 * string property whose value is read from a file or stdin and never echoed (design 13.1 R4).
 */
export type BodyKind = BodyFlagKind | "secret-file";

/**
 * Where a flag's value goes: a parameter by location and wire name, a body field by its RFC 6901
 * pointer relative to the body root (`""` for `--body` and `--body-file`), for the listed media, or
 * an option of the multipart part at `part` (the part flag's body pointer). `pointer` is what
 * `--describe` reports: the parameter's source pointer, a body field's declaring property schema
 * (`BodyFlag.schemaPointer`, from the first media alternative that has the flag), the request body
 * for `--body` and `--body-file`, or a part option's Encoding Object (a header option's Encoding
 * header).
 */
export type FlagSource =
  | {
      readonly _tag: "Parameter";
      readonly location: Parameter["location"];
      readonly pointer: string;
      readonly wireName: string;
    }
  | {
      readonly _tag: "Body";
      readonly kind: BodyKind;
      readonly media: readonly string[];
      readonly pointer: string;
      readonly repeated: boolean;
      readonly wireName: string;
    }
  | {
      readonly _tag: "PartOption";
      readonly media: readonly string[];
      readonly option: PartOptionKind;
      readonly part: string;
      readonly pointer: string;
    };

/**
 * One visible flag (`name`, without `--`) and its internal identifier. A boolean also owns
 * `no-<name>`.
 */
export interface PlannedFlag {
  readonly boolean: boolean;
  readonly identifier: SafeIdentifierValue;
  readonly name: string;
  readonly source: FlagSource;
}

/**
 * Where a command name came from (design 8.1 `commandNames`, D-NAME4).
 */
export type CommandNameSource = "config" | "operationId" | "route" | "x-fern" | "x-forge";

/**
 * Where a command's group name came from (design 8.1 `commandNames`): the first tag, or `none` for
 * a root command.
 */
export type GroupNameSource = "config" | "none" | "tag" | "x-fern" | "x-forge";

/**
 * The sources of one command's group and command name.
 */
export interface NameSources {
  readonly command: CommandNameSource;
  readonly group: GroupNameSource;
}

/**
 * One generated command; `configKey` is the author-config key that renames the operation's
 * primary command. `alias` is an alias command's index in the author-config `aliases`, when given,
 * else in `x-forge-aliases`; an operation's commands are its primary followed by its aliases, each
 * sending the same request (design 4.4).
 */
export interface PlannedCommand {
  readonly alias?: number;
  readonly configKey: string;
  readonly flags: readonly PlannedFlag[];
  readonly identifier: SafeIdentifierValue;
  readonly name: string;
  readonly operation: Operation;
  readonly positionals: readonly PlannedPositional[];
  readonly sources: NameSources;
}

/**
 * The api namespace alias of `api/root.ts`; no group's planned `namespace` takes it.
 */
export const rootNamespace = "Root";

/**
 * One command group from a tag; `parent` is the parent tag of a 3.2 chain and `namespace` the api
 * namespace alias the group's `cli/` modules import, planned once and unique across api modules.
 */
export interface PlannedGroup {
  readonly commands: readonly PlannedCommand[];
  readonly name: string;
  readonly namespace: SafeIdentifierValue;
  readonly parent?: string;
  readonly segment: SafeFileSegmentValue;
  readonly tag: string;
}

/**
 * A security scheme's credential names: the `--<scheme>-file` flag and the environment variable.
 */
export interface PlannedCredential {
  readonly env: string;
  readonly flag: string;
  readonly scheme: string;
}

/**
 * A `mutualTLS` scheme's client certificate names: the environment variables holding the
 * certificate, key and CA paths. It has no flag (design 6.5, D-SEC3).
 */
export interface PlannedCertificate {
  readonly caEnv: string;
  readonly certEnv: string;
  readonly keyEnv: string;
  readonly scheme: string;
}

/**
 * The names a used scheme's credential is read by: a token scheme's `<scheme>-file` flag and
 * environment name, or a `mutualTls` scheme's certificate environment names and no flag. `slug` is
 * empty when the scheme name folds to nothing.
 */
export type CredentialNames =
  | {
      readonly _tag: "Token";
      readonly env: string;
      readonly flag: string;
      readonly slug: string;
    }
  | {
      readonly _tag: "Certificate";
      readonly caEnv: string;
      readonly certEnv: string;
      readonly keyEnv: string;
      readonly slug: string;
    };

export type OperationOverride = NonNullable<
  NonNullable<NonNullable<AuthorConfig["naming"]>["operations"]>[string]
>;

/**
 * The author-config entry for one operation: `operations[<operationId>]`, or `byPointer[<pointer>]`
 * only when the operation has no `operationId` (design D-AD11). `configKey` is the entry's path
 * whether or not the entry exists, so hints can name it.
 */
export interface OverrideSite {
  readonly configKey: string;
  readonly configPointer: string;
  readonly override: OperationOverride | undefined;
}

// Keys come from untrusted documents: read own members only, never the prototype chain.
const own = <Value>(
  record: Readonly<Record<string, Value>> | undefined,
  key: string,
): Value | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

export const overrideSite = (config: AuthorConfig, operation: Operation): OverrideSite => {
  if (operation.operationId !== undefined) {
    const id = operation.operationId;

    return {
      configKey: `naming.operations[${JSON.stringify(id)}]`,
      configPointer: `/naming/operations/${escapeToken(id)}`,
      override: own(config.naming?.operations, id),
    };
  }

  const { pointer } = operation.origin;

  return {
    configKey: `naming.byPointer[${JSON.stringify(pointer)}]`,
    configPointer: `/naming/byPointer/${escapeToken(pointer)}`,
    override: own(config.naming?.byPointer, pointer),
  };
};

const templateExpression = /\{(?<name>[^{}]+)\}/gu;

export type ConfigAlias = NonNullable<OperationOverride["aliases"]>[number];

/**
 * Who names one planned command: the operation itself, through the author config and its own
 * extensions, one of its `x-forge-aliases` entries, through that entry's keys only, or one of its
 * author-config `aliases`, which replace the extension's.
 */
export type Namer =
  | { readonly _tag: "Primary"; readonly override: OperationOverride | undefined }
  | { readonly _tag: "Alias"; readonly alias: typeof NamingAlias.Type }
  | { readonly _tag: "ConfigAlias"; readonly alias: ConfigAlias };

export interface SourcedName {
  readonly folded: Folded<string>;
  readonly source: CommandNameSource;
}

const sourced = (
  folded: Result.Result<Folded<string>, EmptyFold>,
  source: CommandNameSource,
): Result.Result<SourcedName, EmptyFold> =>
  Result.isFailure(folded)
    ? Result.fail(folded.failure)
    : Result.succeed({ folded: folded.success, source });

// The `operationId` fold: a leading word run equal to the group's words is dropped, unless the
// drop would leave nothing.
const foldOperationId = (
  operationId: string,
  groupLabel: string | undefined,
): Result.Result<Folded<string>, EmptyFold> => {
  const idWords = words(operationId);
  const group = groupLabel === undefined ? [] : words(groupLabel).map((word) => word.toLowerCase());
  const leads =
    group.length > 0 &&
    idWords.length > group.length &&
    group.every((word, index) => idWords[index]?.toLowerCase() === word);

  return foldKebab(leads ? idWords.slice(group.length).join(" ") : operationId);
};

// The name without a naming key: the `operationId` fold, else the route form.
const foldedDefault = (
  operation: Operation,
  groupLabel: string | undefined,
): Result.Result<SourcedName, EmptyFold> => {
  if (operation.operationId === undefined) {
    const route = operation.key.path.replaceAll(templateExpression, " by $<name> ");

    return sourced(foldKebab(`${operation.key.method} ${route}`), "route");
  }

  return sourced(foldOperationId(operation.operationId, groupLabel), "operationId");
};

/**
 * The command name before collision checks (design 4.4), per source: for the primary, the author
 * config, else `x-forge-method-name`, else `x-fern-sdk-method-name`, else the `operationId` fold
 * with the group-word drop, else `<method>` and the path's literal words with `by-<param>` for each
 * template expression, in template order. An alias takes its own Forge, else Fern, method name,
 * else the fold of its own `operationId`, never the operation's. An author-config alias takes its
 * own method, else the operation's `operationId` fold or route form. An extension or config name
 * folds without the drop. The route form applies only without an `operationId`, never when its fold
 * is empty. `groupLabel` is the unfolded name of the command's innermost group.
 */
export const commandName = (
  operation: Operation,
  namer: Namer,
  groupLabel: string | undefined,
): Result.Result<SourcedName, EmptyFold> => {
  if (namer._tag === "Alias") {
    const { alias } = namer;
    const method = alias.forge?.method ?? alias.fern?.method;
    if (method !== undefined) {
      return sourced(foldKebab(method), alias.forge?.method === undefined ? "x-fern" : "x-forge");
    }

    // A usable alias has a method name or its own operationId (m2-nmx1); an empty input refuses.
    return sourced(foldOperationId(alias.operationId ?? "", groupLabel), "operationId");
  }

  if (namer._tag === "ConfigAlias") {
    const { method } = namer.alias;

    return method === undefined
      ? foldedDefault(operation, groupLabel)
      : sourced(foldKebab(method), "config");
  }

  const { override } = namer;
  if (override?.command !== undefined) {
    return sourced(foldKebab(override.command), "config");
  }

  const { naming } = operation;
  if (naming?.forge?.method !== undefined) {
    return sourced(foldKebab(naming.forge.method), "x-forge");
  }

  if (naming?.fern?.method !== undefined) {
    return sourced(foldKebab(naming.fern.method), "x-fern");
  }

  return foldedDefault(operation, groupLabel);
};

/**
 * The path parameter names of a template, in template order.
 */
export const templateNames = (path: string): readonly string[] =>
  Arr.map(Arr.fromIterable(path.matchAll(templateExpression)), (match) => match.groups?.name ?? "");

/**
 * The parameter overrides that name `parameter`: the exact `<in>:<name>` key, and for headers every
 * key equal ignoring case (design 2.2 compares header names case-insensitively).
 */
export const overrideKeysFor = (
  override: OperationOverride | undefined,
  parameter: Parameter,
): readonly string[] => {
  const exact = `${parameter.location}:${parameter.wireName}`;

  return Object.keys(override?.parameters ?? {}).filter((key) =>
    parameter.location === "header" ? key.toLowerCase() === exact.toLowerCase() : key === exact,
  );
};

/**
 * The visible name of a parameter: its override `flag`, else its wire name, through the kebab fold.
 */
export const parameterName = (
  override: OperationOverride | undefined,
  key: string | undefined,
  parameter: Parameter,
): Result.Result<Folded<string>, EmptyFold> => {
  const renamed = key === undefined ? undefined : own(override?.parameters, key)?.flag;

  return foldKebab(renamed ?? parameter.wireName);
};

/**
 * A `$ref` chain in the schema store could not be followed: the target is missing, the form is not
 * `#/$defs/<key>`, or it exceeds 64 hops. Earlier stages refuse such inputs, so this is a defect.
 */
export class UnresolvedSchemaRef extends Data.TaggedError("UnresolvedSchemaRef")<{
  readonly key: string;
}> {}

const decodeTyped = Schema.decodeUnknownOption(
  Schema.Struct({
    $ref: Schema.optionalKey(Schema.String),
    type: Schema.optionalKey(Schema.Json),
  }),
);

/**
 * Whether a stored schema is `type: "boolean"` after its `$ref` chain. Each key is settled once per
 * memo, so total work is bounded by the store size; a chain stops at 64 hops (design 3.3).
 */
export const isBooleanSchema = (
  defs: Readonly<Record<string, Schema.Json>>,
  memo: Map<string, boolean>,
  key: string,
): Result.Result<boolean, UnresolvedSchemaRef> => {
  const chain: string[] = [];
  const settle = (value: boolean): Result.Result<boolean, UnresolvedSchemaRef> => {
    for (const visited of chain) {
      memo.set(visited, value);
    }

    return Result.succeed(value);
  };

  let current = key;
  for (let hop = 0; hop <= maxDefsRefHops; hop += 1) {
    const known = memo.get(current);
    if (known !== undefined) {
      return settle(known);
    }

    chain.push(current);

    const node = Option.flatMap(Option.fromNullishOr(own(defs, current)), decodeTyped);
    if (Option.isNone(node)) {
      return Result.fail(new UnresolvedSchemaRef({ key: current }));
    }

    const { $ref: ref, type } = node.value;
    if (ref === undefined) {
      return settle(type === "boolean");
    }

    const next = defsKeyOf(ref);
    if (next === undefined) {
      return Result.fail(new UnresolvedSchemaRef({ key: current }));
    }

    current = next;
  }

  return Result.fail(new UnresolvedSchemaRef({ key }));
};

const runtimeScheme = (
  scheme: SecurityScheme,
  env: string | undefined,
): Exclude<RuntimeScheme, MutualTlsScheme> | undefined => {
  const { kind } = scheme;
  if (kind.type === "apiKey") {
    return { env, in: kind.in, kind: "apiKey", name: kind.name };
  }

  if (kind.type === "http") {
    return { env, kind: "http", scheme: kind.scheme };
  }

  if (kind.type === "oauth2Token") {
    return { env, kind: "oauth2" };
  }

  return kind.type === "oidcToken" ? { env, kind: "openIdConnect" } : undefined;
};

/**
 * The environment names of a `mutualTls` scheme's client certificate: `<PREFIX>_<SCHEME>_CERT`,
 * `_KEY` and `_CA` (design 4.4). The one derivation: the reserved names and the plan entry both
 * read it, and the runtime reads `Config` by the names the plan emits.
 */
export const certificateEnvNames = (
  envPrefix: string,
  scheme: string,
): Omit<PlannedCertificate, "scheme"> => {
  const stem = `${envPrefix}_${schemeSlug(scheme).toUpperCase().replaceAll("-", "_")}`;

  return { caEnv: `${stem}_CA`, certEnv: `${stem}_CERT`, keyEnv: `${stem}_KEY` };
};

/**
 * The credential names of a used scheme. A scheme the runtime sends as a token (`apiKey`, `http`,
 * `oauth2Token` and `oidcToken`, whose operator-supplied token is passed through; design D-SEC1)
 * gets `<scheme>-file` and `<PREFIX>_<SCHEME>` unless `security.<scheme>.env` overrides it (design
 * 6.5), through the runtime's own `schemeSlug` and `envName`. A `mutualTls` scheme gets its
 * `certificateEnvNames` and no flag. `slug` is empty when the scheme name folds to nothing; the
 * caller refuses that.
 */
export const credentialNames = (
  config: AuthorConfig,
  envPrefix: string,
  scheme: SecurityScheme,
): Option.Option<CredentialNames> => {
  const slug = schemeSlug(scheme.name);
  if (scheme.kind.type === "mutualTls") {
    return Option.some({
      _tag: "Certificate",
      ...certificateEnvNames(envPrefix, scheme.name),
      slug,
    });
  }

  const configured = own(config.security, scheme.name);
  const definition = runtimeScheme(
    scheme,
    configured !== undefined && "env" in configured ? configured.env : undefined,
  );
  if (definition === undefined) {
    return Option.none();
  }

  return Option.some({
    _tag: "Token",
    env: envName(envPrefix, scheme.name, definition),
    flag: `${slug}-file`,
    slug,
  });
};

/**
 * The environment prefix: `envPrefix`, else `binName` in SCREAMING_SNAKE (design D-AD11).
 */
export const envPrefixOf = (config: AuthorConfig): string =>
  config.envPrefix ?? config.binName.toUpperCase().replaceAll("-", "_");

/**
 * The reserved environment names after the prefix (design 4.4), including `<SCHEME>_CERT`,
 * `_KEY` and `_CA` for each mutual TLS scheme.
 */
export const reservedEnvNames = (
  envPrefix: string,
  suffixes: readonly string[],
  schemes: readonly SecurityScheme[],
): ReadonlySet<string> =>
  new Set([
    ...suffixes.map((suffix) => `${envPrefix}_${suffix}`),
    ...schemes
      .filter((scheme) => scheme.kind.type === "mutualTls")
      .flatMap((scheme) => {
        const names = certificateEnvNames(envPrefix, scheme.name);

        return [names.caEnv, names.certEnv, names.keyEnv];
      }),
  ]);

/**
 * The api-module identifier families a command identifier owns (`<cmd>Meta`, `<cmd>Media`,
 * `<cmd>Security`, `<Cmd>Input`).
 */
export const familyOf = (identifier: string): readonly string[] => [
  `${identifier}Meta`,
  `${identifier}Media`,
  `${identifier}Security`,
  `${identifier.slice(0, 1).toUpperCase()}${identifier.slice(1)}Input`,
];

/**
 * The first free `<base><n>` for `n >= 2` (design D-NAME1: fold plus a numeric suffix).
 */
export const suffixed = (base: string, taken: (candidate: string) => boolean): string => {
  let index = 2;
  while (taken(`${base}${index}`)) {
    index += 1;
  }

  return `${base}${index}`;
};

export const byName = Order.mapInput(Order.String, (flag: { readonly name: string }) => flag.name);

export type Scope = "document" | "element" | "operation";

export type Severity = "notice" | "refusal";

/**
 * A document and an RFC 6901 pointer, as a diagnostic's `related` entry.
 */
export interface Site {
  readonly document: string;
  readonly pointer: string;
}

/**
 * A diagnostic before decoding; `anchor` is the specification anchor, absent for config findings.
 */
export interface Finding {
  anchor?: string;
  code: string;
  document: string;
  element: string;
  hint?: string;
  message: string;
  operation?: Operation;
  pointer: string;
  related?: readonly Site[];
  scope: Scope;
  severity: Severity;
}

export interface ReportOptions {
  readonly hint?: string;
  readonly pointer?: string;
  readonly related?: readonly Site[];
  readonly scope?: Scope;
  readonly severity?: Severity;
}

/**
 * Accumulates the plan's findings. A refusal at `operation` scope marks the operation refused.
 */
export interface Collector {
  readonly findings: readonly Finding[];
  readonly folded: (
    operation: Operation,
    row: string,
    element: string,
    pointer: string,
    notes: readonly FoldNote[],
  ) => void;
  readonly refused: ReadonlySet<Operation>;
  readonly report: (
    operation: Operation,
    code: string,
    element: string,
    message: string,
    options?: ReportOptions,
  ) => void;
  readonly unmatched: (pointer: string, message: string) => void;
}

const anchors: ReadonlyMap<string, string> = new Map([
  ["OPR", "operation-object"],
  ["PRM", "parameter-object"],
  ["REF", "reference-object"],
  ["RQB", "request-body-object"],
  ["SSC", "security-scheme-object"],
  ["TAG", "tag-object"],
]);

export const siteOf = (operation: Operation, pointer?: string): Site => ({
  document: operation.origin.document,
  pointer: pointer ?? operation.origin.pointer,
});

/**
 * A collector whose unmatched-override findings are notices, or `document` refusals under
 * `--strict` (design D-AD11, R16).
 */
export const makeCollector = (configDocument: string, strict: boolean): Collector => {
  const findings: Finding[] = [];
  const refused = new Set<Operation>();
  const report: Collector["report"] = (operation, code, element, message, options = {}) => {
    const severity = options.severity ?? "refusal";
    const scope = options.scope ?? "operation";
    if (severity === "refusal" && scope === "operation") {
      refused.add(operation);
    }

    const finding: Finding = {
      code,
      document: operation.origin.document,
      element,
      message,
      operation,
      pointer: options.pointer ?? operation.origin.pointer,
      scope,
      severity,
    };
    const anchor = anchors.get(code.slice(0, 3));
    if (anchor !== undefined) {
      finding.anchor = anchor;
    }

    if (options.hint !== undefined) {
      finding.hint = options.hint;
    }

    if (options.related !== undefined && options.related.length > 0) {
      finding.related = options.related;
    }

    findings.push(finding);
  };

  return {
    findings,
    folded: (operation, row, element, pointer, notes) => {
      if (notes.length > 0) {
        report(operation, `${row}/folded`, element, "The fold added a fixed prefix or suffix.", {
          pointer,
          scope: "element",
          severity: "notice",
        });
      }
    },
    refused,
    report,
    unmatched: (pointer, message) => {
      findings.push({
        code: "CFG-1/unmatched-override",
        document: configDocument,
        element: "Author config",
        message,
        pointer,
        scope: "document",
        severity: strict ? "refusal" : "notice",
      });
    },
  };
};

/**
 * A flag before identifiers are assigned; `pointer` is the parameter or media alternative.
 */
export interface DraftFlag {
  readonly boolean: boolean;
  readonly name: string;
  readonly notes: readonly FoldNote[];
  readonly pointer: string;
  readonly source: FlagSource;
}

export interface DraftPositional {
  readonly name: string;
  readonly notes: readonly FoldNote[];
  readonly pointer: string;
  readonly wireName: string;
}

export interface Draft {
  readonly flags: readonly DraftFlag[];
  readonly positionals: readonly DraftPositional[];
}

/**
 * What flag drafting reads: the store's `$defs`, the boolean memo shared across the plan, the
 * credential flags every command must avoid, and the OpenAPI line, which decides whether a
 * read-only body property is offered (S30-31).
 */
export interface DraftContext {
  readonly booleans: Map<string, boolean>;
  readonly collector: Collector;
  readonly credentialFlags: ReadonlySet<string>;
  readonly defs: Readonly<Record<string, Schema.Json>>;
  readonly line: SpecLine;
}

export interface Subject {
  readonly operation: Operation;
  readonly site: OverrideSite;
}

// `pointer` is the parameter or media alternative; `field` is a body flag's RFC 6901 pointer
// relative to the body root. A positional owns its metavar: `--describe` keys positionals and flags
// in one object, so a metavar equal to a flag name collides (design 4.4, FU:CF).
interface Owner {
  readonly field?: string;
  readonly hint: string;
  // Why no field rename can resolve this owner's collision; the refusal then hints only a skip.
  readonly split?: string;
  readonly kind: "body" | "parameter" | "positional";
  readonly pointer: string;
}

type Owners = Map<string, Owner[]>;

const addOwner = (owners: Owners, name: string, owner: Owner): void => {
  const list = owners.get(name);
  if (list === undefined) {
    owners.set(name, [owner]);
  } else {
    list.push(owner);
  }
};

const parameterHint = (site: OverrideSite, key: string): string =>
  `${site.configKey}.parameters[${JSON.stringify(key)}].flag`;

const draftParameter = (
  subject: Subject,
  context: DraftContext,
  parameter: Parameter,
  keys: readonly string[],
): Effect.Effect<Option.Option<DraftFlag | DraftPositional>> =>
  Effect.gen(function* draft() {
    const { operation, site } = subject;
    const { collector } = context;
    const { pointer } = parameter.origin;
    const hint = parameterHint(site, keys[0] ?? `${parameter.location}:${parameter.wireName}`);
    if (keys.length > 1) {
      collector.report(
        operation,
        "CFG-1/ambiguous-override",
        "Parameter",
        "Several overrides name this header.",
        { hint, pointer },
      );

      return Option.none();
    }

    const name = parameterName(site.override, keys[0], parameter);
    if (Result.isFailure(name)) {
      collector.report(
        operation,
        "PRM-02/empty-name",
        "Parameter",
        "The parameter name folds to nothing.",
        { hint, pointer },
      );

      return Option.none();
    }

    const { name: flag, notes } = name.success;
    if (parameter.location === "path") {
      return Option.some({ name: flag, notes, pointer, wireName: parameter.wireName });
    }

    const boolean =
      parameter.serialization.kind === "style" &&
      (yield* Effect.fromResult(
        isBooleanSchema(context.defs, context.booleans, parameter.schema.key),
      ).pipe(Effect.orDie));
    const source: FlagSource = {
      _tag: "Parameter",
      location: parameter.location,
      pointer,
      wireName: parameter.wireName,
    };

    return Option.some({ boolean, name: flag, notes, pointer, source });
  });

const isPositional = (draft: DraftFlag | DraftPositional): draft is DraftPositional =>
  !("source" in draft);

const draftParameters = (
  subject: Subject,
  context: DraftContext,
  owners: Owners,
): Effect.Effect<Draft> =>
  Effect.gen(function* draft() {
    const { operation, site } = subject;
    const flags: DraftFlag[] = [];
    const positionals: DraftPositional[] = [];
    const usedKeys = new Set<string>();
    for (const parameter of operation.parameters) {
      const keys = overrideKeysFor(site.override, parameter);
      for (const key of keys) {
        usedKeys.add(key);
      }

      const found = yield* draftParameter(subject, context, parameter, keys);
      if (Option.isNone(found)) {
        continue;
      }

      const drafted = found.value;
      const hint = parameterHint(site, keys[0] ?? `${parameter.location}:${parameter.wireName}`);
      if (isPositional(drafted)) {
        // Two positionals sharing a metavar are `orderPositionals`' refusal; only the first owns it.
        if (!positionals.some((known) => known.name === drafted.name)) {
          addOwner(owners, drafted.name, { hint, kind: "positional", pointer: drafted.pointer });
        }

        positionals.push(drafted);
        continue;
      }

      flags.push(drafted);

      const owner: Owner = { hint, kind: "parameter", pointer: drafted.pointer };
      addOwner(owners, drafted.name, owner);
      if (drafted.boolean) {
        addOwner(owners, `no-${drafted.name}`, owner);
      }
    }

    for (const key of Object.keys(site.override?.parameters ?? {})) {
      if (!usedKeys.has(key)) {
        context.collector.unmatched(
          `${site.configPointer}/parameters/${escapeToken(key)}`,
          "The operation has no such parameter.",
        );
      }
    }

    return { flags, positionals };
  });

// A flattened body flag as the plan names it: its kind may be `secret-file`.
interface PlannedBodyFlag extends Omit<BodyFlag, "kind"> {
  readonly kind: BodyKind;
}

interface Merged {
  readonly flag: PlannedBodyFlag;
  readonly media: string[];
  readonly pointer: string;
}

const sameFlag = (left: PlannedBodyFlag, right: PlannedBodyFlag): boolean =>
  left.pointer === right.pointer && left.kind === right.kind && left.repeated === right.repeated;

// `--part` is the whole input of a positional body (HT:B15), so it is never renamed.
const isWholeBody = (kind: BodyKind): boolean =>
  kind === "body" || kind === "body-file" || kind === "part";

const maxSchemaVisits = 10_000;

interface JsonObject {
  readonly [key: string]: Schema.Json;
}

const isJsonObject = (json: Schema.Json | undefined): json is JsonObject =>
  Predicate.isObject(json);

const isJsonArray = (json: Schema.Json | undefined): json is readonly Schema.Json[] =>
  Arr.isArray(json);

// Follows a `$ref` chain into `defs`; a reference outside `#/$defs/`, a missing key or a chain
// past the hop budget ends the search.
const dereference = (
  defs: DraftContext["defs"],
  json: Schema.Json | undefined,
  hops = 0,
): JsonObject | undefined => {
  if (!isJsonObject(json) || hops > maxDefsRefHops) {
    return undefined;
  }

  const { $ref } = json;
  if ($ref === undefined) {
    return json;
  }

  const key = Predicate.isString($ref) ? defsKeyOf($ref) : undefined;

  return key === undefined ? undefined : dereference(defs, own(defs, key), hops + 1);
};

// The schema of member `key` of an object schema, found the way the body walk merged it: through
// `$ref`, own `properties`, then `allOf` members. `budget` counts the nodes a hostile `allOf`
// graph may make the search visit.
const memberSchema = (
  defs: DraftContext["defs"],
  json: Schema.Json | undefined,
  key: string,
  budget: { visits: number },
): Schema.Json | undefined => {
  budget.visits += 1;
  const node = dereference(defs, json);
  if (node === undefined || budget.visits > maxSchemaVisits) {
    return undefined;
  }

  const { allOf, properties } = node;
  const found = isJsonObject(properties) ? own(properties, key) : undefined;
  if (found !== undefined || !isJsonArray(allOf)) {
    return found;
  }

  for (const member of allOf) {
    const inMember = memberSchema(defs, member, key, budget);
    if (inMember !== undefined) {
      return inMember;
    }
  }

  return undefined;
};

const branchesOf = (json: Schema.Json | undefined): readonly Schema.Json[] =>
  isJsonArray(json) ? json : [];

// Whether a flag's own schema carries `format: password` on any node the flattener reads (each node
// of a `$ref` chain with its sibling keywords, each `allOf` member) or in any `anyOf` or `oneOf`
// branch. It never descends into `properties` or `items`. It fails closed: past the hop or visit
// budget the answer is yes, so a secret never falls back to an argv flag (design invariant I4).
const isPassword = (
  defs: DraftContext["defs"],
  json: Schema.Json | undefined,
  budget: { visits: number },
  hops = 0,
): boolean => {
  budget.visits += 1;
  if (hops > maxDefsRefHops || budget.visits > maxSchemaVisits) {
    return true;
  }

  if (!isJsonObject(json)) {
    return false;
  }

  if (json.format === "password") {
    return true;
  }

  const { $ref, allOf, anyOf, oneOf } = json;
  const key = Predicate.isString($ref) ? defsKeyOf($ref) : undefined;
  const target = key === undefined ? undefined : own(defs, key);

  return [target, ...branchesOf(allOf), ...branchesOf(anyOf), ...branchesOf(oneOf)].some((branch) =>
    isPassword(defs, branch, budget, hops + 1),
  );
};

// Whether an array schema's `items` is a password string on any node the flattener reads: each
// node of a `$ref` chain with its sibling keywords, each `allOf` member, and any `anyOf` or `oneOf`
// branch. Like `isPassword`, it fails closed past the hop or visit budget.
const hasPasswordItems = (
  defs: DraftContext["defs"],
  json: Schema.Json | undefined,
  budget: { visits: number },
  hops = 0,
): boolean => {
  budget.visits += 1;
  if (hops > maxDefsRefHops || budget.visits > maxSchemaVisits) {
    return true;
  }

  if (!isJsonObject(json)) {
    return false;
  }

  const { $ref, allOf, anyOf, items, oneOf } = json;
  if (items !== undefined && isPassword(defs, items, budget)) {
    return true;
  }

  const key = Predicate.isString($ref) ? defsKeyOf($ref) : undefined;
  const target = key === undefined ? undefined : own(defs, key);

  return [target, ...branchesOf(allOf), ...branchesOf(anyOf), ...branchesOf(oneOf)].some((branch) =>
    hasPasswordItems(defs, branch, budget, hops + 1),
  );
};

// A `format: password` property of a JSON or form body is read from a file or stdin: its flag is
// --<name>-file of kind `secret-file` instead of --<name> (design 13.1 R4). That holds for a
// string flag and for a JSON flag whose own schema is a composition with a password branch; a
// property inside a JSON-valued flag has no flag of its own and gets none (m3 open question 6). A
// property whose array items are password strings, as a repeated flag or a JSON flag, has no flag
// at all (`undefined`) and is reached through --body-file (design 4.5, FMT-05/password-array). A
// property the walk cannot locate within the budget fails closed.
// Multipart parts are unchanged (m3-pw1m).
const secretFile = (
  defs: DraftContext["defs"],
  alternative: Pick<MediaAlternative, "codec" | "schema">,
  flag: BodyFlag,
): Effect.Effect<PlannedBodyFlag | undefined> =>
  Effect.gen(function* secret() {
    const key = alternative.schema?.key;
    const flattened = alternative.codec === "json" || alternative.codec === "form";
    const candidate = flag.kind === "string" || flag.kind === "json";
    if (!flattened || key === undefined || !candidate) {
      return flag;
    }

    const budget = { visits: 0 };
    let property = own(defs, key);
    for (const token of yield* Effect.orDie(parsePointer(flag.pointer))) {
      property = memberSchema(defs, property, token, budget);
    }

    if (!flag.repeated && (property === undefined || isPassword(defs, property, budget))) {
      return { ...flag, kind: "secret-file", name: `${flag.name}-file` };
    }

    return property === undefined || hasPasswordItems(defs, property, budget) ? undefined : flag;
  });

// A skipped property's notice. A multipart body has no whole-body flag, so a part whose name
// folds to nothing is not reachable at all.
const skippedNotice = (skipped: SkippedProperty, multipart: boolean): string => {
  if (skipped.reason === "UnsupportedPart") {
    return `The multipart part at ${skipped.pointer} has no flag; its shape is not supported.`;
  }

  return multipart
    ? `The multipart part at ${skipped.pointer} has no flag and is not reachable; a multipart body has no --body or --body-file.`
    : `The property at ${skipped.pointer} has no flag; --body and --body-file reach it.`;
};

// A body field flag collision is resolved by renaming the field's flag, or by skipping the operation.
const fieldHint = (site: OverrideSite, field: string): string =>
  `Rename the flag with ${site.configKey}.fields[${JSON.stringify(field)}].flag, or skip the operation with ${site.configKey}.skip.`;

const kindOf = (flag: PlannedBodyFlag): string =>
  flag.repeated ? `repeated ${flag.kind}` : flag.kind;

// One body field that is a different kind of flag in two media alternatives (a plain value in one,
// a file part in another) keeps one name: fields[...].flag renames it in every alternative.
const splitReason = (field: string, left: Merged, right: PlannedBodyFlag, media: string): string =>
  ` The body field ${field} is a ${kindOf(left.flag)} flag in ${left.media.join(", ")} and a ${kindOf(right)} flag in ${media}. A rename cannot separate them: fields[...].flag renames the field in every media type.`;

/**
 * The hint for a collision that only skipping the operation resolves.
 */
export const skipHint = (site: OverrideSite): string =>
  `Skip the operation with ${site.configKey}.skip.`;

// A field flag takes its configured name, verbatim: the config decoder admits only fold-shaped
// names. The config is never inferred.
const renamed = (site: OverrideSite, flag: PlannedBodyFlag): PlannedBodyFlag => {
  const configured = isWholeBody(flag.kind) ? undefined : own(site.override?.fields, flag.pointer);

  return configured === undefined ? flag : { ...flag, name: configured.flag, notes: [] };
};

interface DraftedOption {
  readonly choices: readonly string[];
  readonly media: string[];
  readonly part: string;
  readonly pointer: string;
  readonly rule: string;
}

const sameChoices = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((choice, index) => choice === right[index]);

// The `--<part>-content-type` choice flag of each multipart part whose Encoding `contentType`
// lists several concrete media types (design 6.3, ENC-10): named after the part flag, so renaming
// the part flag renames it, and offered over the listed types with no default. Alternatives that
// list the same types share it; a part listing other types elsewhere collides on the name.
const draftContentTypes = (
  subject: Subject,
  parts: readonly Merged[],
  owners: Owners,
): readonly DraftFlag[] => {
  const { operation, site } = subject;
  const drafted = new Map<string, DraftedOption>();
  for (const { flag, media } of parts) {
    for (const alternative of operation.body?.alternatives ?? []) {
      if (alternative.codec !== "multipart" || !media.includes(alternative.mediaType)) {
        continue;
      }

      const rule = alternative.encoding.find(
        (candidate) =>
          candidate.target.kind === "property" &&
          formatPointer([candidate.target.name]) === flag.pointer,
      );
      const choices = rule?.contentType ?? [];
      if (
        rule === undefined ||
        rule.nested !== undefined ||
        choices.length < 2 ||
        choices.some((choice) => choice.includes("*"))
      ) {
        continue;
      }

      const name = `${flag.name}-content-type`;
      const { pointer } = alternative.origin;
      const known = drafted.get(name);
      if (known === undefined) {
        const hint = fieldHint(site, flag.pointer);
        addOwner(owners, name, { field: flag.pointer, hint, kind: "body", pointer });
        drafted.set(name, {
          choices,
          media: [alternative.mediaType],
          part: flag.pointer,
          pointer,
          rule: rule.origin.pointer,
        });
      } else if (known.part === flag.pointer && sameChoices(known.choices, choices)) {
        known.media.push(alternative.mediaType);
      } else {
        const hint = fieldHint(site, flag.pointer);
        addOwner(owners, name, { field: flag.pointer, hint, kind: "body", pointer });
      }
    }
  }

  return [...drafted].map(([name, option]): DraftFlag => ({
    boolean: false,
    name,
    notes: [],
    pointer: option.pointer,
    source: {
      _tag: "PartOption",
      media: option.media,
      option: { choices: option.choices, kind: "content-type" },
      part: option.part,
      pointer: option.rule,
    },
  }));
};

interface DraftedHeader {
  readonly boolean: boolean;
  readonly header: string;
  readonly media: string[];
  readonly part: string;
  readonly pointer: string;
  readonly rule: string;
}

// A part header flag collision: the part flag's rename renames it. The config key for the Encoding
// header itself is not settled yet, so the hint names the header's pointer.
const headerHint = (site: OverrideSite, part: string, header: string): string =>
  `Rename the part flag with ${site.configKey}.fields[${JSON.stringify(part)}].flag (no config key renames the Encoding header at ${header} yet), or skip the operation with ${site.configKey}.skip.`;

// One `--<part>-<header>` flag per declared header of each multipart part's Encoding rule (design
// 6.3, ENC-03): named after the part flag and the header name folded, typed as a header parameter
// is, so a boolean header is negatable. Alternatives that declare the same header on the same part
// share it; any other owner of the name collides.
const draftPartHeaders = (
  subject: Subject,
  context: DraftContext,
  parts: readonly Merged[],
  owners: Owners,
): Effect.Effect<readonly DraftFlag[]> =>
  Effect.gen(function* draft() {
    const { operation, site } = subject;
    const drafted = new Map<string, DraftedHeader>();
    for (const { flag, media } of parts) {
      for (const alternative of operation.body?.alternatives ?? []) {
        if (alternative.codec !== "multipart" || !media.includes(alternative.mediaType)) {
          continue;
        }

        const rule = alternative.encoding.find(
          (candidate) =>
            candidate.target.kind === "property" &&
            formatPointer([candidate.target.name]) === flag.pointer,
        );
        for (const header of rule === undefined || rule.nested !== undefined ? [] : rule.headers) {
          const folded = foldKebab(header.name);
          if (Result.isFailure(folded)) {
            continue;
          }

          const name = `${flag.name}-${folded.success.name}`;
          const at = `${rule?.origin.pointer ?? ""}/headers/${escapeToken(header.name)}`;
          const { pointer } = alternative.origin;
          const owner: Owner = {
            field: flag.pointer,
            hint: headerHint(site, flag.pointer, at),
            kind: "body",
            pointer,
          };
          const known = drafted.get(name);
          if (known !== undefined && known.part === flag.pointer && known.header === header.name) {
            known.media.push(alternative.mediaType);
            continue;
          }

          addOwner(owners, name, owner);
          if (known !== undefined) {
            continue;
          }

          const boolean =
            header.serialization.kind === "style" &&
            !header.serialization.objectValued &&
            (yield* Effect.fromResult(
              isBooleanSchema(context.defs, context.booleans, header.schema.key),
            ).pipe(Effect.orDie));
          if (boolean) {
            addOwner(owners, `no-${name}`, owner);
          }

          drafted.set(name, {
            boolean,
            header: header.name,
            media: [alternative.mediaType],
            part: flag.pointer,
            pointer,
            rule: at,
          });
        }
      }
    }

    return [...drafted].map(([name, option]): DraftFlag => ({
      boolean: option.boolean,
      name,
      notes: [],
      pointer: option.pointer,
      source: {
        _tag: "PartOption",
        media: option.media,
        option: { kind: "header", name: option.header },
        part: option.part,
        pointer: option.rule,
      },
    }));
  });

const draftBody = (
  subject: Subject,
  context: DraftContext,
  owners: Owners,
): Effect.Effect<readonly DraftFlag[]> =>
  Effect.gen(function* draft() {
    const { operation, site } = subject;
    const { collector } = context;
    const merged = new Map<string, Merged>();
    const fields = new Set<string>();
    const passwordArrays = new Set<string>();
    let flattenedAll = true;
    for (const alternative of operation.body?.alternatives ?? []) {
      const { pointer } = alternative.origin;
      const flattened = flattenBody(context.defs, alternative, context.line);
      if (Result.isFailure(flattened)) {
        if (flattened.failure._tag === "UnresolvedBodyRef") {
          return yield* Effect.die(flattened.failure);
        }

        collector.report(
          operation,
          "REF-18/node-budget",
          "Request body",
          "The body schema exceeds the node budget.",
          { pointer },
        );
        flattenedAll = false;
        continue;
      }

      for (const skipped of flattened.success.skipped) {
        collector.report(
          operation,
          "RQB-03/unnamed-property",
          "Request body",
          skippedNotice(skipped, alternative.codec === "multipart"),
          { pointer, scope: "element", severity: "notice" },
        );
      }

      for (const found of flattened.success.flags) {
        const secret = yield* secretFile(context.defs, alternative, found);
        if (secret === undefined) {
          if (!passwordArrays.has(found.schemaPointer)) {
            passwordArrays.add(found.schemaPointer);
            collector.report(
              operation,
              "FMT-05/password-array",
              "Request body",
              `The property at ${found.pointer} is an array of password strings and has no flag.`,
              {
                hint: "Send it in a --body-file document, which keeps the values out of argv.",
                pointer: found.schemaPointer,
                scope: "element",
              },
            );
          }

          continue;
        }

        const flag = renamed(site, secret);
        fields.add(flag.pointer);

        const known = merged.get(flag.name);
        if (known === undefined) {
          merged.set(flag.name, { flag, media: [alternative.mediaType], pointer });
        } else if (sameFlag(known.flag, flag)) {
          known.media.push(alternative.mediaType);
        } else if (known.flag.pointer === flag.pointer) {
          const split = splitReason(flag.pointer, known, flag, alternative.mediaType);
          const hint = skipHint(site);
          addOwner(owners, flag.name, { field: flag.pointer, hint, kind: "body", pointer, split });
        } else {
          const hint = fieldHint(site, flag.pointer);
          addOwner(owners, flag.name, { field: flag.pointer, hint, kind: "body", pointer });
        }
      }
    }

    // A refused alternative's fields are unknown, so its operation's keys are not judged.
    for (const field of flattenedAll ? Object.keys(site.override?.fields ?? {}) : []) {
      if (!fields.has(field)) {
        collector.unmatched(
          `${site.configPointer}/fields/${escapeToken(field)}`,
          "The operation's request body has no field flag at this pointer.",
        );
      }
    }

    const options = draftContentTypes(subject, [...merged.values()], owners);
    const headers = yield* draftPartHeaders(subject, context, [...merged.values()], owners);
    const fieldFlags = [...merged.values()].map(({ flag, media, pointer }): DraftFlag => {
      const boolean = flag.kind === "boolean" && !flag.repeated;
      // `--part` is no reserved name, so a field or parameter flag of that name collides with it
      // here rather than shadowing it; the flag cannot be renamed, so only a skip resolves it.
      if (flag.kind === "part") {
        addOwner(owners, flag.name, { hint: skipHint(site), kind: "body", pointer });
      }

      if (!isWholeBody(flag.kind)) {
        const owner: Owner = {
          field: flag.pointer,
          hint: fieldHint(site, flag.pointer),
          kind: "body",
          pointer,
        };
        addOwner(owners, flag.name, owner);
        if (boolean) {
          addOwner(owners, `no-${flag.name}`, owner);
        }
      }

      const source: FlagSource = {
        _tag: "Body",
        kind: flag.kind,
        media,
        pointer: isWholeBody(flag.kind)
          ? (operation.body?.origin.pointer ?? pointer)
          : flag.schemaPointer,
        repeated: flag.repeated,
        wireName: flag.pointer,
      };

      return { boolean, name: flag.name, notes: flag.notes, pointer, source };
    });

    return [...fieldFlags, ...options, ...headers];
  });

const ownerRank: Record<Owner["kind"], number> = { body: 2, parameter: 1, positional: 0 };

const positionalFirst = Order.mapInput(Order.Number, (owner: Owner) => ownerRank[owner.kind]);

const checkFlags = (subject: Subject, context: DraftContext, owners: Owners): void => {
  const { operation } = subject;
  for (const [name, list] of owners) {
    // Reserved and credential names are flags; a positional alone may use one as its metavar.
    const reserved =
      list.some((owner) => owner.kind !== "positional") &&
      (reservedCliNames.has(name) || context.credentialFlags.has(name));
    const [primary, ...rest] = Arr.sort(list, positionalFirst);
    if (primary === undefined || (rest.length === 0 && !reserved)) {
      continue;
    }

    const isParameter = primary.kind !== "body";
    const summary =
      primary.kind === "positional"
        ? `The positional ${name} collides with the flag --${name}.`
        : `The flag --${name} collides with another flag or a reserved name.`;
    const related = [...new Set(rest.map((owner) => owner.pointer))]
      .filter((pointer) => pointer !== primary.pointer)
      .map((pointer) => siteOf(operation, pointer));
    const fields = [
      ...new Set(list.flatMap((owner) => (owner.field === undefined ? [] : [owner.field]))),
    ];
    const named = fields.length === 0 ? "" : ` Body fields: ${fields.join(", ")}.`;
    const split = list.find((owner) => owner.split !== undefined);
    context.collector.report(
      operation,
      `${isParameter ? "PRM-02" : "RQB-03"}/flag-collision`,
      isParameter ? "Parameter" : "Request body",
      `${summary}${named}${split?.split ?? ""}`,
      { hint: (split ?? primary).hint, pointer: primary.pointer, related },
    );
  }
};

const orderPositionals = (
  subject: Subject,
  context: DraftContext,
  positionals: readonly DraftPositional[],
): readonly DraftPositional[] => {
  const { operation, site } = subject;
  const order = templateNames(operation.key.path);
  const rank = (positional: DraftPositional): number => {
    const index = order.indexOf(positional.wireName);

    return index === -1 ? order.length : index;
  };
  const sorted = Arr.sort(positionals, Order.mapInput(Order.Number, rank));
  const seen = new Map<string, DraftPositional>();
  for (const positional of sorted) {
    const first = seen.get(positional.name);
    if (first === undefined) {
      seen.set(positional.name, positional);
      continue;
    }

    context.collector.report(
      operation,
      "PRM-02/flag-collision",
      "Parameter",
      `The positional ${positional.name} collides.`,
      {
        hint: parameterHint(site, `path:${positional.wireName}`),
        pointer: positional.pointer,
        related: [siteOf(operation, first.pointer)],
      },
    );
  }

  return sorted;
};

/**
 * Drafts one operation's positionals (template order) and flags (parameters, then every media
 * alternative's body flags merged by name), refusing at `operation` scope any two flags that share
 * a name or a boolean's `no-` negation, any flag equal to a reserved or credential flag name
 * (design 4.4 first collision row), and any positional whose metavar equals a flag name. A property
 * whose name folds to nothing is a notice.
 */
export const draftFlags = (subject: Subject, context: DraftContext): Effect.Effect<Draft> =>
  Effect.gen(function* draft() {
    const owners: Owners = new Map();
    const parameters = yield* draftParameters(subject, context, owners);
    const body = yield* draftBody(subject, context, owners);
    checkFlags(subject, context, owners);

    return {
      flags: Arr.sort([...parameters.flags, ...body], byName),
      positionals: orderPositionals(subject, context, parameters.positionals),
    };
  });

export const isWholeBodyFlag = (flag: DraftFlag): boolean =>
  flag.source._tag === "Body" && isWholeBody(flag.source.kind);
