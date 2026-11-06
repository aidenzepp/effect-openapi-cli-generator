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
// generator's report codec, which would pull in the model it checks (design 8.3).
const Record = Schema.Struct({
  document: Schema.String,
  pointer: Schema.String,
  scope: Schema.Literals(["document", "operation", "element"]),
});

const Report = Schema.Struct({ notices: Schema.Array(Record), refusals: Schema.Array(Record) });

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

const key = (document: string, pointer: string): string => `${document}\u0000${pointer}`;

const within = (pointer: string, owner: string): boolean =>
  pointer === owner || pointer.startsWith(`${owner}/`);

type Command = (typeof Description.Type)["commands"][number];

type Operation = Extract<WalkElement, { readonly kind: "operation" }>;

// A security alternative is a set of scheme names; `{}` is the empty set.
const schemeSet = (schemes: readonly string[]): string =>
  JSON.stringify(Arr.sort(schemes, Order.String));

// Whether a command for the operation carries the element, matched on that command's own fields.
const carries = (command: Command, element: WalkElement): boolean => {
  if (element.kind === "parameter") {
    return command.flags.some((flag) => flag.pointer === element.pointer);
  }

  if (element.kind === "requestMedia") {
    return command.requestMedia.includes(element.mediaType);
  }

  if (element.kind === "response") {
    return command.responses.includes(element.key);
  }

  if (element.kind === "securityAlternative") {
    return command.security.some((schemes) => schemeSet(schemes) === schemeSet(element.schemes));
  }

  return element.kind === "operation" || command.servers.includes(element.url);
};

/**
 * Joins the walk with `--describe` and the generation report (design 8.3, R11).
 *
 * - An operation is accounted for by a command at its `(document, pointer)`, or by an operation- or
 *   document-scope refusal.
 * - An element under an operation is accounted for when every command for THAT operation (its primary
 *   name and each `x-forge-aliases` alias, design 8.3 Aliases) carries it: a parameter by flag
 *   pointer, request media and response keys by value as the spec spells them, a security
 *   alternative by scheme set, a server by URL.
 * - An inherited element (path-item parameter, path-item or root server, root security alternative)
 *   is accounted for when every operation that inherits it is refused or every command of it
 *   carries it; with no inheriting operation it affects no request.
 * - An element-scope refusal covers its pointer and descendants; an operation-scope refusal its
 *   subtree and that operation's inherited elements; a document-scope refusal its document.
 * - A notice covers only the element at its exact pointer, never an operation; such elements are
 *   listed in `byNotice`.
 *
 * A command whose pointer is no walked operation is invented, as is a command's request media,
 * response key, security alternative or server that its operation neither declares nor inherits,
 * except the default `/` server when no level declares servers.
 */
export const coverageOf = (input: CoverageInput): Effect.Effect<Coverage, CoverageError> =>
  Effect.gen(function* coverage() {
    const entry = input.resolution.document;
    const label = (document: string) => labelOf(entry, document);
    const elements = yield* walk(input.resolution);
    const description = yield* decodeDescription(input.describe);
    const report = yield* decodeReport(input.report);

    const labelled = (records: typeof report.refusals) =>
      records.map((record) => ({ ...record, document: label(record.document) }));
    const refusals = labelled(report.refusals);
    const notices = new Set(
      labelled(report.notices).map((record) => key(record.document, record.pointer)),
    );
    const siteOf = (element: WalkElement) => key(label(element.document), element.pointer);

    const operations = new Map(
      elements.flatMap((element): readonly (readonly [string, Operation])[] =>
        element.kind === "operation" ? [[siteOf(element), element]] : [],
      ),
    );
    const commandsOf = (operation: Operation): readonly Command[] =>
      description.commands.filter(
        (command) => key(command.document, command.pointer) === siteOf(operation),
      );
    const ownerOf = (element: WalkElement): Operation | undefined =>
      [...operations.values()].find(
        (operation) =>
          operation.document === element.document && within(element.pointer, operation.pointer),
      );

    const refused = (operation: Operation): boolean =>
      refusals.some(
        (record) =>
          record.document === label(operation.document) &&
          (record.scope === "document" ||
            (record.scope === "operation" && within(operation.pointer, record.pointer))),
      );
    // An element- or operation-scope refusal covers its subtree; never used for an operation.
    const refusedElement = (element: WalkElement): boolean =>
      refusals.some(
        (record) =>
          record.document === label(element.document) &&
          (record.scope === "document" || within(element.pointer, record.pointer)),
      );
    // Every command of the operation (its primary name and each alias) must carry the element; an
    // operation with no command carries nothing.
    const carried = (operation: Operation, element: WalkElement): boolean => {
      const commands = commandsOf(operation);

      return (
        refused(operation) ||
        (commands.length > 0 && commands.every((command) => carries(command, element)))
      );
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

      return [...operations.values()]
        .filter((operation) => operation.inherits.includes(element.pointer))
        .every((operation) => carried(operation, element));
    };

    const noticed = (element: WalkElement): boolean =>
      element.kind !== "operation" && notices.has(siteOf(element));

    const invented = description.commands.flatMap((command): readonly Invented[] => {
      const site = { document: command.document, path: command.path, pointer: command.pointer };
      const operation = operations.get(key(command.document, command.pointer));
      if (operation === undefined) {
        return [{ ...site, kind: "command" }];
      }

      const effective = elements.filter(
        (element) => ownerOf(element) === operation || operation.inherits.includes(element.pointer),
      );
      const declares = (matches: (element: WalkElement) => boolean) => effective.some(matches);

      return [
        ...command.requestMedia
          .filter(
            (mediaType) =>
              !declares(
                (element) => element.kind === "requestMedia" && element.mediaType === mediaType,
              ),
          )
          .map((mediaType): Invented => ({ ...site, kind: "requestMedia", mediaType })),
        ...command.responses
          .filter(
            (responseKey) =>
              !declares((element) => element.kind === "response" && element.key === responseKey),
          )
          .map((responseKey): Invented => ({ ...site, key: responseKey, kind: "response" })),
        ...command.security
          .filter(
            (schemes) =>
              !declares(
                (element) =>
                  element.kind === "securityAlternative" &&
                  schemeSet(element.schemes) === schemeSet(schemes),
              ),
          )
          .map((schemes): Invented => ({ ...site, kind: "securityAlternative", schemes })),
        ...command.servers
          .filter(
            (url) =>
              !(operation.defaultServer && url === "/") &&
              !declares((element) => element.kind === "server" && element.url === url),
          )
          .map((url): Invented => ({ ...site, kind: "server", url })),
      ];
    });

    return {
      byNotice: elements.filter((element) => !generated(element) && noticed(element)),
      invented,
      missing: elements.filter((element) => !generated(element) && !noticed(element)),
    };
  });

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
