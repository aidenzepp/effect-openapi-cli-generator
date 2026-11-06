import { Array as Arr, Data, Effect, Option, Order, Predicate, Result, Schema } from "effect";
import type { AuthorConfig } from "../model/author-config.ts";
import type { Api, MediaAlternative, Operation, Parameter } from "../model/entities.ts";
import { runtimeNamespaces } from "../names/domain.ts";
import { foldIdentifier } from "../names/fold.ts";
import type {
  NamePlan,
  PlannedCommand,
  PlannedFlag,
  PlannedGroup,
  PlannedPositional,
} from "../names/index.ts";
import type { FieldEncoding } from "../runtime-src/runtime/input.ts";
import { envPrefixOf, isBooleanSchema } from "../names/plan.ts";
import { formParts, inputKeys, isScalarArraySchema } from "./api.ts";
import type { FormPart } from "./api.ts";
import { operationHelp, sanitizeProse } from "./help.ts";
import type { HelpFlag } from "./help.ts";
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
  newExpr,
  num,
  obj,
  printModule,
  str,
} from "./printer.ts";
import type { Expr, Import, PrinterError, Statement } from "./printer.ts";

/**
 * What the `cli/` layer is emitted from: the normalized `Api`, its name plan, and the author config
 * (bin name, environment prefix and the author-owned commands module).
 */
export interface CliEmitInput {
  readonly api: Api;
  readonly config: AuthorConfig;
  readonly plan: NamePlan;
}

/**
 * The plan, model or author config holds something the `cli/` layer cannot express. Text and form
 * request bodies are `unsupported-body` until their merge exists, and so is a multipart body the
 * runtime writer cannot send exactly (`formParts` names why); an XML body is opaque `--body-file`
 * bytes, like a binary one (design 6.3). `unsupported-flag` is a flag
 * with no call-expression form today: an integer field whose width the walk cannot settle, and a
 * required boolean parameter (absent would send `false`). `unsupported-parameter` is a boolean path
 * parameter, or a path array before another positional (a repeated argument would take the later
 * ones). Those three refuse one operation (`CliRefusal`); every other reason fails `emitCli`.
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
  flag.source._tag === "Body" && (flag.source.kind === "body" || flag.source.kind === "body-file");

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
  readonly format: string | undefined;
  readonly int64: boolean;
  readonly items: Schema.Json | undefined;
  readonly prose: string | undefined;
  readonly properties: JsonObject | undefined;
  readonly ref: string | undefined;
}

// `None` for a node the walk cannot read: not an object, or a `$ref` that is not a string.
const fieldNode = (json: Schema.Json): Option.Option<FieldNode> => {
  if (!isJsonObject(json)) {
    return Option.none();
  }

  const ref = own(json, "$ref");
  if (ref !== undefined && !Predicate.isString(ref)) {
    return Option.none();
  }

  const allOf = own(json, "allOf");
  const properties = own(json, "properties");
  const prose = [own(json, "description"), own(json, "title")].find(Predicate.isString);
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
    format: text("format"),
    int64: own(json, "format") === "int64" || unsafe,
    items: own(json, "items"),
    properties: isJsonObject(properties) ? properties : undefined,
    prose,
    ref,
  });
};

/**
 * Whether an integer field flag fits `Flag.Int`: `int64` when a node on its scalar's `$ref`
 * chain (an array's `items` for a repeated flag) is `int64` or has an unsafe bound, `unsettled`
 * when the walk cannot reach that scalar (an unreadable node, a cycle, an exhausted budget).
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
  readonly mediaType: string | undefined;
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

// The text encoding of a base64 string node: `contentEncoding` wins over 3.0 `format: byte`.
const encodingOf = (node: FieldNode): FieldEncoding | undefined => {
  if (node.contentEncoding === "base64" || node.contentEncoding === "base64url") {
    return node.contentEncoding;
  }

  return node.contentEncoding === undefined && node.format === "byte" ? "base64" : undefined;
};

const fieldSchema = (
  defs: Defs,
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

      const node = fieldNode(current);
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
  const encoding = last === undefined ? undefined : encodingOf(last);

  return {
    description: described?.prose ?? "",
    encoding,
    integer: width(),
    mediaType: last?.contentMediaType,
  };
};

// ---------------------------------------------------------------------------------------------
// One command.

// Where an operation's builder and meta live: its primary command's `api/` module (design 4.4).
interface Target {
  readonly from: string;
  readonly identifier: string;
  readonly namespace: string;
}

interface CommandContext {
  readonly api: Api;
  readonly booleans: Map<string, boolean>;
  readonly defs: Defs;
  readonly domain: NamePlan["domain"];
  readonly plan: NamePlan;
  readonly targets: ReadonlyMap<Operation, Target>;
}

const parameterOf = (operation: Operation, location: string, wireName: string) =>
  operation.parameters.find(
    (parameter) => parameter.location === location && parameter.wireName === wireName,
  );

// Whether a parameter is an array of scalar items, given once per item (design 6.1).
const isArrayParameter = (parameter: Parameter, context: CommandContext) =>
  Effect.gen(function* scalarArray() {
    const array = isScalarArraySchema(context.defs, parameter.schema.key);
    if (Result.isFailure(array)) {
      return yield* refuse("unresolved-schema", array.failure);
    }

    return array.success;
  });

const parameterDescription = (parameter: Parameter): string =>
  parameter.docs.description ?? parameter.docs.summary ?? "";

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

    const described = describedBy(parameterDescription(parameter));
    const value = pipe(fn("Argument.String", str(positional.name)), [
      ...(array ? [fn("Argument.atLeast", num(1))] : []),
      ...(described.length === 0 ? [] : [fn("Argument.withDescription", ...described)]),
    ]);

    return [positional.identifier, value] as const;
  });

const flagConstructor = (flag: PlannedFlag, kind: string): Expr => {
  if (flag.boolean || kind === "boolean") {
    return fn("Flag.Boolean", str(flag.name));
  }

  if (kind === "integer") {
    return fn("Flag.Int", str(flag.name));
  }

  return fn("Flag.Finite", str(flag.name));
};

const bodyFlagHead = (flag: PlannedFlag, kind: string, integer: IntegerWidth): Expr => {
  if (kind === "json") {
    return fn("Input.jsonFlag", str(flag.name));
  }

  if (kind === "integer" && integer === "int64") {
    return fn("Input.int64Flag", str(flag.name));
  }

  // A multipart `file` part flag carries a path, or `-` for stdin.
  return kind === "string" || kind === "file"
    ? fn("Flag.String", str(flag.name))
    : flagConstructor(flag, kind);
};

// A JSON body property the runtime reads from a file and encodes (design 6.3 Binary): its flag is
// a `file` flag inside a JSON alternative, where a multipart part flag of the same kind is a part.
const isEncodedField = (flag: PlannedFlag, alternative: MediaAlternative | undefined): boolean =>
  alternative?.codec === "json" &&
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

// A field flag's help text; an encoded field the walk cannot settle an encoding for is refused.
const fieldDescription = (
  flag: PlannedFlag,
  alternative: MediaAlternative | undefined,
  schema: FieldSchema,
) =>
  Effect.gen(function* described() {
    if (!isEncodedField(flag, alternative)) {
      return schema.description;
    }

    if (schema.encoding === undefined) {
      return yield* refuse("unsupported-flag", flag.name);
    }

    return fileDescription(schema);
  });

const flagEntry = (flag: PlannedFlag, operation: Operation, context: CommandContext) =>
  Effect.gen(function* entry() {
    const { source } = flag;
    if (source._tag === "Body" && source.kind === "body") {
      return [flag.identifier, path("Input.bodyFlag")] as const;
    }

    if (source._tag === "Body" && source.kind === "body-file") {
      return [flag.identifier, path("Input.bodyFileFlag")] as const;
    }

    if (source._tag === "Parameter") {
      const parameter = parameterOf(operation, source.location, source.wireName);
      if (parameter === undefined) {
        return yield* refuse("unplanned-parameter", `${source.location}:${source.wireName}`);
      }

      if (parameter.required && flag.boolean) {
        return yield* refuse("unsupported-flag", flag.name);
      }

      const array = yield* isArrayParameter(parameter, context);
      const head = flag.boolean
        ? fn("Flag.Boolean", str(flag.name))
        : fn("Flag.String", str(flag.name));
      const presence = parameter.required ? [] : [path("Flag.optional")];
      const steps = [
        ...(array ? [fn("Flag.atLeast", num(parameter.required ? 1 : 0))] : presence),
        ...describedBy(parameterDescription(parameter)).map((text) =>
          fn("Flag.withDescription", text),
        ),
      ];

      return [flag.identifier, pipe(head, steps)] as const;
    }

    const alternative = operation.body?.alternatives.find((candidate) =>
      source.media.includes(candidate.mediaType),
    );
    const schema: FieldSchema =
      alternative?.schema === undefined
        ? { description: "", encoding: undefined, integer: "unsettled", mediaType: undefined }
        : fieldSchema(context.defs, alternative.schema.key, source.wireName, source.repeated);
    if (source.kind === "integer" && schema.integer === "unsettled") {
      return yield* refuse("unsupported-flag", flag.name);
    }

    const description = yield* fieldDescription(flag, alternative, schema);
    const head = bodyFlagHead(flag, source.kind, schema.integer);
    const steps = [
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
      return {
        domain: [],
        value: fn("Input.binaryBody", obj([...sources, ["required", bool(required)]])),
      };
    }

    if (alternative.codec !== "json") {
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
      if (!isEncodedField(flag, alternative)) {
        fields.push([source.wireName, value]);
        continue;
      }

      const { encoding } = fieldSchema(context.defs, schemaKey, source.wireName, false);
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
        "Input.mergeBody",
        obj([
          ...sources,
          ["fields", obj(fields)],
          ["required", bool(required)],
          ["schema", ident(yield* identifier(schemaName))],
        ]),
      ),
    };
  });

// A part's values as `Serialize.FormFields` takes them: a list, empty when the flag is absent. A
// file part opens each path, or stdin for `-` under the invocation's one stdin claim.
const partValues = (part: FormPart) =>
  Effect.gen(function* values() {
    const { flag } = part;
    const repeated = flag.source._tag === "Body" && flag.source.repeated;
    const value = yield* flagValue(flag.identifier);
    const list = repeated ? value : fn("Option.toArray", value);
    if (flag.source._tag !== "Body" || flag.source.kind !== "file") {
      return fn("Effect.succeed", list);
    }

    const source = ident(I("source"));
    const file = obj([
      ["filename", fn("Multipart.partFilename", source, str(part.name))],
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

// The step that asserts the part values against the body's schema before the request (design
// 4.5, C2), and the domain name it imports; none for a multipart body that declares no schema.
const formAssertion = (
  command: PlannedCommand,
  parts: readonly FormPart[],
  context: CommandContext,
) =>
  Effect.gen(function* assertion() {
    const { body } = command.operation;
    const key = body?.alternatives.find((alternative) => alternative.codec === "multipart")?.schema
      ?.key;
    if (body === undefined || key === undefined) {
      return { domain: [], steps: [] };
    }

    const schemaName = context.domain.get(key);
    if (schemaName === undefined) {
      return yield* refuse("unresolved-schema", "multipart/form-data");
    }

    const repeated = parts.filter(
      (part) => part.flag.source._tag === "Body" && part.flag.source.repeated,
    );
    const options = obj([
      ["flags", obj(parts.map((part) => [part.name, str(part.flag.name)] as const))],
      ["repeated", arr(repeated.map((part) => str(part.name)))],
      ["required", bool(body.required)],
      ["schema", ident(yield* identifier(schemaName))],
    ]);

    return {
      domain: [schemaName],
      steps: [fn("Effect.flatMap", fn("Serialize.assertFormData", options))],
    };
  });

// A `multipart/form-data` body: the part values, asserted against the body's schema and then
// streamed by the `api/` builder through the runtime writer (design 6.3). There is no whole-body
// flag (D-ENC1 a).
const formBody = (command: PlannedCommand, context: CommandContext) =>
  Effect.gen(function* form() {
    const parts = formParts(command, context.defs);
    if (Result.isFailure(parts)) {
      return yield* refuse("unsupported-body", parts.failure);
    }

    const entries: Entry[] = [];
    for (const part of parts.success) {
      entries.push([part.name, yield* partValues(part)]);
    }

    const assertion = yield* formAssertion(command, parts.success, context);

    return {
      args: [["body", ident(I("parts"))]],
      domain: assertion.domain,
      head: fn("Effect.all", obj(entries)),
      parameter: "parts",
      steps: assertion.steps,
    } satisfies BodyPlan;
  });

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

    if (body.alternatives.some((alternative) => alternative.codec === "multipart")) {
      return Option.some(yield* formBody(command, context));
    }

    if (!choosesType) {
      const single = yield* alternativeBody(command, first, body.required, context);
      const parameter = isOpaque(first) ? "loaded" : "merged";

      return Option.some({
        args: [["body", ident(I(parameter))]],
        domain: single.domain,
        head: single.value,
        parameter,
      });
    }

    const alternatives: Entry[] = [];
    const domain: string[] = [];
    for (const alternative of body.alternatives) {
      const built = yield* alternativeBody(command, alternative, body.required, context);
      alternatives.push([alternative.mediaType, built.value]);
      domain.push(...built.domain);
    }

    const selected = ident(I("selected"));

    return Option.some({
      args: [
        ["body", member(selected, M("body"))],
        ["contentType", member(selected, M("contentType"))],
      ],
      domain,
      head: fn(
        "Input.selectBody",
        obj([
          ["alternatives", obj(alternatives)],
          ["chosen", path("flags.contentType")],
          ["media", member(meta, M("media"))],
        ]),
      ),
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

const helpFlags = (command: PlannedCommand): readonly HelpFlag[] => {
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
  const named = command.flags
    .filter((flag) => !isWholeBody(flag))
    .flatMap((flag): readonly HelpFlag[] => {
      const { source } = flag;
      if (source._tag === "Body") {
        return [{ name: flag.name, source: { _tag: "Body", pointer: source.wireName } }];
      }

      const parameter = parameterOf(operation, source.location, source.wireName);

      return parameter === undefined
        ? []
        : [{ name: flag.name, source: { _tag: "Parameter", negatable: flag.boolean, parameter } }];
    });

  return [...positionals, ...named];
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
        const location = source._tag === "Body" ? "body" : source.location;

        return [flag.name, bindingOf(location, source.pointer, source.wireName)] as const;
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
    credentials: context.plan.credentials,
    diagnostics: context.plan.diagnostics,
    flags: helpFlags(command),
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

    return {
      domain: Option.match(body, { onNone: () => [], onSome: (plan) => plan.domain }),
      statement: {
        _tag: "Const",
        exported: true,
        name,
        value: pipe(make, annotationsOf(command, meta, context)),
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

const packageImports: readonly (readonly [string, string])[] = [
  ["Effect", "effect"],
  ["Layer", "effect"],
  ["Option", "effect"],
  ["Schema", "effect"],
  ["Argument", "effect/cli"],
  ["Command", "effect/cli"],
  ["Flag", "effect/cli"],
];

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

const targetsOf = (plan: NamePlan): ReadonlyMap<Operation, Target> => {
  const modules = [
    ...plan.groups.map((group) => ({
      commands: group.commands,
      from: `../api/${group.segment}.ts`,
      namespace: String(group.namespace),
    })),
    { commands: plan.root, from: "../api/root.ts", namespace: "Root" },
  ];

  return new Map(
    modules.flatMap(({ commands, from, namespace }) =>
      commands
        .filter((command) => command.alias === undefined)
        .map((command) => [command.operation, { from, identifier: command.identifier, namespace }]),
    ),
  );
};

// The api namespaces a cli module may read; only the ones its commands use are imported.
const apiBindings = (targets: ReadonlyMap<Operation, Target>): readonly Binding[] =>
  [...new Map([...targets.values()].map((target) => [target.from, target])).values()].map(
    ({ from, namespace }) => ({ from, kind: "Namespace", name: namespace }),
  );

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
        value: pipe(fn("Command.make", str(group.name)), [
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
];

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
    const subcommands = [
      ...topLevel.map((group) => member(ident(I(cliAlias(group))), M("group"))),
      ...emitted.map((command) => ident(I(command.identifier))),
      ...author.names.map((name) => ident(I(name))),
    ];
    const settings = [
      ...globalSettings.map((setting) => path(setting)),
      ...plan.credentials.map((credential) =>
        fn("Auth.credentialFileSetting", str(credential.scheme)),
      ),
    ];
    const all: Statement[] = [
      ...statements,
      {
        _tag: "Const",
        exported: true,
        name: I("root"),
        value: pipe(fn("Command.make", str(config.binName)), [
          fn("Command.withSubcommands", arr(subcommands)),
          fn("Command.withGlobalFlags", arr(settings)),
        ]),
      },
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
    yield* checkDistinct([...declaredNames(all), ...author.names]);

    const imports = yield* moduleImports(all, [
      ...api,
      { from: "../api/security.ts", kind: "Named", name: "security" },
      { from: "../api/servers.ts", kind: "Named", name: "servers" },
      ...domainBindings(domain),
      ...topLevel.map((group) => ({
        from: `./${group.segment}.ts`,
        kind: "Namespace" as const,
        name: cliAlias(group),
      })),
      ...author.bindings,
    ]);
    const content = yield* printModule({ imports, statements: all });

    return { content, path: "src/cli/root.ts" };
  });

const decodeDefs = Schema.decodeUnknownOption(
  Schema.Struct({ $defs: Schema.Record(Schema.String, Schema.Json) }),
);

const byPath = Order.mapInput(Order.String, (file: EmittedFile) => file.path);

/**
 * Emits the V1 `cli/` layer (design 4.1, 4.4, 4.6, 4.8, 5, 6.6, 8.3; §14 D4, D5): `cli/<group>.ts`
 * per planned group with one `Command.make` per planned command (inline `Flag` and `Argument`
 * constructors, three-state booleans, a handler that builds the body, calls the operation's one
 * `api/` builder, in its primary command's module, with `inputKeys` and runs `Output.send`), its
 * describe binding and help notes, and `group`, so an alias is a full command for its operation;
 * and `cli/root.ts` with the untagged commands, the root command and its global settings, the
 * author-owned commands, and `services`. Files are sorted by path. An operation the layer cannot
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
    const context: CommandContext = {
      api,
      booleans: new Map(),
      defs: Option.match(decodeDefs(api.schemas.document), {
        onNone: () => ({}),
        onSome: (store) => store.$defs,
      }),
      domain: plan.domain,
      plan,
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
          groupFile(group, commandsFor(group), childrenOf(group), apiBindings(targets)),
        ),
      )),
    ];
    files.push(
      yield* rootFile(
        groups.filter((group) => group.parent === undefined),
        rootCommands,
        plan,
        config,
        apiBindings(targets),
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
