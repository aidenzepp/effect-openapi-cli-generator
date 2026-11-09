import { Array as Arr, Data, Option, Order, Predicate, Result } from "effect";
import type { Schema } from "effect";
import type { MediaAlternative } from "../model/entities.ts";
import type { FoldNote } from "./fold.ts";
import { foldKebab } from "./fold.ts";
import { reservedCliNames } from "./reserved.ts";
import { formatPointer } from "../model/pointer.ts";
import { sendsFormPairs } from "../normalize/bodies.ts";
import type { SpecLine } from "../model/spec-section.ts";

/**
 * What a flag carries: a typed scalar, a JSON text (`--<prop> <json>`), a file path or `-` (a
 * binary multipart part, or a base64 body property or multipart part the runtime encodes from the
 * file), the whole body, or the ordered parts of a positional body (`part`, repeated, each a file
 * path or `-`).
 */
export type BodyFlagKind =
  | "body"
  | "body-file"
  | "boolean"
  | "file"
  | "integer"
  | "json"
  | "number"
  | "part"
  | "string";

/**
 * One flag descriptor: the dotted kebab name without `--`, the RFC 6901 pointer of the wire
 * path inside the body (`""` for the whole-body flags), the kind, and whether the flag repeats.
 * A boolean is three-state (`--x`, `--no-x`, absent); a repeated flag is a scalar array.
 * `schemaPointer` is the source-document pointer of the property schema that declares the field
 * (`--describe` reports it; `""` for the whole-body flags): `/components/schemas/<name>/...` for a
 * component, the inline schema's own pointer otherwise, and for a schema in another document its
 * pointer there.
 */
export interface BodyFlag {
  readonly kind: BodyFlagKind;
  readonly name: string;
  readonly notes: readonly FoldNote[];
  readonly pointer: string;
  readonly repeated: boolean;
  readonly schemaPointer: string;
}

/**
 * A field flag whose name, or whose boolean `no-` negation, is a reserved CLI name. Reported,
 * not resolved; collisions are planned by `plan.ts`.
 */
export interface ReservedClash {
  readonly flag: string;
  readonly name: string;
  readonly pointer: string;
}

/**
 * A property that has no field flag: its name folds to nothing (`EmptyFold`), or it is a multipart
 * part whose shape no part flag carries (`UnsupportedPart`: an array of objects, a map or a
 * `oneOf`/`anyOf`). Multipart bodies have no whole-body flags, so nothing else reaches it.
 */
export interface SkippedProperty {
  readonly pointer: string;
  readonly reason: "EmptyFold" | "UnsupportedPart";
}

export interface FlattenedBody {
  readonly flags: readonly BodyFlag[];
  readonly reserved: readonly ReservedClash[];
  readonly skipped: readonly SkippedProperty[];
}

export class UnresolvedBodyRef extends Data.TaggedError("UnresolvedBodyRef")<{
  readonly ref: string;
}> {}

/**
 * The shared node-visit budget for one `flattenBody` call ran out: the schema graph is larger
 * or more entangled than generation will follow.
 */
export class BodyBudgetExceeded extends Data.TaggedError("BodyBudgetExceeded")<{
  readonly budget: number;
}> {}

type FlattenError = BodyBudgetExceeded | UnresolvedBodyRef;

const maxDepth = 2;

const maxVisits = 10_000;

const maxRefHops = 64;

const refPrefix = "#/$defs/";

interface JsonObject {
  readonly [key: string]: Schema.Json;
}

const isObject = (json: Schema.Json | undefined): json is JsonObject =>
  Predicate.isObject(json) && !Arr.isArray(json);

const isJsonArray = (json: Schema.Json): json is readonly Schema.Json[] => Arr.isArray(json);

interface SchemaNode {
  readonly $ref?: string;
  readonly additionalProperties?: Schema.Json;
  readonly allOf?: readonly Schema.Json[];
  readonly anyOf?: Schema.Json;
  readonly contentEncoding?: Schema.Json;
  readonly contentMediaType?: Schema.Json;
  readonly format?: Schema.Json;
  readonly items?: Schema.Json;
  readonly oneOf?: Schema.Json;
  readonly properties?: JsonObject;
  readonly required?: Schema.Json;
  readonly type?: string | readonly string[];
}

const isTypeKeyword = (value: Schema.Json | undefined): value is string | readonly string[] =>
  Predicate.isString(value) || (Arr.isArray(value) && value.every(Predicate.isString));

/**
 * Read only the keyword shapes this module uses, one level deep: children are never walked, so
 * one visit costs the keyword count, not the subtree size. A keyword of the wrong shape makes
 * the node opaque.
 */
const decodeNode = (json: Schema.Json): Option.Option<SchemaNode> => {
  if (!isObject(json)) {
    return Option.none();
  }

  const { $ref, allOf, properties, type } = json;
  const wellFormed =
    ($ref === undefined || Predicate.isString($ref)) &&
    (allOf === undefined || Arr.isArray(allOf)) &&
    (properties === undefined || isObject(properties)) &&
    (type === undefined || isTypeKeyword(type));

  return wellFormed ? Option.some(json) : Option.none();
};

type Scalar = "boolean" | "file" | "integer" | "number" | "string";

/**
 * Where a schema node sits: its `$defs` key and the tokens below that definition.
 */
interface Site {
  readonly key: string;
  readonly tokens: readonly string[];
}

/**
 * A property schema and the site of the `properties` entry that declares it.
 */
interface Property {
  readonly schema: Schema.Json;
  readonly site: Site;
}

type Classified =
  | {
      readonly _tag: "Object";
      readonly properties: ReadonlyMap<string, Property>;
      /**
       * The names its `required` arrays list, its own and those of its `allOf` members.
       */
      readonly required: ReadonlySet<string>;
    }
  | { readonly _tag: "Opaque" }
  | { readonly _tag: "Scalar"; readonly kind: Scalar; readonly repeated: boolean };

const opaque: Classified = { _tag: "Opaque" };

type Defs = Readonly<Record<string, Schema.Json>>;

const inProgress = Symbol("inProgress");

/**
 * Per-call state: each `$defs` key is classified once (an in-progress marker makes a cycle an
 * `UnresolvedBodyRef`), and every node visit spends from one shared budget.
 */
interface Ctx {
  readonly defs: Defs;
  /**
   * JSON and form bodies: a base64 string property is a `file` flag, not a `string`.
   */
  readonly base64Fields: boolean;
  /**
   * 3.0 only: `format: byte` marks a base64 string (D-ENC). On 3.1 and 3.2 it is an annotation and
   * only `contentEncoding` does (FMT-10).
   */
  readonly byteIsBase64: boolean;
  /**
   * Multipart only: the parts whose Encoding rule sends them base64 encoded. Each is a `file`
   * part: the runtime encodes the file's bytes, so typed text is never encoded in their place.
   */
  readonly base64Parts: ReadonlySet<string>;
  /**
   * Multipart only: the parts whose Encoding style joins values into one part (ENC-40). Normalize
   * refuses each at element scope, so it gets no flag and no notice here.
   */
  readonly styleRefused: ReadonlySet<string>;
  /**
   * Multipart only: the parts whose Encoding rule nests by name (design 6.3, HT:B16, ENC-07). An
   * object part among them gets one dotted part flag per nested property instead of a JSON flag.
   */
  readonly nestedParts: ReadonlySet<string>;
  /**
   * Multipart only: the parts whose Encoding rule nests by position (HT:B16, ENC-08, ENC-09). Each
   * is one repeated file flag, its files in order, whatever its schema (the raw posture of HT:B15).
   */
  readonly positionalParts: ReadonlySet<string>;
  /**
   * The top-level properties normalize refused at `field` scope (`refusedFields`, design 8.5). Each
   * gets no flag and no notice, as a style-refused part gets none.
   */
  readonly refusedFields: ReadonlySet<string>;
  /**
   * Multipart only: a binary or `format: password` string is a `file` part, not a `string`.
   */
  readonly fileParts: boolean;
  /**
   * 3.0 only: a read-only property is not offered as a flag (S30-31, D-SCH2). 3.1 and 3.2 keep
   * it (SCH-51).
   */
  readonly readOnlyOmitted: boolean;
  readonly memo: Map<string, Result.Result<Classified, FlattenError> | typeof inProgress>;
  visits: number;
}

// The property parts of a multipart alternative whose rule declares a transfer encoding.
const base64PartsOf = (encoding: MediaAlternative["encoding"]): ReadonlySet<string> =>
  new Set(
    encoding.flatMap((rule) =>
      rule.contentEncoding !== undefined && rule.target.kind === "property"
        ? [rule.target.name]
        : [],
    ),
  );

// The property parts of a multipart alternative whose rule nests by name (ENC-07).
const nestedPartsOf = (encoding: MediaAlternative["encoding"]): ReadonlySet<string> =>
  new Set(
    encoding.flatMap((rule) =>
      rule.target.kind === "property" &&
      (rule.nested ?? []).some((nested) => nested.target.kind === "property")
        ? [rule.target.name]
        : [],
    ),
  );

// The property parts of a multipart alternative whose rule nests by position (ENC-08, ENC-09).
const positionalPartsOf = (encoding: MediaAlternative["encoding"]): ReadonlySet<string> =>
  new Set(
    encoding.flatMap((rule) =>
      rule.target.kind === "property" &&
      (rule.nestedItem !== undefined ||
        (rule.nested ?? []).some((nested) => nested.target.kind === "position"))
        ? [rule.target.name]
        : [],
    ),
  );

// The property parts of a multipart alternative whose style the writer cannot send (ENC-40).
const styleRefusedOf = (encoding: MediaAlternative["encoding"]): ReadonlySet<string> =>
  new Set(
    encoding.flatMap((rule) =>
      rule.serialization !== undefined &&
      !sendsFormPairs(rule.serialization) &&
      rule.target.kind === "property"
        ? [rule.target.name]
        : [],
    ),
  );

const newCtx = (
  defs: Defs,
  codec: "form" | "json" | "multipart",
  encoding: MediaAlternative["encoding"],
  refusedFields: readonly string[],
  line: SpecLine,
): Ctx => ({
  base64Fields: codec === "json" || codec === "form",
  base64Parts: codec === "multipart" ? base64PartsOf(encoding) : new Set(),
  byteIsBase64: line === "3.0",
  defs,
  fileParts: codec === "multipart",
  memo: new Map(),
  nestedParts: codec === "multipart" ? nestedPartsOf(encoding) : new Set(),
  positionalParts: codec === "multipart" ? positionalPartsOf(encoding) : new Set(),
  readOnlyOmitted: line === "3.0",
  refusedFields: new Set(refusedFields),
  styleRefused: codec === "multipart" ? styleRefusedOf(encoding) : new Set(),
  visits: 0,
});

const below = (site: Site, ...tokens: readonly string[]): Site => ({
  key: site.key,
  tokens: [...site.tokens, ...tokens],
});

// The names a schema's own `required` array lists; a keyword of another shape lists none.
const requiredOf = (schema: SchemaNode): ReadonlySet<string> =>
  new Set(Arr.isArray(schema.required) ? schema.required.filter(Predicate.isString) : []);

const propertiesAt = (
  properties: Readonly<Record<string, Schema.Json>>,
  site: Site,
): ReadonlyMap<string, Property> =>
  new Map(
    Object.entries(properties).map(([key, schema]) => [
      key,
      { schema, site: below(site, "properties", key) },
    ]),
  );

/**
 * The source-document pointer of a site, from the `$defs` key rule (design 2.2): a pointer key is
 * the entry document's pointer, a `<document>#<pointer>` key another document's, and any other
 * key a component under `/components/schemas`.
 */
const sourcePointer = ({ key, tokens }: Site): string => {
  const rest = formatPointer(tokens);
  if (key.startsWith("/")) {
    return `${key}${rest}`;
  }

  const hash = key.indexOf("#");

  return hash === -1
    ? `${formatPointer(["components", "schemas", key])}${rest}`
    : `${key.slice(hash + 1)}${rest}`;
};

const exceeded = (): Result.Result<never, BodyBudgetExceeded> =>
  Result.fail(new BodyBudgetExceeded({ budget: maxVisits }));

/**
 * Deep JSON equality that spends one visit per node pair and one per child it queues, from the
 * call's shared budget. Identical references are equal for free.
 */
const equalWithin = (
  ctx: Ctx,
  left: Schema.Json,
  right: Schema.Json,
): Result.Result<boolean, BodyBudgetExceeded> => {
  const pending: [Schema.Json, Schema.Json][] = [[left, right]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [one, two] = pair;
    if (one === two) {
      continue;
    }

    ctx.visits += 1;
    if (ctx.visits > maxVisits) {
      return exceeded();
    }

    if (isJsonArray(one) && isJsonArray(two) && one.length === two.length) {
      ctx.visits += one.length;
      if (ctx.visits > maxVisits) {
        return exceeded();
      }

      for (let index = 0; index < one.length; index += 1) {
        pending.push([one[index] ?? null, two[index] ?? null]);
      }

      continue;
    }

    if (!isObject(one) || !isObject(two)) {
      return Result.succeed(false);
    }

    const keys = Object.keys(one);
    if (keys.length !== Object.keys(two).length || !keys.every((key) => Object.hasOwn(two, key))) {
      return Result.succeed(false);
    }

    ctx.visits += keys.length;
    if (ctx.visits > maxVisits) {
      return exceeded();
    }

    for (const key of keys) {
      pending.push([one[key] ?? null, two[key] ?? null]);
    }
  }

  return Result.succeed(true);
};

const scalarKinds: ReadonlySet<string> = new Set(["boolean", "integer", "number", "string"]);

const isScalar = (value: string): value is Scalar => scalarKinds.has(value);

const isBareSchema = (schema: SchemaNode): boolean => Object.keys(schema).length === 0;

const identityEncodings: ReadonlySet<string> = new Set(["7bit", "8bit", "binary"]);

// A `contentEncoding` that sends the bytes as they are: `binary`, `7bit` or `8bit`, any case.
const isIdentityEncoding = (value: Schema.Json | undefined): boolean =>
  Predicate.isString(value) && identityEncodings.has(value.toLowerCase());

/**
 * A binary part (design 6.3 Binary): 3.0 `format: binary` on a string, a string whose
 * `contentEncoding` is an identity encoding (`binary`, `7bit`, `8bit`, any case), or 3.1+
 * `contentMediaType` without a `contentEncoding`, or a schema with no keyword at all.
 * `format: byte`, any other `contentEncoding` and any other type are text.
 */
const isBinary = (schema: SchemaNode, type: SchemaNode["type"]): boolean => {
  if (
    type === "string" &&
    (schema.format === "binary" || isIdentityEncoding(schema.contentEncoding))
  ) {
    return true;
  }

  if (schema.format !== undefined || schema.contentEncoding !== undefined) {
    return false;
  }

  if (type !== undefined && type !== "string") {
    return false;
  }

  return (
    Predicate.isString(schema.contentMediaType) || (type === undefined && isBareSchema(schema))
  );
};

/**
 * A base64 string property (design 6.3 Binary): `contentEncoding` `base64` or `base64url` on every
 * line, or `format: byte` without a `contentEncoding` where `byteIsBase64` (3.0). Other encodings,
 * 3.1 and 3.2 `format: byte` (FMT-10) and other types are text.
 */
const isBase64 = (ctx: Ctx, schema: SchemaNode, type: SchemaNode["type"]): boolean =>
  type === "string" &&
  (schema.contentEncoding === "base64" ||
    schema.contentEncoding === "base64url" ||
    (ctx.byteIsBase64 && schema.contentEncoding === undefined && schema.format === "byte"));

/**
 * The `allOf` merge: every member an object, and a key two members declare equal in both (its
 * first declaration kept). The equality checks spend from the call's budget.
 */
const mergeObjects = (
  ctx: Ctx,
  members: readonly Classified[],
): Result.Result<Classified, BodyBudgetExceeded> => {
  const merged = new Map<string, Property>();
  const required = new Set<string>();
  for (const member of members) {
    if (member._tag !== "Object") {
      return Result.succeed(opaque);
    }

    for (const name of member.required) {
      required.add(name);
    }

    for (const [key, property] of member.properties) {
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, property);
        continue;
      }

      const equal = equalWithin(ctx, existing.schema, property.schema);
      if (Result.isFailure(equal)) {
        return Result.fail(equal.failure);
      }

      if (!equal.success) {
        return Result.succeed(opaque);
      }
    }
  }

  return Result.succeed({ _tag: "Object", properties: merged, required });
};

type RefLookup =
  | { readonly _tag: "Cached"; readonly result: Result.Result<Classified, FlattenError> }
  | { readonly _tag: "Fresh"; readonly name: string; readonly target: Schema.Json };

const lookupRef = (
  ctx: Ctx,
  ref: string,
  hops: number,
): Result.Result<RefLookup, UnresolvedBodyRef> => {
  const name = ref.startsWith(refPrefix)
    ? ref.slice(refPrefix.length).replaceAll("~1", "/").replaceAll("~0", "~")
    : undefined;
  const target = name === undefined ? undefined : ctx.defs[name];
  const seen = name === undefined ? undefined : ctx.memo.get(name);
  if (name === undefined || target === undefined || hops >= maxRefHops || seen === inProgress) {
    return Result.fail(new UnresolvedBodyRef({ ref }));
  }

  return Result.succeed(
    seen === undefined ? { _tag: "Fresh", name, target } : { _tag: "Cached", result: seen },
  );
};

// A `format: password` string (design 4.5): as a multipart part it is read from a file, so the
// secret never enters argv.
const isPassword = (schema: SchemaNode, type: SchemaNode["type"]): boolean =>
  type === "string" && schema.format === "password";

const leaf = (ctx: Ctx, schema: SchemaNode, type: SchemaNode["type"]): Classified => {
  if (ctx.fileParts && (isBinary(schema, type) || isPassword(schema, type))) {
    return { _tag: "Scalar", kind: "file", repeated: false };
  }

  if (ctx.base64Fields && isBase64(ctx, schema, type)) {
    return { _tag: "Scalar", kind: "file", repeated: false };
  }

  return Predicate.isString(type) && isScalar(type)
    ? { _tag: "Scalar", kind: type, repeated: false }
    : opaque;
};

const classify = (
  ctx: Ctx,
  json: Schema.Json,
  site: Site,
  hops: number,
): Result.Result<Classified, FlattenError> => {
  ctx.visits += 1;
  if (ctx.visits > maxVisits) {
    return Result.fail(new BodyBudgetExceeded({ budget: maxVisits }));
  }

  const node = decodeNode(json);
  if (Option.isNone(node)) {
    return Result.succeed(opaque);
  }

  const schema = node.value;
  if (schema.$ref !== undefined) {
    const found = lookupRef(ctx, schema.$ref, hops);
    if (Result.isFailure(found)) {
      return Result.fail(found.failure);
    }

    if (found.success._tag === "Cached") {
      return found.success.result;
    }

    const { name, target } = found.success;
    ctx.memo.set(name, inProgress);

    const resolved = classify(ctx, target, { key: name, tokens: [] }, hops + 1);
    ctx.memo.set(name, resolved);

    return resolved;
  }

  if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
    return Result.succeed(opaque);
  }

  if (schema.allOf !== undefined) {
    const own: readonly Classified[] =
      schema.properties === undefined
        ? []
        : [
            {
              _tag: "Object",
              properties: propertiesAt(schema.properties, site),
              required: requiredOf(schema),
            },
          ];

    return Result.all(
      schema.allOf.map((member, index) =>
        classify(ctx, member, below(site, "allOf", String(index)), hops + 1),
      ),
    ).pipe(Result.flatMap((members) => mergeObjects(ctx, [...own, ...members])));
  }

  const type = schema.type ?? (schema.properties === undefined ? undefined : "object");
  if (type === "object") {
    const closedOrFree =
      schema.additionalProperties === undefined || Predicate.isBoolean(schema.additionalProperties);

    return Result.succeed(
      closedOrFree
        ? {
            _tag: "Object",
            properties: propertiesAt(schema.properties ?? {}, site),
            required: requiredOf(schema),
          }
        : opaque,
    );
  }

  if (type === "array" && schema.items !== undefined) {
    return Result.map(classify(ctx, schema.items, below(site, "items"), hops + 1), (item) => {
      if (item._tag !== "Scalar" || item.repeated) {
        return opaque;
      }

      // An array of base64 strings repeats a text flag; only a lone property is a file.
      const kind = item.kind === "file" && !ctx.fileParts ? "string" : item.kind;

      return { ...item, kind, repeated: true };
    });
  }

  return Result.succeed(leaf(ctx, schema, type));
};

// Whether a property schema is `readOnly: true` itself or at the end of one `$ref` (S30-31).
const isReadOnly = (ctx: Ctx, schema: Schema.Json): boolean => {
  if (!isObject(schema)) {
    return false;
  }

  if (schema.readOnly === true) {
    return true;
  }

  const { $ref } = schema;
  if (!Predicate.isString($ref) || !$ref.startsWith(refPrefix)) {
    return false;
  }

  const target = ctx.defs[$ref.slice(refPrefix.length).replaceAll("~1", "/").replaceAll("~0", "~")];

  return isObject(target) && target.readOnly === true;
};

// A property the line does not offer as a flag: it gets no flag and no skip notice.
const omitted = (ctx: Ctx, schema: Schema.Json): boolean =>
  ctx.readOnlyOmitted && isReadOnly(ctx, schema);

interface Walk {
  readonly flags: readonly BodyFlag[];
  readonly skipped: readonly SkippedProperty[];
}

const walkProperties = (
  ctx: Ctx,
  properties: ReadonlyMap<string, Property>,
  at: {
    readonly depth: number;
    readonly names: readonly string[];
    readonly tokens: readonly string[];
  },
): Result.Result<Walk, FlattenError> => {
  const flags: BodyFlag[] = [];
  const skipped: SkippedProperty[] = [];
  for (const [key, { schema: child, site }] of properties) {
    ctx.visits += 1;
    if (ctx.visits > maxVisits) {
      return Result.fail(new BodyBudgetExceeded({ budget: maxVisits }));
    }

    if ((at.depth === 1 && ctx.refusedFields.has(key)) || omitted(ctx, child)) {
      continue;
    }

    const tokens = [...at.tokens, key];
    const pointer = formatPointer(tokens);
    const folded = foldKebab(key);
    if (Result.isFailure(folded)) {
      skipped.push({ pointer, reason: "EmptyFold" });
      continue;
    }

    const names = [...at.names, folded.success.name];
    const classified = classify(ctx, child, site, 0);
    if (Result.isFailure(classified)) {
      return Result.fail(classified.failure);
    }

    const nested = classified.success;
    if (nested._tag === "Object" && at.depth < maxDepth && nested.properties.size > 0) {
      const inner = walkProperties(ctx, nested.properties, { depth: at.depth + 1, names, tokens });
      if (Result.isFailure(inner)) {
        return Result.fail(inner.failure);
      }

      flags.push(
        ...inner.success.flags.map((flag) => ({
          ...flag,
          notes: [...folded.success.notes, ...flag.notes],
        })),
      );
      skipped.push(...inner.success.skipped);
      continue;
    }

    flags.push({
      kind: nested._tag === "Scalar" ? nested.kind : "json",
      name: names.join("."),
      notes: folded.success.notes,
      pointer,
      repeated: nested._tag === "Scalar" && nested.repeated,
      schemaPointer: sourcePointer(site),
    });
  }

  return Result.succeed({ flags, skipped });
};

type PartBase = Pick<BodyFlag, "name" | "notes" | "pointer">;

// One part's flag by the top-level part kinds: a scalar typed (a scalar array repeated), a binary
// or password string a file, an object one JSON flag; any other shape has none.
const partFlag = (
  part: Classified,
  base: PartBase,
): Omit<BodyFlag, "schemaPointer"> | undefined => {
  if (part._tag === "Opaque") {
    return undefined;
  }

  return part._tag === "Object"
    ? { ...base, kind: "json", repeated: false }
    : { ...base, kind: part.kind, repeated: part.repeated };
};

// A nested part's flag kind: as a top-level part's, except that a scalar array is one JSON part and
// an array of files has none.
const nestedKind = (part: Classified): BodyFlagKind | undefined => {
  if (part._tag === "Opaque" || (part._tag === "Scalar" && part.repeated && part.kind === "file")) {
    return undefined;
  }

  return part._tag === "Object" || part.repeated ? "json" : part.kind;
};

/**
 * The part flags of a by-name nested part (design 6.3, HT:B16, ENC-07): one per nested property,
 * named `<part>.<property>` with the dotted body-field naming, by the top-level part kinds. A
 * nested scalar array is one JSON part (3.2 sends a nested array as `application/json`, ENC-24),
 * so it is one JSON flag; an array of files has no flag. Nested parts carry no transfer encoding:
 * normalize refuses one (ENC-37/nested-transfer-encoding). None when a required nested
 * property gets no flag: no run could send the part whole, so the part itself is unrepresentable
 * (design 8.5 at generation, the Mind's ruling on M3-MP3).
 */
const nestedFlags = (
  ctx: Ctx,
  part: {
    readonly properties: ReadonlyMap<string, Property>;
    readonly required: ReadonlySet<string>;
  },
  key: string,
  folded: { readonly name: string; readonly notes: readonly FoldNote[] },
): Result.Result<Option.Option<Walk>, FlattenError> => {
  const flags: BodyFlag[] = [];
  const skipped: SkippedProperty[] = [];
  for (const [member, { schema: child, site }] of part.properties) {
    ctx.visits += 1;
    if (ctx.visits > maxVisits) {
      return Result.fail(new BodyBudgetExceeded({ budget: maxVisits }));
    }

    if (omitted(ctx, child)) {
      continue;
    }

    const pointer = formatPointer([key, member]);
    const memberFolded = foldKebab(member);
    if (Result.isFailure(memberFolded)) {
      if (part.required.has(member)) {
        return Result.succeed(Option.none());
      }

      skipped.push({ pointer, reason: "EmptyFold" });
      continue;
    }

    const classified = classify(ctx, child, site, 0);
    if (Result.isFailure(classified)) {
      return Result.fail(classified.failure);
    }

    const kind = nestedKind(classified.success);
    if (kind === undefined) {
      if (part.required.has(member)) {
        return Result.succeed(Option.none());
      }

      skipped.push({ pointer, reason: "UnsupportedPart" });
      continue;
    }

    flags.push({
      kind,
      name: `${folded.name}.${memberFolded.success.name}`,
      notes: [...folded.notes, ...memberFolded.success.notes],
      pointer,
      repeated: false,
      schemaPointer: sourcePointer(site),
    });
  }

  return Result.succeed(Option.some({ flags, skipped }));
};

/**
 * The part flags of a multipart body: each top-level property one flag, a scalar or scalar array
 * (repeated parts), a `file` part when it is binary, a `format: password` string (an array of
 * them a repeated file part) or its rule sends it base64 encoded, or a `json` flag for an object
 * part, sent as one JSON part (ENC-22); any other shape is skipped with a reason. A part whose
 * style normalize refused (ENC-40) or that it refused at `field` scope gets nothing. An object part
 * whose rule nests by name gets one dotted flag per nested property (`nestedFlags`), or none when a
 * required nested property has none; a part whose rule nests by position gets one repeated file
 * flag.
 */
const walkParts = (
  ctx: Ctx,
  properties: ReadonlyMap<string, Property>,
): Result.Result<Walk, FlattenError> => {
  const flags: BodyFlag[] = [];
  const skipped: SkippedProperty[] = [];
  for (const [key, { schema: child, site }] of properties) {
    ctx.visits += 1;
    if (ctx.visits > maxVisits) {
      return Result.fail(new BodyBudgetExceeded({ budget: maxVisits }));
    }

    if (ctx.styleRefused.has(key) || ctx.refusedFields.has(key) || omitted(ctx, child)) {
      continue;
    }

    const pointer = formatPointer([key]);
    const folded = foldKebab(key);
    if (Result.isFailure(folded)) {
      skipped.push({ pointer, reason: "EmptyFold" });
      continue;
    }

    // A part nested by position is raw files in order, one repeated file flag (HT:B16), so every
    // position has a flag and the schema is not classified.
    if (ctx.positionalParts.has(key)) {
      flags.push({
        kind: "file",
        name: folded.success.name,
        notes: folded.success.notes,
        pointer,
        repeated: true,
        schemaPointer: sourcePointer(site),
      });
      continue;
    }

    const classified = classify(ctx, child, site, 0);
    if (Result.isFailure(classified)) {
      return Result.fail(classified.failure);
    }

    const part = classified.success;
    if (part._tag === "Object" && ctx.nestedParts.has(key)) {
      const inner = nestedFlags(ctx, part, key, folded.success);
      if (Result.isFailure(inner)) {
        return Result.fail(inner.failure);
      }

      // A part with a required nested property no flag carries gets no flag at all.
      if (Option.isNone(inner.success)) {
        skipped.push({ pointer, reason: "UnsupportedPart" });
        continue;
      }

      flags.push(...inner.success.value.flags);
      skipped.push(...inner.success.value.skipped);
      continue;
    }

    const flag = partFlag(part, {
      name: folded.success.name,
      notes: folded.success.notes,
      pointer,
    });
    if (flag === undefined) {
      skipped.push({ pointer, reason: "UnsupportedPart" });
      continue;
    }

    flags.push({
      ...flag,
      kind: ctx.base64Parts.has(key) && part._tag === "Scalar" ? "file" : flag.kind,
      schemaPointer: sourcePointer(site),
    });
  }

  return Result.succeed({ flags, skipped });
};

const wholeBody = (kind: "body" | "body-file" | "part"): BodyFlag => ({
  kind,
  name: kind,
  notes: [],
  pointer: "",
  repeated: kind === "part",
  schemaPointer: "",
});

type Positional = Pick<MediaAlternative, "codec" | "mediaType"> &
  Partial<Pick<MediaAlternative, "itemEncoding" | "prefixEncoding">>;

/**
 * Whether an alternative is a 3.2 positional `multipart/mixed` body (design 6.3, HT:B15): normalize
 * gave it a rule per position, so its parts are sent in order from one repeated `--part` flag.
 */
export const isPositionalBody = (alternative: Positional): boolean =>
  alternative.codec === "multipart" &&
  (alternative.mediaType.split(";")[0] ?? "").trim().toLowerCase() === "multipart/mixed" &&
  (alternative.itemEncoding !== undefined || (alternative.prefixEncoding ?? []).length > 0);

const flagOrder = Order.combine(
  Order.mapInput(Order.String, (flag: BodyFlag) => flag.name),
  Order.mapInput(Order.String, (flag: BodyFlag) => flag.pointer),
);

const clashOrder = Order.combine(
  Order.mapInput(Order.String, (clash: ReservedClash) => clash.flag),
  Order.mapInput(Order.String, (clash: ReservedClash) => clash.pointer),
);

const clashesOf = (flag: BodyFlag): readonly ReservedClash[] => [
  ...(reservedCliNames.has(flag.name)
    ? [{ flag: flag.name, name: flag.name, pointer: flag.pointer }]
    : []),
  ...(flag.kind === "boolean" && !flag.repeated && reservedCliNames.has(`no-${flag.name}`)
    ? [{ flag: `no-${flag.name}`, name: flag.name, pointer: flag.pointer }]
    : []),
];

/**
 * Flatten one request media alternative into flag descriptors (design 4.5). Top-level properties
 * and one nested object level become typed flags; scalar arrays repeat; everything else the design
 * names (objects below depth 2, arrays of objects, maps, `oneOf`/`anyOf`, multi-type lists,
 * conflicting `allOf`) is one JSON-valued flag. `defs` is the schema store's `$defs` map and
 * `alternative.schema` is the root's key in it. JSON and form bodies get field flags plus `--body`
 * and `--body-file`; a binary or XML body only `--body-file`; a multipart body one flag per
 * top-level part and no whole-body flag (design 6.3, D-ENC1 a), except a positional
 * `multipart/mixed` body, whose one flag is the repeated `--part`; any other codec both whole-body
 * flags and no field flags. A multipart part reads its transfer encoding from
 * `alternative.encoding` (absent: no rules), never from its schema. Work is bounded: each `$defs`
 * key is classified once per call, and node visits, including every property entry, share one
 * budget (`BodyBudgetExceeded`). On the 3.0 `line`, a property or part whose schema is
 * `readOnly: true`, directly or through one `$ref`, gets no flag and no skip notice (S30-31,
 * D-SCH2); `--body` and `--body-file` still send it as given. On 3.1 and 3.2 a read-only property
 * keeps its flag (SCH-51). `format: byte` makes a JSON or form property a base64 `file` flag on 3.0
 * only; on 3.1 and 3.2 it is a `string` flag sent as given (FMT-10). A top-level property named in
 * `alternative.refusedFields` gets no flag, no nested flag and no skip notice (design 4.5, 8.5).
 */
export const flattenBody = (
  defs: Defs,
  alternative: Pick<MediaAlternative, "codec" | "schema"> &
    Partial<
      Pick<
        MediaAlternative,
        "encoding" | "itemEncoding" | "mediaType" | "prefixEncoding" | "refusedFields"
      >
    >,
  line: SpecLine,
): Result.Result<FlattenedBody, FlattenError> => {
  const { codec, mediaType } = alternative;
  if (mediaType !== undefined && isPositionalBody({ ...alternative, mediaType })) {
    return Result.succeed({ flags: [wholeBody("part")], reserved: [], skipped: [] });
  }

  if (codec === "binary") {
    return Result.succeed({ flags: [wholeBody("body-file")], reserved: [], skipped: [] });
  }

  if (codec === "xml") {
    return Result.succeed({ flags: [wholeBody("body-file")], reserved: [], skipped: [] });
  }

  const multipart = codec === "multipart";
  const whole = multipart ? [] : [wholeBody("body"), wholeBody("body-file")];
  const key = alternative.schema?.key;
  if ((codec !== "json" && codec !== "form" && !multipart) || key === undefined) {
    return Result.succeed({ flags: whole, reserved: [], skipped: [] });
  }

  const ctx = newCtx(
    defs,
    codec,
    alternative.encoding ?? [],
    alternative.refusedFields ?? [],
    line,
  );
  const root = defs[key];
  if (root === undefined) {
    return Result.fail(new UnresolvedBodyRef({ ref: `${refPrefix}${key}` }));
  }

  const classified = classify(ctx, root, { key, tokens: [] }, 0);
  if (Result.isFailure(classified)) {
    return Result.fail(classified.failure);
  }

  const { success: rootClass } = classified;
  const walkRoot = (properties: ReadonlyMap<string, Property>) =>
    multipart
      ? walkParts(ctx, properties)
      : walkProperties(ctx, properties, { depth: 1, names: [], tokens: [] });
  const walked =
    rootClass._tag === "Object"
      ? walkRoot(rootClass.properties)
      : Result.succeed<Walk>({ flags: [], skipped: [] });

  return walked.pipe(
    Result.map(({ flags, skipped }) => ({
      flags: Arr.sort([...whole, ...flags], flagOrder),
      reserved: Arr.sort(flags.flatMap(clashesOf), clashOrder),
      skipped: Arr.sort(
        skipped,
        Order.mapInput(Order.String, (item: SkippedProperty) => item.pointer),
      ),
    })),
  );
};
