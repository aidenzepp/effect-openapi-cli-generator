import { Array as Arr, Data, Effect, Order, Schema } from "effect";
import type { Resolution } from "../../src/resolve/index.ts";
import { Description } from "../../src/runtime-src/runtime/describe.ts";
import { walk } from "./walk.ts";
import type { WalkElement, WalkError } from "./walk.ts";

/**
 * What one coverage check reads: the resolved entry document, the built CLI's `--describe` stdout
 * and the package's `generation-report.json` text. The report must come from a run that named the
 * entry by the same document URI as `resolution`.
 */
export interface CoverageInput {
  readonly describe: string;
  readonly report: string;
  readonly resolution: Resolution;
}

interface CommandSite {
  readonly document: string;
  readonly path: readonly string[];
  readonly pointer: string;
}

/**
 * What `--describe` claims that nothing in the spec stands behind: a command whose
 * `(document, pointer)` is no operation, or a value on a command that its operation does not
 * declare or inherit. Value fields mirror the walk's element fields.
 */
export type Invented =
  | (CommandSite & { readonly kind: "command" })
  | (CommandSite & { readonly kind: "requestMedia"; readonly mediaType: string })
  | (CommandSite & { readonly kind: "response"; readonly key: string })
  | (CommandSite & { readonly kind: "securityAlternative"; readonly schemes: readonly string[] })
  | (CommandSite & { readonly kind: "server"; readonly url: string });

/**
 * The elements nothing accounts for, the claims nothing in the spec stands behind, and the
 * elements accounted for only by a notice. A notice does not say the element was not generated,
 * so `byNotice` keeps that coverage visible instead of silently passing it.
 */
export interface Coverage {
  readonly byNotice: readonly WalkElement[];
  readonly invented: readonly Invented[];
  readonly missing: readonly WalkElement[];
}

export class CoverageMismatch extends Data.TaggedError("CoverageMismatch")<Coverage> {}

export type CoverageError = Schema.SchemaError | WalkError;

// Only the fields the join reads. The checker decodes the report itself instead of importing the
// generator's report codec, which would pull in the model it checks (design 8.3). `operation` is the
// request method token and path template of the operation a diagnostic concerns.
const Record = Schema.Struct({
  document: Schema.String,
  operation: Schema.optionalKey(Schema.Struct({ method: Schema.String, path: Schema.String })),
  pointer: Schema.String,
  scope: Schema.Literals(["document", "operation", "element", "field"]),
});

// `skipped` is optional so a hand-built report naming no skip still decodes; the generator always
// writes it.
const Report = Schema.Struct({
  notices: Schema.Array(Schema.Struct({ ...Record.fields, code: Schema.String })),
  refusals: Schema.Array(Record),
  skipped: Schema.optionalKey(
    Schema.Array(Schema.Struct({ document: Schema.String, pointer: Schema.String })),
  ),
});

const decodeDescription = Schema.decodeUnknownEffect(Schema.fromJsonString(Description));

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(Report));

// `--describe` names a document by its label, the path relative to the entry's directory when it
// shares the entry's origin, else origin and path (the generated binding's rule, C8). The report
// and the walk name it by URI, so both are labelled before the join.
const labelOf = (entry: string, document: string): string => {
  const target = URL.parse(document);
  const base = URL.parse(entry);
  if (target === null || base === null) {
    return document;
  }

  if (base.origin !== target.origin || base.protocol !== target.protocol) {
    return `${target.origin}${target.pathname}`;
  }

  const from = base.pathname.split("/").slice(0, -1);
  const to = target.pathname.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) {
    common += 1;
  }

  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
};

// Notice codes that account for every element at or below their pointer within the operation that
// holds it, because the notice says that whole subtree is not sent. Every other notice accounts
// only for the element at its exact pointer.
const subtreeNotices: ReadonlySet<string> = new Set(["OPR-10/body-ignored"]);

const key = (document: string, pointer: string): string => `${document}\u0000${pointer}`;

// The pointers an element at `pointer` lies within, outermost first and itself last: the root and
// each prefix ending before a `/`. `within(pointer, owner)` holds exactly for these owners.
const ancestors = (pointer: string): readonly string[] => {
  const found = [""];
  for (let at = pointer.indexOf("/", 1); at !== -1; at = pointer.indexOf("/", at + 1)) {
    found.push(pointer.slice(0, at));
  }
  if (pointer !== "") {
    found.push(pointer);
  }

  return found;
};

// Appends `value` to the list at `at`, creating it on first use.
const append = <K, V>(map: Map<K, V[]>, at: K, value: V): void => {
  const list = map.get(at);
  if (list === undefined) {
    map.set(at, [value]);
  } else {
    list.push(value);
  }
};

// Computes `make(at)` once per `at`; an undefined result is computed again.
const memo = <K, V>(make: (at: K) => V): ((at: K) => V) => {
  const cache = new Map<K, V>();

  return (at) => {
    const cached = cache.get(at);
    if (cached !== undefined) {
      return cached;
    }

    const made = make(at);
    cache.set(at, made);

    return made;
  };
};

// An operation-scope refusal's name, as the report spells it: the request method token and path.
const operationName = (method: string, path: string): string => `${method}\u0000${path}`;

type Command = (typeof Description.Type)["commands"][number];

type Operation = Extract<WalkElement, { readonly kind: "operation" }>;

// A security alternative is a set of scheme names; `{}` is the empty set.
const schemeSet = (schemes: readonly string[]): string =>
  JSON.stringify(Arr.sort(schemes, Order.String));

// What a command, or the elements an operation declares or inherits, offer by kind, keyed as the
// join matches them: parameters by pointer, media and response keys by value, security alternatives
// by scheme set, servers by URL.
interface Offer {
  readonly media: ReadonlySet<string>;
  readonly parameters: ReadonlySet<string>;
  readonly responses: ReadonlySet<string>;
  readonly security: ReadonlySet<string>;
  readonly servers: ReadonlySet<string>;
}

const commandOffer = (command: Command): Offer => ({
  media: new Set(command.requestMedia),
  parameters: new Set(command.flags.map((flag) => flag.pointer)),
  responses: new Set(command.responses),
  security: new Set(command.security.map(schemeSet)),
  servers: new Set(command.servers),
});

const elementOffer = (elements: readonly WalkElement[]): Offer => {
  const offer = {
    media: new Set<string>(),
    parameters: new Set<string>(),
    responses: new Set<string>(),
    security: new Set<string>(),
    servers: new Set<string>(),
  };
  for (const element of elements) {
    if (element.kind === "parameter") {
      offer.parameters.add(element.pointer);
    } else if (element.kind === "requestMedia") {
      offer.media.add(element.mediaType);
    } else if (element.kind === "response") {
      offer.responses.add(element.key);
    } else if (element.kind === "securityAlternative") {
      offer.security.add(schemeSet(element.schemes));
    } else if (element.kind === "server") {
      offer.servers.add(element.url);
    }
  }

  return offer;
};

// Whether a command for the operation carries the element, matched on that command's own fields.
const carries = (offer: Offer, element: WalkElement): boolean => {
  if (element.kind === "parameter") {
    return offer.parameters.has(element.pointer);
  }

  if (element.kind === "requestMedia") {
    return offer.media.has(element.mediaType);
  }

  if (element.kind === "response") {
    return offer.responses.has(element.key);
  }

  if (element.kind === "securityAlternative") {
    return offer.security.has(schemeSet(element.schemes));
  }

  return element.kind === "operation" || offer.servers.has(element.url);
};

/**
 * Joins the walk with `--describe` and the generation report (design 8.3, R11).
 *
 * - An operation is accounted for by a command at its `(document, pointer)`, by a document-scope
 *   refusal, by an operation-scope refusal at, above or anywhere inside it or naming it (its method
 *   and path, as a refusal at a path-item parameter it inherits does), or by the report's `skipped`
 *   entry at its pointer (an author-config skip, design 8.2). A skipped operation is treated like a
 *   refused one: its subtree is accounted for, and its inherited elements need no command of it, so
 *   root servers and security stay carried by the emitted commands.
 * - An element under an operation is accounted for when every command for THAT operation (its primary
 *   name and each `x-forge-aliases` alias, design 8.3 Aliases) carries it: a parameter by flag
 *   pointer, request media and response keys by value as the spec spells them, a security
 *   alternative by scheme set, a server by URL.
 * - An inherited element (path-item parameter, path-item or root server, root security alternative)
 *   is accounted for when every operation that inherits it is refused or every command of it
 *   carries it; with no inheriting operation it affects no request.
 * - An element-scope refusal covers its pointer and descendants; an operation-scope refusal its
 *   subtree and that operation's inherited elements; a document-scope refusal its document.
 * - A notice covers only the element at its exact pointer, never an operation, except that a notice
 *   whose code is in `subtreeNotices` covers every element at or below its pointer within the
 *   operation holding it; such elements are listed in `byNotice`.
 *
 * A command whose pointer is no walked operation is invented, as is a command's request media,
 * response key, security alternative or server that its operation neither declares nor inherits,
 * except the default `/` server when no level declares servers.
 *
 * The report and `--describe` are indexed once, so the join's cost grows with the elements and
 * claims, not their product. `count`, when given, receives the number of index lookups and
 * candidates each step examines, which lets a test bound that cost without timing it.
 */
export const coverageOf = (
  input: CoverageInput,
  count?: (examined: number) => void,
): Effect.Effect<Coverage, CoverageError> => {
  // One index lookup each, as `count` sees it.
  const has = <K>(index: ReadonlySet<K> | ReadonlyMap<K, unknown>, at: K): boolean => {
    count?.(1);

    return index.has(at);
  };
  const lookup = <K, V>(index: ReadonlyMap<K, V>, at: K): V | undefined => {
    count?.(1);

    return index.get(at);
  };
  // Whether `index` holds any of the given sites.
  const holds = (index: ReadonlySet<string>, sites: readonly string[]): boolean =>
    sites.some((site) => has(index, site));

  return Effect.gen(function* coverage() {
    const entry = input.resolution.document;
    const label = memo((document: string) => labelOf(entry, document));
    const elements = yield* walk(input.resolution);
    const description = yield* decodeDescription(input.describe);
    const report = yield* decodeReport(input.report);

    const labelled = <R extends { readonly document: string }>(records: readonly R[]) =>
      records.map((record) => ({ ...record, document: label(record.document) }));
    const siteOf = (element: WalkElement) => key(label(element.document), element.pointer);
    // The sites an element lies within, from the one at pointer `from` (the root by default).
    const sitesAbove = (element: WalkElement, from = ""): readonly string[] =>
      ancestors(element.pointer)
        .filter((pointer) => pointer.length >= from.length)
        .map((pointer) => key(label(element.document), pointer));

    // Refusals: documents refused whole, every refusal's site (each covers its subtree), operation
    // refusals by site and by every site at or above one, and operation refusals by name.
    const refusals = labelled(report.refusals);
    const refusedDocuments = new Set(
      refusals.filter((record) => record.scope === "document").map((record) => record.document),
    );
    const refusedSites = new Set(refusals.map((record) => key(record.document, record.pointer)));
    const operationRefusals = refusals.filter((record) => record.scope === "operation");
    const operationRefusalSites = new Set(
      operationRefusals.map((record) => key(record.document, record.pointer)),
    );
    const aboveOperationRefusals = new Set(
      operationRefusals.flatMap((record) =>
        ancestors(record.pointer).map((pointer) => key(record.document, pointer)),
      ),
    );
    const refusedNames = new Set(
      operationRefusals.flatMap((record) =>
        record.operation === undefined
          ? []
          : [operationName(record.operation.method, record.operation.path)],
      ),
    );

    // Notices by exact site, and the sites of notices that cover their subtree.
    const notices = new Set(
      labelled(report.notices).map((record) => key(record.document, record.pointer)),
    );
    const subtrees = new Set(
      labelled(report.notices)
        .filter((record) => subtreeNotices.has(record.code))
        .map((record) => key(record.document, record.pointer)),
    );
    const skipped = new Set(
      labelled(report.skipped ?? []).map((record) => key(record.document, record.pointer)),
    );

    const operations = new Map(
      elements.flatMap((element): readonly (readonly [string, Operation])[] =>
        element.kind === "operation" ? [[siteOf(element), element]] : [],
      ),
    );
    const commandsBySite = new Map<string, Command[]>();
    for (const command of description.commands) {
      append(commandsBySite, key(command.document, command.pointer), command);
    }

    const offerOf = memo(commandOffer);
    const commandsOf = (operation: Operation): readonly Command[] =>
      lookup(commandsBySite, siteOf(operation)) ?? [];

    // Each element's owner, the walked operation at one of its sites; operations by the pointers
    // they inherit; and elements by owner and by pointer, as `inherits` names them.
    const owners = new Map<WalkElement, Operation>();
    const owned = new Map<Operation, WalkElement[]>();
    const atPointer = new Map<string, WalkElement[]>();
    for (const element of elements) {
      const owner = sitesAbove(element)
        .map((site) => lookup(operations, site))
        .find((operation) => operation !== undefined);
      if (owner !== undefined) {
        owners.set(element, owner);
        append(owned, owner, element);
      }

      append(atPointer, element.pointer, element);
    }

    const ownerOf = (element: WalkElement): Operation | undefined => lookup(owners, element);
    const inheritors = new Map<string, Operation[]>();
    for (const operation of operations.values()) {
      for (const pointer of operation.inherits) {
        append(inheritors, pointer, operation);
      }
    }

    // A refusal or an author-config skip: either way the operation has no command by decision. An
    // operation-scope refusal names the operation it refuses. Its pointer may sit outside that
    // operation, at a path-item parameter the operation inherits, so the name decides; method and
    // path identify one operation of the entry's `paths`, whichever document the refusal names.
    // The report spells the method as the request token, the walk as the path-item key.
    const refused = memo(
      (operation: Operation): boolean =>
        has(skipped, siteOf(operation)) ||
        has(refusedNames, operationName(operation.method.toUpperCase(), operation.path)) ||
        has(refusedDocuments, label(operation.document)) ||
        holds(operationRefusalSites, sitesAbove(operation)) ||
        has(aboveOperationRefusals, siteOf(operation)),
    );
    // An element- or operation-scope refusal covers its subtree; never used for an operation.
    const refusedElement = (element: WalkElement): boolean =>
      has(refusedDocuments, label(element.document)) || holds(refusedSites, sitesAbove(element));
    // Every command of the operation (its primary name and each alias) must carry the element; an
    // operation with no command carries nothing.
    const carried = (operation: Operation, element: WalkElement): boolean => {
      if (refused(operation)) {
        return true;
      }

      const commands = commandsOf(operation);
      count?.(commands.length);

      return commands.length > 0 && commands.every((command) => carries(offerOf(command), element));
    };

    // Accounted for by a command or a refusal, without notices.
    const generated = (element: WalkElement): boolean => {
      if (element.kind === "operation") {
        return carried(element, element);
      }

      if (refusedElement(element)) {
        return true;
      }

      const owner = ownerOf(element);
      if (owner !== undefined) {
        return carried(owner, element);
      }

      const inheriting = lookup(inheritors, element.pointer) ?? [];
      count?.(inheriting.length);

      return inheriting.every((operation) => carried(operation, element));
    };

    const noticed = (element: WalkElement): boolean => {
      if (element.kind === "operation") {
        return false;
      }

      const owner = ownerOf(element);

      return (
        has(notices, siteOf(element)) ||
        (owner !== undefined && holds(subtrees, sitesAbove(element, owner.pointer)))
      );
    };

    // What an operation declares or inherits: the elements within it and those at its inherited
    // pointers.
    const declared = memo((operation: Operation): Offer => {
      const effective = [
        ...(owned.get(operation) ?? []),
        ...operation.inherits.flatMap((pointer) => lookup(atPointer, pointer) ?? []),
      ];
      count?.(effective.length);

      return elementOffer(effective);
    });

    const invented = description.commands.flatMap((command): readonly Invented[] => {
      const site = { document: command.document, path: command.path, pointer: command.pointer };
      const operation = lookup(operations, key(command.document, command.pointer));
      if (operation === undefined) {
        return [{ ...site, kind: "command" }];
      }

      const offer = declared(operation);

      return [
        ...command.requestMedia
          .filter((mediaType) => !has(offer.media, mediaType))
          .map((mediaType): Invented => ({ ...site, kind: "requestMedia", mediaType })),
        ...command.responses
          .filter((responseKey) => !has(offer.responses, responseKey))
          .map((responseKey): Invented => ({ ...site, key: responseKey, kind: "response" })),
        ...command.security
          .filter((schemes) => !has(offer.security, schemeSet(schemes)))
          .map((schemes): Invented => ({ ...site, kind: "securityAlternative", schemes })),
        ...command.servers
          .filter((url) => !(operation.defaultServer && url === "/") && !has(offer.servers, url))
          .map((url): Invented => ({ ...site, kind: "server", url })),
      ];
    });

    return {
      byNotice: elements.filter((element) => !generated(element) && noticed(element)),
      invented,
      missing: elements.filter((element) => !generated(element) && !noticed(element)),
    };
  });
};

/**
 * Runs the join and fails with the mismatch when an element is missing or a command is invented.
 */
export const checkCoverage = (
  input: CoverageInput,
): Effect.Effect<Coverage, CoverageError | CoverageMismatch> =>
  coverageOf(input).pipe(
    Effect.flatMap((coverage) =>
      coverage.missing.length === 0 && coverage.invented.length === 0
        ? Effect.succeed(coverage)
        : Effect.fail(new CoverageMismatch(coverage)),
    ),
  );
