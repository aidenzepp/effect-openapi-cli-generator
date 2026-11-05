import { Array as Arr, Data, Option, Order, Predicate, Result, Schema } from "effect";
import type { MediaAlternative } from "../model/entities.ts";
import type { FoldNote } from "./fold.ts";
import { foldKebab } from "./fold.ts";
import { reservedCliNames } from "./reserved.ts";
import { formatPointer } from "../resolve/pointer.ts";

/**
 * What a flag carries: a typed scalar, a JSON text (`--<prop> <json>`), or the whole body.
 */
export type BodyFlagKind =
  | "body"
  | "body-file"
  | "boolean"
  | "integer"
  | "json"
  | "number"
  | "string";

/**
 * One flag descriptor: the dotted kebab name without `--`, the RFC 6901 pointer of the wire
 * path inside the body (`""` for the whole-body flags), the kind, and whether the flag repeats.
 * A boolean is three-state (`--x`, `--no-x`, absent); a repeated flag is a scalar array.
 */
export interface BodyFlag {
  readonly kind: BodyFlagKind;
  readonly name: string;
  readonly notes: readonly FoldNote[];
  readonly pointer: string;
  readonly repeated: boolean;
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
 * A property that has no field flag because its name folds to nothing; `--body` still reaches it.
 */
export interface SkippedProperty {
  readonly pointer: string;
  readonly reason: "EmptyFold";
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

const SchemaNode = Schema.Struct({
  $ref: Schema.optionalKey(Schema.String),
  additionalProperties: Schema.optionalKey(Schema.Json),
  allOf: Schema.optionalKey(Schema.Array(Schema.Json)),
  anyOf: Schema.optionalKey(Schema.Json),
  items: Schema.optionalKey(Schema.Json),
  oneOf: Schema.optionalKey(Schema.Json),
  properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});

const decodeNode = Schema.decodeUnknownOption(SchemaNode);

type Scalar = "boolean" | "integer" | "number" | "string";

type Classified =
  | { readonly _tag: "Object"; readonly properties: Readonly<Record<string, Schema.Json>> }
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
  readonly memo: Map<string, Result.Result<Classified, FlattenError> | typeof inProgress>;
  visits: number;
}

const newCtx = (defs: Defs): Ctx => ({ defs, memo: new Map(), visits: 0 });

const jsonEqual = Schema.toEquivalence(Schema.Json);

const scalarKinds: ReadonlySet<string> = new Set(["boolean", "integer", "number", "string"]);

const isScalar = (value: string): value is Scalar => scalarKinds.has(value);

const mergeObjects = (members: readonly Classified[]): Classified => {
  const merged = new Map<string, Schema.Json>();
  for (const member of members) {
    if (member._tag !== "Object") {
      return opaque;
    }

    for (const [key, value] of Object.entries(member.properties)) {
      const existing = merged.get(key);
      if (existing !== undefined && !jsonEqual(existing, value)) {
        return opaque;
      }

      merged.set(key, value);
    }
  }

  return { _tag: "Object", properties: Object.fromEntries(merged) };
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

const classify = (
  ctx: Ctx,
  json: Schema.Json,
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

    const resolved = classify(ctx, target, hops + 1);
    ctx.memo.set(name, resolved);

    return resolved;
  }

  if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
    return Result.succeed(opaque);
  }

  if (schema.allOf !== undefined) {
    const own: readonly Classified[] =
      schema.properties === undefined ? [] : [{ _tag: "Object", properties: schema.properties }];

    return Result.all(schema.allOf.map((member) => classify(ctx, member, hops + 1))).pipe(
      Result.map((members) => mergeObjects([...own, ...members])),
    );
  }

  const type = schema.type ?? (schema.properties === undefined ? undefined : "object");
  if (type === "object") {
    const closedOrFree =
      schema.additionalProperties === undefined || Predicate.isBoolean(schema.additionalProperties);

    return Result.succeed(
      closedOrFree ? { _tag: "Object", properties: schema.properties ?? {} } : opaque,
    );
  }

  if (type === "array" && schema.items !== undefined) {
    return Result.map(classify(ctx, schema.items, hops + 1), (item) =>
      item._tag === "Scalar" && !item.repeated ? { ...item, repeated: true } : opaque,
    );
  }

  return Result.succeed(
    Predicate.isString(type) && isScalar(type)
      ? { _tag: "Scalar", kind: type, repeated: false }
      : opaque,
  );
};

interface Walk {
  readonly flags: readonly BodyFlag[];
  readonly skipped: readonly SkippedProperty[];
}

const walkProperties = (
  ctx: Ctx,
  properties: Readonly<Record<string, Schema.Json>>,
  at: {
    readonly depth: number;
    readonly names: readonly string[];
    readonly tokens: readonly string[];
  },
): Result.Result<Walk, FlattenError> => {
  const flags: BodyFlag[] = [];
  const skipped: SkippedProperty[] = [];
  for (const [key, child] of Object.entries(properties)) {
    const tokens = [...at.tokens, key];
    const pointer = formatPointer(tokens);
    const folded = foldKebab(key);
    if (Result.isFailure(folded)) {
      skipped.push({ pointer, reason: "EmptyFold" });
      continue;
    }

    const names = [...at.names, folded.success.name];
    const classified = classify(ctx, child, 0);
    if (Result.isFailure(classified)) {
      return Result.fail(classified.failure);
    }

    const nested = classified.success;
    if (
      nested._tag === "Object" &&
      at.depth < maxDepth &&
      Object.keys(nested.properties).length > 0
    ) {
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
    });
  }

  return Result.succeed({ flags, skipped });
};

const wholeBody = (kind: "body" | "body-file"): BodyFlag => ({
  kind,
  name: kind,
  notes: [],
  pointer: "",
  repeated: false,
});

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
 * Flatten one request media alternative into flag descriptors (design 4.5). Top-level
 * properties and one nested object level become typed flags; scalar arrays repeat; everything
 * else the design names (objects below depth 2, arrays of objects, maps, `oneOf`/`anyOf`,
 * multi-type lists, conflicting `allOf`) is one JSON-valued flag. `defs` is the schema store's
 * `$defs` map and `alternative.schema` is the root's key in it. JSON and form bodies get field
 * flags plus `--body` and `--body-file`; a binary body only `--body-file`; any other codec
 * both whole-body flags and no field flags. Work is bounded: each `$defs` key is classified once
 * per call and node visits share one budget (`BodyBudgetExceeded`).
 */
export const flattenBody = (
  defs: Defs,
  alternative: Pick<MediaAlternative, "codec" | "schema">,
): Result.Result<FlattenedBody, FlattenError> => {
  const { codec } = alternative;
  if (codec === "binary") {
    return Result.succeed({ flags: [wholeBody("body-file")], reserved: [], skipped: [] });
  }

  const whole = [wholeBody("body"), wholeBody("body-file")];
  const key = alternative.schema?.key;
  if ((codec !== "json" && codec !== "form") || key === undefined) {
    return Result.succeed({ flags: whole, reserved: [], skipped: [] });
  }

  const ctx = newCtx(defs);
  const root = defs[key];
  if (root === undefined) {
    return Result.fail(new UnresolvedBodyRef({ ref: `${refPrefix}${key}` }));
  }

  const classified = classify(ctx, root, 0);
  if (Result.isFailure(classified)) {
    return Result.fail(classified.failure);
  }

  const walked =
    classified.success._tag === "Object"
      ? walkProperties(ctx, classified.success.properties, { depth: 1, names: [], tokens: [] })
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
