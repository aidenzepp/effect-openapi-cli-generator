import { Array as Arr, Effect, Option, Order, Result, Schema } from "effect";
import type { AuthorConfig } from "../model/author-config.ts";
import type { DocumentUri } from "../model/brands.ts";
import { Diagnostic, sortDiagnostics } from "../model/diagnostic.ts";
import type { Api, Operation, SecurityScheme } from "../model/entities.ts";
import { SafeIdentifier, foldFileSegment, foldIdentifier, foldKebab } from "./fold.ts";
import type { FoldNote, SafeFileSegmentValue, SafeIdentifierValue } from "./fold.ts";
import {
  commandName,
  credentialNames,
  draftFlags,
  envPrefixOf,
  familyOf,
  isWholeBodyFlag,
  makeCollector,
  overrideSite,
  reservedEnvNames,
  siteOf,
  suffixed,
} from "./plan.ts";
import type {
  Collector,
  Draft,
  DraftContext,
  DraftFlag,
  Finding,
  OverrideSite,
  PlannedCommand,
  PlannedCredential,
  PlannedGroup,
} from "./plan.ts";
import { reservedCliNames, reservedEnvSuffixes } from "./reserved.ts";

export type {
  FlagSource,
  PlannedCommand,
  PlannedCredential,
  PlannedFlag,
  PlannedGroup,
  PlannedPositional,
} from "./plan.ts";

/**
 * What the plan reads besides the `Api`. `tagsOf` returns an operation's tags in document order:
 * the model's `Operation` does not carry them yet, so the caller supplies them.
 */
export interface PlanOptions {
  readonly config: AuthorConfig;
  readonly configDocument: typeof DocumentUri.Type;
  readonly strict: boolean;
  readonly tagsOf: (operation: Operation) => readonly string[];
}

/**
 * The name plan: untagged commands at the root, groups in first-use order (parents before
 * children), the credential names of every scheme the planned operations use, and the plan's
 * refusals and notices in diagnostic order. A refused operation is in no group.
 */
export interface NamePlan {
  readonly credentials: readonly PlannedCredential[];
  readonly diagnostics: readonly Diagnostic[];
  readonly groups: readonly PlannedGroup[];
  readonly root: readonly PlannedCommand[];
}

interface GroupNode {
  readonly name: string;
  readonly notes: readonly FoldNote[];
  readonly parent: string | undefined;
  readonly segment: SafeFileSegmentValue;
  readonly tag: string;
}

type ChainError =
  | "TAG-02/empty-name"
  | "TAG-02/unsafe-segment"
  | "TAG-06/parent-cycle"
  | "TAG-06/unknown-parent";

interface Candidate {
  readonly chain: readonly GroupNode[];
  readonly container: string;
  readonly operation: Operation;
  readonly site: OverrideSite;
  readonly tagPointer: string;
}

interface Named extends Candidate {
  readonly name: string;
  readonly notes: readonly FoldNote[];
}

interface CredentialNames {
  readonly env: string;
  readonly flag: string;
  readonly slug: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const root = "";

const specVersion = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.1" } as const;

const fixedNamespaces: ReadonlySet<string> = new Set([
  "Argument",
  "Command",
  "Describe",
  "Effect",
  "Flag",
  "Input",
  "Negotiate",
  "Option",
  "Output",
  "Serialize",
]);

const fixedFlagIdentifiers: ReadonlySet<string> = new Set([
  "accept",
  "body",
  "bodyFile",
  "contentType",
]);

const decodeDefs = Schema.decodeUnknownOption(
  Schema.Struct({ $defs: Schema.Record(Schema.String, Schema.Json) }),
);

const escapeToken = (token: string): string => token.replaceAll("~", "~0").replaceAll("/", "~1");

const toIdentifier = (value: string): SafeIdentifierValue =>
  Schema.decodeSync(SafeIdentifier)(value);

// Every input here is a non-empty kebab name, so the fold cannot be empty.
const identifierOf = (name: string, casing: "camel" | "pascal") =>
  Result.getOrThrow(foldIdentifier(name, casing));

const operationOf = (operation: Operation) =>
  operation.operationId === undefined
    ? { method: operation.key.method, path: operation.key.path }
    : {
        method: operation.key.method,
        operationId: operation.operationId,
        path: operation.key.path,
      };

interface DiagnosticFields {
  code: string;
  document: string;
  element: string;
  hint?: string;
  message: string;
  openapi: string;
  operation?: ReturnType<typeof operationOf>;
  pointer: string;
  related?: Finding["related"];
  row: string;
  scope: Finding["scope"];
  severity: Finding["severity"];
  specSection: string;
}

const toDiagnostic = (api: Api, finding: Finding): Effect.Effect<Diagnostic> => {
  const { anchor } = finding;
  const fields: DiagnosticFields = {
    code: finding.code,
    document: finding.document,
    element: finding.element,
    message: finding.message,
    openapi: anchor === undefined ? "" : api.openapi,
    pointer: finding.pointer,
    row: finding.code.slice(0, finding.code.indexOf("/")),
    scope: finding.scope,
    severity: finding.severity,
    specSection:
      anchor === undefined
        ? finding.document
        : `https://spec.openapis.org/oas/v${specVersion[api.line]}.html#${anchor}`,
  };
  if (finding.hint !== undefined) {
    fields.hint = finding.hint;
  }

  if (finding.operation !== undefined) {
    fields.operation = operationOf(finding.operation);
  }

  if (finding.related !== undefined) {
    fields.related = finding.related;
  }

  return Schema.decodeUnknownEffect(Diagnostic)(fields).pipe(Effect.orDie);
};

// Author-config entries: each operation's site, and every entry that names nothing (R16).
const matchOverrides = (
  api: Api,
  config: AuthorConfig,
  collector: Collector,
): ReadonlyMap<Operation, OverrideSite> => {
  const sites = new Map(
    api.operations.map((operation) => [operation, overrideSite(config, operation)]),
  );
  const used = new Set(
    [...sites.values()].flatMap((site) =>
      site.override === undefined ? [] : [site.configPointer],
    ),
  );
  const entries = [
    ...Object.keys(config.naming?.operations ?? {}).map((id) => ({
      message: "No operation has this operationId.",
      pointer: `/naming/operations/${escapeToken(id)}`,
    })),
    ...Object.keys(config.naming?.byPointer ?? {}).map((key) => ({
      message: "No operation without an operationId is at this pointer.",
      pointer: `/naming/byPointer/${escapeToken(key)}`,
    })),
  ];
  for (const { message, pointer } of entries) {
    if (!used.has(pointer)) {
      collector.unmatched(pointer, message);
    }
  }

  const schemes = new Set(api.securitySchemes.map((scheme) => scheme.name));
  for (const name of Object.keys(config.security ?? {})) {
    if (!schemes.has(name)) {
      collector.unmatched(`/security/${escapeToken(name)}`, "No security scheme has this name.");
    }
  }

  return sites;
};

const groupNode = (
  tag: string,
  parent: string | undefined,
): Result.Result<GroupNode, ChainError> => {
  const name = foldKebab(tag);
  if (Result.isFailure(name)) {
    return Result.fail("TAG-02/empty-name");
  }

  const segment = foldFileSegment(tag);
  if (Result.isFailure(segment)) {
    return Result.fail(
      segment.failure._tag === "EmptyFold" ? "TAG-02/empty-name" : "TAG-02/unsafe-segment",
    );
  }

  return Result.succeed({
    name: name.success.name,
    notes: name.success.notes,
    parent,
    segment: segment.success,
    tag,
  });
};

/**
 * The group chain of a tag, root first, following 3.2 `parent` links. A parent that is not
 * declared, or a cycle, is refused (OpenAPI 3.2 tag `parent`: MUST exist, MUST NOT be circular).
 */
const makeChains = (api: Api) => {
  const declared = new Map(api.tags.map((tag) => [tag.name, tag.parent]));
  const nodes = new Map<string, Result.Result<GroupNode, ChainError>>();
  const nodeOf = (tag: string): Result.Result<GroupNode, ChainError> => {
    const node = nodes.get(tag) ?? groupNode(tag, declared.get(tag));
    nodes.set(tag, node);

    return node;
  };

  return (tag: string): Result.Result<readonly GroupNode[], ChainError> => {
    const chain: GroupNode[] = [];
    let current: string | undefined = tag;
    while (current !== undefined) {
      const node = nodeOf(current);
      if (Result.isFailure(node)) {
        return Result.fail(node.failure);
      }

      const { parent } = node.success;
      if (parent !== undefined && !declared.has(parent)) {
        return Result.fail("TAG-06/unknown-parent");
      }

      if (chain.includes(node.success)) {
        return Result.fail("TAG-06/parent-cycle");
      }

      chain.unshift(node.success);
      current = parent;
    }

    return Result.succeed(chain);
  };
};

const groupOperations = (
  api: Api,
  options: PlanOptions,
  sites: ReadonlyMap<Operation, OverrideSite>,
  collector: Collector,
): readonly Candidate[] => {
  const chainOf = makeChains(api);
  const candidates: Candidate[] = [];
  for (const operation of api.operations) {
    const site = sites.get(operation) ?? overrideSite(options.config, operation);
    const { override } = site;
    if (override?.skip === true) {
      collector.report(operation, "OPR-06/skipped", "Operation", "The author config skips it.", {
        severity: "notice",
      });
      continue;
    }

    const tag = override?.group ?? options.tagsOf(operation)[0];
    const tagPointer =
      override?.group === undefined
        ? `${operation.origin.pointer}/tags/0`
        : operation.origin.pointer;
    const chain = tag === undefined ? Result.succeed([]) : chainOf(tag);
    if (Result.isFailure(chain)) {
      collector.report(operation, chain.failure, "Tag", "The operation's group cannot be named.", {
        hint: `${site.configKey}.group`,
        pointer: tagPointer,
      });
      continue;
    }

    candidates.push({ chain: chain.success, container: tag ?? root, operation, site, tagPointer });
  }

  return candidates;
};

const groupNodesOf = (candidates: readonly Candidate[]): readonly GroupNode[] =>
  Arr.dedupe(candidates.flatMap((candidate) => candidate.chain));

const firstSite = (candidates: readonly Candidate[], tag: string) => {
  const first = candidates.find((candidate) => candidate.chain.some((node) => node.tag === tag));

  return first === undefined ? [] : [siteOf(first.operation, first.tagPointer)];
};

// Group names: two tags folding to one name or file segment, and reserved names.
const checkGroups = (
  candidates: readonly Candidate[],
  authorCommands: ReadonlySet<string>,
  collector: Collector,
): void => {
  const groups = groupNodesOf(candidates);
  const reserved = (node: GroupNode): boolean =>
    reservedCliNames.has(node.name) || (node.parent === undefined && authorCommands.has(node.name));
  for (const candidate of candidates) {
    const { operation, site, tagPointer } = candidate;
    const hint = `${site.configKey}.group`;
    for (const node of candidate.chain) {
      const others = groups.filter((other) => other.segment === node.segment && other !== node);
      if (others.length > 0) {
        collector.report(
          operation,
          "TAG-02/segment-collision",
          "Tag",
          "Two groups fold to one name.",
          {
            hint,
            pointer: tagPointer,
            related: others.flatMap((other) => firstSite(candidates, other.tag)),
          },
        );
      }

      if (reserved(node)) {
        collector.report(operation, "TAG-02/reserved-name", "Tag", "The group name is reserved.", {
          hint,
          pointer: tagPointer,
        });
      }
    }
  }
};

const nameCommand = (
  candidate: Candidate,
  authorCommands: ReadonlySet<string>,
  collector: Collector,
): Named | undefined => {
  const { operation, site } = candidate;
  const hint = `${site.configKey}.command`;
  const name = commandName(operation, site.override, candidate.chain.at(-1)?.tag);
  if (Result.isFailure(name)) {
    collector.report(operation, "OPR-06/empty-name", "Operation", "The name folds to nothing.", {
      hint,
    });

    return undefined;
  }

  const { name: command, notes } = name.success;
  const atRoot = candidate.container === root;
  if (reservedCliNames.has(command) || (atRoot && authorCommands.has(command))) {
    collector.report(operation, "OPR-06/reserved-name", "Operation", "The name is reserved.", {
      hint,
    });
  }

  return { ...candidate, name: command, notes };
};

// Command names: two commands folding equal in one group, and a command equal to a sibling group.
const nameCommands = (
  candidates: readonly Candidate[],
  authorCommands: ReadonlySet<string>,
  collector: Collector,
): readonly Named[] => {
  const named = candidates.flatMap((candidate) => {
    const entry = nameCommand(candidate, authorCommands, collector);

    return entry === undefined ? [] : [entry];
  });
  const groups = groupNodesOf(candidates);
  for (const entry of named) {
    const hint = `${entry.site.configKey}.command`;
    const twins = named.filter(
      (other) =>
        other !== entry && other.container === entry.container && other.name === entry.name,
    );
    if (twins.length > 0) {
      collector.report(
        entry.operation,
        "OPR-06/command-collision",
        "Operation",
        "Two commands in one group fold to one name.",
        {
          hint,
          related: twins.map((twin) => siteOf(twin.operation)),
        },
      );
    }

    const parent = entry.container === root ? undefined : entry.container;
    const sibling = groups.find((node) => node.parent === parent && node.name === entry.name);
    if (sibling !== undefined) {
      collector.report(
        entry.operation,
        "OPR-06/group-collision",
        "Operation",
        "The command name equals a sibling group's name.",
        {
          hint,
          related: firstSite(candidates, sibling.tag),
        },
      );
    }
  }

  return named;
};

interface CredentialPlan {
  readonly flags: ReadonlySet<string>;
  readonly names: ReadonlyMap<string, CredentialNames>;
  readonly usesOf: (operation: Operation) => readonly SecurityScheme[];
}

const usesOfApi =
  (api: Api) =>
  (operation: Operation): readonly SecurityScheme[] => {
    const names = Arr.dedupe(
      operation.security.alternatives.flatMap((alternative) =>
        alternative.uses.map((use) => use.scheme),
      ),
    );

    return api.securitySchemes.filter((scheme) => names.includes(scheme.name));
  };

const schemeSite = (scheme: SecurityScheme) => ({
  document: scheme.origin.document,
  pointer: scheme.origin.pointer,
});

// Credential names: `<scheme>-file` and `<PREFIX>_<SCHEME>` distinct across schemes and reserved names.
const planCredentials = (
  api: Api,
  config: AuthorConfig,
  named: readonly Named[],
  collector: Collector,
): CredentialPlan => {
  const usesOf = usesOfApi(api);
  const envPrefix = envPrefixOf(config);
  const reservedEnv = reservedEnvNames(envPrefix, reservedEnvSuffixes, api.securitySchemes);
  const names = new Map<string, CredentialNames>();
  for (const scheme of named.flatMap((entry) => usesOf(entry.operation))) {
    const credential = credentialNames(config, envPrefix, scheme);
    if (Option.isSome(credential)) {
      names.set(scheme.name, credential.value);
    }
  }

  const all = [...names.values()];
  const count = (pick: (credential: CredentialNames) => string, value: string): number =>
    all.filter((credential) => pick(credential) === value).length;
  const clashes = (credential: CredentialNames): boolean =>
    credential.slug !== "" &&
    (count((entry) => entry.env, credential.env) > 1 ||
      count((entry) => entry.flag, credential.flag) > 1 ||
      reservedEnv.has(credential.env) ||
      reservedCliNames.has(credential.flag));

  for (const entry of named) {
    const uses = usesOf(entry.operation);
    const empty = uses.filter((scheme) => names.get(scheme.name)?.slug === "");
    if (empty.length > 0) {
      collector.report(
        entry.operation,
        "SSC-01/empty-name",
        "Security scheme",
        "A scheme name folds to nothing.",
        {
          related: empty.map(schemeSite),
        },
      );
    }

    const clashing = uses.filter((scheme) => {
      const credential = names.get(scheme.name);

      return credential !== undefined && clashes(credential);
    });
    const [first] = clashing;
    if (first !== undefined) {
      collector.report(
        entry.operation,
        "SSC-01/credential-collision",
        "Security scheme",
        "Two credential names collide.",
        {
          hint: `security[${JSON.stringify(first.name)}].env`,
          related: clashing.map(schemeSite),
        },
      );
    }
  }

  const flags = new Set(
    all.flatMap((credential) => (credential.slug === "" ? [] : [credential.flag])),
  );

  return { flags, names, usesOf };
};

const domainNames = (entries: readonly Named[]): ReadonlySet<string> =>
  new Set(
    entries.flatMap((entry) =>
      (entry.operation.body?.alternatives ?? []).flatMap((alternative) => {
        const key = alternative.schema?.key;
        if (key === undefined || (alternative.codec !== "json" && alternative.codec !== "form")) {
          return [];
        }

        const name = foldIdentifier(key, "pascal");

        return Result.isSuccess(name) ? [name.success.name] : [];
      }),
    ),
  );

const rowOf = (flag: DraftFlag) =>
  flag.source._tag === "Parameter"
    ? { element: "Parameter", row: "PRM-02" }
    : { element: "Request body", row: "RQB-03" };

// Flag and positional identifiers: one scope per command, renamed by suffix on a clash.
const planFlags = (
  entry: Named,
  draft: Draft,
  collector: Collector,
): Pick<PlannedCommand, "flags" | "positionals"> => {
  const assigned = new Set<string>();
  const blocked = (candidate: string): boolean =>
    fixedFlagIdentifiers.has(candidate) || assigned.has(candidate);
  const take = (
    name: string,
    pointer: string,
    row: string,
    element: string,
  ): SafeIdentifierValue => {
    const base = identifierOf(name, "camel");
    collector.folded(entry.operation, row, element, pointer, base.notes);

    const identifier = blocked(base.name) ? toIdentifier(suffixed(base.name, blocked)) : base.name;
    if (identifier !== base.name) {
      collector.report(entry.operation, `${row}/renamed`, element, "An identifier was renamed.", {
        pointer,
        scope: "element",
        severity: "notice",
      });
    }

    assigned.add(identifier);

    return identifier;
  };

  const positionals = draft.positionals.map((positional) => {
    collector.folded(entry.operation, "PRM-02", "Parameter", positional.pointer, positional.notes);

    return {
      identifier: take(positional.name, positional.pointer, "PRM-02", "Parameter"),
      name: positional.name,
      pointer: positional.pointer,
      wireName: positional.wireName,
    };
  });
  const identifiers = new Map<DraftFlag, SafeIdentifierValue>();
  for (const flag of draft.flags.filter(isWholeBodyFlag)) {
    const identifier = identifierOf(flag.name, "camel").name;
    assigned.add(identifier);
    identifiers.set(flag, identifier);
  }

  for (const flag of draft.flags.filter((candidate) => !isWholeBodyFlag(candidate))) {
    const { element, row } = rowOf(flag);
    collector.folded(entry.operation, row, element, flag.pointer, flag.notes);
    identifiers.set(flag, take(flag.name, flag.pointer, row, element));
  }

  const flags = draft.flags.map((flag) => ({
    boolean: flag.boolean,
    identifier: identifiers.get(flag) ?? identifierOf(flag.name, "camel").name,
    name: flag.name,
    source: flag.source,
  }));

  return { flags, positionals };
};

/**
 * Command identifiers of one emitted module. The scope reserves `group`, the fixed namespaces, the
 * api namespace alias, the imported domain names and every command's `<cmd>Meta`, `<cmd>Media`,
 * `<cmd>Security` and `<Cmd>Input`; identifiers compare exactly and a clash renames by suffix
 * (SM-6). Visible names never change.
 */
const planModule = (
  entries: readonly Named[],
  reserved: ReadonlySet<string>,
  drafts: ReadonlyMap<Operation, Draft>,
  collector: Collector,
): readonly PlannedCommand[] => {
  const bases = entries.map((entry) => identifierOf(entry.name, "camel"));
  const taken = new Set(["group", ...reserved, ...bases.flatMap(({ name }) => familyOf(name))]);
  const assigned = new Set<string>();
  const used = (candidate: string): boolean => taken.has(candidate) || assigned.has(candidate);
  const clash = (candidate: string): boolean => used(candidate) || familyOf(candidate).some(used);

  return entries.map((entry, index) => {
    const base = bases[index] ?? identifierOf(entry.name, "camel");
    const { operation } = entry;
    collector.folded(operation, "OPR-06", "Operation", operation.origin.pointer, [
      ...entry.notes,
      ...base.notes,
    ]);

    const identifier = used(base.name) ? toIdentifier(suffixed(base.name, clash)) : base.name;
    if (identifier !== base.name) {
      for (const member of familyOf(identifier)) {
        taken.add(member);
      }

      collector.report(
        operation,
        "OPR-06/renamed",
        "Operation",
        "The command identifier was renamed.",
        {
          scope: "element",
          severity: "notice",
        },
      );
    }

    assigned.add(identifier);

    const draft = drafts.get(operation) ?? { flags: [], positionals: [] };

    return {
      configKey: entry.site.configKey,
      identifier,
      name: entry.name,
      operation,
      ...planFlags(entry, draft, collector),
    };
  });
};

const planGroup = (
  node: GroupNode,
  finals: readonly Named[],
  drafts: ReadonlyMap<Operation, Draft>,
  collector: Collector,
): PlannedGroup => {
  const entries = finals.filter((entry) => entry.container === node.tag);
  const imported = domainNames(entries);
  const first = finals.find((entry) => entry.chain.includes(node));
  const blocked = (candidate: string): boolean =>
    fixedNamespaces.has(candidate) || imported.has(candidate);
  const base = identifierOf(node.name, "pascal");
  const namespace = blocked(base.name) ? toIdentifier(suffixed(base.name, blocked)) : base.name;
  if (first !== undefined) {
    collector.folded(first.operation, "TAG-02", "Tag", first.tagPointer, node.notes);
    if (namespace !== base.name) {
      collector.report(
        first.operation,
        "TAG-02/renamed",
        "Tag",
        "The api namespace alias was renamed.",
        {
          pointer: first.tagPointer,
          scope: "element",
          severity: "notice",
        },
      );
    }
  }

  const group: Mutable<PlannedGroup> = {
    commands: planModule(
      entries,
      new Set([...fixedNamespaces, namespace, ...imported]),
      drafts,
      collector,
    ),
    name: node.name,
    namespace,
    segment: node.segment,
    tag: node.tag,
  };
  if (node.parent !== undefined) {
    group.parent = node.parent;
  }

  return group;
};

const byScheme = Order.mapInput(Order.String, (credential: PlannedCredential) => credential.scheme);

/**
 * Builds the name plan for an `Api` (design 4.4, 4.5, D-NAME1 to D-NAME3, D-AD11). Visible names
 * (groups, commands, flags and their `no-` negations, file segments, credential names) that collide
 * are refused at `operation` scope with both pointers and the config key that resolves them, never
 * renamed. Internal identifiers rename by a numeric suffix with a notice. Every check runs over all
 * candidate operations, so one refusal never hides another. An `UnresolvedBodyRef` or an
 * unfollowable `$ref` chain is a defect: earlier stages refuse every input that produces one.
 */
export const planNames = (api: Api, options: PlanOptions): Effect.Effect<NamePlan> =>
  Effect.gen(function* plan() {
    const { config, configDocument } = options;
    const collector = makeCollector(configDocument, options.strict);
    const authorCommands = new Set(config.commands?.names);
    const sites = matchOverrides(api, config, collector);
    const candidates = groupOperations(api, options, sites, collector);
    checkGroups(candidates, authorCommands, collector);

    const named = nameCommands(candidates, authorCommands, collector);
    const credentials = planCredentials(api, config, named, collector);
    const context: DraftContext = {
      booleans: new Map(),
      collector,
      credentialFlags: credentials.flags,
      defs: Option.match(decodeDefs(api.schemas.document), {
        onNone: () => ({}),
        onSome: (store) => store.$defs,
      }),
    };
    const drafts = new Map<Operation, Draft>();
    for (const entry of named) {
      drafts.set(entry.operation, yield* draftFlags(entry, context));
    }

    const finals = named.filter((entry) => !collector.refused.has(entry.operation));
    const rootEntries = finals.filter((entry) => entry.container === root);
    const rootReserved = new Set([...fixedNamespaces, ...domainNames(rootEntries)]);
    const rootCommands = planModule(rootEntries, rootReserved, drafts, collector);
    const groups = Arr.dedupe(finals.flatMap((entry) => entry.chain)).map((node) =>
      planGroup(node, finals, drafts, collector),
    );
    const planned = new Set(
      finals.flatMap((entry) => credentials.usesOf(entry.operation).map((scheme) => scheme.name)),
    );
    const plannedCredentials = [...credentials.names].flatMap(([scheme, names]) =>
      planned.has(scheme) ? [{ env: names.env, flag: names.flag, scheme }] : [],
    );
    const diagnostics = yield* Effect.all(
      collector.findings.map((finding) => toDiagnostic(api, finding)),
    );

    return {
      credentials: Arr.sort(plannedCredentials, byScheme),
      diagnostics: sortDiagnostics([...api.documents, configDocument], diagnostics),
      groups,
      root: rootCommands,
    };
  });
