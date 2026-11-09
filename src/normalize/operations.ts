import { Array as Arr, Effect, Exit, Option, Order, Schema } from "effect";
import { sanitizeProse } from "../emit/help.ts";
import { JsonPointer, MethodToken, PathTemplate } from "../model/brands.ts";
import { Diagnostic, pointerOrder } from "../model/diagnostic.ts";
import type { DiagnosticOperation } from "../model/diagnostic.ts";
import {
  ContentSerialization,
  Operation,
  Parameter as ParameterEntity,
} from "../model/entities.ts";
import type {
  Body,
  Naming,
  NamingAlias,
  NamingHint,
  Parameter,
  Server,
} from "../model/entities.ts";
import { isArray, isObject } from "../model/json-tree.ts";
import type { JsonObject } from "../model/json-tree.ts";
import { defaultLimits, referenceAt } from "../resolve/index.ts";
import type { ResolveLimits, Resolution } from "../resolve/index.ts";
import { evaluatePointer, childPointer } from "../model/pointer.ts";
import type { Json } from "../model/pointer.ts";
import { formContentRules, hintDiscriminators, normalizeBody } from "./bodies.ts";
import type { BodyNodeBudget, BodyNotReadable, BodySite } from "./bodies.ts";
import { authorChoiceCodes, normalizeParameter } from "./parameters.ts";
import type { ParameterNotReadable, ParameterOutcome, ParameterSite } from "./parameters.ts";
import { normalizeResponses } from "./responses.ts";
import { normalizeSecurityPolicy } from "./security.ts";
import type { SchemeNormalization } from "./security.ts";
import { effectiveServers } from "./servers.ts";
import type { ServerSource, ServersContext } from "./servers.ts";
import { specSectionUrl } from "../model/spec-section.ts";
import { follow, nodeIn } from "./document-set.ts";

/**
 * The operations of the entry document and the diagnostics found assembling them. An operation
 * that an operation-scope refusal removed is absent from `operations` and named in `diagnostics`.
 */
export interface OperationAssembly {
  readonly diagnostics: readonly Diagnostic[];
  readonly operations: readonly Operation[];
}

/**
 * Assembly fails only where a stage below it does: a site validation or resolution should have
 * stopped, or a schema walk past its budget.
 */
export type OperationsError = BodyNodeBudget | BodyNotReadable | ParameterNotReadable;

type DiagnosticOperationValue = typeof DiagnosticOperation.Type;

type Level = "operation" | "pathItem";

type Method = typeof MethodToken.Type;

interface Located {
  readonly node: Json;
  readonly pointer: string;
}

interface Rule {
  readonly anchor: string;
  readonly element: string;
  readonly hint?: string;
  readonly message: string;
  readonly scope: "element" | "operation";
  readonly severity: "notice" | "refusal";
}

const rules = {
  "EXT-01/alias-unnamed": {
    anchor: "specification-extensions",
    element: "Naming extension",
    message: "The alias has no usable group and method name, so it names no command.",
    scope: "element",
    severity: "notice",
  },
  "EXT-01/naming-invalid": {
    anchor: "specification-extensions",
    element: "Naming extension",
    hint: "Give a group as a dotted string or an array of names, and a method as one string.",
    message: "The naming extension value is not a shape this generator reads, so it is ignored.",
    scope: "element",
    severity: "notice",
  },
  "OPR-08/required-parameter-refused": {
    anchor: "operation-parameters",
    element: "Operation parameters",
    hint: "Make the parameter optional, or change it to one this generator implements.",
    message: "A required parameter is refused, so the operation cannot be called.",
    scope: "operation",
    severity: "refusal",
  },
  "OPR-09/required-body-refused": {
    anchor: "operation-request-body",
    element: "Operation request body",
    hint: "Make the body optional, or offer a media type this generator implements.",
    message: "The required request body has no media type that can be sent.",
    scope: "operation",
    severity: "refusal",
  },
  "OPR-10/body-ignored": {
    anchor: "operation-request-body",
    element: "Request body",
    message: "OpenAPI 3.0 says a request body on this method SHALL be ignored, so no body is sent.",
    scope: "element",
    severity: "notice",
  },
  "OPR-10/body-refused": {
    anchor: "operation-request-body",
    element: "Request body",
    hint: "Bun's fetch refuses a body on this method before connecting; remove the body.",
    message: "A request body on this method cannot be sent.",
    scope: "element",
    severity: "refusal",
  },
  "SEC-06/no-satisfiable-alternative": {
    anchor: "operation-security",
    element: "Operation security",
    hint: "Declare an alternative this generator implements, or `{}` to allow no credential.",
    message: "Every declared security alternative is refused, so the operation cannot be called.",
    scope: "operation",
    severity: "refusal",
  },
} as const satisfies Record<string, Rule>;

type Code = keyof typeof rules;

const JsonMap = Schema.Record(Schema.String, Schema.Json);

const PathsRoot = Schema.Struct({
  paths: Schema.optionalKey(JsonMap),
  servers: Schema.optionalKey(Schema.Json),
});

const ItemFields = Schema.Struct({
  additionalOperations: Schema.optionalKey(JsonMap),
  parameters: Schema.optionalKey(Schema.Array(Schema.Json)),
  servers: Schema.optionalKey(Schema.Json),
});

const OperationFields = Schema.Struct({
  deprecated: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  operationId: Schema.optionalKey(Schema.String),
  parameters: Schema.optionalKey(Schema.Array(Schema.Json)),
  requestBody: Schema.optionalKey(Schema.Json),
  servers: Schema.optionalKey(Schema.Json),
  summary: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ParameterIdentity = Schema.Struct({ in: Schema.String, name: Schema.String });

const fixedMethods: ReadonlySet<string> = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

const methodRows: ReadonlyMap<string, string> = new Map([
  ["DELETE", "PTH-17"],
  ["GET", "PTH-14"],
  ["HEAD", "PTH-19"],
  ["OPTIONS", "PTH-18"],
  ["PATCH", "PTH-20"],
  ["POST", "PTH-16"],
  ["PUT", "PTH-15"],
  ["QUERY", "PTH-22"],
  ["TRACE", "PTH-21"],
]);

// Methods whose request body 3.0 says consumers ignore and 3.1+ leaves undecided (OPR-10, OPR-11).
const bodylessMethods: ReadonlySet<string> = new Set(["GET", "HEAD", "DELETE", "OPTIONS", "TRACE"]);

// Bun's fetch throws before connecting when one of these carries a body (design 6.3, probe SP11).
const unsendableMethods: ReadonlySet<string> = new Set(["GET", "HEAD", "TRACE"]);

type Plain<T> = { -readonly [K in keyof T]: T[K] };

const nodeAt = (resolution: Resolution, pointer: string): Option.Option<Json> => {
  const exit = Effect.runSyncExit(evaluatePointer(resolution.value, pointer));

  return Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none();
};

// The path item at a use site, followed through its Reference Object to the end of the chain. A
// path item in another document of the set is not read here: the sites of its operations would sit
// in that document, and assembly walks the entry's sites only.
const locate = (resolution: Resolution, use: string): Option.Option<Located> => {
  const reference = referenceAt(resolution, use);
  if (reference !== undefined && reference.target.document !== resolution.document) {
    return Option.none();
  }

  const pointer = reference === undefined ? use : reference.target.pointer;

  return nodeAt(resolution, pointer).pipe(Option.map((node): Located => ({ node, pointer })));
};

const decodeOption = <A, I>(schema: Schema.Codec<A, I>, value: Json): Option.Option<A> =>
  Schema.decodeUnknownOption(schema)(value);

const jsonPointer = (text: string) =>
  Schema.decodeUnknownEffect(JsonPointer)(text).pipe(Effect.orDie);

interface RawOperation {
  readonly additional: boolean;
  readonly fields: typeof OperationFields.Type;
  readonly node: JsonObject;
  readonly itemFields: typeof ItemFields.Type;
  readonly itemPointer: string;
  readonly method: Method;
  readonly path: typeof PathTemplate.Type;
  readonly pointer: string;
}

const operationsOfItem = (
  resolution: Resolution,
  path: typeof PathTemplate.Type,
  item: Located,
  itemFields: typeof ItemFields.Type,
  itemNode: Record<string, Json>,
): readonly RawOperation[] => {
  const members = resolution.line === "3.2" ? new Set([...fixedMethods, "query"]) : fixedMethods;
  const fixed = Object.keys(itemNode)
    .filter((name) => members.has(name))
    .map((name) => ({ additional: false, name, token: name.toUpperCase() }));
  const extra = Object.keys(itemFields.additionalOperations ?? {}).map((name) => ({
    additional: true,
    name,
    token: name,
  }));

  return [...fixed, ...extra].flatMap((entry): readonly RawOperation[] => {
    const pointer = entry.additional
      ? childPointer(childPointer(item.pointer, "additionalOperations"), entry.name)
      : childPointer(item.pointer, entry.name);
    const node = nodeAt(resolution, pointer).pipe(Option.filter(isObject));
    const fields = node.pipe(Option.flatMap((found) => decodeOption(OperationFields, found)));
    const method = decodeOption(MethodToken, entry.token);

    // A key the check stage refused (PTH-07, PTH-23, PTH-24) is not read: its diagnostic exists.
    return Option.isSome(node) && Option.isSome(fields) && Option.isSome(method)
      ? [
          {
            additional: entry.additional,
            fields: fields.value,
            itemFields,
            itemPointer: item.pointer,
            method: method.value,
            node: node.value,
            path,
            pointer,
          },
        ]
      : [];
  });
};

// An operation's use site under `/paths`: the path key, then the method or its
// `additionalOperations` entry. Unlike `pointer`, it is unique when path items share a target.
const useSite = (key: string, raw: RawOperation): string => {
  const item = childPointer("/paths", key);

  return raw.additional
    ? childPointer(childPointer(item, "additionalOperations"), raw.method)
    : childPointer(item, raw.method.toLowerCase());
};

// The entry document's operations in canonical order (design 3.7): every operation sits in the
// entry document, so the order is its use-site pointer token by token. Member order of `paths`,
// a path item and `additionalOperations` is not semantic and never reaches a later stage.
const rawOperations = (resolution: Resolution): readonly RawOperation[] => {
  const keys = decodeOption(PathsRoot, resolution.value).pipe(
    Option.map((root) => Object.keys(root.paths ?? {})),
    Option.getOrElse((): readonly string[] => []),
  );
  const sited = keys.flatMap((key) => {
    const path = decodeOption(PathTemplate, key);
    const item = locate(resolution, childPointer("/paths", key));
    const fields = item.pipe(Option.flatMap((located) => decodeOption(ItemFields, located.node)));
    const node = item.pipe(Option.flatMap((located) => decodeOption(JsonMap, located.node)));
    if (
      Option.isNone(path) ||
      Option.isNone(item) ||
      Option.isNone(fields) ||
      Option.isNone(node)
    ) {
      return [];
    }

    return operationsOfItem(resolution, path.value, item.value, fields.value, node.value).map(
      (raw) => ({ raw, site: useSite(key, raw) }),
    );
  });

  return Arr.sort(
    sited,
    Order.mapInput(pointerOrder, (entry: { readonly site: string }) => entry.site),
  ).map((entry) => entry.raw);
};

interface ParameterEntry {
  readonly key: string;
  readonly level: Level;
  readonly pointer: string;
}

// A parameter's identity, read from the document of the set its reference chain ends in.
const parameterKey = (resolution: Resolution, pointer: string): string => {
  const target = follow(resolution, { document: resolution.document, pointer });
  const exit = Effect.runSyncExit(nodeIn(resolution, target));
  const identity = (Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none<Json>()).pipe(
    Option.flatMap((node) => decodeOption(ParameterIdentity, node)),
  );

  // An unreadable entry gets a key of its own so `normalizeParameter` reports it.
  return Option.match(identity, {
    onNone: () => `\u0000unreadable\u0000${pointer}`,
    onSome: (found) =>
      `${found.in}\u0000${found.in === "header" ? found.name.toLowerCase() : found.name}`,
  });
};

const entriesOf = (
  resolution: Resolution,
  owner: string,
  list: readonly Json[] | undefined,
  level: Level,
): readonly ParameterEntry[] =>
  (list ?? []).map((_entry, index) => {
    const pointer = childPointer(childPointer(owner, "parameters"), String(index));

    return { key: parameterKey(resolution, pointer), level, pointer };
  });

interface Merged {
  readonly entries: readonly ParameterEntry[];
  readonly overridden: boolean;
}

// Path item entries in document order, an operation entry with the same key replacing its path
// item entry in place, and the operation's other entries after them (design 2.2, SR:G3).
const mergeEntries = (
  itemEntries: readonly ParameterEntry[],
  operationEntries: readonly ParameterEntry[],
): Merged => {
  const merged = [...itemEntries];
  let overridden = false;
  for (const entry of operationEntries) {
    const index = merged.findIndex((existing) => existing.key === entry.key);
    if (index === -1) {
      merged.push(entry);
    } else {
      overridden ||= merged[index]?.level === "pathItem";
      merged[index] = entry;
    }
  }

  return { entries: merged, overridden };
};

interface Assembled {
  readonly diagnostics: readonly Diagnostic[];
  readonly parameters: readonly Parameter[];
  readonly refusedRequired: readonly string[];
}

interface Shared {
  readonly cache: Map<string, ParameterOutcome>;
  readonly checkFindings: readonly Diagnostic[];
  readonly context: ServersContext;
  readonly limits: ResolveLimits;
  readonly resolution: Resolution;
  readonly schemes: SchemeNormalization;
}

const operationInfo = (raw: RawOperation): DiagnosticOperationValue =>
  raw.fields.operationId === undefined
    ? { method: raw.method, path: raw.path }
    : { method: raw.method, operationId: raw.fields.operationId, path: raw.path };

// A 3.2 `querystring` parameter's form content takes Encoding Objects as for bodies (design 6.1):
// the body form rules decide them, and the parameter carries the rules, or is refused with their
// diagnostics when they refuse the content, as a form body alternative would be dropped.
const withFormRules = (
  shared: Shared,
  site: ParameterSite,
  outcome: ParameterOutcome,
): Effect.Effect<ParameterOutcome, BodyNodeBudget | BodyNotReadable> =>
  Effect.gen(function* fill() {
    if (outcome._tag !== "Implemented" || outcome.parameter.location !== "querystring") {
      return outcome;
    }

    const { parameter } = outcome;
    const { serialization } = parameter;
    if (serialization.kind !== "content") {
      return outcome;
    }

    const { nonStandard, ...placed } = site;
    const bodySite: Plain<BodySite> = placed;
    if (nonStandard !== undefined) {
      bodySite.nonStandard = nonStandard;
    }

    const decided = yield* formContentRules(
      shared.resolution,
      bodySite,
      serialization.mediaType,
      shared.limits,
    );
    const diagnostics = [...outcome.diagnostics, ...decided.diagnostics];
    if (decided._tag === "Refused") {
      return { _tag: "Refused", diagnostics, required: parameter.required };
    }

    // Each spread feeds a class constructor, which checks the fields and gives back the class.
    // oxlint-disable-next-line typescript/no-misused-spread -- rebuilt through the constructor
    const filled = new ContentSerialization({ ...serialization, encoding: decided.encoding });

    return {
      _tag: "Implemented",
      diagnostics,
      // oxlint-disable-next-line typescript/no-misused-spread -- rebuilt through the constructor
      parameter: new ParameterEntity({ ...parameter, serialization: filled }),
    };
  });

const assembleParameters = (
  shared: Shared,
  raw: RawOperation,
  merged: Merged,
): Effect.Effect<Assembled, BodyNodeBudget | BodyNotReadable | ParameterNotReadable> =>
  Effect.gen(function* assemble() {
    const parameters: Parameter[] = [];
    const diagnostics: Diagnostic[] = [];
    const refusedRequired: string[] = [];
    for (const entry of merged.entries) {
      // A path item parameter is the item's element, not one operation's: it is read once.
      const site: ParameterSite =
        entry.level === "operation"
          ? {
              nonStandard: shared.context.config.nonStandard,
              openapi: shared.context.openapi,
              operation: operationInfo(raw),
              pointer: entry.pointer,
            }
          : {
              nonStandard: shared.context.config.nonStandard,
              openapi: shared.context.openapi,
              pointer: entry.pointer,
            };
      const outcome =
        shared.cache.get(entry.pointer) ??
        (yield* withFormRules(shared, site, yield* normalizeParameter(shared.resolution, site)));
      shared.cache.set(entry.pointer, outcome);
      diagnostics.push(...outcome.diagnostics);
      if (outcome._tag === "Implemented") {
        parameters.push(outcome.parameter);
      } else if (outcome._tag === "Refused" && outcome.required) {
        refusedRequired.push(entry.pointer);
      }
    }

    return { diagnostics, parameters, refusedRequired };
  });

interface BodyResult {
  readonly body?: Body;
  readonly diagnostics: readonly Diagnostic[];
  readonly refusedRequired: boolean;
}

const diagnose = (
  shared: Shared,
  code: Code,
  site: { readonly operation: DiagnosticOperationValue; readonly pointer: string },
  related: readonly string[] = [],
): Effect.Effect<Diagnostic> => {
  const rule: Rule = rules[code];
  const [row = ""] = code.split("/");
  const fields: Plain<typeof Diagnostic.Encoded> = {
    code,
    document: shared.resolution.document,
    element: rule.element,
    message: rule.message,
    openapi: shared.context.openapi,
    operation: site.operation,
    pointer: site.pointer,
    row,
    scope: rule.scope,
    severity: rule.severity,
    specSection: specSectionUrl(shared.resolution.line, rule.anchor),
  };
  if (rule.hint !== undefined) {
    fields.hint = rule.hint;
  }

  if (related.length > 0) {
    fields.related = related.map((pointer) => ({ document: shared.resolution.document, pointer }));
  }

  return Schema.decodeUnknownEffect(Diagnostic)(fields).pipe(Effect.orDie);
};

const assembleBody = (
  shared: Shared,
  raw: RawOperation,
): Effect.Effect<BodyResult, BodyNodeBudget | BodyNotReadable> =>
  Effect.gen(function* assemble() {
    if (raw.fields.requestBody === undefined) {
      return { diagnostics: [], refusedRequired: false };
    }

    const pointer = childPointer(raw.pointer, "requestBody");
    const operation = operationInfo(raw);
    if (bodylessMethods.has(raw.method)) {
      const ignored = shared.resolution.line === "3.0";
      if (ignored || unsendableMethods.has(raw.method)) {
        const code = ignored ? "OPR-10/body-ignored" : "OPR-10/body-refused";

        return {
          diagnostics: [yield* diagnose(shared, code, { operation, pointer })],
          refusedRequired: false,
        };
      }
    }

    // The author config's bracket switch reaches the body as it reaches the parameters.
    const { nonStandard } = shared.context.config;
    const site: Plain<BodySite> = { openapi: shared.context.openapi, operation, pointer };
    if (nonStandard !== undefined) {
      site.nonStandard = nonStandard;
    }

    const outcome = yield* normalizeBody(shared.resolution, site, shared.limits);
    if (outcome._tag === "Refused") {
      return { diagnostics: outcome.diagnostics, refusedRequired: outcome.required };
    }

    return {
      body: yield* hintDiscriminators(shared.resolution, outcome.body, shared.checkFindings),
      diagnostics: outcome.diagnostics,
      refusedRequired: false,
    };
  });

const serverSource = (pointer: string, value: Json | undefined): Effect.Effect<ServerSource> =>
  jsonPointer(pointer).pipe(Effect.map((decoded): ServerSource => ({ pointer: decoded, value })));

const effectiveServersOf = (
  shared: Shared,
  raw: RawOperation,
): Effect.Effect<{ diagnostics: readonly Diagnostic[]; servers: readonly Server[] }> =>
  Effect.gen(function* servers() {
    const root = decodeOption(PathsRoot, shared.resolution.value).pipe(
      Option.flatMap((fields) => Option.fromUndefinedOr(fields.servers)),
    );

    return effectiveServers(
      {
        operation: yield* serverSource(childPointer(raw.pointer, "servers"), raw.fields.servers),
        pathItem: yield* serverSource(
          childPointer(raw.itemPointer, "servers"),
          raw.itemFields.servers,
        ),
        root: yield* serverSource("/servers", Option.getOrUndefined(root)),
      },
      shared.context,
    );
  });

const docsOf = (fields: typeof OperationFields.Type): Plain<typeof Operation.Encoded.docs> => {
  const docs: Plain<typeof Operation.Encoded.docs> = {};
  if (fields.description !== undefined) {
    docs.description = sanitizeProse(fields.description);
  }

  if (fields.summary !== undefined) {
    docs.summary = sanitizeProse(fields.summary);
  }

  return docs;
};

const rowsOf = (
  shared: Shared,
  raw: RawOperation,
  merged: Merged,
  built: { readonly body: Body | undefined; readonly declared: boolean },
): readonly string[] => {
  const keptBody = built.body !== undefined && bodylessMethods.has(raw.method);
  const rows = [
    "OPR-01",
    "OPR-12",
    raw.additional ? "PTH-23" : (methodRows.get(raw.method) ?? "PTH-23"),
    ...(raw.fields.operationId === undefined ? [] : ["OPR-06"]),
    ...(raw.fields.deprecated === undefined ? [] : ["OPR-14"]),
    ...(raw.fields.parameters === undefined ? [] : ["OPR-08"]),
    ...(merged.entries.some((entry) => entry.level === "pathItem") ? ["PTH-26"] : []),
    ...(merged.overridden ? ["PTH-27"] : []),
    ...(built.body === undefined ? [] : ["OPR-09"]),
    ...(keptBody && shared.resolution.line !== "3.0" ? ["OPR-11"] : []),
    ...(built.declared ? ["OPR-15"] : []),
  ];

  return Arr.sort(Arr.dedupe(rows), Order.String);
};

type NamingCode = "EXT-01/alias-unnamed" | "EXT-01/naming-invalid";

interface NamingNotice {
  readonly code: NamingCode;
  readonly pointer: string;
}

interface NamingRead<A> {
  readonly notices: readonly NamingNotice[];
  readonly value: A | undefined;
}

// The keys each source names a group and a method by (design 4.4 Naming extensions).
const namingKeys = {
  fern: { group: "x-fern-sdk-group-name", method: "x-fern-sdk-method-name" },
  forge: { group: "x-forge-group-name", method: "x-forge-method-name" },
} as const;

const aliasesKey = "x-forge-aliases";

// A group is a dotted string, split at `.`, or an array whose elements are kept whole; no segment
// may be empty. Any other shape is unusable.
const groupSegments = (value: Json): Option.Option<Arr.NonEmptyReadonlyArray<string>> =>
  decodeOption(Schema.String, value).pipe(
    Option.map((text): readonly string[] => text.split(".")),
    Option.orElse(() => decodeOption(Schema.Array(Schema.String), value)),
    Option.filter(Arr.isReadonlyArrayNonEmpty),
    Option.filter((segments) => segments.every((segment) => segment !== "")),
  );

const methodName = (value: Json): Option.Option<string> =>
  decodeOption(Schema.NonEmptyString, value);

const invalid = (pointer: string): NamingNotice => ({ code: "EXT-01/naming-invalid", pointer });

// One source's hint from the object at `pointer`; a present key with an unusable value is dropped
// with a notice at that key.
const hintOf = (
  holder: JsonObject,
  pointer: string,
  source: keyof typeof namingKeys,
): NamingRead<Plain<typeof NamingHint.Encoded>> => {
  const keys = namingKeys[source];
  const notices: NamingNotice[] = [];
  const read = <A>(key: string, parse: (value: Json) => Option.Option<A>): A | undefined => {
    const value = holder[key];
    if (value === undefined) {
      return undefined;
    }

    const parsed = parse(value);
    if (Option.isNone(parsed)) {
      notices.push(invalid(childPointer(pointer, key)));
    }

    return Option.getOrUndefined(parsed);
  };
  const group = read(keys.group, groupSegments);
  const method = read(keys.method, methodName);
  if (group === undefined && method === undefined) {
    return { notices, value: undefined };
  }

  const hint: Plain<typeof NamingHint.Encoded> = { pointer };
  if (group !== undefined) {
    hint.group = group;
  }

  if (method !== undefined) {
    hint.method = method;
  }

  return { notices, value: hint };
};

// An alias names a command by its own keys only: it is usable when its Forge keys, else its Fern
// keys, give both a group and a method, or else when it has its own `operationId`. It never takes
// the operation's `operationId`. An `x-forge-aliases` inside it is not read.
const aliasOf = (
  element: Json,
  pointer: string,
  index: number,
): NamingRead<Plain<typeof NamingAlias.Encoded>> => {
  if (!isObject(element)) {
    return { notices: [invalid(pointer)], value: undefined };
  }

  const forge = hintOf(element, pointer, "forge");
  const fern = hintOf(element, pointer, "fern");
  const notices = [...forge.notices, ...fern.notices];
  const group = forge.value?.group ?? fern.value?.group;
  const method = forge.value?.method ?? fern.value?.method;
  const rawId = element.operationId;
  const operationId = rawId === undefined ? Option.none() : methodName(rawId);
  if (rawId !== undefined && Option.isNone(operationId)) {
    notices.push(invalid(childPointer(pointer, "operationId")));
  }

  if ((group === undefined || method === undefined) && Option.isNone(operationId)) {
    return { notices: [...notices, { code: "EXT-01/alias-unnamed", pointer }], value: undefined };
  }

  const alias: Plain<typeof NamingAlias.Encoded> = { index };
  if (forge.value !== undefined) {
    alias.forge = forge.value;
  }

  if (fern.value !== undefined) {
    alias.fern = fern.value;
  }

  if (Option.isSome(operationId)) {
    alias.operationId = operationId.value;
  }

  return { notices, value: alias };
};

// `x-forge-aliases` must be an array holding at least one usable alias; otherwise it is treated as
// absent with one notice at the array.
const aliasesOf = (
  holder: JsonObject,
  pointer: string,
): NamingRead<Arr.NonEmptyReadonlyArray<Plain<typeof NamingAlias.Encoded>>> => {
  const value = holder[aliasesKey];
  if (value === undefined) {
    return { notices: [], value: undefined };
  }

  const arrayPointer = childPointer(pointer, aliasesKey);
  const read = isArray(value)
    ? value.map((element, index) =>
        aliasOf(element, childPointer(arrayPointer, String(index)), index),
      )
    : [];
  const notices = read.flatMap((one) => one.notices);
  const aliases = read.flatMap((one) => (one.value === undefined ? [] : [one.value]));

  return Arr.isReadonlyArrayNonEmpty(aliases)
    ? { notices, value: aliases }
    : { notices: [invalid(arrayPointer), ...notices], value: undefined };
};

// The naming extensions of an Operation Object (design 4.4, D-NAME4). Only the five naming keys
// are read; every extension stays recorded as EXT-01 by `collectInformational`.
const namingOf = (raw: RawOperation): NamingRead<Plain<typeof Naming.Encoded>> => {
  const forge = hintOf(raw.node, raw.pointer, "forge");
  const fern = hintOf(raw.node, raw.pointer, "fern");
  const aliases = aliasesOf(raw.node, raw.pointer);
  const notices = [...forge.notices, ...fern.notices, ...aliases.notices];
  const naming: Plain<typeof Naming.Encoded> = {};
  if (aliases.value !== undefined) {
    naming.aliases = aliases.value;
  }

  if (fern.value !== undefined) {
    naming.fern = fern.value;
  }

  if (forge.value !== undefined) {
    naming.forge = forge.value;
  }

  return { notices, value: Object.keys(naming).length === 0 ? undefined : naming };
};

interface Assembly {
  readonly diagnostics: readonly Diagnostic[];
  readonly operation?: Operation;
}

// An operation refused whole sends nothing, so none of its elements is sent in the bracket
// convention or as a scalar pair: their notices go with it (design 8.5 rule 7, option A), as a
// refused form alternative's do in the body assembly. `nonStandard` reads generated operations only.
const withoutAuthorChoiceNotices = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  diagnostics.filter((diagnostic) => !authorChoiceCodes.has(diagnostic.code));

const assembleOne = (shared: Shared, raw: RawOperation): Effect.Effect<Assembly, OperationsError> =>
  Effect.gen(function* assemble() {
    const { resolution } = shared;
    const merged = mergeEntries(
      entriesOf(resolution, raw.itemPointer, raw.itemFields.parameters, "pathItem"),
      entriesOf(resolution, raw.pointer, raw.fields.parameters, "operation"),
    );
    const parameters = yield* assembleParameters(shared, raw, merged);
    const body = yield* assembleBody(shared, raw);
    const responses = yield* normalizeResponses(resolution, childPointer(raw.pointer, "responses"));
    const policy = yield* normalizeSecurityPolicy(resolution, shared.schemes, raw.pointer);
    const servers = yield* effectiveServersOf(shared, raw);
    const site = { operation: operationInfo(raw), pointer: raw.pointer };
    const naming = namingOf(raw);
    const namingNotices = yield* Effect.all(
      naming.notices.map((found) =>
        diagnose(shared, found.code, { operation: site.operation, pointer: found.pointer }),
      ),
    );
    const raises = [
      ...(parameters.refusedRequired.length === 0
        ? []
        : [
            yield* diagnose(
              shared,
              "OPR-08/required-parameter-refused",
              site,
              parameters.refusedRequired,
            ),
          ]),
      ...(body.refusedRequired
        ? [
            yield* diagnose(shared, "OPR-09/required-body-refused", site, [
              childPointer(raw.pointer, "requestBody"),
            ]),
          ]
        : []),
      ...(policy.listed > 0 && policy.policy.alternatives.length === 0
        ? [
            yield* diagnose(shared, "SEC-06/no-satisfiable-alternative", site, [
              policy.policy.origin.pointer,
            ]),
          ]
        : []),
    ];
    const diagnostics = [
      ...parameters.diagnostics,
      ...body.diagnostics,
      ...responses.diagnostics,
      ...policy.diagnostics,
      ...servers.diagnostics,
      ...namingNotices,
      ...raises,
    ];
    if (raises.length > 0) {
      return { diagnostics: withoutAuthorChoiceNotices(diagnostics) };
    }

    const fields: Plain<typeof Operation.Encoded> = {
      deprecated: raw.fields.deprecated ?? false,
      docs: docsOf(raw.fields),
      key: { method: raw.method, path: raw.path },
      origin: { document: resolution.document, pointer: raw.pointer },
      parameters: parameters.parameters,
      responses: responses.responses,
      rows: rowsOf(shared, raw, merged, { body: body.body, declared: policy.policy.declared }),
      security: policy.policy,
      servers: servers.servers,
      tags: (raw.fields.tags ?? []).map(sanitizeProse),
    };
    if (body.body !== undefined) {
      fields.body = body.body;
    }

    if (naming.value !== undefined) {
      fields.naming = naming.value;
    }

    // An empty operationId is not a name; naming reports it (OPR-06).
    if (raw.fields.operationId !== undefined && raw.fields.operationId !== "") {
      fields.operationId = raw.fields.operationId;
    }

    const operation = yield* Schema.decodeUnknownEffect(Operation)(fields).pipe(Effect.orDie);

    return { diagnostics, operation };
  });

const diagnosticKey = (diagnostic: Diagnostic): string =>
  JSON.stringify([
    diagnostic.code,
    diagnostic.document,
    diagnostic.pointer,
    diagnostic.operation?.method,
    diagnostic.operation?.path,
    (diagnostic.related ?? []).map((site) => [site.document, site.pointer]),
  ]);

/**
 * Drops repeated diagnostics (same code, document, pointer, operation and related sites), keeping
 * the first of each in order. Root servers, root security and path item parameters are read once
 * per operation that inherits them, and report once.
 */
export const distinctDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  Arr.dedupeWith(diagnostics, (left, right) => diagnosticKey(left) === diagnosticKey(right));

/**
 * Assembles the operations of the entry document in canonical order (design 2.2, 2.4, 3.7, 6.3).
 * Each keeps its method token and path template, the path item's parameters merged with its own
 * (override by name and `in`, a header name case-insensitively), and the effective servers and
 * security. A body on GET, HEAD, DELETE, OPTIONS or TRACE follows the line: 3.0 ignores it with a
 * notice, 3.1 and later send it on DELETE and OPTIONS and refuse it on GET, HEAD and TRACE at
 * element scope. An operation is removed with an operation-scope refusal when a required parameter
 * or a required body is refused, or when every listed security alternative is refused (`[]` and a
 * remaining `{}` alternative are not). A path or method key the check stage refused is not read. A
 * site the earlier stages should have stopped fails as in the stage that reads it. `checkFindings`
 * are the spec-text check findings of the run: a body discriminator they refuse gets no hint.
 */
export const assembleOperations = (
  resolution: Resolution,
  schemes: SchemeNormalization,
  context: ServersContext,
  checkFindings: readonly Diagnostic[],
  limits: ResolveLimits = defaultLimits,
): Effect.Effect<OperationAssembly, OperationsError> =>
  Effect.gen(function* assemble() {
    const shared: Shared = {
      cache: new Map(),
      checkFindings,
      context,
      limits,
      resolution,
      schemes,
    };
    const assembled = yield* Effect.forEach(rawOperations(resolution), (raw) =>
      assembleOne(shared, raw),
    );

    return {
      diagnostics: distinctDiagnostics(assembled.flatMap((one) => one.diagnostics)),
      operations: assembled.flatMap((one) => (one.operation === undefined ? [] : [one.operation])),
    };
  });
