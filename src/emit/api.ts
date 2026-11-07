import { Array as Arr, Data, Effect, Option, Order, Predicate, Result, Schema } from "effect";
import type { Types } from "effect";
import type {
  Api,
  EncodingRule,
  MediaAlternative,
  Operation,
  Parameter,
  ResponseCase,
  SecurityScheme,
  Server,
} from "../model/entities.ts";
import { formatPointer } from "../model/pointer.ts";
import { foldIdentifier } from "../names/fold.ts";
import type { NamePlan, PlannedCommand, PlannedFlag, PlannedGroup } from "../names/index.ts";
import { isBooleanSchema, suffixed } from "../names/plan.ts";
import type { FlagSource, PartOptionKind } from "../names/plan.ts";
import { sendsFormPairs } from "../normalize/bodies.ts";
import { isJsonMedia } from "../runtime-src/runtime/serialize.ts";
import { JsDocText } from "./escape.ts";
import type { EmittedFile } from "./package.ts";
import {
  Identifier,
  MemberName,
  ModuleSpecifier,
  arr,
  arrow,
  bool,
  call,
  ident,
  member,
  num,
  obj,
  printModule,
  str,
  typeKeyword,
  typeLiteral,
  typeReadonlyArray,
  typeRef,
  typeUnion,
} from "./printer.ts";
import type { Expr, Field, Import, Param, PrinterError, Statement, TypeExpr } from "./printer.ts";

/**
 * What the `api/` layer is emitted from: the normalized `Api`, its name plan, and the bound origin
 * set of a servers level (design 6.4: that level's accepted servers' expansions plus the author's
 * `acceptedOrigins`). Each servers table binds the set of its own servers only.
 */
export interface ApiEmitInput {
  readonly api: Api;
  readonly boundOrigins: (servers: readonly Server[]) => readonly string[];
  readonly plan: NamePlan;
}

/**
 * The plan or model holds something the `api/` layer cannot express. Earlier stages refuse every
 * input that reaches this. A group whose file segment is a fixed module is refused by the names
 * plan first (`TAG-02/reserved-segment`); `reserved-segment` here is a defense-in-depth check.
 */
export class ApiEmitError extends Data.TaggedError("ApiEmitError")<{
  readonly reason:
    | "reserved-segment"
    | "unknown-scheme"
    | "unprintable-name"
    | "unresolved-schema"
    | "unsupported-encoding"
    | "unsupported-parameter"
    | "unsupported-scheme";
  readonly subject: string;
}> {}

/**
 * One parameter's key in its operation's `Input` type.
 */
export interface InputKey {
  readonly key: string;
  readonly parameter: Parameter;
}

type Defs = Readonly<Record<string, Schema.Json>>;

const fixedInputKeys: readonly string[] = ["body", "contentType"];

// Segments of the modules every package has: `api/servers.ts`, `api/security.ts`, the root
// commands' `api/root.ts` and `cli/root.ts`.
const reservedSegments: ReadonlySet<string> = new Set(["root", "security", "servers"]);

/**
 * The `Input` keys of an operation's parameters, in parameter order: the wire name folded to camel
 * case, renamed by numeric suffix on a repeat. `body` and `contentType` are reserved. Keys never
 * depend on flag spelling, so an author-config rename leaves the `api/` layer unchanged.
 */
export const inputKeys = (operation: Operation): readonly InputKey[] => {
  const taken = new Set(fixedInputKeys);

  return operation.parameters.map((parameter) => {
    const folded = foldIdentifier(parameter.wireName, "camel");
    const base = Result.isSuccess(folded) ? folded.success.name : "parameter";
    const key = taken.has(base) ? suffixed(base, (candidate) => taken.has(candidate)) : base;
    taken.add(key);

    return { key, parameter };
  });
};

type JsonNode = Readonly<Record<string, Schema.Json>>;

const refPrefix = "#/$defs/";

const maxRefHops = 64;

const scalarTypes: ReadonlySet<string> = new Set(["boolean", "integer", "number", "string"]);

const own = (record: JsonNode, key: string): Schema.Json | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const isNode = (json: Schema.Json | undefined): json is JsonNode =>
  Predicate.isObject(json) && !Array.isArray(json);

const unescape = (token: string): string => token.replaceAll("~1", "/").replaceAll("~0", "~");

// The node a schema reaches after its `$ref` chain through the store, or the key that does not
// resolve. A chain stops at 64 hops, as `isBooleanSchema` does (design 3.3).
const settle = (
  defs: Defs,
  start: Schema.Json | undefined,
  subject: string,
): Result.Result<JsonNode, string> => {
  let current = start;
  let key = subject;
  for (let hop = 0; hop <= maxRefHops; hop += 1) {
    if (!isNode(current)) {
      return Result.fail(key);
    }

    const ref = own(current, "$ref");
    if (ref === undefined) {
      return Result.succeed(current);
    }

    if (!Predicate.isString(ref) || !ref.startsWith(refPrefix)) {
      return Result.fail(key);
    }

    key = unescape(ref.slice(refPrefix.length));
    current = own(defs, key);
  }

  return Result.fail(key);
};

// A settled node's own `type` when it is one of the scalar types.
const scalarOf = (node: JsonNode): string | undefined => {
  const type = own(node, "type");

  return Predicate.isString(type) && scalarTypes.has(type) ? type : undefined;
};

// Whether a parameter value is given once per item, and its scalar `type`, if it has one.
interface ScalarValue {
  readonly array: boolean;
  readonly type: string | undefined;
}

// How a stored parameter schema's value is given, through its `$ref` chain: whether it is an array,
// and the scalar `type` of the schema, or of its `items` for an array. A type list, an untyped
// schema and an array without `items` have no scalar type. The failure is the store key that does
// not resolve.
const scalarValueOf = (defs: Defs, key: string): Result.Result<ScalarValue, string> =>
  Result.flatMap(settle(defs, own(defs, key), key), (node): Result.Result<ScalarValue, string> => {
    if (own(node, "type") !== "array") {
      return Result.succeed({ array: false, type: scalarOf(node) });
    }

    const items = own(node, "items");

    return items === undefined
      ? Result.succeed({ array: true, type: undefined })
      : Result.map(settle(defs, items, key), (item) => ({ array: true, type: scalarOf(item) }));
  });

/**
 * Whether a stored parameter schema is `type: "array"` whose `items` is a scalar type (design 6.1):
 * the operator gives such a parameter once per item. An array without `items`, or of objects or
 * arrays, is not one. The failure is the store key that does not resolve.
 */
export const isScalarArraySchema = (defs: Defs, key: string): Result.Result<boolean, string> =>
  Result.map(scalarValueOf(defs, key), ({ array, type }) => array && type !== undefined);

/**
 * The scalar `type` of a stored parameter schema through its `$ref` chain, or of its `items` for an
 * array (`"boolean"`, `"integer"`, `"number"` or `"string"`). A 3.1 type list, an untyped schema
 * and an array of objects or arrays have none. The failure is the store key that does not resolve.
 */
export const scalarTypeOf = (defs: Defs, key: string): Result.Result<string | undefined, string> =>
  Result.map(scalarValueOf(defs, key), ({ type }) => type);

const refuse = (reason: ApiEmitError["reason"], subject: string) =>
  new ApiEmitError({ reason, subject });

const identifier = (name: string) =>
  Schema.decodeUnknownEffect(Identifier)(name).pipe(
    Effect.mapError(() => refuse("unprintable-name", name)),
  );

const memberName = (name: string) =>
  Schema.decodeUnknownEffect(MemberName)(name).pipe(
    Effect.mapError(() => refuse("unprintable-name", name)),
  );

const docText = (text: string) =>
  Schema.decodeUnknownEffect(JsDocText)(text).pipe(
    Effect.mapError(() => refuse("unprintable-name", text)),
  );

const I = Schema.decodeSync(Identifier);

const M = Schema.decodeSync(MemberName);

const S = Schema.decodeSync(ModuleSpecifier);

const serialize = ident(I("Serialize"));

const fn = (name: string, args: readonly Expr[]) => call(member(serialize, M(name)), args);

const strings = (values: readonly string[]) => arr(values.map(str));

const optionalOf = (type: TypeExpr) => typeUnion([type, typeKeyword("undefined")]);

const groupImports: readonly Import[] = [
  {
    _tag: "Named",
    from: S("../runtime/auth.ts"),
    names: [I("SecurityRequirement")],
    typeOnly: true,
  },
  {
    _tag: "Named",
    from: S("../runtime/negotiate.ts"),
    names: [I("MediaDeclaration")],
    typeOnly: true,
  },
  { _tag: "Namespace", from: S("../runtime/serialize.ts"), name: I("Serialize"), typeOnly: false },
];

const essence = (mediaType: string): string => (mediaType.split(";")[0] ?? "").trim().toLowerCase();

const isRange = (mediaType: string): boolean => essence(mediaType).endsWith("/*");

const mediaTypes = (alternatives: readonly MediaAlternative[]) =>
  alternatives.map((alternative) => alternative.mediaType);

const responseKey = (key: ResponseCase["key"]): string => {
  if (key === "default") {
    return key;
  }

  return "code" in key ? String(key.code) : `${key.range}XX`;
};

/**
 * The label written for a document URI that does not parse, so the raw text never reaches generated
 * source.
 */
export const documentPlaceholder = "<unparsed-document>";

// A document's label, with no credentials, query or fragment (C8). A document on the entry's
// origin is labelled by its path relative to the entry's directory, so no host path is emitted;
// any other parsed document keeps its origin and path; an unparseable one gets the placeholder.
const documentLabel = (entry: string, document: string): string => {
  const target = URL.parse(document);
  if (target === null) {
    return documentPlaceholder;
  }

  const base = URL.parse(entry);
  if (base === null || base.origin !== target.origin || base.protocol !== target.protocol) {
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

// The bracket convention option, `brackets: true`, for an entry the model marks (design 6.1);
// nothing for an unmarked one, so it emits what it emitted before (C16).
const brackets = (marker: EncodingRule["nonStandard"]): readonly (readonly [string, Expr])[] =>
  marker === "deepObjectBrackets" ? [["brackets", bool(true)]] : [];

interface ParameterParts {
  readonly cookie?: Expr;
  readonly field: Field;
  readonly header?: Expr;
  readonly path?: Expr;
  readonly query?: Expr;
}

const pathStyles: ReadonlySet<string> = new Set(["label", "matrix", "simple"]);

const queryStyles: ReadonlySet<string> = new Set([
  "deepObject",
  "form",
  "pipeDelimited",
  "spaceDelimited",
]);

interface ObjectSchemas {
  readonly properties: ReadonlyMap<string, Schema.Json>;
  readonly required: ReadonlySet<string>;
}

const maxPartNodes = 1024;

// The properties and `required` names of an object root (a multipart or form body, a form
// querystring): its own, then those of its `allOf` members, in document order, each node read once.
const objectSchemas = (defs: Defs, key: string): ObjectSchemas => {
  const properties = new Map<string, Schema.Json>();
  const required = new Set<string>();
  const seen = new Set<JsonNode>();
  const pending: (Schema.Json | undefined)[] = [own(defs, key)];
  while (pending.length > 0 && seen.size < maxPartNodes) {
    const node = settle(defs, pending.pop(), key);
    if (Result.isFailure(node) || seen.has(node.success)) {
      continue;
    }

    seen.add(node.success);

    const declared = own(node.success, "properties");
    for (const [name, schema] of isNode(declared) ? Object.entries(declared) : []) {
      if (!properties.has(name)) {
        properties.set(name, schema);
      }
    }

    const names = own(node.success, "required");
    for (const name of Array.isArray(names) ? names.filter(Predicate.isString) : []) {
      required.add(name);
    }

    const members: Schema.Json | undefined = own(node.success, "allOf");
    if (Array.isArray(members)) {
      pending.push(...Arr.reverse(members.filter(isNode)));
    }
  }

  return { properties, required };
};

const cookieStyles: ReadonlySet<string> = new Set(["cookie", "form"]);

const headerStyles: ReadonlySet<string> = new Set(["simple"]);

// The styles each location's builder writes; a `querystring` parameter is written by content.
const locationStyles: Readonly<
  Record<Exclude<Parameter["location"], "querystring">, ReadonlySet<string>>
> = { cookie: cookieStyles, header: headerStyles, path: pathStyles, query: queryStyles };

const formMedia = "application/x-www-form-urlencoded";

// The constructor that writes a `content` parameter in each location that takes one (PRM-15).
const contentConstructors: Readonly<Partial<Record<Parameter["location"], string>>> = {
  cookie: "cookieContent",
  header: "headerContent",
  query: "queryContent",
};

/**
 * Whether the `api/` layer builds a parameter: a `querystring` parameter in `content` form, a
 * query, header or cookie parameter in `content` form under any media but form-urlencoded, or any
 * other in a style its location takes. An operation with any other parameter (path content among
 * them) gets no builder, and `emitCli` refuses it alone (`unsupported-parameter`).
 */
export const buildsParameter = (parameter: Parameter): boolean => {
  const { location, serialization } = parameter;
  if (serialization.kind === "content") {
    return (
      location === "querystring" ||
      (contentConstructors[location] !== undefined &&
        essence(serialization.mediaType) !== formMedia)
    );
  }

  return location !== "querystring" && locationStyles[location].has(serialization.style);
};

/**
 * Whether a `content` parameter's value is JSON data: under JSON media, which the runtime writes as
 * compact JSON text, and under form media in `querystring`, whose object the runtime writes as
 * pairs. Under any other media the value is the operator's string, sent as given.
 */
export const takesJsonContent = (location: Parameter["location"], mediaType: string): boolean =>
  isJsonMedia(mediaType) || (location === "querystring" && essence(mediaType) === formMedia);

interface ParameterContext {
  readonly defs: Defs;
  readonly line: Api["line"];
  readonly memo: Map<string, boolean>;
}

// A `querystring` parameter (design 6.1): its value is JSON data the runtime serializes by its one
// media type. Form content declares the object's properties, in document order, with no Encoding
// fields (a Parameter's `content` carries none), so pair order and the declared names hold.
const querystringParts = (
  entry: InputKey,
  defs: Defs,
): Effect.Effect<ParameterParts, ApiEmitError> =>
  Effect.gen(function* parts() {
    const { key, parameter } = entry;
    const { serialization } = parameter;
    if (serialization.kind !== "content") {
      return yield* refuse("unsupported-parameter", `querystring:${parameter.wireName}`);
    }

    const json = typeRef(I("Serialize"), [M("Json")]);
    const field: Field = {
      key,
      optional: !parameter.required,
      type: parameter.required ? json : optionalOf(json),
    };
    const { mediaType } = serialization;
    const options: (readonly [string, Expr])[] = [["required", bool(parameter.required)]];
    if (essence(mediaType) === formMedia) {
      const { properties } = objectSchemas(defs, serialization.schema.key);
      options.push([
        "properties",
        arr([...properties.keys()].map((name) => arr([str(name), obj([])]))),
      ]);
    }

    const value = member(ident(I("input")), yield* memberName(key));

    return {
      field,
      query: fn("querystring", [str(parameter.wireName), str(mediaType), value, obj(options)]),
    };
  });

// A query, header or cookie `content` parameter (design 6.1): JSON data the runtime serializes by
// its one media type, through the location's content constructor.
const contentParts = (entry: InputKey): Effect.Effect<ParameterParts, ApiEmitError> =>
  Effect.gen(function* parts() {
    const { key, parameter } = entry;
    const { location, serialization } = parameter;
    const writer = contentConstructors[location];
    if (serialization.kind !== "content" || writer === undefined) {
      return yield* refuse("unsupported-parameter", `${location}:${parameter.wireName}`);
    }

    const json = typeRef(I("Serialize"), [M("Json")]);
    const field: Field = {
      key,
      optional: !parameter.required,
      type: parameter.required ? json : optionalOf(json),
    };
    const value = member(ident(I("input")), yield* memberName(key));
    const built = fn(writer, [
      str(parameter.wireName),
      str(serialization.mediaType),
      value,
      obj([["required", bool(parameter.required)]]),
    ]);
    if (location === "query") {
      return { field, query: built };
    }

    return location === "header" ? { field, header: built } : { cookie: built, field };
  });

const parameterParts = (
  entry: InputKey,
  context: ParameterContext,
): Effect.Effect<ParameterParts, ApiEmitError> =>
  Effect.gen(function* parts() {
    const { defs, memo } = context;
    const { key, parameter } = entry;
    const { serialization } = parameter;
    const subject = `${parameter.location}:${parameter.wireName}`;
    if (!buildsParameter(parameter)) {
      return yield* refuse("unsupported-parameter", subject);
    }

    if (parameter.location === "querystring") {
      return yield* querystringParts(entry, defs);
    }

    if (serialization.kind === "content") {
      return yield* contentParts(entry);
    }

    const boolean = isBooleanSchema(defs, memo, parameter.schema.key);
    if (Result.isFailure(boolean)) {
      return yield* refuse("unresolved-schema", boolean.failure.key);
    }

    const array = isScalarArraySchema(defs, parameter.schema.key);
    if (Result.isFailure(array)) {
      return yield* refuse("unresolved-schema", array.failure);
    }

    // An object's value is JSON data, as a `content` parameter's is; the runtime refuses a member
    // that is itself an object or array.
    let valueType = typeKeyword(boolean.success ? "boolean" : "string");
    if (serialization.objectValued) {
      valueType = typeRef(I("Serialize"), [M("Json")]);
    } else if (array.success) {
      valueType = typeReadonlyArray(typeKeyword("string"));
    }

    const field: Field = {
      key,
      optional: !parameter.required,
      type: parameter.required ? valueType : optionalOf(valueType),
    };
    const value = member(ident(I("input")), yield* memberName(key));
    const { allowReserved, explode, style } = serialization;
    const wire = str(parameter.wireName);
    const required = bool(parameter.required);
    if (parameter.location === "path") {
      const options = obj([
        ["allowReserved", bool(allowReserved)],
        ["explode", bool(explode)],
      ]);

      return { field, path: fn(style, [wire, value, options]) };
    }

    if (parameter.location === "query") {
      const options = obj([
        ["allowReserved", bool(allowReserved)],
        ...brackets(serialization.nonStandard),
        ["explode", bool(explode)],
        ["required", required],
      ]);

      return { field, query: fn(style, [wire, value, options]) };
    }

    if (parameter.location === "header") {
      const options = obj([
        ["explode", bool(explode)],
        ["required", required],
      ]);

      return { field, header: fn("header", [wire, value, options]) };
    }

    const options = obj([
      ["allowReserved", bool(allowReserved)],
      ["explode", bool(explode)],
      ["line", str(context.line)],
      ["required", required],
      ["style", str(style)],
    ]);

    return { cookie: fn("cookie", [wire, value, options]), field };
  });

/**
 * A part's `Content-Type`: the one media type its Encoding `contentType` lists, or the operator's
 * choice among several (design 6.3, ENC-10), with the listed types and the `--<part>-content-type`
 * flag.
 */
export type PartType =
  | { readonly _tag: "Declared"; readonly mediaType: string }
  | {
      readonly _tag: "Chosen";
      readonly choices: readonly string[];
      readonly flag: PlannedFlag;
    };

/**
 * One declared header of a part (ENC-03, HDR-01) and its `--<part>-<header>` flag.
 */
export interface PartHeader {
  readonly flag: PlannedFlag;
  readonly header: EncodingRule["headers"][number];
}

/**
 * One `multipart/form-data` part a command sends: its part flag, its part name, its `Content-Type`,
 * its declared headers and, from its Encoding rule, its transfer encoding. `key` is the part's key
 * in the builder's form when the part travels as a `Serialize.ChosenPart` beside `fields`: it
 * lists several types or declares a header.
 */
export interface FormPart {
  readonly contentEncoding?: "base64";
  readonly contentType: PartType;
  readonly flag: PlannedFlag;
  readonly headers: readonly PartHeader[];
  readonly key?: string;
  readonly name: string;
}

/**
 * The keys in the builder's form of the parts that travel as a `Serialize.ChosenPart` (ENC-10,
 * ENC-03), by part name: each multipart part whose Encoding `contentType` lists several types or
 * whose rule declares a header, folded to camel case and renamed by numeric suffix past `fields`
 * and each other. Keys never depend on flag spelling.
 */
export const keyedPartKeys = (operation: Operation): ReadonlyMap<string, string> => {
  const taken = new Set(["fields"]);
  const keys = new Map<string, string>();
  for (const alternative of operation.body?.alternatives ?? []) {
    for (const { contentType, headers, target } of alternative.encoding) {
      if (
        alternative.codec !== "multipart" ||
        target.kind !== "property" ||
        (contentType.length < 2 && headers.length === 0) ||
        keys.has(target.name)
      ) {
        continue;
      }

      const folded = foldIdentifier(target.name, "camel");
      const base = Result.isSuccess(folded) ? folded.success.name : "part";
      const key = taken.has(base) ? suffixed(base, (candidate) => taken.has(candidate)) : base;
      taken.add(key);
      keys.set(target.name, key);
    }
  }

  return keys;
};

type PartFlag = PlannedFlag & { readonly source: Extract<FlagSource, { readonly _tag: "Body" }> };

const isPartFlag = (flag: PlannedFlag, mediaType: string): flag is PartFlag =>
  flag.source._tag === "Body" &&
  flag.source.kind !== "body" &&
  flag.source.kind !== "body-file" &&
  flag.source.media.includes(mediaType);

interface OrderedPart extends FormPart {
  readonly order: number;
}

interface PartContext {
  readonly alternative: MediaAlternative;
  readonly flags: readonly PlannedFlag[];
  readonly keys: ReadonlyMap<string, string>;
  readonly schemas: ObjectSchemas;
}

// The part option flag of kind `kind` (and header `header`) of the part at `pointer` under the
// context's alternative.
const optionFlag = (
  context: PartContext,
  pointer: string,
  matches: (option: PartOptionKind) => boolean,
): PlannedFlag | undefined =>
  context.flags.find(
    ({ source }) =>
      source._tag === "PartOption" &&
      source.part === pointer &&
      matches(source.option) &&
      source.media.includes(context.alternative.mediaType),
  );

// The flag that chooses a part's `Content-Type` among `choices` under the context's alternative.
const choiceOf = (
  context: PartContext,
  pointer: string,
  choices: readonly string[],
): PartType | undefined => {
  const flag = optionFlag(context, pointer, (option) => option.kind === "content-type");

  return flag === undefined ? undefined : { _tag: "Chosen", choices, flag };
};

// Each declared header of a part with its `--<part>-<header>` flag, or the first header with none.
const headersOf = (
  context: PartContext,
  pointer: string,
  rule: EncodingRule,
): Result.Result<readonly PartHeader[], string> => {
  const headers: PartHeader[] = [];
  for (const header of rule.headers) {
    const flag = optionFlag(
      context,
      pointer,
      (option) => option.kind === "header" && option.name === header.name,
    );
    if (flag === undefined) {
      return Result.fail(`a flag for header ${header.name} of multipart part ${pointer}`);
    }

    headers.push({ flag, header });
  }

  return Result.succeed(headers);
};

// The reason a body's multipart alternative is not one the writer sends, or `undefined`.
const alternativeProblem = (alternative: MediaAlternative): string | undefined => {
  const { mediaType } = alternative;
  if (isRange(mediaType) || essence(mediaType) !== "multipart/form-data") {
    return `a ${mediaType} request body`;
  }

  const positional =
    alternative.itemSchema !== undefined ||
    alternative.itemEncoding !== undefined ||
    alternative.prefixEncoding.length > 0 ||
    alternative.encoding.some((rule) => rule.target.kind === "position");

  return positional ? `positional parts of ${mediaType}` : undefined;
};

// One part flag's part, with the index of its Encoding rule, or the reason it is refused.
const partOf = (flag: PartFlag, context: PartContext): Result.Result<OrderedPart, string> => {
  const { alternative } = context;
  const pointer = flag.source.wireName;
  const [name, ...rest] = pointer.split("/").slice(1).map(unescape);
  if (name === undefined || rest.length > 0) {
    return Result.fail(`the nested multipart part ${pointer}`);
  }

  const order = alternative.encoding.findIndex(
    (candidate) => candidate.target.kind === "property" && candidate.target.name === name,
  );
  const rule = alternative.encoding[order];
  if (rule === undefined) {
    return Result.fail(`an encoding for multipart part ${pointer}`);
  }

  // A style the writer sends (ENC-40) arrives typed `text/plain`; normalize refuses any other, and
  // the names plan gives that part no flag.
  if (rule.serialization !== undefined && !sendsFormPairs(rule.serialization)) {
    return Result.fail(`a style for multipart part ${pointer}`);
  }

  const [first] = rule.contentType;
  if (first === undefined || rule.contentType.some((type) => type.includes("*"))) {
    return Result.fail(`one content type for multipart part ${pointer}`);
  }

  const contentType: PartType | undefined =
    rule.contentType.length === 1
      ? { _tag: "Declared", mediaType: first }
      : choiceOf(context, pointer, rule.contentType);
  if (contentType === undefined) {
    return Result.fail(`a content type flag for multipart part ${pointer}`);
  }

  const headers = headersOf(context, pointer, rule);
  if (Result.isFailure(headers)) {
    return Result.fail(headers.failure);
  }

  const key = context.keys.get(name);
  const keyed = contentType._tag === "Chosen" || headers.success.length > 0;
  if (keyed && key === undefined) {
    return Result.fail(`a form key for multipart part ${pointer}`);
  }

  const part: Types.Mutable<OrderedPart> = {
    contentType,
    flag,
    headers: headers.success,
    name,
    order,
  };
  if (keyed && key !== undefined) {
    part.key = key;
  }

  if (rule.contentEncoding !== undefined) {
    part.contentEncoding = rule.contentEncoding;
  }

  return Result.succeed(part);
};

const byOrder = Order.mapInput(Order.Number, (part: OrderedPart) => part.order);

/**
 * The parts a `multipart/form-data` command sends, in Encoding order, or the reason the runtime
 * writer cannot send it exactly (design 6.3; a `CliRefusal` subject). `alternative` is one of the
 * command's request media alternatives; the part flags are those whose media lists it. Refused,
 * not guessed: a multipart alternative under a range key, another multipart subtype, 3.2
 * positional parts, a nested part, a part style other than exploded `form`, a part whose
 * `contentType` lists a range, a part listing several types with no `--<part>-content-type` flag,
 * a part header the names plan gave no `--<part>-<header>` flag, and a required part the names plan
 * gave no flag. Normalize keeps the headers the writer owns out of the rule (ENC-03).
 */
export const formParts = (
  command: PlannedCommand,
  alternative: MediaAlternative,
  defs: Defs,
): Result.Result<readonly FormPart[], string> => {
  const problem = alternativeProblem(alternative);
  if (problem !== undefined) {
    return Result.fail(problem);
  }

  // Checked over the rules, not the part flags: a part the names plan gave no flag (a
  // `prefixItems` array) still carries its nested rule. Positional rules were refused above.
  const nested = alternative.encoding.find((rule) => rule.nested !== undefined);
  if (nested !== undefined && nested.target.kind === "property") {
    return Result.fail(`nested parts in multipart part ${formatPointer([nested.target.name])}`);
  }

  const key = alternative.schema?.key ?? "";
  const context: PartContext = {
    alternative,
    flags: command.flags,
    keys: keyedPartKeys(command.operation),
    schemas: objectSchemas(defs, key),
  };
  const parts: OrderedPart[] = [];
  for (const flag of command.flags) {
    if (isPartFlag(flag, alternative.mediaType)) {
      const part = partOf(flag, context);
      if (Result.isFailure(part)) {
        return Result.fail(part.failure);
      }

      parts.push(part.success);
    }
  }

  const sent = new Set(parts.map((part) => part.name));
  const missing = [...context.schemas.required].find((name) => !sent.has(name));
  if (missing !== undefined) {
    return Result.fail(`a flag for multipart part ${formatPointer([missing])}`);
  }

  return Result.succeed(Arr.sort(parts, byOrder).map(({ order: _order, ...part }) => part));
};

interface BodyParts {
  readonly declarations: readonly Statement[];
  readonly entry?: readonly [string, Expr];
  readonly fields: readonly Field[];
}

// One form-urlencoded property's Encoding Object fields: those its rule sets, `style` only when a
// query style (design 6.3). An explicit Encoding `contentType` has no runtime input yet.
const formEncoding = (
  alternative: MediaAlternative,
  name: string,
): Effect.Effect<Expr, ApiEmitError> => {
  const rule = alternative.encoding.find(
    (candidate) => candidate.target.kind === "property" && candidate.target.name === name,
  );
  const serialization = rule?.serialization;
  const entries: (readonly [string, Expr])[] = [];
  if (serialization?.allowReserved !== undefined) {
    entries.push(["allowReserved", bool(serialization.allowReserved)]);
  }

  entries.push(...brackets(rule?.nonStandard));

  if (serialization?.explode !== undefined) {
    entries.push(["explode", bool(serialization.explode)]);
  }

  const style = serialization?.style;
  if (style !== undefined && !queryStyles.has(style)) {
    return Effect.fail(refuse("unsupported-encoding", `${alternative.mediaType}:${name}`));
  }

  if (style !== undefined) {
    entries.push(["style", str(style)]);
  }

  return Effect.succeed(obj(entries));
};

/**
 * Whether a body with several media alternatives is encoded per alternative: one of them is form
 * or multipart, so its bytes depend on the key the operator chose (design 6.6). The `api/` builder
 * then takes the whole `Serialize.Chosen`, and the `cli/` command passes `Input.selectBody`'s
 * choice to it unchanged.
 */
export const encodesByKey = (alternatives: readonly MediaAlternative[]): boolean =>
  alternatives.length > 1 &&
  alternatives.some(
    (alternative) => alternative.codec === "form" || alternative.codec === "multipart",
  );

// How one alternative's body value is typed and sent: `encode` takes the value and the
// `Content-Type` expressions; `typed` is whether it reads the second; `declarations` declare the
// value's type when the encoder names one.
interface Encoder {
  readonly declarations?: readonly Statement[];
  readonly encode: (value: Expr, contentType: Expr) => Expr;
  readonly type: TypeExpr;
  readonly typed: boolean;
}

const bytesEncoder: Encoder = {
  encode: (value, contentType) => fn("body", [contentType, value]),
  type: typeRef(I("Serialize"), [M("Body")]),
  typed: true,
};

// One alternative's encoder (design 4.5, 6.3). A form body is its JSON value, or `undefined` for
// no body input, encoded by `Serialize.urlEncoded` over the schema's properties in document order.
// A multipart body the writer can send is its part values, streamed by `Serialize.formData`. Any
// other body is an `HttpBody` that `Serialize.body` sends. A multipart body the writer cannot send
// has no encoder (`None`); `cli/` refuses its operation. A multipart body with a chosen part type is
// the `formName` interface.
const encoderOf = (
  command: PlannedCommand,
  alternative: MediaAlternative,
  defs: Defs,
  formName: string,
): Effect.Effect<Option.Option<Encoder>, ApiEmitError> =>
  Effect.gen(function* encoder() {
    const required = bool(command.operation.body?.required ?? false);
    if (alternative.codec === "form" && !isRange(alternative.mediaType)) {
      const names = [...objectSchemas(defs, alternative.schema?.key ?? "").properties.keys()];
      const properties = yield* Effect.all(
        names.map((name) =>
          formEncoding(alternative, name).pipe(
            Effect.map((encoding) => arr([str(name), encoding])),
          ),
        ),
      );
      const options = obj([
        ["properties", arr(properties)],
        ["required", required],
      ]);

      return Option.some<Encoder>({
        encode: (value, contentType) => fn("urlEncoded", [contentType, value, options]),
        type: optionalOf(typeRef(I("Serialize"), [M("Json")])),
        typed: true,
      });
    }

    if (alternative.codec !== "multipart") {
      return Option.some(bytesEncoder);
    }

    const parts = formParts(command, alternative, defs);
    if (Result.isFailure(parts)) {
      return Option.none();
    }

    // A keyed part travels with its type and header values in the form, so a part not sent has no
    // type or header to give (ENC-10, ENC-03). A chosen type's union is its own alias, named after
    // the form and the part's key, so the field line stays short however many types it lists.
    const aliases: Statement[] = [];
    const keyed: Field[] = [];
    const sends: ((form: Expr) => Expr)[] = [];
    for (const { contentEncoding, contentType, key, name } of parts.success) {
      const encoding = contentEncoding === undefined ? [] : [str(contentEncoding)];
      if (key === undefined && contentType._tag === "Declared") {
        sends.push(() => arr([str(name), str(contentType.mediaType), ...encoding]));
        continue;
      }

      const formKey = key ?? name;
      let typeArgument: TypeExpr;
      if (contentType._tag === "Declared") {
        typeArgument = typeLiteral(contentType.mediaType);
      } else {
        const alias = yield* identifier(
          `${formName}${formKey.slice(0, 1).toUpperCase()}${formKey.slice(1)}ContentType`,
        );
        aliases.push({
          _tag: "TypeAlias",
          doc: yield* docText("The content types the operator may choose for one multipart part."),
          name: alias,
          type: typeUnion(contentType.choices.map((choice) => typeLiteral(choice))),
        });
        typeArgument = typeRef(alias);
      }

      keyed.push({
        key: formKey,
        optional: true,
        type: optionalOf(typeRef(I("Serialize"), [M("ChosenPart")], [typeArgument])),
      });

      const slot = yield* memberName(formKey);
      sends.push((form) => arr([str(name), member(form, slot), ...encoding]));
    }

    const options = (form: Expr) =>
      obj([
        ["parts", arr(sends.map((send) => send(form)))],
        ["required", required],
      ]);
    const fields = typeRef(I("Serialize"), [M("FormFields")]);
    if (keyed.length === 0) {
      return Option.some<Encoder>({
        encode: (value) => fn("formData", [value, options(value)]),
        type: fields,
        typed: false,
      });
    }

    const name = yield* identifier(formName);
    const doc = yield* docText(
      "The multipart parts: fields holds each part with one listed content type and no declared header; each other part carries its content type and header values, or is absent when not sent.",
    );

    return Option.some<Encoder>({
      declarations: [
        ...aliases,
        {
          _tag: "Interface",
          doc,
          fields: [{ key: "fields", optional: false, type: fields }, ...keyed],
          name,
        },
      ],
      encode: (value) => fn("formData", [member(value, M("fields")), options(value)]),
      type: typeRef(name),
      typed: false,
    });
  });

// A body encoded per alternative (`encodesByKey`): the `<Op>Bodies` interface maps each key the
// builder sends to its value type, the input is the choice `Input.selectBody` made, and
// `Serialize.alternatives` calls the chosen key's encoder, with annotated parameters. A multipart
// alternative the writer cannot send is left out, so no builder sends multipart without its
// boundary; `cli/` refuses that operation.
const chosenParts = (
  command: PlannedCommand,
  defs: Defs,
  name: typeof Identifier.Type,
  formName: string,
) =>
  Effect.gen(function* chosen() {
    const declarations: Statement[] = [];
    const fields: Field[] = [];
    const table: (readonly [string, Expr])[] = [];
    for (const alternative of command.operation.body?.alternatives ?? []) {
      const forms = declarations.length;
      const numbered = forms === 0 ? formName : `${formName}${forms + 1}`;
      const found = yield* encoderOf(command, alternative, defs, numbered);
      if (Option.isNone(found)) {
        continue;
      }

      const encoder = found.value;
      const { mediaType } = alternative;
      const sent = isRange(mediaType) ? typeKeyword("string") : typeLiteral(mediaType);
      const params: Param[] = [{ name: I("body"), type: encoder.type }];
      if (encoder.typed) {
        params.push({ name: I("contentType"), type: sent });
      }

      declarations.push(...(encoder.declarations ?? []));
      fields.push({ key: mediaType, optional: false, type: encoder.type });
      table.push([
        mediaType,
        arrow(params, encoder.encode(ident(I("body")), ident(I("contentType")))),
      ]);
    }

    const value = member(ident(I("input")), M("body"));

    return {
      declarations: [...declarations, { _tag: "Interface", fields, name }],
      entry: ["body", fn("alternatives", [value, obj(table)])],
      fields: [
        {
          key: "body",
          optional: false,
          type: typeRef(I("Serialize"), [M("Chosen")], [typeRef(name)]),
        },
      ],
    } satisfies BodyParts;
  });

// The body is always present in `Input` when the operation declares one: an optional body with
// no input is `HttpBody.empty`, which `Serialize.request` sends without `Content-Type`. A lone
// alternative is sent by its own encoder under its media type. The content type is an input when
// the operator chooses it among bytes alternatives, or under a range key; a body with a form or
// multipart alternative among several is encoded per key (`chosenParts`). `formName` names a
// multipart body with a chosen part type.
const bodyParts = (
  command: PlannedCommand,
  defs: Defs,
  bodies: typeof Identifier.Type,
  formName: string,
): Effect.Effect<BodyParts, ApiEmitError> =>
  Effect.gen(function* parts() {
    const alternatives = command.operation.body?.alternatives ?? [];
    const [first] = alternatives;
    if (first === undefined) {
      return { declarations: [], fields: [] };
    }

    if (encodesByKey(alternatives)) {
      return yield* chosenParts(command, defs, bodies, formName);
    }

    const input = ident(I("input"));
    const value = member(input, M("body"));
    if (alternatives.length === 1 && !isRange(first.mediaType)) {
      const found = yield* encoderOf(command, first, defs, formName);
      const encoder = Option.getOrElse(found, () => bytesEncoder);

      return {
        declarations: encoder.declarations ?? [],
        entry: ["body", encoder.encode(value, str(first.mediaType))],
        fields: [{ key: "body", optional: false, type: encoder.type }],
      };
    }

    const types = mediaTypes(alternatives);
    const contentType: Field = {
      key: "contentType",
      optional: false,
      type: types.some(isRange)
        ? typeKeyword("string")
        : typeUnion(types.map((type) => typeLiteral(type))),
    };

    return {
      declarations: [],
      entry: ["body", bytesEncoder.encode(value, member(input, M("contentType")))],
      fields: [{ key: "body", optional: false, type: bytesEncoder.type }, contentType],
    };
  });

const serverEntry = (server: Server): Expr => {
  const entries: (readonly [string, Expr])[] = [["url", str(server.template)]];
  if (server.name !== undefined) {
    entries.push(["name", str(server.name)]);
  }

  if (server.variables.length > 0) {
    const variables = server.variables.map((variable) => {
      const fields: (readonly [string, Expr])[] = [["default", str(variable.default)]];
      if (variable.enum !== undefined) {
        fields.push(["enum", strings(variable.enum)]);
      }

      return [variable.name, obj(fields)] as const;
    });
    entries.push(["variables", obj(variables)]);
  }

  return obj(entries);
};

// The servers table: every server of the level, the first accepted one as the default, and the
// bound origin set of that level's servers (design 6.4).
const serversTable = (servers: readonly Server[], bound: ApiEmitInput["boundOrigins"]): Expr => {
  const entries: (readonly [string, Expr])[] = [
    ["boundOrigins", strings(bound(servers))],
    ["servers", arr(servers.map(serverEntry))],
  ];
  const accepted = servers.findIndex((server) => server.accepted);
  if (accepted !== -1) {
    entries.push(["defaultServer", num(accepted)]);
  }

  return obj(entries);
};

const requestIdNames: ReadonlySet<string> = new Set([
  "request-id",
  "x-request-id",
  "x-correlation-id",
]);

/**
 * The first declared response header, in response-key then document order, named `request-id`,
 * `x-request-id` or `x-correlation-id` in any case (design 7.1), with its declared spelling.
 */
const requestIdHeaderOf = (responses: Operation["responses"]): string | undefined =>
  responses
    .flatMap((response) => response.headers)
    .find((header) => requestIdNames.has(header.name.toLowerCase()))?.name;

/**
 * The required response headers of each case that declares any, keyed as the media table keys the
 * case, each list in document order (design 7.3; HDR-03).
 */
const requiredHeadersOf = (responses: Operation["responses"]): (readonly [string, Expr])[] =>
  responses.flatMap((response) => {
    const names = response.headers.filter((header) => header.required).map((header) => header.name);

    return names.length === 0 ? [] : [[responseKey(response.key), strings(names)] as const];
  });

const requirementOf = (operation: Operation, schemes: ReadonlySet<string>) =>
  Effect.gen(function* requirement() {
    const alternatives = operation.security.alternatives.map((alternative) =>
      alternative.uses.map((use) => use.scheme),
    );
    const unknown = alternatives.flat().find((scheme) => !schemes.has(scheme));
    if (unknown !== undefined) {
      return yield* refuse("unknown-scheme", unknown);
    }

    return arr(alternatives.map(strings));
  });

interface CommandContext extends ParameterContext {
  readonly bound: ApiEmitInput["boundOrigins"];
  readonly document: (uri: string) => string;
  readonly schemes: ReadonlySet<string>;
}

const commandStatements = (
  command: PlannedCommand,
  path: string,
  context: CommandContext,
): Effect.Effect<readonly Statement[], ApiEmitError> =>
  Effect.gen(function* statements() {
    const { operation } = command;
    const name = command.identifier;
    const capitalized = `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
    const inputName = yield* identifier(`${capitalized}Input`);
    const mediaName = yield* identifier(`${name}Media`);
    const securityName = yield* identifier(`${name}Security`);
    const parameters = yield* Effect.forEach(inputKeys(operation), (entry) =>
      parameterParts(entry, context),
    );
    const bodies = yield* identifier(`${capitalized}Bodies`);
    const body = yield* bodyParts(command, context.defs, bodies, `${capitalized}Form`);
    const cookies = parameters.flatMap((part) => (part.cookie === undefined ? [] : [part.cookie]));
    const parts: (readonly [string, Expr])[] = [
      [
        "headers",
        arr(parameters.flatMap((part) => (part.header === undefined ? [] : [part.header]))),
      ],
      [
        "path",
        fn("path", [
          str(operation.key.path),
          arr(parameters.flatMap((part) => (part.path === undefined ? [] : [part.path]))),
        ]),
      ],
      ["query", arr(parameters.flatMap((part) => (part.query === undefined ? [] : [part.query])))],
    ];
    if (body.entry !== undefined) {
      parts.push(body.entry);
    }

    // Only an operation with cookie parameters names `cookies`, so M1 output is unchanged (C16).
    if (cookies.length > 0) {
      parts.push(["cookies", arr(cookies)]);
    }

    const fields = [...body.fields, ...parameters.map((part) => part.field)];
    // An operation with no input takes no argument: an empty interface and an unused parameter
    // fail the package's own lint.
    const builder = arrow(
      fields.length === 0 ? [] : [{ name: I("input"), type: typeRef(inputName) }],
      fn("request", [str(operation.key.method), obj(parts)]),
      typeRef(I("Serialize"), [M("Request")]),
    );
    const media = obj([
      ["request", strings(mediaTypes(operation.body?.alternatives ?? []))],
      [
        "responses",
        obj(
          operation.responses.map(
            (response) =>
              [responseKey(response.key), strings(mediaTypes(response.alternatives))] as const,
          ),
        ),
      ],
    ]);
    const meta: (readonly [string, Expr])[] = [
      ...(operation.deprecated ? ([["deprecated", bool(true)]] as const) : []),
      ["media", ident(mediaName)],
      ["method", str(operation.key.method)],
      [
        "origin",
        obj([
          ["document", str(context.document(operation.origin.document))],
          ["pointer", str(operation.origin.pointer)],
        ]),
      ],
      ["pathTemplate", str(operation.key.path)],
      ["security", ident(securityName)],
    ];
    if (operation.operationId !== undefined) {
      meta.push(["operationId", str(operation.operationId)]);
    }

    // Only an operation that declares a candidate names one, so M1 output is unchanged (C16).
    const requestId = requestIdHeaderOf(operation.responses);
    if (requestId !== undefined) {
      meta.push(["requestIdHeader", str(requestId)]);
    }

    // Only an operation that declares a required response header names the table (HDR-03).
    const requiredHeaders = requiredHeadersOf(operation.responses);
    if (requiredHeaders.length > 0) {
      meta.push(["requiredHeaders", obj(requiredHeaders)]);
    }

    if (operation.servers.some((server) => server.level !== "root")) {
      meta.push(["servers", serversTable(operation.servers, context.bound)]);
    }

    const declarations: readonly Statement[] = [
      ...body.declarations,
      ...(fields.length === 0 ? [] : [{ _tag: "Interface", fields, name: inputName } as const]),
    ];

    return [
      ...declarations,
      {
        _tag: "Const",
        doc: yield* docText(`Request builder for ${path}, not an HttpApi definition.`),
        exported: true,
        name: yield* identifier(name),
        value: builder,
      },
      {
        _tag: "Const",
        exported: false,
        name: mediaName,
        type: typeRef(I("MediaDeclaration")),
        value: media,
      },
      {
        _tag: "Const",
        exported: false,
        name: securityName,
        type: typeRef(I("SecurityRequirement")),
        value: yield* requirementOf(operation, context.schemes),
      },
      { _tag: "Const", exported: true, name: yield* identifier(`${name}Meta`), value: obj(meta) },
    ];
  });

// An operation's builder, `Meta`, `Media`, `Security` and `Input` belong to its primary command
// alone; its alias commands call them (design 4.4). An operation with a parameter this layer does
// not build has none: `emitCli` refuses it.
const primaries = (commands: readonly PlannedCommand[]): readonly PlannedCommand[] =>
  commands.filter(
    (command) => command.alias === undefined && command.operation.parameters.every(buildsParameter),
  );

const moduleFile = (
  segment: string,
  commands: readonly PlannedCommand[],
  prefix: string,
  context: CommandContext,
) =>
  Effect.gen(function* file() {
    const statements = yield* Effect.all(
      commands.map((command) => commandStatements(command, `${prefix}${command.name}`, context)),
    );
    // Declaration names are composed from command identifiers and form keys; two compositions that
    // spell the same name are refused rather than printed twice.
    const declared = new Set<string>();
    for (const statement of statements.flat()) {
      if (statement._tag !== "Expression") {
        if (declared.has(statement.name)) {
          return yield* refuse("unprintable-name", statement.name);
        }

        declared.add(statement.name);
      }
    }

    const content = yield* printModule({ imports: groupImports, statements: statements.flat() });

    return { content, path: `src/api/${segment}.ts` };
  });

// The visible command path of a group, parents first, followed by a space.
const groupPrefix = (group: PlannedGroup, byTag: ReadonlyMap<string, PlannedGroup>): string => {
  const names = [group.name];
  const seen = new Set([group.tag]);
  let parent = group.parent === undefined ? undefined : byTag.get(group.parent);
  while (parent !== undefined && !seen.has(parent.tag)) {
    names.unshift(parent.name);
    seen.add(parent.tag);
    parent = parent.parent === undefined ? undefined : byTag.get(parent.parent);
  }

  return `${names.join(" ")} `;
};

// A scheme the document marks deprecated carries `deprecated: true`; any other prints no field.
const deprecation = (scheme: SecurityScheme): readonly (readonly [string, Expr])[] =>
  scheme.deprecated ? [["deprecated", bool(true)]] : [];

const runtimeScheme = (scheme: SecurityScheme, env: string): Effect.Effect<Expr, ApiEmitError> => {
  const { kind } = scheme;
  if (kind.type === "apiKey") {
    return Effect.succeed(
      obj([
        ...deprecation(scheme),
        ["env", str(env)],
        ["in", str(kind.in)],
        ["kind", str("apiKey")],
        ["name", str(kind.name)],
      ]),
    );
  }

  if (kind.type === "http") {
    return Effect.succeed(
      obj([
        ...deprecation(scheme),
        ["env", str(env)],
        ["kind", str("http")],
        ["scheme", str(kind.scheme)],
      ]),
    );
  }

  return Effect.fail(refuse("unsupported-scheme", scheme.name));
};

const securityFile = (api: Api, plan: NamePlan) =>
  Effect.gen(function* file() {
    const schemes = yield* Effect.all(
      plan.credentials.map((credential) => {
        const scheme = api.securitySchemes.find(
          (candidate) => candidate.name === credential.scheme,
        );

        return scheme === undefined
          ? Effect.fail(refuse("unknown-scheme", credential.scheme))
          : runtimeScheme(scheme, credential.env).pipe(
              Effect.map((value) => [credential.scheme, value] as const),
            );
      }),
    );
    const content = yield* printModule({
      imports: [
        {
          _tag: "Named",
          from: S("../runtime/auth.ts"),
          names: [I("SecurityTable")],
          typeOnly: true,
        },
      ],
      statements: [
        {
          _tag: "Const",
          exported: true,
          name: I("security"),
          type: typeRef(I("SecurityTable")),
          value: obj([["schemes", obj(schemes)]]),
        },
      ],
    });

    return { content, path: "src/api/security.ts" };
  });

const serversFile = (api: Api, bound: ApiEmitInput["boundOrigins"]) =>
  printModule({
    imports: [
      {
        _tag: "Named",
        from: S("../runtime/base-url.ts"),
        names: [I("ServersTable")],
        typeOnly: true,
      },
    ],
    statements: [
      {
        _tag: "Const",
        exported: true,
        name: I("servers"),
        type: typeRef(I("ServersTable")),
        value: serversTable(api.servers, bound),
      },
    ],
  }).pipe(Effect.map((content) => ({ content, path: "src/api/servers.ts" })));

const decodeDefs = Schema.decodeUnknownOption(
  Schema.Struct({ $defs: Schema.Record(Schema.String, Schema.Json) }),
);

const byPath = Order.mapInput(Order.String, (file: EmittedFile) => file.path);

/**
 * Emits the V1 `api/` layer (design 4.1, 4.4, 4.8, 6.4, 6.5; §14 D1, D6): `api/<group>.ts` per
 * planned group and `api/root.ts` for untagged commands that hold a primary command, each
 * operation once, under its primary command, with its `Input` type, a pure request builder over
 * `runtime/serialize`, its media declaration, its security requirement and its meta (servers only
 * when the operation or path item overrides them); `api/servers.ts`; and `api/security.ts` with
 * every scheme the planned operations use. Builders read no flag. Files are sorted by path.
 */
export const emitApi = (
  input: ApiEmitInput,
): Effect.Effect<readonly EmittedFile[], ApiEmitError | PrinterError> =>
  Effect.gen(function* emit() {
    const { api, plan } = input;
    const reserved = plan.groups.find((group) => reservedSegments.has(group.segment));
    if (reserved !== undefined) {
      return yield* refuse("reserved-segment", reserved.segment);
    }

    const context: CommandContext = {
      bound: input.boundOrigins,
      defs: Option.match(decodeDefs(api.schemas.document), {
        onNone: () => ({}),
        onSome: (store) => store.$defs,
      }),
      document: (uri) => documentLabel(api.entry, uri),
      line: api.line,
      memo: new Map(),
      schemes: new Set(plan.credentials.map((credential) => credential.scheme)),
    };
    const byTag = new Map(plan.groups.map((group) => [group.tag, group] as const));
    const withPrimaries = plan.groups.filter((group) => primaries(group.commands).length > 0);
    const groups = yield* Effect.all(
      withPrimaries.map((group) =>
        moduleFile(group.segment, primaries(group.commands), groupPrefix(group, byTag), context),
      ),
    );
    const files: EmittedFile[] = [...groups];
    const rootPrimaries = primaries(plan.root);
    if (rootPrimaries.length > 0) {
      files.push(yield* moduleFile("root", rootPrimaries, "", context));
    }

    files.push(yield* securityFile(api, plan), yield* serversFile(api, input.boundOrigins));

    return Arr.sort(files, byPath);
  });
