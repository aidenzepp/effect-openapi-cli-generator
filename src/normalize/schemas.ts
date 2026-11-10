import {
  Array as Arr,
  Effect,
  JsonPointer,
  JsonSchema,
  Option,
  Order,
  pipe,
  Predicate,
  Result,
  Schema,
  SchemaRepresentation,
} from "effect";
import type { DocumentUri } from "../model/brands.ts";
import { makeDiagnostic, sortDiagnostics } from "../model/diagnostic.ts";
import type { Diagnostic, DiagnosticInput } from "../model/diagnostic.ts";
import { defsKey, keyOf } from "../resolve/canonical.ts";
import type { CanonicalKey } from "../resolve/canonical.ts";
import { defaultLimits } from "../resolve/index.ts";
import type { ReferenceKind, Resolution, ResolveLimits } from "../resolve/index.ts";
import { evaluatePointerResult, formatPointer, parsePointerResult } from "../model/pointer.ts";
import type { Json } from "../model/pointer.ts";
import type { Line } from "../validate/index.ts";
import { specSectionUrl } from "../model/spec-section.ts";
import { isObject, isArray, nodeAt, stringMember } from "../model/json-tree.ts";
import type { JsonObject } from "../model/json-tree.ts";
import { nodeIn, referenceIn } from "./document-set.ts";

type Document = typeof DocumentUri.Type;

/**
 * The design 2.2 `Shape` facts of one stored schema, which flattening and serialization read: the
 * declared type set, property names in source order, `required`, whether items are declared, the
 * `$defs` key a `$ref` names, and the binary and content-encoding markers. A marker the schema does
 * not carry is `undefined`. The discriminator is a body fact (`MediaAlternative.discriminator`).
 */
export interface SchemaFacts {
  readonly contentEncoding: string | undefined;
  readonly contentMediaType: string | undefined;
  readonly format: "binary" | "byte" | undefined;
  readonly items: boolean;
  readonly properties: readonly string[];
  readonly reference: string | undefined;
  readonly required: readonly string[];
  readonly types: readonly string[];
}

/**
 * One change from the stored document to its validation copy. `path` is relative to the definition
 * under `key`: the removed keyword, the dropped `enum` member, or the retyped or replaced node.
 * Every edit carries the diagnostic code it is reported under.
 */
export interface SchemaEdit {
  readonly action: "drop-member" | "remove" | "replace" | "retype";
  readonly code: string;
  readonly key: string;
  readonly path: readonly string[];
}

/**
 * The validation copy of design 3.5 and the edits that derive it from the stored document (X10).
 */
export interface ValidationCopy {
  readonly definitions: ReadonlyMap<string, Json>;
  readonly edits: readonly SchemaEdit[];
}

/**
 * The stored draft 2020-12 definitions under their `$defs` keys, with their facts.
 */
export interface StoredSchemas {
  readonly definitions: ReadonlyMap<string, Json>;
  readonly facts: ReadonlyMap<string, SchemaFacts>;
}

/**
 * The schema store of one document set, its validation copy and the diagnostics the copy records.
 */
export interface SchemaNormalization extends StoredSchemas {
  readonly diagnostics: readonly Diagnostic[];
  readonly line: Line;
  readonly validation: ValidationCopy;
}

/**
 * A conversion or import failure that no D-AD12 class names: a defect in that list (design 3.5).
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError<Self>()(tag, fields) declares a class; nothing is thrown
export class SchemaImportDefect extends Schema.TaggedError<SchemaImportDefect>()(
  "SchemaImportDefect",
  { key: Schema.String, message: Schema.String },
) {}

/**
 * A schema walk visited more nodes than the node budget allows (design 3.3, 9 I5).
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError<Self>()(tag, fields) declares a class; nothing is thrown
export class SchemaBudgetExceeded extends Schema.TaggedError<SchemaBudgetExceeded>()(
  "SchemaBudgetExceeded",
  { limit: Schema.Number },
) {}

/**
 * The node budget of one call: `maxNodes` from the resolution limits.
 */
export type SchemaLimits = Partial<Pick<ResolveLimits, "maxNodes">>;

/**
 * The node budget one call's walks share: every schema or OpenAPI object a walk visits is charged
 * once; past the limit, walks stop descending and the call fails (or, for a predicate, fails
 * closed).
 */
export interface Budget {
  readonly limit: number;
  spent: number;
}

/**
 * A fresh budget of `maxNodes` from the limits, the resolution default when absent.
 */
export const budgetOf = (limits: SchemaLimits): Budget => ({
  limit: limits.maxNodes ?? defaultLimits.maxNodes,
  spent: 0,
});

/**
 * Charges one visit; false once the budget is spent.
 */
export const charge = (budget: Budget): boolean => {
  budget.spent += 1;

  return budget.spent <= budget.limit;
};

const within = <A>(budget: Budget, value: A): Effect.Effect<A, SchemaBudgetExceeded> =>
  budget.spent > budget.limit
    ? Effect.fail(new SchemaBudgetExceeded({ limit: budget.limit }))
    : Effect.succeed(value);

const member = (node: JsonObject, key: string): Json | undefined =>
  Object.hasOwn(node, key) ? node[key] : undefined;

const strings = (value: Json | undefined): readonly string[] =>
  isArray(value) ? value.filter(Predicate.isString) : [];

const isJson = Schema.is(Schema.Json);

const byString = Order.String;

const sortedKeys = (map: ReadonlyMap<string, unknown>): readonly string[] =>
  Arr.sort([...map.keys()], byString);

const tokensOf = (pointer: string): readonly string[] | undefined =>
  Result.getSuccess(parsePointerResult(pointer)).pipe(Option.getOrUndefined);

const childAt = (node: Json | undefined, token: string): Json | undefined => {
  if (isObject(node)) {
    return member(node, token);
  }

  return isArray(node) ? node[Number(token)] : undefined;
};

// The `$defs` key a `#/$defs/<token>` reference names (one token, as Effect's importer requires).
const referenceKey = (ref: string): string | undefined => {
  const tokens = JsonPointer.parseUriFragment(ref);
  const [defs, key, ...rest] = tokens ?? [];

  return defs === "$defs" && rest.length === 0 ? key : undefined;
};

const refFor = (key: string): string => JsonPointer.formatUriFragment(["$defs", key]);

// Subschema positions per line, as the resolver walks them (3.0 Schema Object; 2020-12 applicators).
interface Positions {
  readonly list: ReadonlySet<string>;
  readonly map: ReadonlySet<string>;
  readonly one: ReadonlySet<string>;
}

const positions30: Positions = {
  list: new Set(["allOf", "anyOf", "oneOf"]),
  map: new Set(["properties"]),
  one: new Set(["additionalProperties", "items", "not"]),
};

const positions2020: Positions = {
  list: new Set(["allOf", "anyOf", "oneOf", "prefixItems"]),
  map: new Set(["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"]),
  one: new Set([
    "additionalProperties",
    "contains",
    "contentSchema",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties",
  ]),
};

// Positions the copies descend into. Nested `$defs` stay out: every referenced member is lifted
// under its own key.
const copyPositions: Positions = {
  list: positions2020.list,
  map: new Set(["dependentSchemas", "patternProperties", "properties"]),
  one: positions2020.one,
};

// In-place applicators: a cycle of references through only these never descends into the instance.
const inPlace: Positions = {
  list: new Set(["allOf", "anyOf", "oneOf"]),
  map: new Set(["dependentSchemas"]),
  one: new Set(["else", "if", "not", "then"]),
};

type Visit = (node: JsonObject, path: readonly string[]) => JsonObject;

// Rebuilds a schema node: `visit` rewrites the node itself, then its subschemas are transformed.
// Objects are rebuilt with `Object.fromEntries`, so a `__proto__` member stays an own key.
const transformSchema = (
  budget: Budget,
  node: Json,
  path: readonly string[],
  where: Positions,
  visit: Visit,
): Json => {
  if (!isObject(node) || !charge(budget)) {
    return node;
  }

  const child = (value: Json, tokens: readonly string[]): Json =>
    transformSchema(budget, value, [...path, ...tokens], where, visit);

  return Object.fromEntries(
    Object.entries(visit(node, path)).map(([key, value]): [string, Json] => {
      if (where.one.has(key)) {
        return [key, child(value, [key])];
      }

      if (where.list.has(key) && isArray(value)) {
        return [key, value.map((item, index) => child(item, [key, String(index)]))];
      }

      if (where.map.has(key) && isObject(value)) {
        const entries = Object.entries(value).map(([name, item]): [string, Json] => [
          name,
          child(item, [key, name]),
        ]);

        return [key, Object.fromEntries(entries)];
      }

      return [key, value];
    }),
  );
};

const forEachSchema = (
  budget: Budget,
  node: Json,
  where: Positions,
  visit: (node: JsonObject, path: readonly string[]) => void,
  start: readonly string[] = [],
): void => {
  transformSchema(budget, node, start, where, (current, path) => {
    visit(current, path);

    return current;
  });
};

// ---------------------------------------------------------------------------------------------
// The OpenAPI structure around schemas: where schema roots sit, and which objects are not schemas.

type Kind =
  | "callback"
  | "components"
  | "encoding"
  | "header"
  | "mediaType"
  | "operation"
  | "pathItem"
  | "requestBody"
  | "response"
  | "root";

type Arity = "list" | "map" | "one";

type Field = readonly [name: string, kind: Kind | "schema", arity: Arity];

const methods = ["delete", "get", "head", "options", "patch", "post", "put", "query", "trace"];

const content: Field = ["content", "mediaType", "map"];

const encodings: readonly Field[] = [
  ["encoding", "encoding", "map"],
  ["itemEncoding", "encoding", "one"],
  ["prefixEncoding", "encoding", "list"],
];

const layoutFields = new Map<Kind, readonly Field[]>([
  ["callback", []],
  [
    "components",
    [
      ["callbacks", "callback", "map"],
      ["headers", "header", "map"],
      ["mediaTypes", "mediaType", "map"],
      ["parameters", "header", "map"],
      ["pathItems", "pathItem", "map"],
      ["requestBodies", "requestBody", "map"],
      ["responses", "response", "map"],
      ["schemas", "schema", "map"],
    ],
  ],
  ["encoding", [["headers", "header", "map"], ...encodings]],
  ["header", [["schema", "schema", "one"], content]],
  ["mediaType", [["itemSchema", "schema", "one"], ["schema", "schema", "one"], ...encodings]],
  [
    "operation",
    [
      ["callbacks", "callback", "map"],
      ["parameters", "header", "list"],
      ["requestBody", "requestBody", "one"],
      ["responses", "response", "map"],
    ],
  ],
  [
    "pathItem",
    [
      ["additionalOperations", "operation", "map"],
      ["parameters", "header", "list"],
      ...methods.map((method): Field => [method, "operation", "one"]),
    ],
  ],
  ["requestBody", [content]],
  ["response", [["headers", "header", "map"], content]],
  [
    "root",
    [
      ["components", "components", "one"],
      ["paths", "pathItem", "map"],
      ["webhooks", "pathItem", "map"],
    ],
  ],
]);

interface Layout {
  readonly budget: Budget;
  readonly roots: string[];
  readonly structural: Set<string>;
}

const childPointer = (pointer: string, ...tokens: readonly string[]): string =>
  `${pointer}${formatPointer(tokens)}`;

// Walks the OpenAPI objects that hold schemas. Every object and container on the way is recorded as
// structural (not a schema), and every Schema Object position as a root.
const walkLayout = (layout: Layout, kind: Kind | "schema", node: Json, pointer: string): void => {
  if (kind === "schema") {
    layout.roots.push(pointer);

    return;
  }

  if (!isObject(node) || !charge(layout.budget)) {
    return;
  }

  layout.structural.add(pointer);
  if (kind === "callback") {
    for (const [expression, item] of Object.entries(node)) {
      walkLayout(layout, "pathItem", item, childPointer(pointer, expression));
    }

    return;
  }

  for (const [name, child, arity] of layoutFields.get(kind) ?? []) {
    const value = member(node, name);
    const location = childPointer(pointer, name);
    if (arity === "one" && value !== undefined) {
      walkLayout(layout, child, value, location);
    } else if (arity === "list" && isArray(value)) {
      layout.structural.add(location);
      for (const [index, item] of value.entries()) {
        walkLayout(layout, child, item, childPointer(location, String(index)));
      }
    } else if (arity === "map" && isObject(value)) {
      layout.structural.add(location);
      for (const [entry, item] of Object.entries(value)) {
        walkLayout(layout, child, item, childPointer(location, entry));
      }
    }
  }
};

const layoutOf = (budget: Budget, value: Json): Layout => {
  const layout: Layout = { budget, roots: [], structural: new Set() };
  walkLayout(layout, "root", value, "");

  return layout;
};

// The layout kind each non-schema reference target starts a walk at.
const targetKinds: Partial<Record<ReferenceKind, Kind>> = {
  callback: "callback",
  header: "header",
  mediaType: "mediaType",
  parameter: "header",
  pathItem: "pathItem",
  requestBody: "requestBody",
  response: "response",
};

// The layout of each other document of the set, walked from the objects references reach there,
// so only the schema roots a reference brings into the entry's operations are stored.
const memberLayouts = (budget: Budget, resolution: Resolution): ReadonlyMap<Document, Layout> => {
  const layouts = new Map<Document, Layout>();
  for (const { kind, target } of resolution.references.values()) {
    const start = targetKinds[kind];
    const value = resolution.documents.get(target.document);
    if (target.document !== resolution.document && start !== undefined && value !== undefined) {
      const layout = layouts.get(target.document) ?? { budget, roots: [], structural: new Set() };
      layouts.set(target.document, layout);
      walkLayout(layout, start, nodeAt(value, target.pointer) ?? null, target.pointer);
    }
  }

  return layouts;
};

// ---------------------------------------------------------------------------------------------
// The store: every schema root and every schema `$ref` target, converted to draft 2020-12.

const messageOf = (cause: unknown): string =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message
    : "The importer failed without a message.";

// Rewrites every schema `$ref` to `#/$defs/<key>` from the resolution, before conversion.
const rewriteReferences = (
  budget: Budget,
  resolution: Resolution,
  node: Json,
  at: CanonicalKey,
): Json => {
  const where = resolution.line === "3.0" ? positions30 : positions2020;
  const tokens = tokensOf(at.pointer);
  if (tokens === undefined) {
    return node;
  }

  return transformSchema(budget, node, tokens, where, (current, path) => {
    const site = { document: at.document, pointer: formatPointer(path) };
    const reference =
      stringMember(current, "$ref") === undefined
        ? undefined
        : resolution.references.get(keyOf(site));
    if (reference === undefined) {
      return current;
    }

    // A reference the resolver left without a key names the document root, which is no schema
    // (D-AD12): the `$ref` is dropped here and `diagnosticsOf` refuses the site.
    if (reference.defsKey === undefined) {
      return Object.fromEntries(Object.entries(current).filter(([key]) => key !== "$ref"));
    }

    const ref = refFor(reference.defsKey);

    return Object.fromEntries(
      Object.entries(current).map(([key, value]): [string, Json] =>
        key === "$ref" ? [key, ref] : [key, value],
      ),
    );
  });
};

const fromOpenApi = (line: Line, node: JsonObject): JsonSchema.JsonSchema =>
  line === "3.0"
    ? JsonSchema.fromSchemaOpenApi3_0(node).schema
    : JsonSchema.fromSchemaOpenApi3_1(node).schema;

const convert = (line: Line, key: string, node: Json): Effect.Effect<Json, SchemaImportDefect> => {
  if (Predicate.isBoolean(node)) {
    return Effect.succeed(node ? {} : { not: {} });
  }

  if (!isObject(node)) {
    return Effect.fail(new SchemaImportDefect({ key, message: "The schema is not an object." }));
  }

  return Effect.try({
    catch: (cause) => new SchemaImportDefect({ key, message: messageOf(cause) }),
    try: () => fromOpenApi(line, node),
  }).pipe(
    Effect.flatMap((schema) =>
      isJson(schema)
        ? Effect.succeed(schema)
        : Effect.fail(new SchemaImportDefect({ key, message: "The conversion is not JSON." })),
    ),
  );
};

const typesOf = (node: JsonObject): readonly string[] => {
  const type = member(node, "type");

  return Predicate.isString(type) ? [type] : strings(type);
};

const factsOf = (node: Json): SchemaFacts => {
  const object = isObject(node) ? node : {};
  const properties = member(object, "properties");
  const ref = stringMember(object, "$ref");
  const format = stringMember(object, "format");

  return {
    contentEncoding: stringMember(object, "contentEncoding"),
    contentMediaType: stringMember(object, "contentMediaType"),
    format: format === "binary" || format === "byte" ? format : undefined,
    items: member(object, "items") !== undefined || member(object, "prefixItems") !== undefined,
    properties: isObject(properties) ? Object.keys(properties) : [],
    reference: ref === undefined ? undefined : referenceKey(ref),
    required: strings(member(object, "required")),
    types: typesOf(object),
  };
};

// The source of every stored key: Schema Object roots under `defsKey` of their use site, in the
// entry and in the objects references reach in other documents, and schema `$ref` targets in any
// document under the resolver's key unless the target is not a schema.
const sitesOf = (budget: Budget, resolution: Resolution): ReadonlyMap<string, CanonicalKey> => {
  const entry: Document = resolution.document;
  const layout = layoutOf(budget, resolution.value);
  const members = memberLayouts(budget, resolution);
  const roots = [
    ...layout.roots.map((pointer): CanonicalKey => ({ document: entry, pointer })),
    ...[...members].flatMap(([document, found]) =>
      found.roots.map((pointer): CanonicalKey => ({ document, pointer })),
    ),
  ];
  const sites = new Map(roots.map((root): [string, CanonicalKey] => [defsKey(entry, root), root]));
  for (const { defsKey: key, kind, target } of resolution.references.values()) {
    const structural =
      target.document === entry ? layout.structural : members.get(target.document)?.structural;
    const lifted =
      kind === "schema" && key !== undefined && structural?.has(target.pointer) !== true;
    if (lifted) {
      sites.set(key, target);
    }
  }

  return sites;
};

const storeFrom = (
  budget: Budget,
  resolution: Resolution,
  sites: ReadonlyMap<string, CanonicalKey>,
): Effect.Effect<StoredSchemas, SchemaBudgetExceeded | SchemaImportDefect> =>
  Effect.forEach(sortedKeys(sites), (key) => {
    const at = sites.get(key) ?? { document: resolution.document, pointer: "" };

    return Effect.option(nodeIn(resolution, at)).pipe(
      Effect.map(Option.getOrElse((): Json => ({}))),
      Effect.flatMap((node) =>
        convert(resolution.line, key, rewriteReferences(budget, resolution, node, at)),
      ),
      Effect.map((converted): [string, Json] => [key, converted]),
    );
  }).pipe(
    Effect.flatMap((entries) =>
      within(budget, {
        definitions: new Map(entries),
        facts: new Map(entries.map(([key, node]): [string, SchemaFacts] => [key, factsOf(node)])),
      }),
    ),
  );

/**
 * Builds the schema store (design 2.2, 3.5): each Schema Object root (components and inline use
 * sites in parameters, headers, media types and encodings) and each schema `$ref` target, converted
 * with `JsonSchema.fromSchemaOpenApi3_0` or `_3_1` into one set of draft 2020-12 definitions. Keys
 * follow `defsKey` (design 2.2 key rule): a component uses its name and any other schema its
 * canonical pointer, so an inline parameter or request schema is stored under `defsKey(entry, use
 * site)`. Every `$ref` names `#/$defs/<key>`. A `$ref` target that is the document root or another
 * OpenAPI object is not stored; the validation copy refuses the reference.
 */
export const storeSchemas = (
  resolution: Resolution,
  limits: SchemaLimits = {},
): Effect.Effect<StoredSchemas, SchemaBudgetExceeded | SchemaImportDefect> => {
  const budget = budgetOf(limits);

  return storeFrom(budget, resolution, sitesOf(budget, resolution));
};

// Keywords beside a `$ref` that assert nothing: annotations, extensions and location keywords.
const nonAsserting: ReadonlySet<string> = new Set([
  "$anchor",
  "$comment",
  "$defs",
  "$id",
  "$schema",
  "default",
  "definitions",
  "deprecated",
  "description",
  "example",
  "examples",
  "nullable",
  "readOnly",
  "title",
  "writeOnly",
]);

const asserts = (keyword: string): boolean =>
  keyword !== "$ref" && !nonAsserting.has(keyword) && !keyword.startsWith("x-");

/**
 * The store key of the schema at a use site (design 2.2 key rule, SCH-03). A `$ref` names its
 * target's key, so the target's export is shared, unless a 3.1 or later `$ref` carries a keyword
 * beside it that asserts, such as `maximum`: then the use site's own key, whose stored definition
 * keeps both. A 3.0 `$ref` ignores its siblings. A site without a `$ref` is its own key.
 */
export const schemaKeyAt = (resolution: Resolution, site: CanonicalKey): string => {
  const own = defsKey(resolution.document, site);
  const target = referenceIn(resolution, site)?.defsKey;
  if (target === undefined || resolution.line === "3.0") {
    return target ?? own;
  }

  const value = resolution.documents.get(site.document);
  const node = value === undefined ? undefined : nodeAt(value, site.pointer);

  return isObject(node) && Object.keys(node).some(asserts) ? own : target;
};

// ---------------------------------------------------------------------------------------------
// The validation copy (design 3.5 "Import copies"; D-AD12 tiers and special cases).

// Inventory rows per keyword, for 3.0 and for 3.1 and 3.2.
const keywordRows = new Map<string, readonly [row30: string, row31: string]>([
  ["additionalProperties", ["S30-24", "SCH-13"]],
  ["const", ["SCH-28", "SCH-28"]],
  ["contains", ["SCH-12", "SCH-12"]],
  ["contentSchema", ["SCH-57", "SCH-57"]],
  ["dependentRequired", ["SCH-46", "SCH-46"]],
  ["dependentSchemas", ["SCH-16", "SCH-16"]],
  ["else", ["SCH-20", "SCH-20"]],
  ["enum", ["S30-16", "SCH-29"]],
  ["format", ["S30-26", "SCH-54"]],
  ["if", ["SCH-18", "SCH-18"]],
  ["maxContains", ["SCH-41", "SCH-41"]],
  ["minContains", ["SCH-42", "SCH-42"]],
  ["not", ["S30-21", "SCH-24"]],
  ["pattern", ["S30-09", "SCH-37"]],
  ["patternProperties", ["SCH-15", "SCH-15"]],
  ["then", ["SCH-19", "SCH-19"]],
  ["unevaluatedItems", ["SCH-25", "SCH-25"]],
  ["unevaluatedProperties", ["SCH-26", "SCH-26"]],
]);

const rowOf = (line: Line, keyword: string): string => {
  const [row30, row31] = keywordRows.get(keyword) ?? ["SCO-01", "SCO-01"];

  return line === "3.0" ? row30 : row31;
};

// Server-validated keywords, removed wherever they occur (D-AD12).
const serverValidated: ReadonlySet<string> = new Set([
  "contains",
  "contentSchema",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "if",
  "maxContains",
  "minContains",
  "pattern",
  "patternProperties",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

// The dynamic and recursive keywords (D-AD12): refused wherever a schema holds them, and a body
// schema that applies one is refused with it (SCH-05, 06, 65, 66).
const dynamicKeywords = new Map([
  ["$dynamicAnchor", "SCH-06/dynamic-anchor"],
  ["$dynamicRef", "SCH-05/dynamic-ref"],
  ["$recursiveAnchor", "SCH-65/recursive-anchor"],
  ["$recursiveRef", "SCH-66/recursive-ref"],
]);

// Keywords of other dialects that 3.1 and 3.2 refuse at element scope (SCH-07, SCH-64); a 3.0
// schema does not read them.
const otherDialect = new Map([
  ["$vocabulary", "SCH-07/vocabulary"],
  ["dependencies", "SCH-64/dependencies"],
]);

// The refusal code of a refused keyword (D-AD12), or `undefined`.
const refusedCode = (line: Line, keyword: string): string | undefined =>
  dynamicKeywords.get(keyword) ?? (line === "3.0" ? undefined : otherDialect.get(keyword));

// Every refused keyword in a stored schema's source, nested `$defs` and `definitions` members
// included, so whether a member is referenced does not change the refusal: one rule wherever the
// keyword sits. The copy removes the ones it stores; these are reported at their schema.
const refusedInSource = (
  budget: Budget,
  resolution: Resolution,
  sites: ReadonlyMap<string, CanonicalKey>,
): readonly (readonly [code: string, at: CanonicalKey])[] => {
  const where = resolution.line === "3.0" ? positions30 : positions2020;
  const found: [string, CanonicalKey][] = [];
  for (const key of sortedKeys(sites)) {
    const site = sites.get(key) ?? { document: resolution.document, pointer: "" };
    const value = resolution.documents.get(site.document);
    const tokens = tokensOf(site.pointer);
    const node = value === undefined ? undefined : nodeAt(value, site.pointer);
    if (tokens !== undefined && node !== undefined) {
      const visit = (current: JsonObject, path: readonly string[]): void => {
        for (const keyword of Object.keys(current)) {
          const code = refusedCode(resolution.line, keyword);
          if (code !== undefined) {
            found.push([code, { document: site.document, pointer: formatPointer(path) }]);
          }
        }
      };
      forEachSchema(budget, node, where, visit, tokens);
    }
  }

  return found;
};

// Whether the schema at `at` holds a dynamic or recursive keyword in place (subschemas included,
// nested `$defs` not); the targets of its `$ref`s join `pending`.
const holdsDynamicKeyword = (
  budget: Budget,
  resolution: Resolution,
  at: CanonicalKey,
  pending: CanonicalKey[],
): boolean => {
  const value = resolution.documents.get(at.document);
  const tokens = tokensOf(at.pointer);
  const node = value === undefined ? undefined : nodeAt(value, at.pointer);
  if (tokens === undefined || node === undefined) {
    return false;
  }

  const where = resolution.line === "3.0" ? positions30 : copyPositions;
  let found = false;
  forEachSchema(
    budget,
    node,
    where,
    (current, path) => {
      found ||= Object.keys(current).some((keyword) => dynamicKeywords.has(keyword));

      const pointer = formatPointer(path);
      const reference =
        stringMember(current, "$ref") === undefined
          ? undefined
          : referenceIn(resolution, { document: at.document, pointer });
      if (reference !== undefined) {
        pending.push(reference.target);
      }
    },
    tokens,
  );

  return found;
};

/**
 * Whether the schema at `site` applies a dynamic or recursive keyword (SCH-05, 06, 65, 66):
 * itself, through a subschema, or through a `$ref` chain, across the document set. A nested
 * `$defs` member applies only through a reference. A body schema that does cannot be checked, so
 * it is refused like any other refused body schema, and a required one raises to operation scope.
 */
export const appliesDynamicKeyword = (
  resolution: Resolution,
  site: CanonicalKey,
  limits: SchemaLimits = {},
): boolean => {
  const budget = budgetOf(limits);
  const seen = new Set<string>();
  const pending = [site];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (!seen.has(keyOf(at))) {
      seen.add(keyOf(at));
      if (holdsDynamicKeyword(budget, resolution, at, pending)) {
        return true;
      }
    }
  }

  return false;
};

const annotationKeys: ReadonlySet<string> = new Set([
  "$comment",
  "deprecated",
  "description",
  "examples",
  "title",
]);

const isStructured = (value: Json | undefined): boolean => isArray(value) || isObject(value);

const isEmptySchema = (value: Json | undefined): boolean =>
  isObject(value) && Object.keys(value).length === 0;

const inTypes = (types: readonly string[], value: Json): boolean => {
  if (value === null) {
    return types.includes("null");
  }

  if (Predicate.isNumber(value)) {
    return types.includes("number") || (types.includes("integer") && Number.isInteger(value));
  }

  return (
    (Predicate.isString(value) && types.includes("string")) ||
    (Predicate.isBoolean(value) && types.includes("boolean"))
  );
};

const isAnnotationOnly = (branch: JsonObject): boolean =>
  Object.keys(branch).every(
    (key) => key === "const" || annotationKeys.has(key) || key.startsWith("x-"),
  );

// The values of a `oneOf`/`anyOf` whose branches are all primitive `const` values with annotations
// only (the S7 rule).
const constValues = (branches: Json | undefined): readonly Json[] | undefined => {
  if (!isArray(branches) || branches.length === 0) {
    return undefined;
  }

  const values: Json[] = [];
  for (const branch of branches) {
    const value = isObject(branch) ? member(branch, "const") : undefined;
    if (!isObject(branch) || value === undefined || isStructured(value)) {
      return undefined;
    }

    if (!isAnnotationOnly(branch)) {
      return undefined;
    }

    values.push(value);
  }

  return values;
};

const outsideSafeRange = (node: JsonObject): boolean =>
  ["exclusiveMaximum", "exclusiveMinimum", "maximum", "minimum"].some((keyword) => {
    const bound = member(node, keyword);

    return Predicate.isNumber(bound) && Math.abs(bound) > Number.MAX_SAFE_INTEGER;
  });

const isInt64 = (node: JsonObject): boolean =>
  typesOf(node).includes("integer") &&
  (stringMember(node, "format") === "int64" || outsideSafeRange(node));

interface Recorder {
  readonly definitions: ReadonlyMap<string, Json>;
  readonly edits: SchemaEdit[];
  readonly key: string;
  readonly line: Line;
}

const record = (
  recorder: Recorder,
  action: SchemaEdit["action"],
  code: string,
  path: readonly string[],
): void => {
  recorder.edits.push({ action, code, key: recorder.key, path });
};

// The members a node's `enum` keeps. An object or array member removes the keyword
// (server-validated); a primitive member outside the declared type is dropped (SM-R16), and an
// `enum` left empty is removed.
const filterEnum = (
  recorder: Recorder,
  node: JsonObject,
  path: readonly string[],
): readonly Json[] | undefined => {
  const members = member(node, "enum");
  const enumPath = [...path, "enum"];
  const types = typesOf(node);
  if (!isArray(members)) {
    return undefined;
  }

  if (members.some(isStructured)) {
    record(recorder, "remove", `${rowOf(recorder.line, "enum")}/not-asserted`, enumPath);

    return undefined;
  }

  const kept = members.filter((value, index) => {
    const inside = types.length === 0 || inTypes(types, value);
    if (!inside) {
      const code = `${rowOf(recorder.line, "enum")}/outside-type`;
      record(recorder, "drop-member", code, [...enumPath, String(index)]);
    }

    return inside;
  });

  return kept.length > 0 ? kept : undefined;
};

// Whether a property schema is `readOnly: true`, itself or as the target of its `$ref`.
const isReadOnly = (definitions: ReadonlyMap<string, Json>, schema: Json | undefined): boolean => {
  if (!isObject(schema)) {
    return false;
  }

  const ref = stringMember(schema, "$ref");
  const key = ref === undefined ? undefined : referenceKey(ref);
  const target = key === undefined ? undefined : definitions.get(key);

  return (
    member(schema, "readOnly") === true || (isObject(target) && member(target, "readOnly") === true)
  );
};

// The names a node's `required` keeps on a request. A read-only property is not required there
// (D-SCH2): 3.0.4 says `required` takes effect on the response only, so it is dropped under a code
// no rule reports; in 3.1 and 3.2 the server decides (server-validated tier), so each drop is a
// SCH-45 notice. `required` in one `allOf` branch naming a read-only property declared in another
// is not seen here and stays asserted.
const filterRequired = (
  recorder: Recorder,
  node: JsonObject,
  path: readonly string[],
): Json | undefined => {
  const names = member(node, "required");
  const properties = member(node, "properties");
  if (!isArray(names) || !isObject(properties)) {
    return names;
  }

  const code = recorder.line === "3.0" ? "S30-31/response-only" : "SCH-45/read-only-required";
  const kept = names.filter((name, index) => {
    const readOnly =
      Predicate.isString(name) && isReadOnly(recorder.definitions, member(properties, name));
    if (readOnly) {
      record(recorder, "drop-member", code, [...path, "required", String(index)]);
    }

    return !readOnly;
  });

  return kept.length > 0 ? kept : undefined;
};

// Whether a value is an instance of one of the declared types; no declared type admits any value.
const conformsTo = (types: readonly string[], value: Json): boolean => {
  if (types.length === 0) {
    return true;
  }

  if (isArray(value)) {
    return types.includes("array");
  }

  return isObject(value) ? types.includes("object") : inTypes(types, value);
};

// The code of a keyword the validation copy removes, or `undefined` when the keyword stays. A 3.0
// `default` MUST conform to the schema's type (S30-27, D-OC3); one that does not is refused at
// element scope. In 3.1 and 3.2 `default` is an annotation (SCH-49) and stays.
const removalCode = (
  line: Line,
  node: JsonObject,
  keyword: string,
  value: Json,
): string | undefined => {
  if (keyword === "default" && line === "3.0" && !conformsTo(typesOf(node), value)) {
    return "S30-27/nonconforming-default";
  }

  const refused = refusedCode(line, keyword);
  const notAsserted =
    serverValidated.has(keyword) ||
    (keyword === "format" && value !== "binary" && value !== "byte") ||
    (keyword === "not" && !isEmptySchema(value)) ||
    (keyword === "const" && isStructured(value));
  if (refused !== undefined) {
    return refused;
  }

  if (notAsserted) {
    return `${rowOf(line, keyword)}/not-asserted`;
  }

  return keyword === "nullable" && line !== "3.0" ? "SCH-62/nullable-no-effect" : undefined;
};

const retype = (value: Json): Json => {
  if (Predicate.isString(value)) {
    return "number";
  }

  return [...new Set(strings(value).map((type) => (type === "integer" ? "number" : type)))];
};

// An `additionalProperties` that rejects or types some keys. Beside `patternProperties` it cannot
// stay: which keys it governs depends on the patterns, which are not asserted (SCH-15), so the
// object is left open, as Effect's importer leaves it when it ignores patterns.
const constrainsKeys = (value: Json): boolean =>
  value === false || (isObject(value) && !isEmptySchema(value));

const filterNode =
  (recorder: Recorder): Visit =>
  (node, path) => {
    const int64 = isInt64(node);
    let enumValues = filterEnum(recorder, node, path);
    const rewritten = new Set<string>();
    for (const keyword of ["oneOf", "anyOf"]) {
      const values = constValues(member(node, keyword));
      if (values !== undefined) {
        rewritten.add(keyword);
        enumValues =
          enumValues === undefined ? values : enumValues.filter((item) => values.includes(item));
      }
    }

    if (int64) {
      record(recorder, "retype", "FMT-02/int64-range", path);
    }

    const patterned = member(node, "patternProperties") !== undefined;
    const kept: [string, Json][] = [];
    for (const [keyword, value] of Object.entries(node)) {
      const code = removalCode(recorder.line, node, keyword, value);
      if (code !== undefined) {
        record(recorder, "remove", code, [...path, keyword]);
      } else if (keyword === "additionalProperties" && patterned && constrainsKeys(value)) {
        record(recorder, "remove", `${rowOf(recorder.line, "patternProperties")}/not-asserted`, [
          ...path,
          keyword,
        ]);
      } else if (keyword === "type" && int64) {
        kept.push([keyword, retype(value)]);
      } else if (keyword === "required") {
        const required = filterRequired(recorder, node, path);
        if (required !== undefined) {
          kept.push([keyword, required]);
        }
      } else if (keyword !== "enum" && !rewritten.has(keyword)) {
        kept.push([keyword, value]);
      }
    }

    if (enumValues !== undefined) {
      kept.push(["enum", enumValues]);
    }

    return Object.fromEntries(kept);
  };

interface Edge {
  readonly from: string;
  readonly path: readonly string[];
  readonly to: string;
}

const edgesOf = (budget: Budget, definitions: ReadonlyMap<string, Json>): readonly Edge[] => {
  const edges: Edge[] = [];
  for (const key of sortedKeys(definitions)) {
    forEachSchema(budget, definitions.get(key) ?? {}, inPlace, (node, path) => {
      const ref = stringMember(node, "$ref");
      const to = ref === undefined ? undefined : referenceKey(ref);
      if (to !== undefined && definitions.has(to)) {
        edges.push({ from: key, path, to });
      }
    });
  }

  return edges;
};

interface Frame {
  at: number;
  readonly key: string;
  readonly targets: readonly string[];
}

interface Tarjan {
  counter: number;
  readonly component: Map<string, number>;
  readonly index: Map<string, number>;
  readonly low: Map<string, number>;
  readonly next: ReadonlyMap<string, readonly string[]>;
  readonly onStack: Set<string>;
  readonly stack: string[];
  readonly work: Frame[];
}

const lower = (state: Tarjan, key: string, value: number): void => {
  state.low.set(key, Math.min(state.low.get(key) ?? value, value));
};

const open = (state: Tarjan, key: string): void => {
  state.index.set(key, state.counter);
  state.low.set(key, state.counter);
  state.counter += 1;
  state.stack.push(key);
  state.onStack.add(key);
  state.work.push({ at: 0, key, targets: state.next.get(key) ?? [] });
};

// Closes a finished node: its low link flows to its caller, and a root pops its component.
const close = (state: Tarjan, frame: Frame): void => {
  const own = state.index.get(frame.key) ?? 0;
  const low = state.low.get(frame.key) ?? own;
  const caller = state.work.at(-1);
  if (caller !== undefined) {
    lower(state, caller.key, low);
  }

  if (low !== own) {
    return;
  }

  let popped = state.stack.pop();
  while (popped !== undefined) {
    state.onStack.delete(popped);
    state.component.set(popped, own);
    popped = popped === frame.key ? undefined : state.stack.pop();
  }
};

// One depth-first search with an explicit work stack, so a long reference chain cannot exhaust
// the call stack.
const connect = (state: Tarjan, root: string): void => {
  open(state, root);
  let frame = state.work.at(-1);
  while (frame !== undefined) {
    const target = frame.targets[frame.at];
    if (target === undefined) {
      state.work.pop();
      close(state, frame);
    } else {
      frame.at += 1;
      if (!state.index.has(target)) {
        open(state, target);
      } else if (state.onStack.has(target)) {
        lower(state, frame.key, state.index.get(target) ?? 0);
      }
    }

    frame = state.work.at(-1);
  }
};

// Tarjan's strongly connected components over the in-place reference graph, iteratively.
const componentsOf = (
  keys: readonly string[],
  edges: readonly Edge[],
): ReadonlyMap<string, number> => {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = next.get(edge.from);
    if (targets === undefined) {
      next.set(edge.from, [edge.to]);
    } else {
      targets.push(edge.to);
    }
  }

  const state: Tarjan = {
    component: new Map(),
    counter: 0,
    index: new Map(),
    low: new Map(),
    next,
    onStack: new Set(),
    stack: [],
    work: [],
  };
  for (const key of keys) {
    if (!state.index.has(key)) {
      connect(state, key);
    }
  }

  return state.component;
};

const replaceAt = (node: Json, path: readonly string[]): Json => {
  const [token, ...rest] = path;
  if (token === undefined) {
    return {};
  }

  if (isArray(node)) {
    return node.map((item, index) => (String(index) === token ? replaceAt(item, rest) : item));
  }

  if (!isObject(node)) {
    return node;
  }

  return Object.fromEntries(
    Object.entries(node).map(([key, value]): [string, Json] =>
      key === token ? [key, replaceAt(value, rest)] : [key, value],
    ),
  );
};

// Refuses every reference site on a cycle that returns to a schema without descending into the
// instance (D-AD12 refused tier, DOC-23/alias-cycle): each such site becomes `{}` in the copy.
const breakAliasCycles = (
  budget: Budget,
  initial: ReadonlyMap<string, Json>,
  edits: SchemaEdit[],
): ReadonlyMap<string, Json> => {
  const edges = edgesOf(budget, initial);
  const component = componentsOf(sortedKeys(initial), edges);
  const sizes = new Map<number, number>();
  for (const id of component.values()) {
    sizes.set(id, (sizes.get(id) ?? 0) + 1);
  }

  const definitions = new Map(initial);
  for (const edge of edges) {
    const id = component.get(edge.from);
    const cyclic =
      id !== undefined &&
      id === component.get(edge.to) &&
      (edge.from === edge.to || (sizes.get(id) ?? 0) > 1);
    if (cyclic) {
      edits.push({
        action: "replace",
        code: "DOC-23/alias-cycle",
        key: edge.from,
        path: edge.path,
      });
      definitions.set(edge.from, replaceAt(definitions.get(edge.from) ?? {}, edge.path));
    }
  }

  return definitions;
};

// The importer's failure classes D-AD12 names (spike S7); any other class is a defect.
const importClasses: readonly (readonly [prefix: string, code: (line: Line) => string])[] = [
  ["Cannot intersect these", () => "SCO-09/union-not-asserted"],
  [
    'Cannot combine typed "additionalProperties"',
    (line) => `${rowOf(line, "additionalProperties")}/not-asserted`,
  ],
  ["Missing definition", (line) => `${line === "3.0" ? "REF-02" : "SCH-03"}/non-schema-target`],
  ['Cannot resolve $ref under a nested "$id"', () => "SCH-02/nested-resource"],
  ["Definition ", () => "DOC-23/alias-cycle"],
];

const quoted = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

const pathToken = /\[(?<token>"(?:[^"\\]|\\.)*"|\d+)\]/gu;

// The importer's error path (a line `  at ["definitions"]["A"][0]`) as tokens.
const importPath = (message: string): readonly string[] => {
  const [, location = ""] = message.split("\n  at ");

  return [...location.matchAll(pathToken)].map((match) => {
    const token = match.groups?.token ?? "";

    return token.startsWith('"') ? Option.getOrElse(quoted(token), () => token) : token;
  });
};

// The child a schema keyword reaches from `node`, with the number of path tokens it consumes.
const keywordChild = (
  node: JsonObject,
  keyword: string,
  name: string,
): readonly [child: Json | undefined, width: number] => {
  const container = member(node, keyword);
  if (copyPositions.one.has(keyword)) {
    return [container, 1];
  }

  const indexed = copyPositions.list.has(keyword) || copyPositions.map.has(keyword);

  return indexed ? [childAt(container, name), 2] : [undefined, 1];
};

// The deepest schema node on `tokens` that exists: the importer's path can run through merged
// intersection scopes that are not positions in the document (spike S7).
const deepestSchema = (node: Json, tokens: readonly string[]): readonly string[] => {
  let current = node;
  let consumed = 0;
  while (consumed < tokens.length && isObject(current)) {
    const [child, width] = keywordChild(
      current,
      tokens[consumed] ?? "",
      tokens[consumed + 1] ?? "",
    );
    if (child === undefined || !(isObject(child) || Predicate.isBoolean(child))) {
      break;
    }

    current = child;
    consumed += width;
  }

  return tokens.slice(0, consumed);
};

const multiDocument = (
  definitions: ReadonlyMap<string, Json>,
): JsonSchema.MultiDocument<"draft-2020-12"> | undefined => {
  const keys = sortedKeys(definitions);
  const [first, ...rest] = keys.map((key) => ({ $ref: refFor(key) }));
  if (first === undefined) {
    return undefined;
  }

  const entries = keys.flatMap((key): [string, JsonObject][] => {
    const node = definitions.get(key);

    return isObject(node) ? [[key, node]] : [];
  });

  return {
    definitions: Object.fromEntries(entries),
    dialect: "draft-2020-12",
    schemas: [first, ...rest],
  };
};

/**
 * Effect's importer as both import copies run it: the validation copy here, and the
 * code-generation copy in the domain emitter. Pattern constraints stay at the importer's default
 * (rejected): the validation copy removes every `pattern` and `patternProperties` before import, so
 * the two copies can never disagree on one.
 */
export const importSchemas = (
  multi: JsonSchema.MultiDocument<"draft-2020-12">,
): readonly [Schema.Top, ...Schema.Top[]] =>
  SchemaRepresentation.fromJsonSchemaMultiDocument(multi);

const importOnce = (
  definitions: ReadonlyMap<string, Json>,
): Effect.Effect<Option.Option<string>> => {
  const multi = multiDocument(definitions);
  if (multi === undefined) {
    return Effect.succeed(Option.none());
  }

  return Effect.try({ catch: messageOf, try: () => importSchemas(multi) }).pipe(
    Effect.match({ onFailure: (message) => Option.some(message), onSuccess: () => Option.none() }),
  );
};

const sameJson = (left: Json | undefined, right: Json | undefined): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

// The edit for one importer failure, or `undefined` when its class is unnamed or it makes no
// progress (the located node is already `{}`).
const importEdit = (
  line: Line,
  definitions: ReadonlyMap<string, Json>,
  message: string,
): SchemaEdit | undefined => {
  const [first = ""] = message.split("\n");
  const found = importClasses.find(([prefix]) => first.startsWith(prefix));
  const [root, name = "", ...tokens] = importPath(message);
  const key = root === "schemas" ? (sortedKeys(definitions)[Number(name)] ?? "") : name;
  const node = definitions.get(key);
  if (found === undefined || node === undefined) {
    return undefined;
  }

  const path = root === "definitions" ? deepestSchema(node, tokens) : [];

  return sameJson(replaceAt(node, path), node)
    ? undefined
    : { action: "replace", code: found[1](line), key, path };
};

// Imports through `importSchemas`; each rejected node becomes `{}` under the code of its class,
// at its deepest existing schema ancestor, until the import succeeds. The importer stops at its
// first failure, so repairs cannot be batched: each pass is charged the number of definitions it
// imports, and the budget caps the passes.
const importCopy = Effect.fnUntraced(function* importCopy(
  budget: Budget,
  line: Line,
  initial: ReadonlyMap<string, Json>,
  edits: SchemaEdit[],
): Effect.fn.Return<ReadonlyMap<string, Json>, SchemaBudgetExceeded | SchemaImportDefect> {
  const definitions = new Map(initial);
  budget.spent += definitions.size;
  yield* within(budget, definitions);
  let failure = yield* importOnce(definitions);
  while (Option.isSome(failure)) {
    const edit = importEdit(line, definitions, failure.value);
    if (edit === undefined) {
      return yield* new SchemaImportDefect({ key: "", message: failure.value });
    }

    edits.push(edit);
    definitions.set(edit.key, replaceAt(definitions.get(edit.key) ?? {}, edit.path));
    budget.spent += definitions.size;
    yield* within(budget, definitions);
    failure = yield* importOnce(definitions);
  }

  return definitions;
});

/**
 * Derives the validation copy from stored definitions (design 3.5 "Import copies", D-AD12): the
 * server-validated keywords are removed with a notice per occurrence; refused keywords are removed
 * with a refusal; an all-constant `oneOf` or `anyOf` becomes one `enum` with no notice; `enum`
 * members outside the declared type are dropped with a notice (SM-R16); a 3.0 `nullable` in 3.1 or
 * 3.2 is removed with a notice and no effect; an out-of-safe-range integer is asserted as a number
 * (int64 notice); `patternProperties` is removed with a notice, with an `additionalProperties`
 * beside it that rejects or types keys (SCH-15); a name in `required` whose property is read-only
 * is dropped (SCH-45: a notice in 3.1 and 3.2, none in 3.0); a 3.0 `default` outside the schema's
 * type is removed with a refusal (S30-27); a pure alias cycle is refused; then
 * Effect's importer runs, and each node it still rejects becomes `{}` under the code of its D-AD12
 * class. The copy is the stored document minus `edits` (X10); it is recomputed, never edited.
 */
export const validationCopy = Effect.fnUntraced(function* validationCopy(
  line: Line,
  definitions: ReadonlyMap<string, Json>,
  limits: SchemaLimits = {},
): Effect.fn.Return<ValidationCopy, SchemaBudgetExceeded | SchemaImportDefect> {
  const budget = budgetOf(limits);
  const edits: SchemaEdit[] = [];
  const filtered = new Map(
    sortedKeys(definitions).map((key): [string, Json] => {
      const visit = filterNode({ definitions, edits, key, line });

      return [key, transformSchema(budget, definitions.get(key) ?? {}, [], copyPositions, visit)];
    }),
  );
  const acyclic = yield* within(budget, breakAliasCycles(budget, filtered, edits));
  const imported = yield* importCopy(budget, line, acyclic, edits);

  return { definitions: imported, edits };
});

// ---------------------------------------------------------------------------------------------
// Diagnostics.

interface Rule {
  readonly anchor: string;
  readonly element: string;
  readonly message: string;
  readonly severity: "notice" | "refusal";
}

const keywordsSection = "json-schema-keywords";

const rules = new Map<string, Rule>([
  [
    "alias-cycle",
    {
      anchor: "handling-reference-cycles",
      element: "Schema reference cycle",
      message:
        "A cycle of schema references returns to a schema without descending into the instance.",
      severity: "refusal",
    },
  ],
  [
    "dependencies",
    {
      anchor: keywordsSection,
      element: "Schema dependencies",
      message:
        "dependencies is not a keyword of the OpenAPI dialect; use dependentRequired or dependentSchemas.",
      severity: "refusal",
    },
  ],
  [
    "dynamic-anchor",
    {
      anchor: keywordsSection,
      element: "Schema $dynamicAnchor",
      message: "$dynamicAnchor is not supported.",
      severity: "refusal",
    },
  ],
  [
    "dynamic-ref",
    {
      anchor: keywordsSection,
      element: "Schema $dynamicRef",
      message: "$dynamicRef is not supported.",
      severity: "refusal",
    },
  ],
  [
    "int64-range",
    {
      anchor: "data-type-format",
      element: "Schema integer range",
      message: "int64 range is not asserted client-side.",
      severity: "notice",
    },
  ],
  [
    "nested-resource",
    {
      anchor: keywordsSection,
      element: "Schema $id resource",
      message: "A $ref inside a nested $id resource cannot be flattened into $defs.",
      severity: "refusal",
    },
  ],
  [
    "non-schema-target",
    {
      anchor: keywordsSection,
      element: "Schema $ref target",
      message: "The $ref target is the document root or another object that is not a schema.",
      severity: "refusal",
    },
  ],
  [
    "nonconforming-default",
    {
      anchor: keywordsSection,
      element: "Schema default",
      message: "The default does not conform to the schema type; it is never sent.",
      severity: "refusal",
    },
  ],
  [
    "not-asserted",
    {
      anchor: keywordsSection,
      element: "Schema keyword",
      message: "The schema is not asserted here client-side; the value is sent unvalidated.",
      severity: "notice",
    },
  ],
  [
    "nullable-no-effect",
    {
      anchor: keywordsSection,
      element: "Schema nullable",
      message: 'nullable has no effect in OpenAPI 3.1 and later; use type: [..., "null"].',
      severity: "notice",
    },
  ],
  [
    "outside-type",
    {
      anchor: keywordsSection,
      element: "Schema enum member",
      message: "An enum member outside the declared type is dropped.",
      severity: "notice",
    },
  ],
  [
    "read-only-required",
    {
      anchor: "validating-readonly-and-writeonly",
      element: "Schema required",
      message:
        "A required read-only property is not asserted client-side on a request; the server decides.",
      severity: "notice",
    },
  ],
  [
    "recursive-anchor",
    {
      anchor: keywordsSection,
      element: "Schema $recursiveAnchor",
      message: "$recursiveAnchor is not supported.",
      severity: "refusal",
    },
  ],
  [
    "recursive-ref",
    {
      anchor: keywordsSection,
      element: "Schema $recursiveRef",
      message: "$recursiveRef is not supported.",
      severity: "refusal",
    },
  ],
  [
    "vocabulary",
    {
      anchor: keywordsSection,
      element: "Schema $vocabulary",
      message: "$vocabulary is not supported; schemas must use the OpenAPI dialect.",
      severity: "refusal",
    },
  ],
  [
    "union-not-asserted",
    {
      anchor: "composition-and-inheritance-polymorphism",
      element: "Schema composition",
      message:
        "These allOf, anyOf or oneOf alternatives cannot be intersected; the schema is not asserted client-side.",
      severity: "notice",
    },
  ],
]);

const Declared = Schema.Struct({ openapi: Schema.String });

// The deepest existing node of the source document on the edit's path, as an RFC 6901 pointer.
const sourcePointer = (value: Json, base: string, path: readonly string[]): string => {
  const tokens = tokensOf(base);
  if (tokens === undefined) {
    return "";
  }

  let current = Result.getSuccess(evaluatePointerResult(value, base)).pipe(Option.getOrUndefined);
  let consumed = 0;
  for (const token of path) {
    current = childAt(current, token);
    if (current === undefined) {
      break;
    }

    consumed += 1;
  }

  return formatPointer([...tokens, ...path.slice(0, consumed)]);
};

// A refusal of a removed keyword is reported at its schema, as the resolver reports `$dynamicRef`;
// a name dropped from `required` at the `required` keyword, once per schema.
const reportedPath = (edit: SchemaEdit, rule: Rule): readonly string[] => {
  const removedRefusal = rule.severity === "refusal" && edit.action === "remove";
  const droppedRequired = edit.action === "drop-member" && edit.path.at(-2) === "required";

  return removedRefusal || droppedRequired ? edit.path.slice(0, -1) : edit.path;
};

// A diagnostic's identity for deduplication: its code at its document and pointer.
const identityOf = (code: string, at: { readonly document: string; readonly pointer: string }) =>
  `${code} ${at.document}#${at.pointer}`;

const diagnosticsOf = (
  resolution: Resolution,
  sites: ReadonlyMap<string, CanonicalKey>,
  edits: readonly SchemaEdit[],
  refused: readonly (readonly [code: string, at: CanonicalKey])[],
): Effect.Effect<readonly Diagnostic[]> => {
  const openapi = Schema.decodeUnknownOption(Declared)(resolution.value).pipe(
    Option.map((declared) => declared.openapi),
    Option.getOrElse(() => "unknown"),
  );
  const seen = new Set(
    resolution.diagnostics.map((diagnostic) => identityOf(diagnostic.code, diagnostic)),
  );
  const records: DiagnosticInput[] = [];
  const report = (
    code: string,
    at: CanonicalKey,
    rule: Rule | undefined,
    keyword?: string,
  ): void => {
    const [, name = ""] = code.split("/");
    const identity = identityOf(code, at);
    if (rule !== undefined && !seen.has(identity)) {
      seen.add(identity);

      records.push({
        code,
        document: at.document,
        element:
          name === "not-asserted" && keyword !== undefined ? `Schema ${keyword}` : rule.element,
        message: rule.message,
        openapi,
        pointer: at.pointer,
        scope: "element",
        severity: rule.severity,
        specSection: specSectionUrl(resolution.line, rule.anchor),
      });
    }
  };
  for (const edit of edits) {
    const rule = rules.get(edit.code.split("/")[1] ?? "");
    const site = sites.get(edit.key) ?? { document: resolution.document, pointer: "" };
    const value = resolution.documents.get(site.document) ?? null;
    const pointer =
      rule === undefined ? "" : sourcePointer(value, site.pointer, reportedPath(edit, rule));
    report(
      edit.code,
      { document: site.document, pointer },
      rule,
      edit.action === "remove" ? edit.path.at(-1) : undefined,
    );
  }

  for (const [code, at] of refused) {
    report(code, at, rules.get(code.split("/")[1] ?? ""));
  }

  for (const reference of resolution.references.values()) {
    if (reference.kind === "schema" && reference.defsKey === undefined) {
      const row = resolution.line === "3.0" ? "REF-02" : "SCH-03";
      report(`${row}/non-schema-target`, reference.site, rules.get("non-schema-target"));
    }
  }

  return pipe(
    records,
    Effect.forEach(makeDiagnostic),
    Effect.map((diagnostics) => sortDiagnostics([...resolution.documents.keys()], diagnostics)),
  );
};

/**
 * Normalizes the schemas of a resolved document set (design 3.5, unit NZ-4): the store, the facts,
 * the validation copy, one diagnostic per distinct edit at its source use site, and a refusal for
 * each refused keyword in a stored schema's source, nested `$defs` members included. A refusal the
 * resolver already reported is not repeated.
 */
export const normalizeSchemas = Effect.fnUntraced(function* normalizeSchemas(
  resolution: Resolution,
  limits: SchemaLimits = {},
): Effect.fn.Return<SchemaNormalization, SchemaBudgetExceeded | SchemaImportDefect> {
  const budget = budgetOf(limits);
  const sites = yield* within(budget, sitesOf(budget, resolution));
  const stored = yield* storeFrom(budget, resolution, sites);
  const refused = yield* within(budget, refusedInSource(budget, resolution, sites));
  const validation = yield* validationCopy(resolution.line, stored.definitions, {
    maxNodes: budget.limit - budget.spent,
  });
  const diagnostics = yield* diagnosticsOf(resolution, sites, validation.edits, refused);

  return { ...stored, diagnostics, line: resolution.line, validation };
});

// ---------------------------------------------------------------------------------------------
// The code-generation copy.

const annotationsDropped: ReadonlySet<string> = new Set(["default", "example", "examples"]);

const forCodeGeneration: Visit = (node) =>
  Object.fromEntries(
    Object.entries(node).flatMap(([keyword, value]): [string, Json][] => {
      if (annotationsDropped.has(keyword)) {
        return [];
      }

      if (keyword !== "properties" || !isObject(value)) {
        return [[keyword, value]];
      }

      const names = Arr.sort(Object.keys(value), byString);

      return [
        [keyword, Object.fromEntries(names.map((name) => [name, member(value, name) ?? {}]))],
      ];
    }),
  );

const referencedKeys = (budget: Budget, node: Json): readonly string[] => {
  const keys: string[] = [];
  forEachSchema(budget, node, copyPositions, (current) => {
    const ref = stringMember(current, "$ref");
    const key = ref === undefined ? undefined : referenceKey(ref);
    if (key !== undefined) {
      keys.push(key);
    }
  });

  return keys;
};

/**
 * The code-generation copy (design 3.5): the validation copy restricted to `roots` and every
 * definition they reference, with `examples`, `example` and `default` removed and the keys of every
 * `properties` object sorted. A root that is not a stored key is skipped.
 */
export const codeGenerationCopy = (
  validation: ReadonlyMap<string, Json>,
  roots: readonly string[],
  limits: SchemaLimits = {},
): Effect.Effect<ReadonlyMap<string, Json>, SchemaBudgetExceeded> => {
  const budget = budgetOf(limits);
  const reached = new Set<string>();
  const pending = roots.filter((root) => validation.has(root));
  let key = pending.pop();
  while (key !== undefined) {
    if (!reached.has(key)) {
      reached.add(key);

      const refs = referencedKeys(budget, validation.get(key) ?? {});
      pending.push(...refs.filter((ref) => validation.has(ref) && !reached.has(ref)));
    }

    key = pending.pop();
  }

  const copy = new Map(
    Arr.sort([...reached], byString).map((name): [string, Json] => [
      name,
      transformSchema(budget, validation.get(name) ?? {}, [], copyPositions, forCodeGeneration),
    ]),
  );

  return within(budget, copy);
};
