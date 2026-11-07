import { Array as Arr, Effect, Option, Order, Predicate, Result, Schema } from "effect";
import type { AuthorConfig } from "../model/author-config.ts";
import type { DocumentUri } from "../model/brands.ts";
import { Diagnostic, sortDiagnostics } from "../model/diagnostic.ts";
import type { Api, NamingHint, Operation, SecurityScheme } from "../model/entities.ts";
import { domainIdentifiers, fixedNamespaces, rootModuleNames } from "./domain.ts";
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
  rootNamespace,
  siteOf,
  suffixed,
} from "./plan.ts";
import type {
  Collector,
  CommandNameSource,
  Draft,
  DraftContext,
  DraftFlag,
  Finding,
  GroupNameSource,
  Namer,
  OverrideSite,
  PlannedCommand,
  PlannedCredential,
  PlannedGroup,
  ReportOptions,
} from "./plan.ts";
import { reservedCliNames, reservedEnvSuffixes } from "./reserved.ts";
import { specSectionUrl } from "../model/spec-section.ts";
import { escapeToken } from "../model/pointer.ts";

export { domainIdentifiers } from "./domain.ts";

export type {
  CommandNameSource,
  FlagSource,
  GroupNameSource,
  NameSources,
  PlannedCommand,
  PlannedCredential,
  PlannedFlag,
  PlannedGroup,
  PlannedPositional,
} from "./plan.ts";

/**
 * What the plan reads besides the `Api`.
 */
export interface PlanOptions {
  readonly config: AuthorConfig;
  readonly configDocument: typeof DocumentUri.Type;
  readonly strict: boolean;
}

/**
 * The name plan: untagged commands at the root, groups in first-use order (parents before
 * children), the credential names of every scheme the planned operations use, and the plan's
 * refusals and notices in diagnostic order. A refused operation is in no group. `domain` is the
 * export name of every stored schema key in `domain/schemas.ts` (`domainIdentifiers`); cli modules
 * import those names and the domain emitter takes the same map.
 */
export interface NamePlan {
  readonly credentials: readonly PlannedCredential[];
  readonly diagnostics: readonly Diagnostic[];
  readonly domain: ReadonlyMap<string, SafeIdentifierValue>;
  readonly groups: readonly PlannedGroup[];
  readonly root: readonly PlannedCommand[];
}

// `tag` is the group's key: the tag name, or for a group from a naming extension its folded
// segment names joined with `.`. `label` is the unfolded name the group-word drop compares.
interface GroupNode {
  readonly label: string;
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
  | "TAG-06/parent-depth"
  | "TAG-06/unknown-parent";

// One command to plan: an operation's primary, or one of its aliases (`alias` is the index).
// `namePointer` is where the command's name is declared; config hints name the primary only.
interface Candidate {
  readonly alias: number | undefined;
  readonly chain: readonly GroupNode[];
  readonly commandHint: string | undefined;
  readonly container: string;
  readonly groupHint: string | undefined;
  readonly groupSource: GroupNameSource;
  readonly namePointer: string;
  readonly namer: Namer;
  readonly operation: Operation;
  readonly site: OverrideSite;
  readonly tagPointer: string;
}

interface Named extends Candidate {
  readonly commandSource: CommandNameSource;
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

const maxParentHops = 64;

const withHint = (hint: string | undefined, options: ReportOptions): ReportOptions =>
  hint === undefined ? options : { ...options, hint };

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
};

// File segments the package always owns: `api/root.ts` for untagged commands, `api/servers.ts`
// and `api/security.ts`.
const reservedSegments: ReadonlySet<string> = new Set(["root", "security", "servers"]);

const fixedFlagIdentifiers: ReadonlySet<string> = new Set([
  "accept",
  "body",
  "bodyFile",
  "contentType",
]);

const decodeDefs = Schema.decodeUnknownOption(
  Schema.Struct({ $defs: Schema.Record(Schema.String, Schema.Json) }),
);

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
    specSection: anchor === undefined ? finding.document : specSectionUrl(api.line, anchor),
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
    // `add` is the added-scheme block, not a scheme name.
    if (name !== "add" && !schemes.has(name)) {
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
    label: tag,
    name: name.success.name,
    notes: name.success.notes,
    parent,
    segment: segment.success,
    tag,
  });
};

/**
 * The group chain of a tag, root first, following 3.2 `parent` links. A parent that is not
 * declared, or a cycle, is refused (OpenAPI 3.2 tag `parent`: MUST exist, MUST NOT be circular);
 * so is a chain of more than 64 parent hops (design 3.3 budgets). Each tag's chain is walked once
 * and shared, so total work is bounded by 65 nodes per distinct tag.
 */
const makeChains = (api: Api) => {
  const declared = new Map(api.tags.map((tag) => [tag.name, tag.parent]));
  const nodes = new Map<string, Result.Result<GroupNode, ChainError>>();
  const nodeOf = (tag: string): Result.Result<GroupNode, ChainError> => {
    const node = nodes.get(tag) ?? groupNode(tag, declared.get(tag));
    nodes.set(tag, node);

    return node;
  };

  const walk = (tag: string): Result.Result<readonly GroupNode[], ChainError> => {
    const chain: GroupNode[] = [];
    const visited = new Set<string>();
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

      if (visited.has(current)) {
        return Result.fail("TAG-06/parent-cycle");
      }

      if (chain.length > maxParentHops) {
        return Result.fail("TAG-06/parent-depth");
      }

      visited.add(current);
      chain.push(node.success);
      current = parent;
    }

    return Result.succeed(Arr.reverse(chain));
  };

  const chains = new Map<string, Result.Result<readonly GroupNode[], ChainError>>();

  return (tag: string): Result.Result<readonly GroupNode[], ChainError> => {
    const chain = chains.get(tag) ?? walk(tag);
    chains.set(tag, chain);

    return chain;
  };
};

const extensionNode = (
  key: string,
  label: string,
  name: { readonly name: string; readonly notes: readonly FoldNote[] },
  parent: string | undefined,
): Result.Result<GroupNode, ChainError> => {
  const segment = foldFileSegment(key);
  if (Result.isFailure(segment)) {
    return Result.fail(
      segment.failure._tag === "EmptyFold" ? "TAG-02/empty-name" : "TAG-02/unsafe-segment",
    );
  }

  return Result.succeed({
    label,
    name: name.name,
    notes: name.notes,
    parent,
    segment: segment.success,
    tag: key,
  });
};

/**
 * The group chain of a naming extension's segments, top level first (design 4.4): each segment
 * folds to one name, nested under the previous one, with no `tag.parent` lookup. Groups are keyed
 * by their folded names joined with `.` whatever the source: a key that `tagAt` gives a tag group
 * for is that group (the tag's key and description kept), and otherwise a node keyed by the folded
 * names is shared by every chain that reaches it.
 */
const makeExtensionChains = (tagAt: (key: string) => GroupNode | undefined) => {
  const nodes = new Map<string, Result.Result<GroupNode, ChainError>>();

  return (segments: readonly string[]): Result.Result<readonly GroupNode[], ChainError> => {
    const chain: GroupNode[] = [];
    let parentKey: string | undefined = undefined;
    let parentTag: string | undefined = undefined;
    for (const label of segments) {
      const name = foldKebab(label);
      if (Result.isFailure(name)) {
        return Result.fail("TAG-02/empty-name");
      }

      const key: string =
        parentKey === undefined ? name.success.name : `${parentKey}.${name.success.name}`;
      const tagged = tagAt(key);
      const node: Result.Result<GroupNode, ChainError> =
        tagged === undefined
          ? (nodes.get(key) ?? extensionNode(key, label, name.success, parentTag))
          : Result.succeed(tagged);
      nodes.set(key, node);
      if (Result.isFailure(node)) {
        return Result.fail(node.failure);
      }

      chain.push(node.success);
      parentKey = key;
      parentTag = node.success.tag;
    }

    return Result.succeed(chain);
  };
};

// Every tag group's folded key (its chain's names joined with `.`): the declared tags, each
// operation's first tag and every author-config group. The first tag of a key wins; any other
// tag of that key still collides with it.
const tagKeys = (
  api: Api,
  sites: Iterable<OverrideSite>,
  tag: (tag: string) => Chain,
): ReadonlyMap<string, GroupNode> => {
  const names = [
    ...api.tags.map((declared) => declared.name),
    ...api.operations.flatMap((operation) => operation.tags.slice(0, 1)),
    ...[...sites].flatMap((site) =>
      site.override?.group === undefined ? [] : [site.override.group],
    ),
  ];
  const keys = new Map<string, GroupNode>();
  for (const name of names) {
    const chain = tag(name);
    const node = Result.isSuccess(chain) ? chain.success.at(-1) : undefined;
    if (Result.isSuccess(chain) && node !== undefined) {
      const key = chain.success.map((link) => link.name).join(".");
      if (!keys.has(key)) {
        keys.set(key, node);
      }
    }
  }

  return keys;
};

type Chain = Result.Result<readonly GroupNode[], ChainError>;

interface GroupChoice {
  readonly chain: Chain;
  readonly pointer: string;
  readonly source: GroupNameSource;
}

interface Chains {
  readonly extension: (segments: readonly string[]) => Chain;
  readonly tag: (tag: string) => Chain;
}

const groupKeys = { "x-fern": "x-fern-sdk-group-name", "x-forge": "x-forge-group-name" } as const;

const extensionGroup = (
  hint: typeof NamingHint.Type | undefined,
  source: keyof typeof groupKeys,
  chains: Chains,
): GroupChoice | undefined =>
  hint?.group === undefined
    ? undefined
    : {
        chain: chains.extension(hint.group),
        pointer: `${hint.pointer}/${groupKeys[source]}`,
        source,
      };

// The primary command's group, per design 4.4: the author config, else Forge, else Fern, else the
// first tag and its 3.2 `parent` chain, else the root.
const primaryGroup = (operation: Operation, site: OverrideSite, chains: Chains): GroupChoice => {
  const configured = site.override?.group;
  if (configured !== undefined) {
    return { chain: chains.tag(configured), pointer: operation.origin.pointer, source: "config" };
  }

  const { naming } = operation;
  const extension =
    extensionGroup(naming?.forge, "x-forge", chains) ??
    extensionGroup(naming?.fern, "x-fern", chains);
  if (extension !== undefined) {
    return extension;
  }

  const [tag] = operation.tags;
  const pointer = `${operation.origin.pointer}/tags/0`;

  return tag === undefined
    ? { chain: Result.succeed([]), pointer, source: "none" }
    : { chain: chains.tag(tag), pointer, source: "tag" };
};

interface AliasEntry {
  readonly alias: number;
  readonly choice: GroupChoice;
  readonly commandHint: string | undefined;
  readonly groupHint: string | undefined;
  readonly namePointer: string;
  readonly namer: Namer;
}

const rootChoice = (pointer: string): GroupChoice => ({
  chain: Result.succeed([]),
  pointer,
  source: "none",
});

/**
 * An operation's alias commands (design 4.4): the author config's `aliases` when given, which
 * replace `x-forge-aliases` (`[]` drops them), else each usable `x-forge-aliases` entry. An alias
 * is named by its own keys only: without a group of its own it sits at the root.
 */
const aliasesOf = (
  operation: Operation,
  site: OverrideSite,
  chains: Chains,
): readonly AliasEntry[] => {
  const configured = site.override?.aliases;
  if (configured !== undefined) {
    const { pointer } = operation.origin;

    return configured.map((alias, index) => {
      const hint = `${site.configKey}.aliases[${index}]`;
      const { group } = alias;
      const segments = Predicate.isString(group) ? group.split(".") : group;

      return {
        alias: index,
        choice:
          segments === undefined
            ? rootChoice(pointer)
            : { chain: chains.extension(segments), pointer, source: "config" },
        commandHint: hint,
        groupHint: hint,
        namePointer: pointer,
        namer: { _tag: "ConfigAlias", alias },
      };
    });
  }

  return (operation.naming?.aliases ?? []).map((alias) => {
    const namePointer = `${operation.origin.pointer}/x-forge-aliases/${alias.index}`;

    return {
      alias: alias.index,
      choice:
        extensionGroup(alias.forge, "x-forge", chains) ??
        extensionGroup(alias.fern, "x-fern", chains) ??
        rootChoice(namePointer),
      commandHint: undefined,
      groupHint: undefined,
      namePointer,
      namer: { _tag: "Alias", alias },
    };
  });
};

const groupOperations = (
  api: Api,
  options: PlanOptions,
  sites: ReadonlyMap<Operation, OverrideSite>,
  collector: Collector,
): readonly Candidate[] => {
  const tag = makeChains(api);
  const keys = tagKeys(api, sites.values(), tag);
  const chains: Chains = { extension: makeExtensionChains((key) => keys.get(key)), tag };
  const candidates: Candidate[] = [];
  for (const operation of api.operations) {
    const site = sites.get(operation) ?? overrideSite(options.config, operation);
    const { override } = site;
    if (override?.skip === true) {
      collector.report(operation, "OPR-06/skipped", "Operation", "The author config skips it.", {
        scope: "element",
        severity: "notice",
      });
      continue;
    }

    const primary = {
      alias: undefined,
      choice: primaryGroup(operation, site, chains),
      commandHint: `${site.configKey}.command`,
      groupHint: `${site.configKey}.group`,
      namePointer: operation.origin.pointer,
      namer: { _tag: "Primary", override } satisfies Namer,
    };
    for (const { choice, ...entry } of [primary, ...aliasesOf(operation, site, chains)]) {
      if (Result.isFailure(choice.chain)) {
        collector.report(
          operation,
          choice.chain.failure,
          "Tag",
          "The operation's group cannot be named.",
          withHint(entry.groupHint, { pointer: choice.pointer }),
        );
        continue;
      }

      const chain = choice.chain.success;
      candidates.push({
        ...entry,
        chain,
        container: chain.at(-1)?.tag ?? root,
        groupSource: choice.source,
        operation,
        site,
        tagPointer: choice.pointer,
      });
    }
  }

  return candidates;
};

/**
 * The group nodes of the candidates in first-use order, each with the first candidate whose chain
 * holds it.
 */
const firstUses = <C extends Candidate>(candidates: readonly C[]): ReadonlyMap<GroupNode, C> => {
  const first = new Map<GroupNode, C>();
  for (const candidate of candidates) {
    for (const node of candidate.chain) {
      if (!first.has(node)) {
        first.set(node, candidate);
      }
    }
  }

  return first;
};

const groupNodesOf = (candidates: readonly Candidate[]): readonly GroupNode[] => [
  ...firstUses(candidates).keys(),
];

const makeFirstSite = (candidates: readonly Candidate[]) => {
  const first = new Map(
    [...firstUses(candidates)].map(([node, candidate]) => [
      node.tag,
      siteOf(candidate.operation, candidate.tagPointer),
    ]),
  );

  return (tag: string) => {
    const site = first.get(tag);

    return site === undefined ? [] : [site];
  };
};

// Group names: two tags folding to one name or file segment, reserved names, and the file
// segments the package reserves.
const checkGroups = (
  candidates: readonly Candidate[],
  authorCommands: ReadonlySet<string>,
  collector: Collector,
): void => {
  const firstSite = makeFirstSite(candidates);
  const bySegment = new Map<string, GroupNode[]>();
  for (const node of groupNodesOf(candidates)) {
    push(bySegment, node.segment, node);
  }

  const relatedOf = new Map<GroupNode, ReturnType<typeof firstSite>>();
  const collidingWith = (node: GroupNode) => {
    const known = relatedOf.get(node);
    if (known !== undefined) {
      return known;
    }

    const others = (bySegment.get(node.segment) ?? []).filter((other) => other !== node);
    const related = others.flatMap((other) => firstSite(other.tag));
    relatedOf.set(node, related);

    return related;
  };
  const reserved = (node: GroupNode): boolean =>
    reservedCliNames.has(node.name) || (node.parent === undefined && authorCommands.has(node.name));
  for (const candidate of candidates) {
    const { groupHint: hint, operation, tagPointer } = candidate;
    for (const node of candidate.chain) {
      if ((bySegment.get(node.segment)?.length ?? 0) > 1) {
        collector.report(
          operation,
          "TAG-02/segment-collision",
          "Tag",
          "Two groups fold to one name.",
          withHint(hint, { pointer: tagPointer, related: collidingWith(node) }),
        );
      }

      if (reserved(node)) {
        collector.report(
          operation,
          "TAG-02/reserved-name",
          "Tag",
          "The group name is reserved.",
          withHint(hint, { pointer: tagPointer }),
        );
      }

      if (reservedSegments.has(node.segment)) {
        collector.report(
          operation,
          "TAG-02/reserved-segment",
          "Tag",
          `The group ${JSON.stringify(node.tag)} folds to the file segment ${JSON.stringify(node.segment)}, which api/${node.segment}.ts reserves.`,
          withHint(hint, { pointer: tagPointer }),
        );
      }
    }
  }
};

const nameCommand = (
  candidate: Candidate,
  authorCommands: ReadonlySet<string>,
  collector: Collector,
): Named | undefined => {
  const { commandHint: hint, namePointer: pointer, operation } = candidate;
  const name = commandName(operation, candidate.namer, candidate.chain.at(-1)?.label);
  if (Result.isFailure(name)) {
    collector.report(
      operation,
      "OPR-06/empty-name",
      "Operation",
      "The name folds to nothing.",
      withHint(hint, { pointer }),
    );

    return undefined;
  }

  const { folded, source } = name.success;
  const atRoot = candidate.container === root;
  if (reservedCliNames.has(folded.name) || (atRoot && authorCommands.has(folded.name))) {
    collector.report(
      operation,
      "OPR-06/reserved-name",
      "Operation",
      "The name is reserved.",
      withHint(hint, { pointer }),
    );
  }

  return { ...candidate, commandSource: source, name: folded.name, notes: folded.notes };
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
  const firstSite = makeFirstSite(candidates);
  const siblings = new Map<string | undefined, Map<string, GroupNode>>();
  for (const node of groupNodesOf(candidates)) {
    const names = siblings.get(node.parent) ?? new Map<string, GroupNode>();
    siblings.set(node.parent, names);
    if (!names.has(node.name)) {
      names.set(node.name, node);
    }
  }

  const byName = new Map<string, Map<string, Named[]>>();
  for (const entry of named) {
    const names = byName.get(entry.container) ?? new Map<string, Named[]>();
    byName.set(entry.container, names);
    push(names, entry.name, entry);
  }

  for (const entry of named) {
    const { commandHint: hint, namePointer: pointer } = entry;
    const twins = (byName.get(entry.container)?.get(entry.name) ?? []).filter(
      (other) => other !== entry,
    );
    if (twins.length > 0) {
      collector.report(
        entry.operation,
        "OPR-06/command-collision",
        "Operation",
        "Two commands in one group fold to one name.",
        withHint(hint, {
          pointer,
          related: twins.map((twin) => siteOf(twin.operation, twin.namePointer)),
        }),
      );
    }

    const parent = entry.container === root ? undefined : entry.container;
    const sibling = siblings.get(parent)?.get(entry.name);
    if (sibling !== undefined) {
      collector.report(
        entry.operation,
        "OPR-06/group-collision",
        "Operation",
        "The command name equals a sibling group's name.",
        withHint(hint, { pointer, related: firstSite(sibling.tag) }),
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

// The schemes an operation uses, in `securitySchemes` order; settled once per operation.
const usesOfApi = (api: Api) => {
  const index = new Map(api.securitySchemes.map((scheme, position) => [scheme.name, position]));
  const memo = new Map<Operation, readonly SecurityScheme[]>();

  return (operation: Operation): readonly SecurityScheme[] => {
    const known = memo.get(operation);
    if (known !== undefined) {
      return known;
    }

    const positions = new Set(
      operation.security.alternatives.flatMap((alternative) =>
        alternative.uses.flatMap((use) => {
          const position = index.get(use.scheme);

          return position === undefined ? [] : [position];
        }),
      ),
    );
    const uses = Arr.sort(positions, Order.Number).flatMap((position) => {
      const scheme = api.securitySchemes[position];

      return scheme === undefined ? [] : [scheme];
    });
    memo.set(operation, uses);

    return uses;
  };
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
  // An operation with aliases has several commands; its credentials are checked once.
  const operations = [...new Set(named.map((entry) => entry.operation))];
  for (const scheme of operations.flatMap(usesOf)) {
    const credential = credentialNames(config, envPrefix, scheme);
    if (Option.isSome(credential)) {
      names.set(scheme.name, credential.value);
    }
  }

  const all = [...names.values()];
  const tally = (pick: (credential: CredentialNames) => string): ReadonlyMap<string, number> => {
    const counts = new Map<string, number>();
    for (const credential of all) {
      counts.set(pick(credential), (counts.get(pick(credential)) ?? 0) + 1);
    }

    return counts;
  };
  const envCounts = tally((entry) => entry.env);
  const flagCounts = tally((entry) => entry.flag);
  const clashes = (credential: CredentialNames): boolean =>
    credential.slug !== "" &&
    ((envCounts.get(credential.env) ?? 0) > 1 ||
      (flagCounts.get(credential.flag) ?? 0) > 1 ||
      reservedEnv.has(credential.env) ||
      reservedCliNames.has(credential.flag));

  for (const operation of operations) {
    const uses = usesOf(operation);
    const empty = uses.filter((scheme) => names.get(scheme.name)?.slug === "");
    if (empty.length > 0) {
      collector.report(
        operation,
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
        operation,
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

// The domain names a module's commands import: the `domain` names of their json, form and
// multipart bodies.
const domainNames = (
  entries: readonly Named[],
  domain: ReadonlyMap<string, SafeIdentifierValue>,
): ReadonlySet<string> =>
  new Set(
    entries.flatMap((entry) =>
      (entry.operation.body?.alternatives ?? []).flatMap((alternative) => {
        const key = alternative.schema?.key;
        if (
          key === undefined ||
          (alternative.codec !== "json" &&
            alternative.codec !== "form" &&
            alternative.codec !== "multipart")
        ) {
          return [];
        }

        const name = domain.get(key);

        return name === undefined ? [] : [name];
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
 * api namespace aliases (its own and those its alias commands call), the imported domain names and
 * every command's `<cmd>Meta`, `<cmd>Media`, `<cmd>Security` and `<Cmd>Input`; identifiers compare
 * exactly and a clash renames by suffix (SM-6). Visible names never change.
 */
const planModule = (
  entries: readonly Named[],
  reserved: ReadonlySet<string>,
  drafts: ReadonlyMap<Operation, Draft>,
  flagPlans: FlagPlans,
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

    const command: Mutable<PlannedCommand> = {
      configKey: entry.site.configKey,
      identifier,
      name: entry.name,
      operation,
      sources: { command: entry.commandSource, group: entry.groupSource },
      ...flagPlans.of(entry, drafts),
    };
    if (entry.alias !== undefined) {
      command.alias = entry.alias;
    }

    return command;
  });
};

type CommandFlags = Pick<PlannedCommand, "flags" | "positionals">;

interface FlagPlans {
  readonly of: (entry: Named, drafts: ReadonlyMap<Operation, Draft>) => CommandFlags;
}

// Every command of one operation has the same flags and positionals; they are planned, with
// their notices, once.
const makeFlagPlans = (collector: Collector): FlagPlans => {
  const plans = new Map<Operation, CommandFlags>();

  return {
    of: (entry, drafts) => {
      const known = plans.get(entry.operation);
      if (known !== undefined) {
        return known;
      }

      const draft = drafts.get(entry.operation) ?? { flags: [], positionals: [] };
      const planned = planFlags(entry, draft, collector);
      plans.set(entry.operation, planned);

      return planned;
    },
  };
};

interface GroupNamespace {
  readonly base: string;
  readonly namespace: SafeIdentifierValue;
}

// A group's api namespace alias: the Pascal fold of its name, suffixed past every name a cli
// module that imports it already binds.
const namespaceOf = (node: GroupNode, blocked: (candidate: string) => boolean): GroupNamespace => {
  const base = identifierOf(node.name, "pascal");

  return {
    base: base.name,
    namespace: blocked(base.name) ? toIdentifier(suffixed(base.name, blocked)) : base.name,
  };
};

// The depth of a group in its chain: 0 for a top-level group.
const depthOf = (node: GroupNode, byTag: ReadonlyMap<string, GroupNode>): number => {
  let depth = 0;
  let { parent } = node;
  while (parent !== undefined) {
    depth += 1;
    parent = byTag.get(parent)?.parent;
  }

  return depth;
};

/**
 * Every group's api namespace, planned once and unique across all api modules: `Root` is
 * `api/root.ts`, a namespace `N` also claims `NCli`, the alias its `cli/` module is imported under,
 * and neither may be a fixed namespace every cli module imports. Groups take their namespace
 * shallowest first, then by group path (`tag`), so the first group to fold to a name keeps it and
 * every later one takes the next free numeric suffix (`Accounts`, `Accounts2`, ...) past the
 * claimed names and the names its importers bind.
 */
const planNamespaces = (
  nodes: readonly GroupNode[],
  blockedFor: (node: GroupNode) => (candidate: string) => boolean,
): ReadonlyMap<GroupNode, GroupNamespace> => {
  const byTag = new Map(nodes.map((node) => [node.tag, node]));
  const order = Order.combine(
    Order.mapInput(Order.Number, (node: GroupNode) => depthOf(node, byTag)),
    Order.mapInput(Order.String, (node: GroupNode) => node.tag),
  );
  const claimed = new Set([rootNamespace, `${rootNamespace}Cli`, ...fixedNamespaces]);
  const planned = new Map<GroupNode, GroupNamespace>();
  for (const node of Arr.sort(nodes, order)) {
    const importers = blockedFor(node);
    const blocked = (candidate: string): boolean =>
      claimed.has(candidate) || claimed.has(`${candidate}Cli`) || importers(candidate);
    const namespace = namespaceOf(node, blocked);
    claimed.add(namespace.namespace);
    claimed.add(`${namespace.namespace}Cli`);
    planned.set(node, namespace);
  }

  return planned;
};

// The modules (by container) an alias command calls into: an alias in one container calls its
// primary's builder in the primary's container (design 4.4). `hosts` maps a primary container to
// the containers holding its aliases, `targets` the reverse.
interface AliasLinks {
  readonly hosts: ReadonlyMap<string, ReadonlySet<string>>;
  readonly targets: ReadonlyMap<string, ReadonlySet<string>>;
}

const link = (map: Map<string, Set<string>>, key: string, value: string): void => {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
};

const aliasLinks = (entries: readonly Named[]): AliasLinks => {
  const primaries = new Map<Operation, string>();
  for (const entry of entries) {
    if (entry.alias === undefined) {
      primaries.set(entry.operation, entry.container);
    }
  }

  const hosts = new Map<string, Set<string>>();
  const targets = new Map<string, Set<string>>();
  for (const entry of entries) {
    const primary = primaries.get(entry.operation);
    if (entry.alias !== undefined && primary !== undefined && primary !== entry.container) {
      link(hosts, primary, entry.container);
      link(targets, entry.container, primary);
    }
  }

  return { hosts, targets };
};

const planGroup = (
  node: GroupNode,
  entries: readonly Named[],
  first: Named | undefined,
  { base, namespace }: GroupNamespace,
  foreign: ReadonlySet<string>,
  domain: ReadonlyMap<string, SafeIdentifierValue>,
  drafts: ReadonlyMap<Operation, Draft>,
  flagPlans: FlagPlans,
  collector: Collector,
): PlannedGroup => {
  const imported = domainNames(entries, domain);
  if (first !== undefined) {
    collector.folded(first.operation, "TAG-02", "Tag", first.tagPointer, node.notes);
    if (namespace !== base) {
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
      new Set([...fixedNamespaces, namespace, ...imported, ...foreign]),
      drafts,
      flagPlans,
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
      line: api.line,
    };
    const drafts = new Map<Operation, Draft>();
    for (const entry of named) {
      if (!drafts.has(entry.operation)) {
        drafts.set(entry.operation, yield* draftFlags(entry, context));
      }
    }

    const domain = domainIdentifiers(Object.keys(context.defs));
    const finals = named.filter((entry) => !collector.refused.has(entry.operation));
    const byContainer = new Map<string, Named[]>();
    for (const entry of finals) {
      push(byContainer, entry.container, entry);
    }

    const imports = (container: string): ReadonlySet<string> =>
      new Set([
        ...domainNames(byContainer.get(container) ?? [], domain),
        ...(container === root ? rootModuleNames : []),
      ]);
    // A group's namespace is also imported by every cli module holding one of its aliases, and
    // `cli/root.ts` is offered every api namespace beside its own bindings, so no namespace may
    // take one of the root module's names.
    const links = aliasLinks(finals);
    const firsts = firstUses(finals);
    const namespacesOf = planNamespaces([...firsts.keys()], (node) => {
      const importers = [node.tag, root, ...(links.hosts.get(node.tag) ?? [])].map(imports);

      return (candidate) => importers.some((names) => names.has(candidate));
    });
    const used = [...firsts].flatMap(([node, first]) => {
      const namespace = namespacesOf.get(node);

      return namespace === undefined ? [] : [{ first, namespace, node }];
    });
    const namespaces = new Map(used.map(({ namespace, node }) => [node.tag, namespace.namespace]));
    // The api namespaces a container's aliases call into.
    const foreign = (container: string): ReadonlySet<string> =>
      new Set(
        [...(links.targets.get(container) ?? [])].flatMap((target) => {
          const namespace = target === root ? rootNamespace : namespaces.get(target);

          return namespace === undefined ? [] : [namespace];
        }),
      );
    const rootEntries = byContainer.get(root) ?? [];
    const rootReserved = new Set([
      ...fixedNamespaces,
      ...rootModuleNames,
      ...domainNames(rootEntries, domain),
      ...foreign(root),
    ]);
    const flagPlans = makeFlagPlans(collector);
    const rootCommands = planModule(rootEntries, rootReserved, drafts, flagPlans, collector);
    const groups = used.map(({ first, namespace, node }) =>
      planGroup(
        node,
        byContainer.get(node.tag) ?? [],
        first,
        namespace,
        foreign(node.tag),
        domain,
        drafts,
        flagPlans,
        collector,
      ),
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
      domain,
      groups,
      root: rootCommands,
    };
  });
