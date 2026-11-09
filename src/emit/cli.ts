import { Array as Arr, Data, Effect, Option, Order, Predicate, Result, Schema } from "effect";
import type { AuthorConfig } from "../model/author-config.ts";
import type { Api, MediaAlternative, Operation, Parameter } from "../model/entities.ts";
import { formatPointer } from "../model/pointer.ts";
import type { SchemaEdit } from "../normalize/schemas.ts";
import type { SpecLine } from "../model/spec-section.ts";
import { packageImports, rootNamespaceImports, runtimeNamespaces } from "../names/domain.ts";
import { isPositionalBody } from "../names/flatten.ts";
import { foldIdentifier } from "../names/fold.ts";
import type {
  NamePlan,
  PlannedCommand,
  PlannedFlag,
  PlannedGroup,
  PlannedPositional,
} from "../names/index.ts";
import type { FieldEncoding, NumericKind } from "../runtime-src/runtime/input.ts";
import { envPrefixOf, isBooleanSchema, rootNamespace } from "../names/plan.ts";
import {
  buildsParameter,
  encodesByKey,
  formParts,
  inputKeys,
  isScalarArraySchema,
  mixedParts,
  scalarTypeOf,
  takesJsonContent,
} from "./api.ts";
import type { FormPart, MixedPlan, NestedFormPart, PartHeader } from "./api.ts";
import { operationHelp, sanitizeProse } from "./help.ts";
import type { HelpBodyField, HelpFlag, HelpPartOption } from "./help.ts";
import type { EmittedFile } from "./package.ts";
import {
  Identifier,
  MemberName,
  ModuleSpecifier,
  arr,
  arrow,
  bool,
  call,
  dynamicImport,
  ident,
  member,
  newExpr,
  num,
  obj,
  printModule,
  str,
  typeKeyword,
  typeReadonlyArray,
} from "./printer.ts";
import type { Expr, Import, PrinterError, Statement } from "./printer.ts";

/**
 * What the `cli/` layer is emitted from: the normalized `Api`, its name plan, the author config
 * (bin name, environment prefix and the author-owned commands module), and the edits normalize
 * recorded deriving the schemas' validation copy, from which help learns the defaults it refused
 * (S30-27). Required: a spec with no refused default passes an empty list, written explicitly.
 */
export interface CliEmitInput {
  readonly api: Api;
  readonly config: AuthorConfig;
  readonly plan: NamePlan;
  readonly validationEdits: readonly SchemaEdit[];
}

/**
 * The plan, model or author config holds something the `cli/` layer cannot express. An SSE body is
 * `unsupported-body`, and so is a multipart body the runtime writer cannot send exactly
 * (`formParts` names why), alone or beside other media; an XML body is opaque `--body-file` bytes,
 * like a binary one, and a text or sequential body is the operator's `--body` text or
 * `--body-file` stream (design 6.3).
 * `unsupported-flag` is a flag with no call-expression form today: an integer field whose width the
 * walk cannot settle, and a required boolean parameter (absent would send `false`).
 * `unsupported-parameter` is a parameter the `api/` layer does not build (`buildsParameter`), a
 * boolean path parameter, or a path array before another positional (a repeated argument would take
 * the later ones). Those three refuse one operation (`CliRefusal`); every other reason fails
 * `emitCli`.
 */
export class CliEmitError extends Data.TaggedError("CliEmitError")<{
  readonly reason:
    | "name-clash"
    | "reserved-segment"
    | "unknown-parent"
    | "unknown-primary"
    | "unplanned-parameter"
    | "unprintable-name"
    | "unresolved-schema"
    | "unsafe-commands-module"
    | "unsupported-body"
    | "unsupported-flag"
    | "unsupported-parameter";
  readonly subject: string;
}> {}

type OperationReason = "unsupported-body" | "unsupported-flag" | "unsupported-parameter";

const operationReasons: readonly string[] = [
  "unsupported-body",
  "unsupported-flag",
  "unsupported-parameter",
] satisfies readonly OperationReason[];

const isOperationReason = (reason: CliEmitError["reason"]): reason is OperationReason =>
  operationReasons.includes(reason);

/**
 * An operation-scope refusal: the operation's command is not emitted, the rest of the package
 * is. `reason` is the `CliEmitError` code and `subject` names the parameter, flag or media type.
 */
export interface CliRefusal {
  readonly operation: Operation["key"];
  readonly reason: OperationReason;
  readonly scope: "operation";
  readonly subject: string;
}

/**
 * The emitted `cli/` files, sorted by path, and the operations refused in operation order.
 */
export interface CliEmitOutput {
  readonly files: readonly EmittedFile[];
  readonly refusals: readonly CliRefusal[];
}

type Defs = Readonly<Record<string, Schema.Json>>;

type Entry = readonly [string, Expr];

const refuse = (reason: CliEmitError["reason"], subject: string) =>
  new CliEmitError({ reason, subject });

const identifier = (name: string) =>
  Schema.decodeUnknownEffect(Identifier)(name).pipe(
    Effect.mapError(() => refuse("unprintable-name", name)),
  );

const memberName = (name: string) =>
  Schema.decodeUnknownEffect(MemberName)(name).pipe(
    Effect.mapError(() => refuse("unprintable-name", name)),
  );

const specifier = (value: string, reason: CliEmitError["reason"]) =>
  Schema.decodeUnknownEffect(ModuleSpecifier)(value).pipe(
    Effect.mapError(() => refuse(reason, value)),
  );

const I = Schema.decodeSync(Identifier);

const M = Schema.decodeSync(MemberName);

// `path("a.b.c")` is the member access `a.b.c`; every caller passes a fixed name.
const path = (dotted: string): Expr => {
  const [head = "", ...rest] = dotted.split(".");

  let expr = ident(I(head));
  for (const name of rest) {
    expr = member(expr, M(name));
  }

  return expr;
};

const fn = (dotted: string, ...args: readonly Expr[]): Expr => call(path(dotted), args);

const pipe = (head: Expr, args: readonly Expr[]): Expr =>
  args.length === 0 ? head : call(member(head, M("pipe")), args);

const flags = ident(I("flags"));

// Segments of the modules every package has (`api/servers.ts`, `api/security.ts`, `api/root.ts`
// and `cli/root.ts`). The names plan refuses them first (`TAG-02/reserved-segment`).
const reservedSegments: ReadonlySet<string> = new Set(["root", "security", "servers"]);

const essence = (mediaType: string): string => (mediaType.split(";")[0] ?? "").trim().toLowerCase();

const isRange = (mediaType: string): boolean => essence(mediaType).endsWith("/*");

const isWholeBody = (flag: PlannedFlag): boolean =>
  flag.source._tag === "Body" &&
  (flag.source.kind === "body" || flag.source.kind === "body-file" || flag.source.kind === "part");

const isPartFlag = (flag: PlannedFlag): boolean =>
  flag.source._tag === "Body" && flag.source.kind === "part";

const isFieldFlag = (flag: PlannedFlag): boolean =>
  flag.source._tag === "Body" && !isWholeBody(flag);

const describedBy = (description: string): readonly Expr[] => {
  const text = sanitizeProse(description);

  return text === "" ? [] : [str(text)];
};

// ---------------------------------------------------------------------------------------------
// Body field schemas: the property a field flag writes, for its description and `int64` check.
// The walk follows `$ref`, `properties`, `allOf` members and an array's `items`, each node once
// per pointer token (so a cycle ends), under one visit budget per field. A node is read
// shallowly: only the keywords below, never its subtree.

const refPrefix = "#/$defs/";

const maxVisits = 10_000;

type JsonObject = Readonly<Record<string, Schema.Json>>;

const own = (record: JsonObject, key: string): Schema.Json | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const isJsonObject = (json: Schema.Json | undefined): json is JsonObject =>
  Predicate.isObject(json) && !Array.isArray(json);

const unescapeToken = (token: string): string => token.replaceAll("~1", "/").replaceAll("~0", "~");

// A bound outside the safe-integer range makes an integer field a digit string (design 4.5).
const boundKeywords: readonly string[] = [
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maximum",
  "minimum",
];

interface FieldNode {
  readonly allOf: readonly Schema.Json[];
  readonly contentEncoding: string | undefined;
  readonly contentMediaType: string | undefined;
  readonly default: Schema.Json | undefined;
  readonly deprecated: boolean;
  readonly enum: readonly Schema.Json[] | undefined;
  readonly format: string | undefined;
  readonly int64: boolean;
  readonly items: Schema.Json | undefined;
  readonly maxLength: number | undefined;
  readonly prose: string | undefined;
  readonly properties: JsonObject | undefined;
  readonly readOnly: boolean;
  readonly ref: string | undefined;
}

// `None` for a node the walk cannot read: not an object, or a `$ref` that is not a string. A
// `default` normalize refused reads as absent.
const fieldNode = (
  json: Schema.Json,
  refusedDefaults: ReadonlySet<Schema.Json>,
): Option.Option<FieldNode> => {
  if (!isJsonObject(json)) {
    return Option.none();
  }

  const ref = own(json, "$ref");
  if (ref !== undefined && !Predicate.isString(ref)) {
    return Option.none();
  }

  const allOf = own(json, "allOf");
  const values = own(json, "enum");
  const properties = own(json, "properties");
  const prose = [own(json, "description"), own(json, "title")].find(Predicate.isString);
  const maxLength = own(json, "maxLength");
  const unsafe = boundKeywords.some((keyword) => {
    const bound = own(json, keyword);

    return Predicate.isNumber(bound) && Math.abs(bound) > Number.MAX_SAFE_INTEGER;
  });

  const text = (key: string): string | undefined => {
    const value = own(json, key);

    return Predicate.isString(value) ? value : undefined;
  };

  return Option.some({
    allOf: Array.isArray(allOf) ? allOf : [],
    contentEncoding: text("contentEncoding"),
    contentMediaType: text("contentMediaType"),
    default: refusedDefaults.has(json) ? undefined : own(json, "default"),
    deprecated: own(json, "deprecated") === true,
    enum: Array.isArray(values) ? values : undefined,
    format: text("format"),
    int64: own(json, "format") === "int64" || unsafe,
    items: own(json, "items"),
    maxLength:
      Predicate.isNumber(maxLength) && Number.isSafeInteger(maxLength) && maxLength >= 0
        ? maxLength
        : undefined,
    properties: isJsonObject(properties) ? properties : undefined,
    prose,
    readOnly: own(json, "readOnly") === true,
    ref,
  });
};

/**
 * Which flag an integer field takes: `int64` (`Input.int64Flag`) when a node on its scalar's `$ref`
 * chain (an array's `items` for a repeated flag) is `int64` or has an unsafe bound, `safe`
 * (`Input.numericFlag`) otherwise, and `unsettled` when the walk cannot reach that scalar (an
 * unreadable node, a cycle, an exhausted budget).
 */
type IntegerWidth = "int64" | "safe" | "unsettled";

interface FieldSchema {
  readonly description: string;
  /**
   * The text encoding of a base64 string field (3.0 `format: byte`; 3.1+ `contentEncoding`),
   * read from the end of the `$ref` chain as the name plan's walk reads it.
   */
  readonly encoding: FieldEncoding | undefined;
  readonly integer: IntegerWidth;
  /**
   * The tightest `maxLength` on the `$ref` chain: for a binary body, its byte limit (MED-21).
   */
  readonly maxLength: number | undefined;
  readonly mediaType: string | undefined;
  /**
   * The annotations help notes (SCH-29, 49, 50, 51): the first `enum` and `default` on the `$ref`
   * chain (an array's `items` too, for `enum`), and whether any node is read-only or deprecated.
   */
  readonly notes: HelpBodyField;
  /**
   * Whether any node on the scalar's `$ref` chain (an array's `items` for a repeated flag) is
   * `format: password`, so a multipart file part's flag reads as a secret (ruling DR4).
   */
  readonly password: boolean;
}

// The node chain a schema reaches through `$ref`, starting at the schema itself; `settled` when
// it ends at a node without `$ref`.
interface Chain {
  readonly nodes: readonly FieldNode[];
  readonly settled: boolean;
}

type Work =
  | { readonly _tag: "Direct"; readonly node: FieldNode }
  | { readonly _tag: "Expand"; readonly json: Schema.Json };

// The text encoding of a base64 string node: `contentEncoding` on every line, or `format: byte`
// without one on 3.0 only (FMT-10), as `flattenBody` reads it.
const encodingOf = (node: FieldNode, line: SpecLine): FieldEncoding | undefined => {
  if (node.contentEncoding === "base64" || node.contentEncoding === "base64url") {
    return node.contentEncoding;
  }

  return line === "3.0" && node.contentEncoding === undefined && node.format === "byte"
    ? "base64"
    : undefined;
};

// The stored `$defs`, the nodes among them whose `default` normalize refused (S30-27), and the
// OpenAPI line, which decides whether `format: byte` is a base64 encoding.
interface FieldStore {
  readonly defs: Defs;
  readonly line: SpecLine;
  readonly refusedDefaults: ReadonlySet<Schema.Json>;
}

const fieldSchema = (
  { defs, line, refusedDefaults }: FieldStore,
  rootKey: string,
  pointer: string,
  repeated: boolean,
): FieldSchema => {
  let visits = 0;
  const chain = (start: Schema.Json | undefined): Chain => {
    const nodes: FieldNode[] = [];
    const seen = new Set<Schema.Json>();
    let current = start;
    while (current !== undefined && !seen.has(current) && visits < maxVisits) {
      seen.add(current);
      visits += 1;

      const node = fieldNode(current, refusedDefaults);
      if (Option.isNone(node)) {
        break;
      }

      nodes.push(node.value);

      const { ref } = node.value;
      if (ref === undefined) {
        return { nodes, settled: true };
      }

      current = ref.startsWith(refPrefix)
        ? own(defs, unescapeToken(ref.slice(refPrefix.length)))
        : undefined;
    }

    return { nodes, settled: false };
  };
  // Depth first, in declaration order: a node's own `properties`, then its `allOf` members.
  const property = (start: Schema.Json, name: string): Schema.Json | undefined => {
    const seen = new Set<Schema.Json>([start]);
    const pending: Work[] = [{ _tag: "Expand", json: start }];
    for (let work = pending.pop(); work !== undefined; work = pending.pop()) {
      if (work._tag === "Direct") {
        const found =
          work.node.properties === undefined ? undefined : own(work.node.properties, name);
        if (found !== undefined) {
          return found;
        }

        continue;
      }

      const later: Work[] = [];
      for (const node of chain(work.json).nodes) {
        later.push({ _tag: "Direct", node });
        for (const part of node.allOf) {
          if (!seen.has(part)) {
            seen.add(part);
            later.push({ _tag: "Expand", json: part });
          }
        }
      }

      pending.push(...Arr.reverse(later));
    }

    return undefined;
  };
  let target = own(defs, rootKey);
  for (const token of pointer.split("/").slice(1).map(unescapeToken)) {
    target = target === undefined ? undefined : property(target, token);
  }

  const field = chain(target);
  const items = repeated ? chain(field.nodes.at(-1)?.items) : { nodes: [], settled: true };
  const described = field.nodes.find((node) => node.prose !== undefined);
  const width = (): IntegerWidth => {
    if ([...field.nodes, ...items.nodes].some((node) => node.int64)) {
      return "int64";
    }

    return field.settled && items.settled ? "safe" : "unsettled";
  };

  const last = field.nodes.at(-1);
  const encoding = last === undefined ? undefined : encodingOf(last, line);

  const bounds = field.nodes.flatMap((node) =>
    node.maxLength === undefined ? [] : [node.maxLength],
  );

  const notes: HelpBodyField = {
    default: field.nodes.find((node) => node.default !== undefined)?.default,
    deprecated: field.nodes.some((node) => node.deprecated),
    enum: [...field.nodes, ...items.nodes].find((node) => node.enum !== undefined)?.enum,
    readOnly: field.nodes.some((node) => node.readOnly),
  };

  return {
    description: described?.prose ?? "",
    encoding,
    integer: width(),
    maxLength: bounds.length === 0 ? undefined : Math.min(...bounds),
    mediaType: last?.contentMediaType,
    notes,
    password: (repeated ? items : field).nodes.some((node) => node.format === "password"),
  };
};

const unknownField: FieldSchema = {
  description: "",
  encoding: undefined,
  integer: "unsettled",
  maxLength: undefined,
  mediaType: undefined,
  notes: { default: undefined, deprecated: false, enum: undefined, readOnly: false },
  password: false,
};

type BodyFlagSource = Extract<PlannedFlag["source"], { readonly _tag: "Body" }>;

// The body alternative a field flag writes into, and that field's schema.
const bodyField = (operation: Operation, source: BodyFlagSource, store: FieldStore) => {
  const alternative = operation.body?.alternatives.find((candidate) =>
    source.media.includes(candidate.mediaType),
  );
  const schema =
    alternative?.schema === undefined
      ? unknownField
      : fieldSchema(store, alternative.schema.key, source.wireName, source.repeated);

  return { alternative, schema };
};

// ---------------------------------------------------------------------------------------------
// One command.

// Where an operation's builder and meta live: its primary command's `api/` module (design 4.4).
interface Target {
  readonly from: string;
  readonly identifier: string;
  readonly namespace: string;
}

interface CommandContext extends FieldStore {
  readonly api: Api;
  readonly booleans: Map<string, boolean>;
  readonly domain: NamePlan["domain"];
  // The author config's environment prefix, which each command's run record reads.
  readonly envPrefix: string;
  readonly plan: NamePlan;
  readonly targets: ReadonlyMap<Operation, Target>;
}

const parameterOf = (operation: Operation, location: string, wireName: string) =>
  operation.parameters.find(
    (parameter) => parameter.location === location && parameter.wireName === wireName,
  );

// What typing a header-shaped value reads: a parameter, or a part header typed as one (ENC-03).
type Typed = Pick<Parameter, "location" | "schema" | "serialization">;

// Whether a parameter is an array of scalar items, given once per item (design 6.1).
const isArrayParameter = (parameter: Pick<Typed, "schema">, context: CommandContext) =>
  Effect.gen(function* scalarArray() {
    const array = isScalarArraySchema(context.defs, parameter.schema.key);
    if (Result.isFailure(array)) {
      return yield* refuse("unresolved-schema", array.failure);
    }

    return array.success;
  });

// Whether a styled parameter takes JSON (design 6.1): an object, or a union the scalar switch
// covers (`nonStandardScalars`, design 6.1 Scalar switch). The operator gives it as JSON, which the
// builder hands to the style serializer. A `content` parameter is one value whatever its schema.
const isObjectParameter = ({ serialization }: Pick<Typed, "serialization">): boolean =>
  serialization.kind === "style" &&
  (serialization.objectValued || serialization.nonStandardScalars !== undefined);

// Whether a parameter flag takes JSON text: an object parameter, or a JSON content one. Its help
// names the value json; the callers add that metavar as a step of the flag's one chain.
const takesJsonText = (parameter: Typed): boolean =>
  isObjectParameter(parameter) ||
  (parameter.serialization.kind === "content" &&
    takesJsonContent(parameter.location, parameter.serialization.mediaType));

// The numeric kind of an `integer` or `number` parameter, or of its items for an array (design
// 6.1): the runtime checks the operator's text against that grammar and sends it unchanged. A
// `content` parameter is one value whatever its schema, so it has none.
const numericKindOf = (parameter: Typed, context: CommandContext) =>
  Effect.gen(function* numeric() {
    let kind: NumericKind | undefined;
    if (parameter.serialization.kind === "style") {
      const type = scalarTypeOf(context.defs, parameter.schema.key);
      if (Result.isFailure(type)) {
        return yield* refuse("unresolved-schema", type.failure);
      }

      if (type.success === "integer" || type.success === "number") {
        kind = type.success;
      }
    }

    return kind;
  });

const parameterDescription = (parameter: Parameter): string =>
  parameter.docs.description ?? parameter.docs.summary ?? "";

// The notice step of a deprecated parameter's flag or argument (PRM-07); none for any other.
const deprecation = (parameter: Parameter, combinator: string, name: string): readonly Expr[] =>
  parameter.deprecated ? [fn(combinator, str(name))] : [];

const positionalEntry = (
  operation: Operation,
  positional: PlannedPositional,
  last: boolean,
  context: CommandContext,
) =>
  Effect.gen(function* entry() {
    const parameter = parameterOf(operation, "path", positional.wireName);
    if (parameter === undefined) {
      return yield* refuse("unplanned-parameter", `path:${positional.wireName}`);
    }

    // The `api/` builder types a boolean path parameter as `boolean`; an argument is a string.
    const boolean = isBooleanSchema(context.defs, context.booleans, parameter.schema.key);
    if (Result.isFailure(boolean)) {
      return yield* refuse("unresolved-schema", boolean.failure.key);
    }

    if (boolean.success) {
      return yield* refuse("unsupported-parameter", `path:${positional.wireName}`);
    }

    const array = yield* isArrayParameter(parameter, context);
    if (array && !last) {
      return yield* refuse("unsupported-parameter", `path:${positional.wireName}`);
    }

    const object = isObjectParameter(parameter);
    const numeric = yield* numericKindOf(parameter, context);
    let head = fn("Argument.String", str(positional.name));
    if (object) {
      head = fn("Input.jsonArgument", str(positional.name));
    } else if (numeric !== undefined) {
      head = fn("Input.numericArgument", str(positional.name), str(numeric));
    }

    const described = describedBy(parameterDescription(parameter));
    const value = pipe(head, [
      ...(object ? [fn("Argument.withMetavar", str("json"))] : []),
      ...(array ? [fn("Argument.atLeast", num(1))] : []),
      ...deprecation(parameter, "Input.deprecatedArgument", positional.name),
      ...(described.length === 0 ? [] : [fn("Argument.withDescription", ...described)]),
    ]);

    return [positional.identifier, value] as const;
  });

// The step that carries a numeric flag's checked text as a `JsonNumber`, so the JSON body or the
// multipart part sends the operator's digits unchanged (FMT-04).
const asJsonNumber = fn(
  "Flag.map",
  arrow([{ name: I("text") }], newExpr(path("Input.JsonNumber"), [ident(I("text"))])),
);

// A body field flag's constructor and the steps before its presence wrapper.
interface BodyFlagHead {
  readonly head: Expr;
  readonly steps: readonly Expr[];
}

// An `integer` or `number` field is checked against the same grammar as an `integer` or `number`
// parameter (an `int64` one as digits by `Input.int64Flag`), never parsed to a JavaScript number.
const bodyFlagHead = (flag: PlannedFlag, kind: string, integer: IntegerWidth): BodyFlagHead => {
  // A JSON-valued field takes JSON text, named in help as an object parameter's is.
  if (kind === "json") {
    return {
      head: fn("Input.jsonFlag", str(flag.name)),
      steps: [fn("Flag.withMetavar", str("json"))],
    };
  }

  if (kind === "integer" && integer === "int64") {
    return { head: fn("Input.int64Flag", str(flag.name)), steps: [] };
  }

  // A multipart `file` part flag carries a path, or `-` for stdin.
  if (kind === "string" || kind === "file") {
    return { head: fn("Flag.String", str(flag.name)), steps: [] };
  }

  if (flag.boolean || kind === "boolean") {
    return { head: fn("Flag.Boolean", str(flag.name)), steps: [] };
  }

  return {
    head: fn("Input.numericFlag", str(flag.name), str(kind === "integer" ? "integer" : "number")),
    steps: [asJsonNumber],
  };
};

// A JSON or form body property the runtime reads from a file and encodes (design 6.3 Binary): its
// flag is a `file` flag inside a JSON or form alternative, where a multipart part flag of the same
// kind is a part.
const isEncodedField = (flag: PlannedFlag, alternative: MediaAlternative | undefined): boolean =>
  (alternative?.codec === "json" || alternative?.codec === "form") &&
  flag.source._tag === "Body" &&
  flag.source.kind === "file" &&
  !flag.source.repeated;

const fileDescription = ({ description, encoding, mediaType }: FieldSchema): string =>
  [
    description,
    `File path, or - for stdin; the ${encoding ?? "base64"} encoding is applied for you.`,
    ...(mediaType === undefined ? [] : [`Content type: ${mediaType}.`]),
  ]
    .filter((part) => part !== "")
    .join(" ");

// The transfer encoding of a multipart `file` part flag, from its Encoding rule and never its
// schema (design 6.3 Multipart transfer encoding): the runtime encodes the file's bytes.
const partEncoding = (
  flag: PlannedFlag,
  alternative: MediaAlternative | undefined,
): FieldEncoding | undefined => {
  const { source } = flag;
  if (alternative?.codec !== "multipart" || source._tag !== "Body" || source.kind !== "file") {
    return undefined;
  }

  return alternative.encoding.find(
    (rule) =>
      rule.target.kind === "property" && formatPointer([rule.target.name]) === source.wireName,
  )?.contentEncoding;
};

// A field flag's help text; an encoded field the walk cannot settle an encoding for is refused.
const fieldDescription = (
  flag: PlannedFlag,
  alternative: MediaAlternative | undefined,
  schema: FieldSchema,
) =>
  Effect.gen(function* described() {
    const encoding = partEncoding(flag, alternative);
    if (encoding !== undefined) {
      return fileDescription({ ...schema, encoding });
    }

    if (!isEncodedField(flag, alternative)) {
      return schema.description;
    }

    if (schema.encoding === undefined) {
      return yield* refuse("unsupported-flag", flag.name);
    }

    return fileDescription(schema);
  });

// A parameter flag's constructor. A `content` parameter's value (any location, `querystring`
// included) is JSON data under JSON media and form querystring media (design 6.1), decoded the way
// a non-flattened JSON field flag is, and the operator's string under any other media; a boolean
// styled parameter is negatable, an object one takes JSON, and an `integer` or `number` one (per item
// for an array) is checked against its grammar.
const parameterFlagHead = (
  flag: PlannedFlag,
  parameter: Typed,
  object: boolean,
  numeric: NumericKind | undefined,
): Expr => {
  const { location, serialization } = parameter;
  if (serialization.kind === "content") {
    return takesJsonContent(location, serialization.mediaType)
      ? fn("Input.jsonFlag", str(flag.name))
      : fn("Flag.String", str(flag.name));
  }

  if (object) {
    return fn("Input.jsonFlag", str(flag.name));
  }

  if (flag.boolean) {
    return fn("Flag.Boolean", str(flag.name));
  }

  return numeric === undefined
    ? fn("Flag.String", str(flag.name))
    : fn("Input.numericFlag", str(flag.name), str(numeric));
};

type PartOptionSource = Extract<PlannedFlag["source"], { readonly _tag: "PartOption" }>;

// The Encoding header a part header option sets, from the first multipart alternative it applies to.
const partHeaderOf = (operation: Operation, source: PartOptionSource) => {
  const { option } = source;

  return (operation.body?.alternatives ?? [])
    .filter((alternative) => source.media.includes(alternative.mediaType))
    .flatMap((alternative) => alternative.encoding)
    .find(
      ({ target }) => target.kind === "property" && formatPointer([target.name]) === source.part,
    )
    ?.headers.find((header) => option.kind === "header" && header.name === option.name);
};

// A content type option takes one of the listed values, with no default (ENC-10). A part header
// option is typed as a header parameter of its schema or content is, and is optional at parse:
// `Input.partOptions` requires it only when its part is sent (ENC-03).
const partOptionEntry = (
  flag: PlannedFlag,
  source: PartOptionSource,
  operation: Operation,
  context: CommandContext,
) =>
  Effect.gen(function* entry() {
    if (source.option.kind === "content-type") {
      const choices = arr(source.option.choices.map((choice) => str(choice)));

      return [
        flag.identifier,
        pipe(fn("Flag.Literals", str(flag.name), choices), [path("Flag.optional")]),
      ] as const;
    }

    const header = partHeaderOf(operation, source);
    if (header === undefined) {
      return yield* refuse("unsupported-flag", flag.name);
    }

    const typed: Typed = { ...header, location: "header" };
    const array =
      header.serialization.kind === "style" && (yield* isArrayParameter(typed, context));
    const object = isObjectParameter(typed);
    const head = parameterFlagHead(flag, typed, object, yield* numericKindOf(typed, context));
    const steps = [
      ...(takesJsonText(typed) ? [fn("Flag.withMetavar", str("json"))] : []),
      array ? fn("Flag.atLeast", num(0)) : path("Flag.optional"),
      ...(header.deprecated ? [fn("Input.deprecated", str(flag.name))] : []),
    ];

    return [flag.identifier, pipe(head, steps)] as const;
  });

// The flag of a whole-body input: `--body`, `--body-file`, or a positional body's `--part`
// (HT:B15), repeated and kept in invocation order, each a path or `-`; `undefined` for any other.
const wholeBodyEntry = (flag: PlannedFlag): Expr | undefined => {
  const { source } = flag;
  if (source._tag !== "Body") {
    return undefined;
  }

  if (source.kind === "body") {
    return path("Input.bodyFlag");
  }

  if (source.kind === "body-file") {
    return path("Input.bodyFileFlag");
  }

  return source.kind === "part"
    ? pipe(fn("Flag.String", str(flag.name)), [
        fn("Flag.withMetavar", str("path|-")),
        fn("Flag.atLeast", num(0)),
        fn(
          "Flag.withDescription",
          str("Ordered multipart/mixed part from a file or stdin; repeat in order"),
        ),
      ])
    : undefined;
};

// A multipart `format: password` part is a file part (ruling DR4) whose help reads as the
// secret-file flag's: `Input.secretPartFlag` carries the `path|-` metavar and the note.
const isSecretPart = (
  source: BodyFlagSource,
  alternative: MediaAlternative | undefined,
  schema: FieldSchema,
): boolean => source.kind === "file" && alternative?.codec === "multipart" && schema.password;

const secretPartEntry = (
  flag: PlannedFlag,
  alternative: MediaAlternative | undefined,
  schema: FieldSchema,
) =>
  Effect.gen(function* secretPart() {
    const description = describedBy(yield* fieldDescription(flag, alternative, schema));
    const repeated = flag.source._tag === "Body" && flag.source.repeated;
    const presence = repeated ? fn("Flag.atLeast", num(0)) : path("Flag.optional");

    return [
      flag.identifier,
      pipe(fn("Input.secretPartFlag", str(flag.name), ...description), [presence]),
    ] as const;
  });

const flagEntry = (flag: PlannedFlag, operation: Operation, context: CommandContext) =>
  Effect.gen(function* entry() {
    const { source } = flag;
    const whole = wholeBodyEntry(flag);
    if (whole !== undefined) {
      return [flag.identifier, whole] as const;
    }

    if (source._tag === "Parameter") {
      const parameter = parameterOf(operation, source.location, source.wireName);
      if (parameter === undefined) {
        return yield* refuse("unplanned-parameter", `${source.location}:${source.wireName}`);
      }

      // A `content` parameter is one value, whatever its schema: never negatable, never repeated.
      const styled = parameter.serialization.kind === "style";
      if (styled && parameter.required && flag.boolean) {
        return yield* refuse("unsupported-flag", flag.name);
      }

      const array = styled && (yield* isArrayParameter(parameter, context));
      const object = isObjectParameter(parameter);
      const head = parameterFlagHead(
        flag,
        parameter,
        object,
        yield* numericKindOf(parameter, context),
      );
      const presence = parameter.required ? [] : [path("Flag.optional")];
      // A deprecated parameter's notice goes outside the presence wrapper, which settles whether
      // the operator gave the flag (PRM-07).
      const steps = [
        ...(takesJsonText(parameter) ? [fn("Flag.withMetavar", str("json"))] : []),
        ...(array ? [fn("Flag.atLeast", num(parameter.required ? 1 : 0))] : presence),
        ...deprecation(parameter, "Input.deprecated", flag.name),
        ...describedBy(parameterDescription(parameter)).map((text) =>
          fn("Flag.withDescription", text),
        ),
      ];

      return [flag.identifier, pipe(head, steps)] as const;
    }

    if (source._tag === "PartOption") {
      return yield* partOptionEntry(flag, source, operation, context);
    }

    const { alternative, schema } = bodyField(operation, source, context);

    // A `format: password` property's secret-file flag (design 13.1 R4): the m3-pw2 helper carries
    // its presence and its help note, after the property's sanitized description when it has one.
    if (source.kind === "secret-file") {
      const description = describedBy(yield* fieldDescription(flag, alternative, schema));

      return [flag.identifier, fn("Input.secretFileFlag", str(flag.name), ...description)] as const;
    }

    if (isSecretPart(source, alternative, schema)) {
      return yield* secretPartEntry(flag, alternative, schema);
    }

    if (source.kind === "integer" && schema.integer === "unsettled") {
      return yield* refuse("unsupported-flag", flag.name);
    }

    const description = yield* fieldDescription(flag, alternative, schema);
    const { head, steps: carried } = bodyFlagHead(flag, source.kind, schema.integer);
    const steps = [
      ...carried,
      source.repeated ? fn("Flag.atLeast", num(0)) : path("Flag.optional"),
      ...describedBy(description).map((text) => fn("Flag.withDescription", text)),
    ];

    return [flag.identifier, pipe(head, steps)] as const;
  });

const flagValue = (key: string) => memberName(key).pipe(Effect.map((name) => member(flags, name)));

interface BodyPlan {
  readonly args: readonly Entry[];
  readonly domain: readonly string[];
  readonly head: Expr;
  readonly parameter: string;
  readonly steps?: readonly Expr[];
}

const wholeBody = (
  command: PlannedCommand,
  kind: "body" | "body-file",
): Effect.Effect<Expr, CliEmitError> => {
  const flag = command.flags.find(
    (candidate) => candidate.source._tag === "Body" && candidate.source.kind === kind,
  );

  return flag === undefined ? Effect.succeed(fn("Option.none")) : flagValue(flag.identifier);
};

// Bodies sent as the operator's bytes from `--body-file`: binary, and XML, which is never built
// from its XML Object (design 6.3).
const isOpaque = (alternative: MediaAlternative): boolean =>
  alternative.codec === "binary" || alternative.codec === "xml";

// Bodies sent as the operator's bytes, as given: `--body` text or a `--body-file` stream, never
// parsed or framed (design 6.3 Sequential uploads).
const isVerbatim = (alternative: MediaAlternative): boolean =>
  alternative.codec === "ndjson" || alternative.codec === "jsonseq" || alternative.codec === "text";

// Bodies the command hands to the builder as an `HttpBody`, not a JSON value.
const isLoaded = (alternative: MediaAlternative): boolean =>
  isOpaque(alternative) || isVerbatim(alternative);

// A form-urlencoded body is merged from the JSON body sources into the value the `api/` builder
// encodes (`Input.structuredBody`). A text or sequential body is `Input.sequentialBody`; the
// builder's `Serialize.body` sets its media type as `Content-Type`. A multipart body is
// `formBody`'s, and an SSE body is refused.
const alternativeBody = (
  command: PlannedCommand,
  alternative: MediaAlternative,
  required: boolean,
  context: CommandContext,
) =>
  Effect.gen(function* body() {
    const sources: Entry[] = [
      ["body", yield* wholeBody(command, "body")],
      ["bodyFile", yield* wholeBody(command, "body-file")],
    ];
    if (isOpaque(alternative)) {
      // MED-21: a binary body's `maxLength` counts its octets, so it bounds the upload.
      const limit =
        alternative.codec === "binary" && alternative.schema !== undefined
          ? fieldSchema(context, alternative.schema.key, "", false).maxLength
          : undefined;
      const bound: Entry[] = limit === undefined ? [] : [["maxBytes", num(limit)]];

      return {
        domain: [],
        value: fn("Input.binaryBody", obj([...sources, ...bound, ["required", bool(required)]])),
      };
    }

    if (isVerbatim(alternative)) {
      return {
        domain: [],
        value: fn("Input.sequentialBody", obj([...sources, ["required", bool(required)]])),
      };
    }

    const structured = alternative.codec === "form";
    if (alternative.codec !== "json" && !structured) {
      return yield* refuse("unsupported-body", `${alternative.codec}:${alternative.mediaType}`);
    }

    const schemaName =
      alternative.schema === undefined ? undefined : context.domain.get(alternative.schema.key);
    if (schemaName === undefined) {
      return yield* refuse("unresolved-schema", alternative.mediaType);
    }

    const schemaKey = alternative.schema?.key ?? "";
    const fields: Entry[] = [];
    for (const flag of command.flags.filter(isFieldFlag)) {
      const { source } = flag;
      if (source._tag !== "Body" || !source.media.includes(alternative.mediaType)) {
        continue;
      }

      const value = yield* flagValue(flag.identifier);
      // The secret-file flag stays a path string at parse; the runtime reads it, bounded, and
      // scrubs it from every error path (m3-pw2).
      if (source.kind === "secret-file") {
        fields.push([
          source.wireName,
          fn(
            "Option.map",
            value,
            arrow(
              [{ name: I("path") }],
              newExpr(path("Input.SecretField"), [
                obj([
                  ["flag", str(flag.name)],
                  ["path", ident(I("path"))],
                ]),
              ]),
            ),
          ),
        ]);
        continue;
      }

      if (!isEncodedField(flag, alternative)) {
        fields.push([source.wireName, value]);
        continue;
      }

      const { encoding } = fieldSchema(context, schemaKey, source.wireName, false);
      if (encoding === undefined) {
        return yield* refuse("unsupported-flag", flag.name);
      }

      // The flag stays a path string at parse; the runtime reads and encodes it (m2-b64a).
      fields.push([
        source.wireName,
        fn(
          "Option.map",
          value,
          arrow(
            [{ name: I("path") }],
            newExpr(path("Input.FileField"), [
              obj([
                ["encoding", str(encoding)],
                ["flag", str(flag.name)],
                ["path", ident(I("path"))],
              ]),
            ]),
          ),
        ),
      ]);
    }

    return {
      domain: [schemaName],
      value: fn(
        structured ? "Input.structuredBody" : "Input.mergeBody",
        obj([
          ...sources,
          ["fields", obj(fields)],
          ["required", bool(required)],
          ["schema", ident(yield* identifier(schemaName))],
        ]),
      ),
    };
  });

// One part flag's values as `Serialize.FormFields` takes them: a list, empty when the flag is
// absent. A JSON part's value is `Serialize.jsonPart`'s (ENC-22). A file part opens each path, or
// stdin for `-` under the invocation's one stdin claim; `name` is the filename `-` gives.
const flagValues = (flag: PlannedFlag, name: string) =>
  Effect.gen(function* values() {
    const repeated = flag.source._tag === "Body" && flag.source.repeated;
    const value = yield* flagValue(flag.identifier);
    if (flag.source._tag === "Body" && flag.source.kind === "json" && !repeated) {
      return fn(
        "Effect.succeed",
        fn("Option.toArray", fn("Option.map", value, path("Serialize.jsonPart"))),
      );
    }

    const list = repeated ? value : fn("Option.toArray", value);
    if (flag.source._tag !== "Body" || flag.source.kind !== "file") {
      return fn("Effect.succeed", list);
    }

    const source = ident(I("source"));
    const file = obj([
      ["filename", fn("Multipart.partFilename", source, str(name))],
      ["stream", ident(I("bytes"))],
    ]);

    return fn(
      "Effect.forEach",
      list,
      arrow(
        [{ name: I("source") }],
        fn(
          "Effect.map",
          fn("Multipart.fileBody", str(flag.name), source),
          arrow([{ name: I("bytes") }], file),
        ),
      ),
    );
  });

// A part's values: its flag's, or for a part nested by name (HT:B16) its nested parts' values,
// each as a part's, gathered by `Serialize.nestedValues`.
const partValues = (part: FormPart) =>
  Effect.gen(function* values() {
    if (part.nested === undefined) {
      return yield* flagValues(part.flag, part.name);
    }

    const members: Entry[] = [];
    for (const inner of part.nested.parts) {
      members.push([inner.name, yield* flagValues(inner.flag, inner.name)]);
    }

    return fn("Effect.map", fn("Effect.all", obj(members)), path("Serialize.nestedValues"));
  });

const isRepeatedPart = (flag: PlannedFlag): boolean =>
  flag.source._tag === "Body" && flag.source.repeated;

// The names of the parts among `parts` whose flag repeats.
const repeatedNames = (parts: readonly { readonly flag: PlannedFlag; readonly name: string }[]) =>
  arr(parts.filter((part) => isRepeatedPart(part.flag)).map((part) => str(part.name)));

// A nested body's `Serialize.FormPartFlags`: each nested part's flag and the nested parts that
// repeat.
const partFlags = (parts: readonly NestedFormPart[]): Expr =>
  obj([
    ["flags", obj(parts.map((part) => [part.name, str(part.flag.name)] as const))],
    ["repeated", repeatedNames(parts)],
  ]);

// The step that asserts the part values against the body's schema before the request (design
// 4.5, C2), and the domain name it imports; none for a multipart body that declares no schema.
const formAssertion = (
  command: PlannedCommand,
  alternative: MediaAlternative,
  parts: readonly FormPart[],
  context: CommandContext,
) =>
  Effect.gen(function* assertion() {
    const { body } = command.operation;
    const key = alternative.schema?.key;
    if (body === undefined || key === undefined) {
      return { domain: [], steps: [] };
    }

    const schemaName = context.domain.get(key);
    if (schemaName === undefined) {
      return yield* refuse("unresolved-schema", "multipart/form-data");
    }

    // A part nested by name is asserted as its object, its nested parts by their own flags; it
    // is named by its first nested flag when missing (HT:B16).
    const nested = parts.flatMap((part) =>
      part.nested === undefined ? [] : [[part.name, partFlags(part.nested.parts)] as const],
    );
    const options = obj([
      ["flags", obj(parts.map((part) => [part.name, str(part.flag.name)] as const))],
      ...(nested.length === 0 ? [] : ([["nested", obj(nested)]] as const)),
      ["repeated", repeatedNames(parts.filter((part) => part.nested === undefined))],
      ["required", bool(body.required)],
      ["schema", ident(yield* identifier(schemaName))],
    ]);

    return {
      domain: [schemaName],
      steps: [fn("Effect.flatMap", fn("Serialize.assertFormData", options))],
    };
  });

// Whether the operator gave a flag at least once; a repeated flag's value is a list.
const gaveFlag = (flag: PlannedFlag, repeated: boolean) =>
  Effect.map(flagValue(flag.identifier), (value) =>
    repeated ? fn("Option.isSome", fn("Option.fromIterable", value)) : fn("Option.isSome", value),
  );

// One part header's value as a header parameter (ENC-03, HDR-01), serialized by its style or
// content as a header parameter is, and never required on its own: `Input.partOptions` settles
// whether the sent part needs it. An array header's flag repeats, and its list is the value.
const headerValue = (entry: PartHeader, array: boolean) =>
  Effect.gen(function* value() {
    const { flag, header } = entry;
    const raw = yield* flagValue(flag.identifier);
    const { serialization } = header;
    if (serialization.kind === "content") {
      return fn(
        "Serialize.headerContent",
        str(header.name),
        str(serialization.mediaType),
        fn("Option.getOrUndefined", raw),
        obj([["required", bool(false)]]),
      );
    }

    const options = obj([
      ["explode", bool(serialization.explode)],
      ["required", bool(false)],
    ]);

    return fn(
      "Serialize.header",
      str(header.name),
      array ? raw : fn("Option.getOrUndefined", raw),
      options,
    );
  });

interface KeyedPart {
  readonly check: Expr;
  readonly choice: readonly [string, Expr];
}

// A keyed part (ENC-10, ENC-03): `Input.partOptions` refuses an option flag without the part and a
// sent part without a required option, before any request, and `Serialize.chooseParts` moves the
// sent part's values beside its type and header parameters under its key in the builder's form.
const keyedPart = (part: FormPart, context: CommandContext) =>
  Effect.gen(function* keyed() {
    const { contentType, key } = part;
    if (key === undefined) {
      return Option.none<KeyedPart>();
    }

    const options: Expr[] = [];
    let type: Expr;
    if (contentType._tag === "Declared") {
      type = str(contentType.mediaType);
    } else {
      type = yield* flagValue(contentType.flag.identifier);
      options.push(arr([str(contentType.flag.name), fn("Option.isSome", type), bool(true)]));
    }

    const headers: Expr[] = [];
    for (const entry of part.headers) {
      const { header } = entry;
      const array =
        header.serialization.kind === "style" && (yield* isArrayParameter(header, context));
      options.push(
        arr([str(entry.flag.name), yield* gaveFlag(entry.flag, array), bool(header.required)]),
      );
      headers.push(yield* headerValue(entry, array));
    }

    const sent = yield* gaveFlag(part.flag, isRepeatedPart(part.flag));
    const choice = arr([str(part.name), type, ...(headers.length === 0 ? [] : [arr(headers)])]);

    return Option.some<KeyedPart>({
      check: fn("Input.partOptions", str(part.flag.name), sent, arr(options)),
      choice: [key, choice],
    });
  });

// A `multipart/form-data` alternative's body: the part values, asserted against its schema and
// then streamed by the `api/` builder through the runtime writer (design 6.3). There is no
// whole-body flag (D-ENC1 a). A part with a chosen type leaves the values for the builder's form.
const formBody = (
  command: PlannedCommand,
  alternative: MediaAlternative,
  context: CommandContext,
) =>
  Effect.gen(function* form() {
    const parts = formParts(command, alternative, context.defs);
    if (Result.isFailure(parts)) {
      return yield* refuse("unsupported-body", parts.failure);
    }

    const entries: Entry[] = [];
    const checks: Expr[] = [];
    const choices: Entry[] = [];
    for (const part of parts.success) {
      entries.push([part.name, yield* partValues(part)]);

      const keyed = yield* keyedPart(part, context);
      if (Option.isSome(keyed)) {
        checks.push(keyed.value.check);
        choices.push(keyed.value.choice);
      }
    }

    const assertion = yield* formAssertion(command, alternative, parts.success, context);
    const values = fn("Effect.all", obj(entries));
    const [check, ...more] = checks;
    const ordered = [...more, values].map((next) => fn("Effect.andThen", next));
    const split =
      choices.length === 0 ? [] : [fn("Effect.flatMap", fn("Serialize.chooseParts", obj(choices)))];

    return {
      args: [["body", ident(I("parts"))]],
      domain: assertion.domain,
      head: check ?? values,
      parameter: "parts",
      steps: [...(check === undefined ? [] : ordered), ...assertion.steps, ...split],
    } satisfies BodyPlan;
  });

// The media alternatives a body or part option flag applies to; a parameter applies to none.
const sourceMedia = (flag: PlannedFlag): readonly string[] =>
  flag.source._tag === "Parameter" ? [] : flag.source.media;

// A positional `multipart/mixed` alternative's body (design 6.3, HT:B15): each `--part` path opened
// in invocation order, or stdin for `-` under the invocation's one stdin claim, for the `api/`
// builder's `Serialize.mixed`. Part bytes are never parsed or asserted against the schema.
const positionalBody = (
  command: PlannedCommand,
  alternative: MediaAlternative,
  context: CommandContext,
) =>
  Effect.gen(function* positional() {
    const mixed = mixedParts(alternative, context.defs);
    if (Result.isFailure(mixed)) {
      return yield* refuse("unsupported-body", mixed.failure);
    }

    const flag = command.flags.find(
      (candidate) =>
        isPartFlag(candidate) && sourceMedia(candidate).includes(alternative.mediaType),
    );
    if (flag === undefined) {
      return yield* refuse("unsupported-body", `a --part flag for ${alternative.mediaType}`);
    }

    const source = ident(I("source"));

    return fn(
      "Effect.forEach",
      yield* flagValue(flag.identifier),
      arrow([{ name: I("source") }], fn("Multipart.fileBody", str(flag.name), source)),
    );
  });

// The body flags that do not apply to one alternative, each mapped to whether the operator gave
// it (`Input.selectBody`'s `foreign`): a field, part or part option flag whose media does not list
// the key, and `--body` and `--body-file` for a multipart key (D-ENC1 a). A binary or XML key keeps
// its own `--body` refusal.
const foreignFlags = (command: PlannedCommand, alternative: MediaAlternative) =>
  Effect.gen(function* foreign() {
    const entries: Entry[] = [];
    for (const flag of command.flags) {
      const { source } = flag;
      if (source._tag === "Parameter") {
        continue;
      }

      // `--part` applies to its positional key alone, `--body` and `--body-file` to no multipart
      // key, and every other body flag to the keys its media lists.
      const applies =
        isWholeBody(flag) && !isPartFlag(flag)
          ? alternative.codec !== "multipart"
          : source.media.includes(alternative.mediaType);
      if (applies) {
        continue;
      }

      const value = yield* flagValue(flag.identifier);
      const repeated = source._tag === "Body" && source.repeated;
      const given = repeated ? fn("Option.fromIterable", value) : value;
      entries.push([flag.name, fn("Option.isSome", given)]);
    }

    return entries;
  });

// One alternative's unevaluated body effect in the `Input.selectBody` table.
const choiceEntry = (
  command: PlannedCommand,
  alternative: MediaAlternative,
  required: boolean,
  context: CommandContext,
) =>
  Effect.gen(function* entry() {
    if (alternative.codec !== "multipart") {
      return yield* alternativeBody(command, alternative, required, context);
    }

    if (isPositionalBody(alternative)) {
      return { domain: [], value: yield* positionalBody(command, alternative, context) };
    }

    const form = yield* formBody(command, alternative, context);

    return { domain: form.domain, value: pipe(form.head, form.steps ?? []) };
  });

// A lone alternative is built directly. Several, or a range key, go into the `Input.selectBody`
// table with each key's foreign flags; the builder takes the whole choice when it encodes per key
// (`encodesByKey`), else the chosen body and its `Content-Type`.
const bodyPlan = (
  command: PlannedCommand,
  meta: Expr,
  choosesType: boolean,
  context: CommandContext,
): Effect.Effect<Option.Option<BodyPlan>, CliEmitError> =>
  Effect.gen(function* plan() {
    const { body } = command.operation;
    const [first] = body?.alternatives ?? [];
    if (body === undefined || first === undefined) {
      return Option.none();
    }

    if (!choosesType && isPositionalBody(first)) {
      return Option.some({
        args: [["body", ident(I("parts"))]],
        domain: [],
        head: yield* positionalBody(command, first, context),
        parameter: "parts",
      });
    }

    if (!choosesType && first.codec === "multipart") {
      return Option.some(yield* formBody(command, first, context));
    }

    if (!choosesType) {
      const single = yield* alternativeBody(command, first, body.required, context);
      const parameter = isLoaded(first) ? "loaded" : "merged";

      return Option.some({
        args: [["body", ident(I(parameter))]],
        domain: single.domain,
        head: single.value,
        parameter,
      });
    }

    const alternatives: Entry[] = [];
    const domain: string[] = [];
    const foreign: Entry[] = [];
    for (const alternative of body.alternatives) {
      const built = yield* choiceEntry(command, alternative, body.required, context);
      alternatives.push([alternative.mediaType, built.value]);
      domain.push(...built.domain);

      const misplaced = yield* foreignFlags(command, alternative);
      if (misplaced.length > 0) {
        foreign.push([alternative.mediaType, obj(misplaced)]);
      }
    }

    const selected = ident(I("selected"));
    const options: Entry[] = [
      ["alternatives", obj(alternatives)],
      ["chosen", path("flags.contentType")],
      ["media", member(meta, M("media"))],
    ];
    if (foreign.length > 0) {
      options.push(["foreign", obj(foreign)]);
    }

    return Option.some({
      args: encodesByKey(body.alternatives)
        ? [["body", selected]]
        : [
            ["body", member(selected, M("body"))],
            ["contentType", member(selected, M("contentType"))],
          ],
      domain,
      head: fn("Input.selectBody", obj(options)),
      parameter: "selected",
    });
  });

interface CommandParts {
  readonly domain: readonly string[];
  readonly statement: Statement;
}

const bindingOf = (location: string, pointer: string, wireName: string): Expr =>
  obj([
    ["location", str(location)],
    ["pointer", str(pointer)],
    ["wireName", str(wireName)],
  ]);

// What help says of a part option: its choices, or its header's marks and its part flag.
const helpPartOption = (
  command: PlannedCommand,
  source: PartOptionSource,
): HelpPartOption | undefined => {
  const { option } = source;
  if (option.kind === "content-type") {
    return option;
  }

  const header = partHeaderOf(command.operation, source);
  const part = command.flags.find(
    (flag) => flag.source._tag === "Body" && flag.source.wireName === source.part,
  );

  return header === undefined || part === undefined
    ? undefined
    : {
        deprecated: header.deprecated,
        kind: "header",
        name: header.name,
        partFlag: part.name,
        required: header.required,
      };
};

// What help says of `--part`: each position's content type, then every later part's.
const partsHelp = (
  command: PlannedCommand,
  flag: PlannedFlag,
  store: FieldStore,
): HelpFlag["source"] | undefined => {
  const alternative = command.operation.body?.alternatives.find(
    (candidate) => isPositionalBody(candidate) && sourceMedia(flag).includes(candidate.mediaType),
  );
  const mixed: Result.Result<MixedPlan, string> =
    alternative === undefined
      ? Result.fail("no positional body")
      : mixedParts(alternative, store.defs);

  if (Result.isFailure(mixed)) {
    return undefined;
  }

  const { item, prefix } = mixed.success;
  const types = prefix.map((rule) => rule.contentType);

  return item === undefined
    ? { _tag: "Parts", prefix: types }
    : { _tag: "Parts", item: item.contentType, prefix: types };
};

const helpFlags = (command: PlannedCommand, store: FieldStore): readonly HelpFlag[] => {
  const { operation } = command;
  const positionals = command.positionals.flatMap((positional) => {
    const parameter = parameterOf(operation, "path", positional.wireName);

    return parameter === undefined
      ? []
      : [
          {
            name: positional.name,
            source: { _tag: "Parameter", negatable: false, parameter },
          } as const,
        ];
  });
  const parts = command.flags.filter(isPartFlag).flatMap((flag): readonly HelpFlag[] => {
    const plan = partsHelp(command, flag, store);

    return plan === undefined ? [] : [{ name: flag.name, source: plan }];
  });
  const named = command.flags
    .filter((flag) => !isWholeBody(flag))
    .flatMap((flag): readonly HelpFlag[] => {
      const { source } = flag;
      if (source._tag === "Body") {
        const field = bodyField(operation, source, store).schema.notes;

        return [{ name: flag.name, source: { _tag: "Body", field, pointer: source.wireName } }];
      }

      if (source._tag === "PartOption") {
        const option = helpPartOption(command, source);

        return option === undefined
          ? []
          : [{ name: flag.name, source: { _tag: "PartOption", option, part: source.part } }];
      }

      const parameter = parameterOf(operation, source.location, source.wireName);

      return parameter === undefined
        ? []
        : [{ name: flag.name, source: { _tag: "Parameter", negatable: flag.boolean, parameter } }];
    });

  return [...positionals, ...parts, ...named];
};

const record = (entries: Readonly<Record<string, string>>): Expr =>
  obj(Object.entries(entries).map(([key, value]) => [key, str(value)] as const));

const describeParameters = (command: PlannedCommand): Expr =>
  obj([
    ...command.positionals.map(
      (positional) =>
        [positional.name, bindingOf("path", positional.pointer, positional.wireName)] as const,
    ),
    ...command.flags
      .filter((flag) => !isWholeBody(flag))
      .map((flag) => {
        const { source } = flag;
        const location = source._tag === "Parameter" ? source.location : "body";
        const wireName = source._tag === "PartOption" ? source.part : source.wireName;

        return [flag.name, bindingOf(location, source.pointer, wireName)] as const;
      }),
  ]);

const distinct = (values: readonly string[]): readonly string[] => [...new Set(values)];

interface Choices {
  readonly accepts: boolean;
  readonly choosesType: boolean;
}

const choicesOf = (operation: Operation): Choices => {
  const requestTypes = (operation.body?.alternatives ?? []).map((item) => item.mediaType);
  const responseTypes = distinct(
    operation.responses.flatMap((response) =>
      response.alternatives.map((alternative) => alternative.mediaType),
    ),
  );

  return {
    accepts: responseTypes.length > 1,
    choosesType: requestTypes.length > 1 || requestTypes.some(isRange),
  };
};

// The command's config object: arguments, flags, then the negotiation flags it needs.
const configOf = (command: PlannedCommand, choices: Choices, context: CommandContext) =>
  Effect.gen(function* config() {
    const { operation } = command;
    const entries: Entry[] = [];
    for (const [index, positional] of command.positionals.entries()) {
      const last = index === command.positionals.length - 1;
      entries.push(yield* positionalEntry(operation, positional, last, context));
    }

    for (const flag of command.flags) {
      entries.push(yield* flagEntry(flag, operation, context));
    }

    if (choices.choosesType) {
      entries.push(["contentType", path("Negotiate.contentTypeFlag")]);
    }

    if (choices.accepts) {
      entries.push(["accept", path("Negotiate.acceptFlag")]);
    }

    return entries;
  });

// The builder's argument entries for the operation's parameters, keyed by `inputKeys`. An array
// parameter's flag or argument already yields the array, empty when an optional one is absent.
const parameterInputs = (command: PlannedCommand, context: CommandContext) =>
  Effect.gen(function* inputs() {
    const entries: Entry[] = [];
    for (const { key, parameter } of inputKeys(command.operation)) {
      const owner =
        parameter.location === "path"
          ? command.positionals.find((candidate) => candidate.wireName === parameter.wireName)
          : command.flags.find(
              (candidate) =>
                candidate.source._tag === "Parameter" &&
                candidate.source.location === parameter.location &&
                candidate.source.wireName === parameter.wireName,
            );
      if (owner === undefined) {
        return yield* refuse("unplanned-parameter", `${parameter.location}:${parameter.wireName}`);
      }

      const value = yield* flagValue(owner.identifier);
      const passed = parameter.required || (yield* isArrayParameter(parameter, context));
      entries.push([key, passed ? value : fn("Option.getOrUndefined", value)]);
    }

    return entries;
  });

const annotationsOf = (command: PlannedCommand, meta: Expr, context: CommandContext) => {
  const help = operationHelp({
    certificates: context.plan.certificates,
    credentials: context.plan.credentials,
    diagnostics: context.plan.diagnostics,
    flags: helpFlags(command, context),
    operation: command.operation,
    schemes: context.api.securitySchemes,
  });

  return [
    ...(help.description === "" ? [] : [fn("Command.withDescription", str(help.description))]),
    fn(
      "Command.annotate",
      path("Describe.Binding"),
      obj([
        ["operation", meta],
        ["parameters", describeParameters(command)],
      ]),
    ),
    fn(
      "Command.annotate",
      path("Output.Help"),
      obj([
        ["arguments", record(help.arguments)],
        ["flags", record(help.flags)],
        ["sections", arr(help.sections.map(([label, text]) => arr([str(label), str(text)])))],
      ]),
    ),
  ];
};

const commandStatement = (
  command: PlannedCommand,
  context: CommandContext,
): Effect.Effect<CommandParts, CliEmitError> =>
  Effect.gen(function* statement() {
    // The `api/` layer emits no builder for an operation with a parameter it does not build.
    const unbuilt = command.operation.parameters.find((parameter) => !buildsParameter(parameter));
    if (unbuilt !== undefined) {
      return yield* refuse("unsupported-parameter", `${unbuilt.location}:${unbuilt.wireName}`);
    }

    // Every command of an operation, alias or not, calls the primary's builder and meta, so each
    // sends the same bytes and binds the same operation.
    const target = context.targets.get(command.operation);
    if (target === undefined) {
      return yield* refuse("unknown-primary", command.name);
    }

    const namespace = ident(yield* identifier(target.namespace));
    const name = yield* identifier(command.identifier);
    const meta = member(namespace, yield* memberName(`${target.identifier}Meta`));
    const choices = choicesOf(command.operation);
    const config = yield* configOf(command, choices, context);
    const body = yield* bodyPlan(command, meta, choices.choosesType, context);
    const inputs: Entry[] = [
      ...Option.match(body, { onNone: () => [], onSome: (plan) => plan.args }),
      ...(yield* parameterInputs(command, context)),
    ];
    const builder = member(namespace, yield* memberName(target.identifier));
    const built = call(builder, inputs.length === 0 ? [] : [obj(inputs)]);
    const send = fn(
      "Effect.flatMap",
      fn("Output.send", ...(choices.accepts ? [meta, path("flags.accept")] : [meta])),
    );
    const handled = Option.match(body, {
      onNone: () => pipe(built, [send]),
      onSome: (plan) =>
        pipe(plan.head, [
          ...(plan.steps ?? []),
          fn("Effect.flatMap", arrow([{ name: I(plan.parameter) }], built)),
          send,
        ]),
    });
    const handler = arrow(config.length === 0 ? [] : [{ name: I("flags") }], handled);
    const make = fn("Command.make", str(command.name), obj(config), handler);
    // The run's error format is recorded after parsing and before the handler's first fallible
    // step, so an error raised before `send` renders in it (design 7.4 revision 31b).
    const recording = fn(
      "Command.provideEffectDiscard",
      fn("Output.recordRun", str(context.envPrefix)),
    );

    return {
      domain: Option.match(body, { onNone: () => [], onSome: (plan) => plan.domain }),
      statement: {
        _tag: "Const",
        exported: true,
        name,
        value: pipe(make, [recording, ...annotationsOf(command, meta, context)]),
      },
    };
  });

// ---------------------------------------------------------------------------------------------
// Modules.

// Every identifier an expression reads at its head: the namespaces and bindings it needs.
const heads = (expr: Expr, into: Set<string>): Set<string> => {
  switch (expr._tag) {
    case "Identifier": {
      into.add(expr.name);
      break;
    }
    case "Member": {
      heads(expr.object, into);
      break;
    }
    case "Object": {
      for (const [, value] of expr.entries) {
        heads(value, into);
      }

      break;
    }
    case "Array": {
      for (const element of expr.elements) {
        heads(element, into);
      }

      break;
    }
    case "Call":
    case "New": {
      heads(expr.callee, into);
      for (const arg of expr.args) {
        heads(arg, into);
      }

      break;
    }
    case "Arrow": {
      heads(expr.body, into);
      break;
    }
    case "Conditional": {
      heads(expr.test, into);
      heads(expr.consequent, into);
      heads(expr.alternate, into);
      break;
    }
    case "Plus": {
      heads(expr.left, into);
      heads(expr.right, into);
      break;
    }
    case "Boolean":
    case "DynamicImport":
    case "Number":
    case "String":
    case "Undefined": {
      break;
    }
    default: {
      break;
    }
  }

  return into;
};

interface Binding {
  readonly from: string;
  readonly kind: "Named" | "Namespace";
  readonly name: string;
}

const declaredNames = (statements: readonly Statement[]): readonly string[] =>
  statements.flatMap((statement) => (statement._tag === "Expression" ? [] : [statement.name]));

// The imports a module's statements read, from the fixed sources and the module's own bindings.
// Two bindings of one name from different places are refused, never aliased.
const moduleImports = (
  statements: readonly Statement[],
  bindings: readonly Binding[],
): Effect.Effect<readonly Import[], CliEmitError> =>
  Effect.gen(function* imports() {
    const used = new Set<string>();
    for (const statement of statements) {
      if (statement._tag === "Const" || statement._tag === "Expression") {
        heads(statement.value, used);
      }
    }

    const declared = new Set<string>(declaredNames(statements));
    const all: Binding[] = [
      ...packageImports.map(([name, from]) => ({ from, kind: "Named" as const, name })),
      ...runtimeNamespaces.map(([name, from]) => ({ from, kind: "Namespace" as const, name })),
      ...bindings,
    ];
    const chosen = new Map<string, Binding>();
    for (const binding of all.filter((candidate) => used.has(candidate.name))) {
      const known = chosen.get(binding.name);
      if (known !== undefined && (known.from !== binding.from || known.kind !== binding.kind)) {
        return yield* refuse("name-clash", binding.name);
      }

      if (declared.has(binding.name)) {
        return yield* refuse("name-clash", binding.name);
      }

      chosen.set(binding.name, binding);
    }

    const result: Import[] = [];
    for (const binding of chosen.values()) {
      const name = yield* identifier(binding.name);
      const from = yield* specifier(binding.from, "unprintable-name");
      result.push(
        binding.kind === "Named"
          ? { _tag: "Named", from, names: [name], typeOnly: false }
          : { _tag: "Namespace", from, name, typeOnly: false },
      );
    }

    return result;
  });

const domainBindings = (names: readonly string[]): readonly Binding[] =>
  names.map((name) => ({ from: "../domain/schemas.ts", kind: "Named", name }));

const cliAlias = (group: PlannedGroup): string => `${group.namespace}Cli`;

const checkDistinct = (names: readonly string[]) => {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      return Effect.fail(refuse("name-clash", name));
    }

    seen.add(name);
  }

  return Effect.void;
};

interface Commands {
  readonly domain: readonly string[];
  readonly emitted: readonly PlannedCommand[];
  readonly refusals: readonly CliRefusal[];
  readonly statements: readonly Statement[];
}

// The commands a module emits; an operation-scope refusal drops its command and is recorded.
const commandsOf = (
  commands: readonly PlannedCommand[],
  context: CommandContext,
): Effect.Effect<Commands, CliEmitError> =>
  Effect.gen(function* emit() {
    const parts: CommandParts[] = [];
    const emitted: PlannedCommand[] = [];
    const refusals: CliRefusal[] = [];
    for (const command of commands) {
      const built = yield* Effect.result(commandStatement(command, context));
      if (Result.isSuccess(built)) {
        parts.push(built.success);
        emitted.push(command);
        continue;
      }

      const { reason, subject } = built.failure;
      if (!isOperationReason(reason)) {
        return yield* built.failure;
      }

      refusals.push({ operation: command.operation.key, reason, scope: "operation", subject });
    }

    return {
      domain: Arr.dedupe(parts.flatMap((part) => part.domain)),
      emitted,
      refusals,
      statements: parts.map((part) => part.statement),
    };
  });

interface ApiModule {
  readonly commands: readonly PlannedCommand[];
  readonly from: string;
  readonly namespace: string;
}

// Every api module under the namespace the names plan gave it, unique across the modules.
const apiModules = (plan: NamePlan): readonly ApiModule[] => [
  ...plan.groups.map((group) => ({
    commands: group.commands,
    from: `../api/${group.segment}.ts`,
    namespace: String(group.namespace),
  })),
  { commands: plan.root, from: "../api/root.ts", namespace: rootNamespace },
];

const targetsOf = (plan: NamePlan): ReadonlyMap<Operation, Target> =>
  new Map(
    apiModules(plan).flatMap(({ commands, from, namespace }) =>
      commands
        .filter((command) => command.alias === undefined)
        .map((command) => [command.operation, { from, identifier: command.identifier, namespace }]),
    ),
  );

// The api namespaces a cli module may read, one per api module under its planned name; only the
// ones its commands use are imported.
const apiBindings = (plan: NamePlan): readonly Binding[] =>
  apiModules(plan).map(({ from, namespace }) => ({ from, kind: "Namespace", name: namespace }));

// The header fields a group module's `Command.make` sets, which its root table entry carries
// (`runtime/groups.ts` `Header`): today the name only.
interface GroupHeader {
  readonly name: string;
}

const headerOf = (group: PlannedGroup): GroupHeader => ({ name: group.name });

const groupFile = (
  group: PlannedGroup,
  built: Commands,
  children: readonly PlannedGroup[],
  api: readonly Binding[],
) =>
  Effect.gen(function* file() {
    const { domain, emitted, statements } = built;
    const subcommands = [
      ...emitted.map((command) => ident(I(command.identifier))),
      ...children.map((child) => member(ident(I(cliAlias(child))), M("group"))),
    ];
    const all: Statement[] = [
      ...statements,
      {
        _tag: "Const",
        exported: true,
        name: I("group"),
        value: pipe(fn("Command.make", str(headerOf(group).name)), [
          fn("Command.withSubcommands", arr(subcommands)),
        ]),
      },
    ];
    yield* checkDistinct(declaredNames(all));

    const imports = yield* moduleImports(all, [
      ...api,
      ...domainBindings(domain),
      ...children.map((child) => ({
        from: `./${child.segment}.ts`,
        kind: "Namespace" as const,
        name: cliAlias(child),
      })),
    ]);
    const content = yield* printModule({ imports, statements: all });

    return { content, path: `src/cli/${group.segment}.ts` };
  });

// `commands.module` is relative to the package root and must stay inside it: `./` then plain
// segments, no `..`, `.` or empty segment, no absolute path.
const commandsModule = (module: string) =>
  Effect.gen(function* resolveModule() {
    const segments = module.split("/");
    const [lead, ...rest] = segments;
    if (
      lead !== "." ||
      rest.length === 0 ||
      rest.some((part) => part === "" || part === "." || part === "..")
    ) {
      return yield* refuse("unsafe-commands-module", module);
    }

    return yield* specifier(`../../${rest.join("/")}`, "unsafe-commands-module");
  });

const authorCommands = (config: AuthorConfig) =>
  Effect.gen(function* commands() {
    const declared = config.commands;
    if (declared === undefined) {
      return { bindings: [], names: [] };
    }

    const from = yield* commandsModule(declared.module);
    const names: string[] = [];
    for (const name of declared.names) {
      const folded = foldIdentifier(name, "camel");
      if (Result.isFailure(folded)) {
        return yield* refuse("unprintable-name", name);
      }

      names.push(yield* identifier(folded.success.name));
    }

    return {
      bindings: names.map((name) => ({ from, kind: "Named" as const, name })),
      names,
    };
  });

const globalSettings: readonly string[] = [
  "BaseUrl.baseUrlSetting",
  "BaseUrl.serverSetting",
  "BaseUrl.serverVariableSetting",
  "Auth.allowCredentialsForBaseUrl",
  "Output.OutputPath",
  "Output.Force",
  "Output.MaxErrorBytes",
  "Describe.describeFlag",
  "Client.timeoutSetting",
  "Client.retriesSetting",
  "Client.retryUnsafeSetting",
  "Client.verboseSetting",
  "Output.Raw",
  "Output.MaxRecordBytes",
  "Output.errorFormatSetting",
  "Output.dryRunSetting",
];

// One table row per top-level group: its header and a thunk importing its module by a literal
// specifier, so the module loads only when `Groups.root` selects it (design 4.1 Lazy root).
const tableEntry = (group: PlannedGroup) =>
  specifier(`./${group.segment}.ts`, "unprintable-name").pipe(
    Effect.map((from) =>
      obj([
        ["load", arrow([], dynamicImport(from))],
        ["name", str(headerOf(group).name)],
      ]),
    ),
  );

const rootFile = (
  topLevel: readonly PlannedGroup[],
  built: Commands,
  plan: NamePlan,
  config: AuthorConfig,
  api: readonly Binding[],
) =>
  Effect.gen(function* file() {
    const { domain, emitted, statements } = built;
    const author = yield* authorCommands(config);
    const prefix = str(envPrefixOf(config));
    const others = [
      ...emitted.map((command) => ident(I(command.identifier))),
      ...author.names.map((name) => ident(I(name))),
    ];
    const settings = [
      ...globalSettings.map((setting) => path(setting)),
      ...plan.credentials.map((credential) =>
        fn("Auth.credentialFileSetting", str(credential.scheme)),
      ),
    ];
    // The loaded groups come first, then the untagged and author commands, as the eager order was.
    const subcommands =
      others.length === 0 ? path("groups") : fn("Arr.appendAll", path("groups"), arr(others));
    const header = (children: Expr) =>
      pipe(fn("Command.make", str(config.binName)), [
        fn("Command.withSubcommands", children),
        fn("Command.withGlobalFlags", arr(settings)),
      ]);
    const entries = yield* Effect.all(topLevel.map(tableEntry));
    // With no top-level group there is nothing to load, and an empty table would infer `unknown`
    // requirements, so the root is the header over the other commands.
    const lazy: Statement[] =
      topLevel.length === 0
        ? [
            {
              _tag: "Const",
              exported: true,
              name: I("root"),
              value: arrow([], fn("Effect.succeed", header(arr(others)))),
            },
          ]
        : [
            { _tag: "Const", exported: true, name: I("table"), value: arr(entries) },
            {
              _tag: "Const",
              exported: true,
              name: I("root"),
              value: arrow(
                [{ name: I("args"), type: typeReadonlyArray(typeKeyword("string")) }],
                fn(
                  "Groups.root",
                  path("table"),
                  arrow([{ name: I("groups") }], header(subcommands)),
                  path("args"),
                ),
              ),
            },
          ];
    const all: Statement[] = [
      ...statements,
      ...lazy,
      {
        _tag: "Const",
        exported: true,
        name: I("services"),
        value: fn(
          "Layer.mergeAll",
          fn("BaseUrl.layer", path("servers"), prefix),
          fn("Auth.layer", path("security"), prefix),
          fn("Auth.redactedNames", path("security")),
          path("Input.stdinClaimLayer"),
        ),
      },
    ];
    // `args` and `groups` are the root's parameters: a command of either name would be shadowed.
    yield* checkDistinct([...declaredNames(all), ...author.names, "args", "groups"]);

    const imports = yield* moduleImports(all, [
      ...api,
      { from: "../api/security.ts", kind: "Named", name: "security" },
      { from: "../api/servers.ts", kind: "Named", name: "servers" },
      ...rootNamespaceImports.map(([name, from]) => ({ from, kind: "Namespace" as const, name })),
      ...domainBindings(domain),
      ...author.bindings,
    ]);
    const content = yield* printModule({ imports, statements: all });

    return { content, path: "src/cli/root.ts" };
  });

const decodeDefs = Schema.decodeUnknownOption(
  Schema.Struct({ $defs: Schema.Record(Schema.String, Schema.Json) }),
);

const byPath = Order.mapInput(Order.String, (file: EmittedFile) => file.path);

// The code normalize's validation copy records when it removes a 3.0 `default` (S30-27).
const refusedDefaultCode = "S30-27/nonconforming-default";

const isJsonArray = (json: Schema.Json | undefined): json is readonly Schema.Json[] =>
  Arr.isArray(json);

// The member of an object, or the element of an array, that one path token names.
const childAt = (json: Schema.Json | undefined, token: string): Schema.Json | undefined => {
  if (isJsonObject(json)) {
    return own(json, token);
  }

  return isJsonArray(json) ? json[Number(token)] : undefined;
};

/**
 * The stored nodes whose `default` normalize refused (S30-27, D-OC3: a refused default is not
 * shown): the validation copy's edits under that code, located in `defs`, so help reads the one
 * fact normalize records rather than re-checking conformance. Only the 3.0 line records one.
 */
const refusedDefaultsOf = (edits: readonly SchemaEdit[], defs: Defs): ReadonlySet<Schema.Json> => {
  const nodes = new Set<Schema.Json>();
  for (const edit of edits) {
    if (edit.code !== refusedDefaultCode) {
      continue;
    }

    let node: Schema.Json | undefined = own(defs, edit.key);
    for (const token of edit.path.slice(0, -1)) {
      node = childAt(node, token);
    }

    if (node !== undefined) {
      nodes.add(node);
    }
  }

  return nodes;
};

/**
 * Emits the V1 `cli/` layer (design 4.1, 4.4, 4.6, 4.8, 5, 6.6, 8.3; §14 D4, D5): `cli/<group>.ts`
 * per planned group with one `Command.make` per planned command (inline `Flag` and `Argument`
 * constructors, three-state booleans, a handler that builds the body, calls the operation's one
 * `api/` builder, in its primary command's module, with `inputKeys` and runs `Output.send`), its
 * describe binding and help notes, and `group`, so an alias is a full command for its operation;
 * and `cli/root.ts` with the untagged commands, the header table that loads each top-level group
 * by a literal `import()`, `root` building the root command and its global settings through
 * `Groups.root` from the arguments, the author-owned commands, and `services`. Files are sorted by
 * path. An operation the layer cannot
 * express is refused alone (`CliRefusal`), and a group left with no command and no emitted child
 * group is not emitted.
 */
export const emitCli = (
  input: CliEmitInput,
): Effect.Effect<CliEmitOutput, CliEmitError | PrinterError> =>
  Effect.gen(function* emit() {
    const { api, config, plan } = input;
    const reserved = plan.groups.find((group) => reservedSegments.has(group.segment));
    if (reserved !== undefined) {
      return yield* refuse("reserved-segment", reserved.segment);
    }

    const tags = new Set(plan.groups.map((group) => group.tag));
    const orphan = plan.groups.find(
      (group) => group.parent !== undefined && !tags.has(group.parent),
    );
    if (orphan !== undefined) {
      return yield* refuse("unknown-parent", orphan.tag);
    }

    const targets = targetsOf(plan);
    const defs = Option.match(decodeDefs(api.schemas.document), {
      onNone: (): Defs => ({}),
      onSome: (store) => store.$defs,
    });
    const context: CommandContext = {
      api,
      booleans: new Map(),
      defs,
      domain: plan.domain,
      envPrefix: envPrefixOf(config),
      line: api.line,
      plan,
      refusedDefaults: refusedDefaultsOf(input.validationEdits, defs),
      targets,
    };
    const built = new Map<string, Commands>();
    for (const group of plan.groups) {
      built.set(group.tag, yield* commandsOf(group.commands, context));
    }

    const rootCommands = yield* commandsOf(plan.root, context);
    // A group is emitted when it keeps a command or has an emitted child group.
    const emitted = new Set<string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const group of plan.groups) {
        const hasChild = plan.groups.some(
          (child) => child.parent === group.tag && emitted.has(child.tag),
        );
        const kept = built.get(group.tag)?.emitted.length ?? 0;
        if (!emitted.has(group.tag) && (kept > 0 || hasChild)) {
          emitted.add(group.tag);
          grew = true;
        }
      }
    }

    const empty: Commands = { domain: [], emitted: [], refusals: [], statements: [] };
    const commandsFor = (group: PlannedGroup): Commands => built.get(group.tag) ?? empty;
    const groups = plan.groups.filter((group) => emitted.has(group.tag));
    const childrenOf = (group: PlannedGroup) =>
      groups.filter((child) => child.parent === group.tag);
    const files: EmittedFile[] = [
      ...(yield* Effect.all(
        groups.map((group) =>
          groupFile(group, commandsFor(group), childrenOf(group), apiBindings(plan)),
        ),
      )),
    ];
    files.push(
      yield* rootFile(
        groups.filter((group) => group.parent === undefined),
        rootCommands,
        plan,
        config,
        apiBindings(plan),
      ),
    );

    return {
      files: Arr.sort(files, byPath),
      refusals: [
        ...plan.groups.flatMap((group) => commandsFor(group).refusals),
        ...rootCommands.refusals,
      ],
    };
  });
