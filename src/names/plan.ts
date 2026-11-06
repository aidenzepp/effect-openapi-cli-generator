import { Array as Arr, Data, Effect, Option, Order, Result, Schema } from "effect";
import type { AuthorConfig } from "../model/author-config.ts";
import type { Operation, Parameter, SecurityScheme } from "../model/entities.ts";
import { envName, schemeSlug } from "../runtime-src/runtime/auth.ts";
import type { SecurityScheme as RuntimeScheme } from "../runtime-src/runtime/auth.ts";
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
import { escapeToken } from "../model/pointer.ts";

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
 * Where a flag's value goes: a parameter by location and wire name, or a body field by its RFC 6901
 * pointer relative to the body root (`""` for `--body` and `--body-file`), for the listed media.
 * `pointer` is what `--describe` reports: the parameter's source pointer, a body field's declaring
 * property schema (`BodyFlag.schemaPointer`, from the first media alternative that has the flag),
 * or the request body for `--body` and `--body-file`.
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
      readonly kind: BodyFlagKind;
      readonly media: readonly string[];
      readonly pointer: string;
      readonly repeated: boolean;
      readonly wireName: string;
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
 * One generated command; `configKey` is the author-config key that renames it.
 */
export interface PlannedCommand {
  readonly configKey: string;
  readonly flags: readonly PlannedFlag[];
  readonly identifier: SafeIdentifierValue;
  readonly name: string;
  readonly operation: Operation;
  readonly positionals: readonly PlannedPositional[];
}

/**
 * One command group from a tag; `parent` is the parent tag of a 3.2 chain and `namespace` the api
 * namespace alias the group's `cli/` module imports.
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

type OperationOverride = NonNullable<
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

/**
 * The command name before collision checks (design 4.4): the override, else the `operationId` fold
 * with a leading word run equal to the group's words dropped, else `<method>` and the path's
 * literal words with `by-<param>` for each template expression, in template order. The route form
 * applies only without an `operationId`, never when its fold is empty. A drop that would leave
 * nothing is not made.
 */
export const commandName = (
  operation: Operation,
  override: OperationOverride | undefined,
  groupTag: string | undefined,
): Result.Result<Folded<string>, EmptyFold> => {
  if (override?.command !== undefined) {
    return foldKebab(override.command);
  }

  if (operation.operationId === undefined) {
    const route = operation.key.path.replaceAll(templateExpression, " by $<name> ");

    return foldKebab(`${operation.key.method} ${route}`);
  }

  const idWords = words(operation.operationId);
  const group = groupTag === undefined ? [] : words(groupTag).map((word) => word.toLowerCase());
  const leads =
    group.length > 0 &&
    idWords.length > group.length &&
    group.every((word, index) => idWords[index]?.toLowerCase() === word);

  return foldKebab(leads ? idWords.slice(group.length).join(" ") : operation.operationId);
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

const maxRefHops = 64;

const refPrefix = "#/$defs/";

const decodeTyped = Schema.decodeUnknownOption(
  Schema.Struct({
    $ref: Schema.optionalKey(Schema.String),
    type: Schema.optionalKey(Schema.Json),
  }),
);

const unescapeKey = (token: string): string => token.replaceAll("~1", "/").replaceAll("~0", "~");

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
  for (let hop = 0; hop <= maxRefHops; hop += 1) {
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

    if (!ref.startsWith(refPrefix)) {
      return Result.fail(new UnresolvedSchemaRef({ key: current }));
    }

    current = unescapeKey(ref.slice(refPrefix.length));
  }

  return Result.fail(new UnresolvedSchemaRef({ key }));
};

const runtimeScheme = (
  scheme: SecurityScheme,
  env: string | undefined,
): RuntimeScheme | undefined => {
  const { kind } = scheme;
  if (kind.type === "apiKey") {
    return { env, in: kind.in, kind: "apiKey", name: kind.name };
  }

  return kind.type === "http" ? { env, kind: "http", scheme: kind.scheme } : undefined;
};

/**
 * The credential names of a scheme the runtime can send (`apiKey`, `http`): `<scheme>-file` and
 * `<PREFIX>_<SCHEME>` unless `security.<scheme>.env` overrides it (design 6.5), through the
 * runtime's own `schemeSlug` and `envName`. Other kinds have no credential flag in Milestone 1.
 * `slug` is empty when the scheme name folds to nothing; the caller refuses that.
 */
export const credentialNames = (
  config: AuthorConfig,
  envPrefix: string,
  scheme: SecurityScheme,
): Option.Option<{ readonly env: string; readonly flag: string; readonly slug: string }> => {
  const definition = runtimeScheme(scheme, own(config.security, scheme.name)?.env);
  if (definition === undefined) {
    return Option.none();
  }

  const slug = schemeSlug(scheme.name);

  return Option.some({
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
        const stem = `${envPrefix}_${schemeSlug(scheme.name).toUpperCase().replaceAll("-", "_")}`;

        return [`${stem}_CA`, `${stem}_CERT`, `${stem}_KEY`];
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
 * What flag drafting reads: the store's `$defs`, the boolean memo shared across the plan, and the
 * credential flags every command must avoid.
 */
export interface DraftContext {
  readonly booleans: Map<string, boolean>;
  readonly collector: Collector;
  readonly credentialFlags: ReadonlySet<string>;
  readonly defs: Readonly<Record<string, Schema.Json>>;
}

export interface Subject {
  readonly operation: Operation;
  readonly site: OverrideSite;
}

// `pointer` is the parameter or media alternative; `field` is a body flag's RFC 6901 pointer
// relative to the body root.
interface Owner {
  readonly field?: string;
  readonly hint: string;
  readonly kind: "body" | "parameter";
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
      if (isPositional(drafted)) {
        positionals.push(drafted);
        continue;
      }

      flags.push(drafted);

      const owner: Owner = {
        hint: parameterHint(site, keys[0] ?? `${parameter.location}:${parameter.wireName}`),
        kind: "parameter",
        pointer: drafted.pointer,
      };
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

interface Merged {
  readonly flag: BodyFlag;
  readonly media: string[];
  readonly pointer: string;
}

const sameFlag = (left: BodyFlag, right: BodyFlag): boolean =>
  left.pointer === right.pointer && left.kind === right.kind && left.repeated === right.repeated;

const isWholeBody = (kind: BodyFlagKind): boolean => kind === "body" || kind === "body-file";

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

const draftBody = (
  subject: Subject,
  context: DraftContext,
  owners: Owners,
): Effect.Effect<readonly DraftFlag[]> =>
  Effect.gen(function* draft() {
    const { operation, site } = subject;
    const { collector } = context;
    const hint = `${site.configKey}.skip`;
    const merged = new Map<string, Merged>();
    for (const alternative of operation.body?.alternatives ?? []) {
      const { pointer } = alternative.origin;
      const flattened = flattenBody(context.defs, alternative);
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

      for (const flag of flattened.success.flags) {
        const known = merged.get(flag.name);
        if (known === undefined) {
          merged.set(flag.name, { flag, media: [alternative.mediaType], pointer });
        } else if (sameFlag(known.flag, flag)) {
          known.media.push(alternative.mediaType);
        } else {
          addOwner(owners, flag.name, { field: flag.pointer, hint, kind: "body", pointer });
        }
      }
    }

    return [...merged.values()].map(({ flag, media, pointer }): DraftFlag => {
      const boolean = flag.kind === "boolean" && !flag.repeated;
      if (!isWholeBody(flag.kind)) {
        const owner: Owner = { field: flag.pointer, hint, kind: "body", pointer };
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
  });

const parameterFirst = Order.mapInput(Order.Number, (owner: Owner) =>
  owner.kind === "parameter" ? 0 : 1,
);

const checkFlags = (subject: Subject, context: DraftContext, owners: Owners): void => {
  const { operation } = subject;
  for (const [name, list] of owners) {
    const reserved = reservedCliNames.has(name) || context.credentialFlags.has(name);
    const [primary, ...rest] = Arr.sort(list, parameterFirst);
    if (primary === undefined || (rest.length === 0 && !reserved)) {
      continue;
    }

    const isParameter = primary.kind === "parameter";
    const related = [...new Set(rest.map((owner) => owner.pointer))]
      .filter((pointer) => pointer !== primary.pointer)
      .map((pointer) => siteOf(operation, pointer));
    const fields = [
      ...new Set(list.flatMap((owner) => (owner.field === undefined ? [] : [owner.field]))),
    ];
    const named = fields.length === 0 ? "" : ` Body fields: ${fields.join(", ")}.`;
    context.collector.report(
      operation,
      `${isParameter ? "PRM-02" : "RQB-03"}/flag-collision`,
      isParameter ? "Parameter" : "Request body",
      `The flag --${name} collides with another flag or a reserved name.${named}`,
      { hint: primary.hint, pointer: primary.pointer, related },
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
 * a name or a boolean's `no-` negation, and any flag equal to a reserved or credential flag name
 * (design 4.4 first collision row). A property whose name folds to nothing is a notice.
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
