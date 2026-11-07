import { Array as Arr, Data, Effect, FileSystem, Option, Order, Schema } from "effect";
import type { Path, PlatformError, Stream, Types } from "effect";
import { stringLiteral } from "./emit/escape.ts";
import { emitApi } from "./emit/api.ts";
import type { ApiEmitError } from "./emit/api.ts";
import { emitCli } from "./emit/cli.ts";
import type { CliEmitError, CliRefusal } from "./emit/cli.ts";
import { emitDomainSchemas } from "./emit/domain.ts";
import type { DomainEmitError } from "./emit/domain.ts";
import { emitScaffold } from "./emit/index.ts";
import { PackageEmitError } from "./emit/package.ts";
import type { EmittedFile, GeneratorSource } from "./emit/package.ts";
import type { PrinterError } from "./emit/printer.ts";
import { checkSpecText } from "./check/index.ts";
import { defaultLimits, loadBytes } from "./load/index.ts";
import type { LoadRefusal } from "./load/index.ts";
import { duplicateUri } from "./load/document-set.ts";
import type { DocumentSet } from "./load/document-set.ts";
import { readFileBounded, readStreamBounded } from "./load/budget.ts";
import { decodeAuthorConfig } from "./model/author-config.ts";
import type { AuthorConfig } from "./model/author-config.ts";
import type { DocumentUri } from "./model/brands.ts";
import { Diagnostic, sortDiagnostics } from "./model/diagnostic.ts";
import { Api } from "./model/entities.ts";
import type { Operation } from "./model/entities.ts";
import { planNames } from "./names/index.ts";
import { overrideSite } from "./names/plan.ts";
import type { NamePlan, PlannedCommand, PlannedGroup } from "./names/index.ts";
import { normalize } from "./normalize/index.ts";
import type { NormalizeError } from "./normalize/index.ts";
import { distinctDiagnostics } from "./normalize/operations.ts";
import { normalizeSchemas } from "./normalize/schemas.ts";
import type { SchemaBudgetExceeded, SchemaImportDefect } from "./normalize/schemas.ts";
import { boundOrigins } from "./normalize/servers.ts";
import {
  makeGenerationReport,
  nonStandardEntries,
  printGenerationReport,
  skippedEntries,
} from "./report/index.ts";
import type { GenerationReportValue } from "./report/index.ts";
import { resolve } from "./resolve/index.ts";
import type { Resolution, ResolveMember } from "./resolve/index.ts";
import { diagnoseDocument } from "./validate/index.ts";
import type {
  SchemaManifestError,
  UnsupportedOpenApiVersion,
  ValidatorError,
} from "./validate/index.ts";
import { lineOf } from "./validate/dispatch.ts";
import type { InvalidInstanceLocation } from "./validate/locations.ts";
import { writeFiles } from "./write/index.ts";
import type { WriteNotice, WriteRefused } from "./write/index.ts";
import type { RunLockHeld, RunLockUnavailable } from "./write/lock.ts";
import { sha256Hex } from "./write/manifest.ts";
import { patchVersion, specSectionUrl } from "./model/spec-section.ts";

type Document = typeof DocumentUri.Type;

/**
 * Where the specification's bytes come from: a file, or a byte stream such as stdin. Either is
 * read through the loader's byte limit.
 */
export type SpecSource =
  | { readonly _tag: "File"; readonly path: string }
  | {
      readonly _tag: "Stream";
      readonly stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
    };

/**
 * One generator run: the specification, its retrieval URI, the other documents `$ref` may resolve
 * over, the output directory, `--strict`, and the generator's own `package.json` and
 * `tsconfig.json` (the emitted pins and the report's version), which the caller reads.
 */
export interface GenerateInput {
  readonly document: Document;
  /**
   * The document set (`--document`, `--ref-root`; design 3.3). Absent, the set is the entry alone.
   */
  readonly documents?: DocumentSet;
  readonly generator: GeneratorSource;
  readonly outDir: string;
  readonly source: SpecSource;
  readonly strict: boolean;
}

/**
 * The author config file and the URI its diagnostics name.
 */
export interface GenerateConfig {
  readonly document: Document;
  readonly path: string;
}

/**
 * A written run: every diagnostic in diagnostic order, the paths written (sorted), the writer's
 * notices about previous-manifest files, and the report written as `generation-report.json`.
 */
export interface GenerateResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly files: readonly string[];
  readonly notices: readonly WriteNotice[];
  readonly report: GenerationReportValue;
}

/**
 * Nothing was written (design 8.1 exit 1): the author config cannot be used, the document is
 * refused, or `--strict` met a refusal. `diagnostics` are the run's diagnostics so far.
 */
export class GenerateRefused extends Data.TaggedError("GenerateRefused")<{
  readonly diagnostics: readonly Diagnostic[];
  readonly reason: "config" | "document" | "strict";
}> {}

/**
 * Every way `generate` can fail. Besides `GenerateRefused` and the writer's errors, the rest are
 * defects of earlier stages or of the generator's own data, kept typed so the caller decides.
 */
export type GenerateError =
  | ApiEmitError
  | CliEmitError
  | DomainEmitError
  | GenerateRefused
  | InvalidInstanceLocation
  | NormalizeError
  | PackageEmitError
  | PrinterError
  | RunLockHeld
  | RunLockUnavailable
  | SchemaBudgetExceeded
  | SchemaImportDefect
  | SchemaManifestError
  | Schema.SchemaError
  | UnsupportedOpenApiVersion
  | ValidatorError
  | WriteRefused;

const reportPath = "generation-report.json";

const emitHints: Readonly<Record<CliRefusal["reason"], string | undefined>> = {
  "unsupported-body":
    "Text and form request bodies, and multipart bodies the runtime writer cannot send exactly, are not emitted yet.",
  "unsupported-flag": undefined,
  "unsupported-parameter": undefined,
};

const GeneratorVersion = Schema.Struct({ version: Schema.String });

const DeclaredOpenapi = Schema.Struct({ openapi: Schema.String });

const isRefusal = (diagnostic: Diagnostic): boolean => diagnostic.severity === "refusal";

const isDocumentRefusal = (diagnostic: Diagnostic): boolean =>
  isRefusal(diagnostic) && diagnostic.scope === "document";

const refused =
  (reason: GenerateRefused["reason"]) =>
  (diagnostics: readonly Diagnostic[]): GenerateRefused =>
    new GenerateRefused({ diagnostics, reason });

const readSpec = (
  input: GenerateInput,
): Effect.Effect<Uint8Array, LoadRefusal, FileSystem.FileSystem> =>
  input.source._tag === "File"
    ? readFileBounded(input.source.path, defaultLimits, input.document)
    : readStreamBounded(input.source.stream, defaultLimits, input.document);

const readConfig = (
  config: GenerateConfig,
): Effect.Effect<
  { readonly bytes: Uint8Array; readonly value: AuthorConfig },
  GenerateRefused,
  FileSystem.FileSystem
> =>
  Effect.gen(function* read() {
    const bytes = yield* readFileBounded(config.path, defaultLimits, config.document);
    const loaded = yield* loadBytes(bytes, { document: config.document });

    return { bytes, json: loaded.value };
  }).pipe(
    Effect.mapError((refusal) => refused("config")([refusal.diagnostic])),
    Effect.flatMap(({ bytes, json }) =>
      decodeAuthorConfig(json, { document: config.document }).pipe(
        Effect.mapError((refusal) => refused("config")(refusal.diagnostics)),
        Effect.map((value) => ({ bytes, value })),
      ),
    ),
  );

// The set's documents other than the entry, in set order, each with the hash of the bytes it parsed.
const memberInputs = (entry: Document, documents: DocumentSet | undefined) =>
  [...(documents?.documents ?? [])].flatMap(([document, member]) =>
    document === entry ? [] : [{ document, sha256: member.sha256 }],
  );

// The real path of `path`, or undefined when it has none.
const realPathOf = (path: string) =>
  Effect.gen(function* real() {
    const fs = yield* FileSystem.FileSystem;

    return Option.getOrUndefined(yield* Effect.option(fs.realPath(path)));
  });

/**
 * The set's documents other than the entry, in set order, each with the line it declares (the
 * entry's when it declares none the generator reads). A member under the entry's own retrieval URI
 * is the entry when it is the same file, as when `--ref-root` holds the entry; under that URI any
 * other file is refused as `REF-16/duplicate-uri`, never chosen between.
 */
export const setMembers = (
  entry: { readonly document: Document; readonly source: SpecSource },
  documents: DocumentSet | undefined,
): Effect.Effect<readonly ResolveMember[], LoadRefusal, FileSystem.FileSystem> =>
  Effect.gen(function* members() {
    const found: ResolveMember[] = [];

    for (const [document, member] of documents?.documents ?? []) {
      if (document === entry.document) {
        const entryPath =
          entry.source._tag === "File" ? yield* realPathOf(entry.source.path) : undefined;
        if (entryPath === undefined || entryPath !== (yield* realPathOf(member.path))) {
          return yield* duplicateUri({ path: member.path, uri: document });
        }
      } else {
        const line = yield* Effect.option(lineOf(member.value));
        found.push(
          Option.isSome(line)
            ? { document, line: line.value, value: member.value }
            : { document, value: member.value },
        );
      }
    }

    return found;
  });

const pathItemSite = /^\/paths\/[^/]+$/u;

/**
 * Design 3.3, `PTH-10`: a Path Item under `paths` whose `$ref` ends in another document of the set
 * is refused at element scope. Assembly and the spec-text checks walk the entry's sites only, so
 * without this its operations would be left out with no diagnostic.
 */
export const otherDocumentPathItems = (
  resolution: Resolution,
): Effect.Effect<readonly Diagnostic[]> => {
  const openapi = Option.match(Schema.decodeUnknownOption(DeclaredOpenapi)(resolution.value), {
    onNone: () => patchVersion[resolution.line],
    onSome: (found) => found.openapi,
  });
  const references = [...resolution.references.values()].filter(
    (reference) =>
      reference.kind === "pathItem" &&
      reference.site.document === resolution.document &&
      pathItemSite.test(reference.site.pointer) &&
      reference.target.document !== resolution.document,
  );

  return Effect.all(
    references.map((reference) =>
      Schema.decodeUnknownEffect(Diagnostic)({
        code: "PTH-10/other-document",
        document: resolution.document,
        element: "Path Item",
        hint: "Path Items are read from the entry document only; move this one into it.",
        message:
          "The Path Item is a reference into another document of the set; its operations are not generated.",
        openapi,
        pointer: reference.site.pointer,
        related: [reference.target],
        row: "PTH-10",
        scope: "element",
        severity: "refusal",
        specSection: specSectionUrl(resolution.line, "path-item-ref"),
      }).pipe(Effect.orDie),
    ),
  );
};

const sameKey = (operation: Operation, method: string, path: string): boolean =>
  operation.key.method === method && operation.key.path === path;

// Operations an operation-scope spec-text refusal names (PTH-03, PTH-04, PTH-08, PTH-28, STY-44
// and the rest of design 3.4) are absent from the model, as normalize's own refusals are (2.4).
const withoutRefused = (api: Api, checked: readonly Diagnostic[]): Api => {
  const named = checked.flatMap((diagnostic) =>
    isRefusal(diagnostic) && diagnostic.scope === "operation" && diagnostic.operation !== undefined
      ? [diagnostic.operation]
      : [],
  );
  const operations = api.operations.filter(
    (operation) => !named.some((key) => sameKey(operation, key.method, key.path)),
  );

  return operations.length === api.operations.length
    ? api
    : new Api({
        documents: api.documents,
        entry: api.entry,
        info: api.info,
        informational: api.informational,
        line: api.line,
        openapi: api.openapi,
        operations,
        origin: api.origin,
        rows: api.rows,
        schemas: api.schemas,
        securitySchemes: api.securitySchemes,
        servers: api.servers,
        tags: api.tags,
      });
};

// The code-generation copy's roots (design 3.5): every schema a request parameter or body uses.
const requestRoots = (api: Api): readonly string[] =>
  Arr.dedupe(
    api.operations.flatMap((operation) => [
      ...operation.parameters.flatMap((parameter) => [
        parameter.schema.key,
        ...(parameter.serialization.kind === "content" ? [parameter.serialization.schema.key] : []),
      ]),
      ...(operation.body?.alternatives ?? []).flatMap((alternative) => [
        ...(alternative.schema === undefined ? [] : [alternative.schema.key]),
        ...(alternative.itemSchema === undefined ? [] : [alternative.itemSchema.key]),
      ]),
    ]),
  );

interface CommandAt {
  readonly command: PlannedCommand;
  readonly path: readonly string[];
}

// Every planned command with its visible path, in the order `--describe` walks the tree (design
// 8.3): top-level groups in plan order, each group's commands before its child groups, then the
// root's commands.
const commandOrder = (plan: NamePlan): readonly CommandAt[] => {
  const byTag = new Map(plan.groups.map((group) => [group.tag, group]));
  const namesOf = (group: PlannedGroup): readonly string[] => {
    const parent = group.parent === undefined ? undefined : byTag.get(group.parent);

    return [...(parent === undefined ? [] : namesOf(parent)), group.name];
  };
  const walk = (group: PlannedGroup): readonly CommandAt[] => [
    ...group.commands.map((command) => ({ command, path: [...namesOf(group), command.name] })),
    ...plan.groups.filter((child) => child.parent === group.tag).flatMap(walk),
  ];

  return [
    ...plan.groups.filter((group) => group.parent === undefined).flatMap(walk),
    ...plan.root.map((command) => ({ command, path: [command.name] })),
  ];
};

const refusedBy = (refusals: readonly CliRefusal[], operation: Operation): boolean =>
  refusals.some((refusal) => sameKey(operation, refusal.operation.method, refusal.operation.path));

type CommandName = GenerationReportValue["commandNames"][number];

const commandName = ({ command, path }: CommandAt): CommandName => {
  const name: Types.Mutable<CommandName> = {
    command: command.sources.command,
    document: command.operation.origin.document,
    group: command.sources.group,
    path,
    pointer: command.operation.origin.pointer,
  };
  if (command.alias !== undefined) {
    name.alias = command.alias;
  }

  return name;
};

// Design 8.1 `commandNames`: the emitted commands, so none of a refused operation's names.
const commandNames = (
  order: readonly CommandAt[],
  refusals: readonly CliRefusal[],
): GenerationReportValue["commandNames"] =>
  order.flatMap((entry) =>
    refusedBy(refusals, entry.command.operation) ? [] : [commandName(entry)],
  );

// `emitCli` refuses each command of an operation alone, and an operation's commands share its
// flags, so its primary and alias commands are refused for one reason: keep the first of each.
const refusedOperations = (refusals: readonly CliRefusal[]): readonly CliRefusal[] =>
  Arr.dedupeWith(
    refusals,
    (left, right) =>
      left.operation.method === right.operation.method &&
      left.operation.path === right.operation.path &&
      left.reason === right.reason &&
      left.subject === right.subject,
  );

// Design 8.4 `EMT-1`: one operation-scope refusal per operation `emitCli` could not express,
// naming every command of the operation that is not generated.
const emitRefusal = (
  api: Api,
  refusal: CliRefusal,
  order: readonly CommandAt[],
): Effect.Effect<Diagnostic> =>
  Effect.gen(function* map() {
    const operation = api.operations.find((candidate) =>
      sameKey(candidate, refusal.operation.method, refusal.operation.path),
    );
    if (operation === undefined) {
      return yield* Effect.die("emitCli refused an operation the model does not hold");
    }

    const { method, path } = operation.key;
    const names = order.flatMap((entry) =>
      sameKey(entry.command.operation, method, path) ? [stringLiteral(entry.path.join(" "))] : [],
    );
    const needs = stringLiteral(refusal.subject);
    const message =
      names.length > 1
        ? `The commands ${names.join(", ")} are not generated: they need ${needs}.`
        : `The command is not generated: it needs ${needs}.`;
    const key =
      operation.operationId === undefined
        ? { method, path }
        : { method, operationId: operation.operationId, path };
    const base = {
      code: `EMT-1/${refusal.reason}`,
      document: operation.origin.document,
      element: "Emitted command",
      message,
      openapi: api.openapi,
      operation: key,
      pointer: operation.origin.pointer,
      row: "EMT-1",
      scope: refusal.scope,
      severity: "refusal",
      specSection: specSectionUrl(api.line, "operation-object"),
    };
    const hint = emitHints[refusal.reason];
    const fields = hint === undefined ? base : { ...base, hint };

    return yield* Schema.decodeUnknownEffect(Diagnostic)(fields).pipe(Effect.orDie);
  });

// The accepted servers' templates in model order: root servers, then each operation's.
const acceptedServers = (api: Api): readonly string[] =>
  Arr.dedupe(
    [...api.servers, ...api.operations.flatMap((operation) => operation.servers)].flatMap(
      (server) => (server.accepted ? [server.template] : []),
    ),
  );

interface Analysis {
  readonly api: Api;
  readonly diagnostics: readonly Diagnostic[];
  readonly order: readonly Document[];
  readonly resolution: Resolution;
}

// Stages 1 to 6 (design 3): load, validate, resolve, check and normalize. A document-scope
// refusal at any of them fails with every diagnostic seen so far.
const analyze = (
  input: GenerateInput,
  bytes: Uint8Array,
  config: AuthorConfig,
  configDocument: Document,
) =>
  Effect.gen(function* analyzeGen() {
    const { document } = input;
    const members = yield* setMembers(input, input.documents).pipe(
      Effect.mapError((refusal) => refused("document")([refusal.diagnostic])),
    );
    const documents = [document, ...members.map((member) => member.document), configDocument];
    const order = (diagnostics: readonly Diagnostic[]) =>
      sortDiagnostics(documents, distinctDiagnostics(diagnostics));
    const loaded = yield* loadBytes(bytes, { document }).pipe(
      Effect.mapError((refusal) => refused("document")([refusal.diagnostic])),
    );
    const line = yield* lineOf(loaded.value);
    const diagnosis = yield* diagnoseDocument(loaded.value, document);
    const validated = [
      ...diagnosis.notices,
      ...diagnosis.refusals.map((entry) => entry.diagnostic),
    ];
    if (diagnosis.refusals.length > 0) {
      return yield* refused("document")(order(validated));
    }

    const resolution = yield* resolve({ document, line, members, value: loaded.value }).pipe(
      Effect.mapError((refusal) => refused("document")(order([...validated, refusal.diagnostic]))),
    );
    const checked = yield* checkSpecText(resolution);
    const outside = yield* otherDocumentPathItems(resolution);
    const early = [...validated, ...resolution.diagnostics, ...checked, ...outside];
    if (early.some(isDocumentRefusal)) {
      return yield* refused("document")(order(early));
    }

    const normalized = yield* normalize(resolution, { config, configDocument });
    const api = withoutRefused(normalized.api, checked);
    const diagnostics = order([...early, ...normalized.diagnostics]);
    if (diagnostics.some(isDocumentRefusal)) {
      return yield* refused("document")(diagnostics);
    }

    const analysis: Analysis = { api, diagnostics, order: documents, resolution };

    return analysis;
  });

/**
 * Generates a CLI package (design 3, D-AD14): load, validate, resolve over the document set, check,
 * normalize, plan names, emit `domain/`, `api/`, `cli/` and the scaffold, then write every file and
 * `generation-report.json` in one run. A document-scope refusal stops before emission and writes
 * nothing; an operation or element refusal leaves that element out and writes the rest; under
 * `strict` any refusal writes nothing. Each operation `emitCli` refuses becomes one `EMT-1`
 * diagnostic (design 8.4), so none of its commands is emitted and the report lists it; the report's
 * `commandNames` lists every emitted command with the sources of its names (design 8.1).
 */
export const generate = (
  input: GenerateInput,
  config: GenerateConfig,
): Effect.Effect<GenerateResult, GenerateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* generateGen() {
    const { document } = input;
    const configDocument = config.document;
    const author = yield* readConfig(config);
    const bytes = yield* readSpec(input).pipe(
      Effect.mapError((refusal) => refused("document")([refusal.diagnostic])),
    );
    const {
      api,
      diagnostics: analyzed,
      order,
      resolution,
    } = yield* analyze(input, bytes, author.value, configDocument);
    // Each servers table binds the origins of its own level only (design 6.4), so a credential
    // for one operation never reaches a host accepted only for another or only at the root.
    const serversContext = { config: author.value, configDocument, document, openapi: api.openapi };
    const bound = boundOrigins(api.servers, serversContext);
    const plan = yield* planNames(api, {
      config: author.value,
      configDocument,
      strict: input.strict,
    });
    const planned = sortDiagnostics(
      order,
      distinctDiagnostics([...analyzed, ...bound.diagnostics, ...plan.diagnostics]),
    );
    if (planned.some(isDocumentRefusal)) {
      return yield* refused("document")(planned);
    }

    // normalize keeps the stored schemas only; the domain emitter reads their validation copy.
    const schemas = yield* normalizeSchemas(resolution);
    const domain = yield* emitDomainSchemas(
      schemas.validation.definitions,
      requestRoots(api),
      plan.domain,
    );
    const apiFiles = yield* emitApi({
      api,
      boundOrigins: (servers) => boundOrigins(servers, serversContext).origins,
      plan,
    });
    const cli = yield* emitCli({ api, config: author.value, plan });
    const commands = commandOrder(plan);
    const emitted = yield* Effect.all(
      refusedOperations(cli.refusals).map((refusal) => emitRefusal(api, refusal, commands)),
    );
    const diagnostics = sortDiagnostics(order, distinctDiagnostics([...planned, ...emitted]));
    if (input.strict && diagnostics.some(isRefusal)) {
      return yield* refused("strict")(diagnostics);
    }

    const scaffold = yield* emitScaffold({
      api,
      config: author.value,
      diagnostics,
      generator: input.generator,
      plan,
    });
    const { version } = yield* Schema.decodeUnknownEffect(GeneratorVersion)(
      input.generator.packageJson,
    ).pipe(Effect.mapError(() => new PackageEmitError({ reason: "invalid-generator-source" })));
    const report = makeGenerationReport({
      acceptedServers: acceptedServers(api),
      commandNames: commandNames(commands, cli.refusals),
      diagnostics,
      inputs: [
        { document, sha256: sha256Hex(bytes) },
        ...memberInputs(document, input.documents),
        { document: configDocument, sha256: sha256Hex(author.bytes) },
      ],
      nonStandard: nonStandardEntries(api, order),
      // The names plan reports renames as notices only; it carries no from/to pairs yet.
      renames: [],
      schemes: api.securitySchemes,
      // The names plan emits no command for these (design 8.2); the same rule picks them here.
      skipped: skippedEntries(
        api.operations.filter(
          (operation) => overrideSite(author.value, operation).override?.skip === true,
        ),
        order,
      ),
      version,
    });
    const files: readonly EmittedFile[] = [
      domain,
      ...apiFiles,
      ...cli.files,
      ...scaffold,
      { content: yield* printGenerationReport(report), path: reportPath },
    ];
    const notices = yield* writeFiles(input.outDir, files);

    return {
      diagnostics,
      files: Arr.sort(
        files.map((file) => file.path),
        Order.String,
      ),
      notices,
      report,
    };
  });
