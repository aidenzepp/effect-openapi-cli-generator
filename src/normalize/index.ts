import { Array as Arr, Effect, Option, Order, Record, Schema } from "effect";
import type { Types } from "effect";
import { sanitizeProse } from "../emit/help.ts";
import type { AuthorConfig } from "../model/author-config.ts";
import { JsonPointer } from "../model/brands.ts";
import type { DocumentUri } from "../model/brands.ts";
import { sortDiagnostics } from "../model/diagnostic.ts";
import type { Diagnostic } from "../model/diagnostic.ts";
import { Api } from "../model/entities.ts";
import { defaultLimits } from "../resolve/index.ts";
import type { ResolveLimits, Resolution } from "../resolve/index.ts";
import type { Json } from "../model/pointer.ts";
import { collectInformational } from "./informational.ts";
import { assembleOperations, distinctDiagnostics } from "./operations.ts";
import type { OperationsError } from "./operations.ts";
import { normalizeSchemas } from "./schemas.ts";
import type { SchemaBudgetExceeded, SchemaImportDefect } from "./schemas.ts";
import { normalizeSecurityPolicy, normalizeSecuritySchemes } from "./security.ts";
import { effectiveServers } from "./servers.ts";
import type { ServersContext } from "./servers.ts";

/**
 * What normalization needs besides the resolution: the author config, the document it came from,
 * and the findings the spec-text check stage raised for this run (`checkSpecText`).
 */
export interface NormalizeContext {
  readonly checkFindings: readonly Diagnostic[];
  readonly config: AuthorConfig;
  readonly configDocument: typeof DocumentUri.Type;
}

/**
 * The normalized `Api` and every diagnostic its stages raised, in document order (design 3.7).
 */
export interface Normalization {
  readonly api: Api;
  readonly diagnostics: readonly Diagnostic[];
}

export type NormalizeError = OperationsError | SchemaBudgetExceeded | SchemaImportDefect;

// The root `servers` site, a constant, decoded once.
const serversPointer = JsonPointer.make("/servers");

const Described = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
});

const Tag = Schema.Struct({
  ...Described.fields,
  kind: Schema.optionalKey(Schema.String),
  name: Schema.NonEmptyString,
  parent: Schema.optionalKey(Schema.String),
});

const Root = Schema.Struct({
  info: Schema.optionalKey(Described),
  openapi: Schema.String,
  servers: Schema.optionalKey(Schema.Json),
  tags: Schema.optionalKey(Schema.Array(Schema.Json)),
});

const docsOf = (
  fields: typeof Described.Type | undefined,
): Types.Mutable<typeof Api.Encoded.info> => {
  const docs: Types.Mutable<typeof Api.Encoded.info> = {};
  if (fields?.description !== undefined) {
    docs.description = sanitizeProse(fields.description);
  }

  if (fields?.summary !== undefined) {
    docs.summary = sanitizeProse(fields.summary);
  }

  return docs;
};

type PlainTag = Types.Mutable<(typeof Api.Encoded.tags)[number]>;

const tagOf = (entry: Json): readonly PlainTag[] => {
  const found = Schema.decodeUnknownOption(Tag)(entry);
  if (Option.isNone(found)) {
    return [];
  }

  const tag: PlainTag = { name: found.value.name };
  const docs: Record<string, string> = docsOf(found.value);
  if (!Record.isEmptyRecord(docs)) {
    tag.docs = docs;
  }

  if (found.value.kind !== undefined) {
    tag.kind = found.value.kind;
  }

  if (found.value.parent !== undefined) {
    tag.parent = found.value.parent;
  }

  return [tag];
};

// Tags in document order; an entry that is not a Tag Object with a name is not read here.
const tagsOf = (entries: readonly Json[] | undefined): readonly PlainTag[] =>
  (entries ?? []).flatMap(tagOf);

const storeOf = (definitions: ReadonlyMap<string, unknown>) => ({
  $defs: Object.fromEntries(
    Arr.sort(
      [...definitions].map(([key, node]) => [key, node] as const),
      Order.mapInput(Order.String, ([key]: readonly [string, unknown]) => key),
    ),
  ),
});

/**
 * Builds the `Api` from the resolved entry document (design 2.2, 3.5): the document's info and
 * tags, its root servers, security schemes and schema store, the informational elements, and the
 * operations of `assembleOperations`. The diagnostics are those of every normalization stage, with
 * repeats dropped, in the order of design 3.7: document, then pointer token by token, then code.
 * Earlier stages (validation, resolution, spec-text checks) report their own.
 */
export const normalize = Effect.fn("normalize.normalize")(function* normalize(
  resolution: Resolution,
  context: NormalizeContext,
  limits: ResolveLimits = defaultLimits,
): Effect.fn.Return<Normalization, NormalizeError> {
  const root = Schema.decodeUnknownOption(Root)(resolution.value);
  const openapi = Option.match(root, { onNone: () => resolution.line, onSome: (r) => r.openapi });
  const fields = Option.getOrUndefined(root);
  const servers: ServersContext = {
    config: context.config,
    configDocument: context.configDocument,
    document: resolution.document,
    openapi,
  };
  const schemes = yield* normalizeSecuritySchemes(
    resolution,
    { config: context.config, configDocument: context.configDocument },
    context.checkFindings,
  );
  const schemas = yield* normalizeSchemas(resolution, { maxNodes: limits.maxNodes });
  const assembly = yield* assembleOperations(
    resolution,
    schemes,
    servers,
    context.checkFindings,
    limits,
  );
  const policy = yield* normalizeSecurityPolicy(resolution, schemes);
  const rootServers = effectiveServers(
    {
      root: {
        pointer: serversPointer,
        value: fields?.servers,
      },
    },
    servers,
  );
  const api = yield* Schema.decodeUnknownEffect(Api)({
    documents: [...resolution.documents.keys()],
    entry: resolution.document,
    info: docsOf(fields?.info),
    informational: yield* collectInformational(resolution),
    line: resolution.line,
    openapi,
    operations: assembly.operations,
    origin: { document: resolution.document, pointer: "" },
    rows: ["DOC-01", "DOC-02", "DOC-04"],
    schemas: {
      document: storeOf(schemas.definitions),
      origin: { document: resolution.document, pointer: "" },
      rows: ["SCO-01"],
    },
    securitySchemes: schemes.schemes,
    servers: rootServers.servers,
    tags: tagsOf(fields?.tags),
  }).pipe(Effect.orDie);

  return {
    api,
    diagnostics: sortDiagnostics(
      [resolution.document],
      distinctDiagnostics([
        ...schemes.diagnostics,
        ...schemas.diagnostics,
        ...policy.diagnostics,
        ...rootServers.diagnostics,
        ...assembly.diagnostics,
      ]),
    ),
  };
});
