import { Array as Arr, Data, Effect, Order, Schema } from "effect";
import type { FileSystem, Path, PlatformError, Stream } from "effect";
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
import { readFileBounded, readStreamBounded } from "./load/budget.ts";
import { decodeAuthorConfig } from "./model/author-config.ts";
import type { AuthorConfig } from "./model/author-config.ts";
import type { DocumentUri } from "./model/brands.ts";
import { Diagnostic, sortDiagnostics } from "./model/diagnostic.ts";
import { Api } from "./model/entities.ts";
import type { Operation } from "./model/entities.ts";
import { planNames } from "./names/index.ts";
import { normalize } from "./normalize/index.ts";
import type { NormalizeError } from "./normalize/index.ts";
import { distinctDiagnostics } from "./normalize/operations.ts";
import { normalizeSchemas } from "./normalize/schemas.ts";
import type { SchemaBudgetExceeded, SchemaImportDefect } from "./normalize/schemas.ts";
import { boundOrigins } from "./normalize/servers.ts";
import { makeGenerationReport, printGenerationReport } from "./report/index.ts";
import type { GenerationReportValue } from "./report/index.ts";
import { resolve } from "./resolve/index.ts";
import type { Resolution } from "./resolve/index.ts";
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
 * One generator run: the specification, its retrieval URI, the output directory, `--strict`, and
 * the generator's own `package.json` and `tsconfig.json` (the emitted pins and the report's
 * version), which the caller reads.
 */
export interface GenerateInput {
  readonly document: Document;
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

const patch = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.1" } as const;

const emitHints: Readonly<Record<CliRefusal["reason"], string | undefined>> = {
  "unsupported-body": "Text, XML, form and multipart request bodies are not emitted yet.",
  "unsupported-flag": undefined,
  "unsupported-parameter": undefined,
};

const GeneratorVersion = Schema.Struct({ version: Schema.String });

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

// Design 8.4 `EMT-1`: one operation-scope refusal per command `emitCli` could not express.
const emitRefusal = (api: Api, refusal: CliRefusal): Effect.Effect<Diagnostic> =>
  Effect.gen(function* map() {
    const operation = api.operations.find((candidate) =>
      sameKey(candidate, refusal.operation.method, refusal.operation.path),
    );
    if (operation === undefined) {
      return yield* Effect.die("emitCli refused an operation the model does not hold");
    }

    const { method, path } = operation.key;
    const key =
      operation.operationId === undefined
        ? { method, path }
        : { method, operationId: operation.operationId, path };
    const base = {
      code: `EMT-1/${refusal.reason}`,
      document: operation.origin.document,
      element: "Emitted command",
      message: `The command is not generated: it needs ${stringLiteral(refusal.subject)}.`,
      openapi: api.openapi,
      operation: key,
      pointer: operation.origin.pointer,
      row: "EMT-1",
      scope: refusal.scope,
      severity: "refusal",
      specSection: `https://spec.openapis.org/oas/v${patch[api.line]}.html#operation-object`,
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
    const order = (diagnostics: readonly Diagnostic[]) =>
      sortDiagnostics([document, configDocument], distinctDiagnostics(diagnostics));
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

    const resolution = yield* resolve({ document, line, value: loaded.value }).pipe(
      Effect.mapError((refusal) => refused("document")(order([...validated, refusal.diagnostic]))),
    );
    const checked = yield* checkSpecText(resolution);
    const early = [...validated, ...resolution.diagnostics, ...checked];
    if (early.some(isDocumentRefusal)) {
      return yield* refused("document")(order(early));
    }

    const normalized = yield* normalize(resolution, { config, configDocument });
    const api = withoutRefused(normalized.api, checked);
    const diagnostics = order([...early, ...normalized.diagnostics]);
    if (diagnostics.some(isDocumentRefusal)) {
      return yield* refused("document")(diagnostics);
    }

    const analysis: Analysis = { api, diagnostics, resolution };

    return analysis;
  });

/**
 * Generates a CLI package (design 3, D-AD14): load, validate, resolve, check, normalize, plan
 * names, emit `domain/`, `api/`, `cli/` and the scaffold, then write every file and
 * `generation-report.json` in one run. A document-scope refusal stops before emission and writes
 * nothing; an operation or element refusal leaves that element out and writes the rest; under
 * `strict` any refusal writes nothing. Each `CliRefusal` becomes an `EMT-1` diagnostic (design
 * 8.4), so its command is absent and the report lists it.
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
      resolution,
    } = yield* analyze(input, bytes, author.value, configDocument);
    const bound = boundOrigins(
      [...api.servers, ...api.operations.flatMap((operation) => operation.servers)],
      { config: author.value, configDocument, document, openapi: api.openapi },
    );
    const plan = yield* planNames(api, {
      config: author.value,
      configDocument,
      strict: input.strict,
    });
    const planned = sortDiagnostics(
      [document, configDocument],
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
    const apiFiles = yield* emitApi({ api, boundOrigins: bound.origins, plan });
    const cli = yield* emitCli({ api, config: author.value, plan });
    const emitted = yield* Effect.all(cli.refusals.map((refusal) => emitRefusal(api, refusal)));
    const diagnostics = sortDiagnostics(
      [document, configDocument],
      distinctDiagnostics([...planned, ...emitted]),
    );
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
      diagnostics,
      inputs: [
        { document, sha256: sha256Hex(bytes) },
        { document: configDocument, sha256: sha256Hex(author.bytes) },
      ],
      // The names plan reports renames as notices only; it carries no from/to pairs yet.
      renames: [],
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
