import { Array as Arr, Data, Effect, Option, Order, Predicate, Result, Schema } from "effect";
import type {
  Api,
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
import type { Expr, Field, Import, PrinterError, Statement, TypeExpr } from "./printer.ts";

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

/**
 * Whether a stored parameter schema is `type: "array"` whose `items` is a scalar type (design 6.1):
 * the operator gives such a parameter once per item. An array without `items`, or of objects or
 * arrays, is not one. The failure is the store key that does not resolve.
 */
export const isScalarArraySchema = (defs: Defs, key: string): Result.Result<boolean, string> =>
  Result.flatMap(settle(defs, own(defs, key), key), (node) => {
    const items = own(node, "items");
    if (own(node, "type") !== "array" || items === undefined) {
      return Result.succeed(false);
    }

    return Result.map(settle(defs, items, key), (item) => {
      const type = own(item, "type");

      return Predicate.isString(type) && scalarTypes.has(type);
    });
  });

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

interface ParameterParts {
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

const parameterParts = (
  entry: InputKey,
  defs: Defs,
  memo: Map<string, boolean>,
): Effect.Effect<ParameterParts, ApiEmitError> =>
  Effect.gen(function* parts() {
    const { key, parameter } = entry;
    const { serialization } = parameter;
    const subject = `${parameter.location}:${parameter.wireName}`;
    if (serialization.kind !== "style") {
      return yield* refuse("unsupported-parameter", subject);
    }

    const boolean = isBooleanSchema(defs, memo, parameter.schema.key);
    if (Result.isFailure(boolean)) {
      return yield* refuse("unresolved-schema", boolean.failure.key);
    }

    const array = isScalarArraySchema(defs, parameter.schema.key);
    if (Result.isFailure(array)) {
      return yield* refuse("unresolved-schema", array.failure);
    }

    const valueType = array.success
      ? typeReadonlyArray(typeKeyword("string"))
      : typeKeyword(boolean.success ? "boolean" : "string");
    const field: Field = {
      key,
      optional: !parameter.required,
      type: parameter.required ? valueType : optionalOf(valueType),
    };
    const value = member(ident(I("input")), yield* memberName(key));
    const { allowReserved, explode, style } = serialization;
    const wire = str(parameter.wireName);
    const required = bool(parameter.required);
    if (parameter.location === "path" && pathStyles.has(style)) {
      const options = obj([
        ["allowReserved", bool(allowReserved)],
        ["explode", bool(explode)],
      ]);

      return { field, path: fn(style, [wire, value, options]) };
    }

    if (parameter.location === "query" && queryStyles.has(style)) {
      const options = obj([
        ["allowReserved", bool(allowReserved)],
        ["explode", bool(explode)],
        ["required", required],
      ]);

      return { field, query: fn(style, [wire, value, options]) };
    }

    if (parameter.location === "header" && style === "simple") {
      const options = obj([
        ["explode", bool(explode)],
        ["required", required],
      ]);

      return { field, header: fn("header", [wire, value, options]) };
    }

    return yield* refuse("unsupported-parameter", subject);
  });

/**
 * One `multipart/form-data` part a command sends: its part flag, its part name and its Encoding
 * `contentType`.
 */
export interface FormPart {
  readonly contentType: string;
  readonly flag: PlannedFlag;
  readonly name: string;
}

interface PartSchemas {
  readonly properties: ReadonlyMap<string, Schema.Json>;
  readonly required: ReadonlySet<string>;
}

const maxPartNodes = 1024;

// The properties and `required` names of a multipart root: its own, and those of its `allOf`
// members, each node read once.
const partSchemas = (defs: Defs, key: string): PartSchemas => {
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
      pending.push(...members.filter(isNode));
    }
  }

  return { properties, required };
};

// Whether a part's schema, or its array's `items`, declares `contentEncoding`.
const isEncoded = (defs: Defs, schema: Schema.Json | undefined, key: string): boolean => {
  const node = settle(defs, schema, key);
  if (Result.isFailure(node)) {
    return false;
  }

  const items = own(node.success, "items");
  const item = items === undefined ? undefined : settle(defs, items, key);

  return (
    own(node.success, "contentEncoding") !== undefined ||
    (item !== undefined &&
      Result.isSuccess(item) &&
      own(item.success, "contentEncoding") !== undefined)
  );
};

const isPartFlag = (flag: PlannedFlag, mediaType: string): boolean =>
  flag.source._tag === "Body" &&
  flag.source.kind !== "body" &&
  flag.source.kind !== "body-file" &&
  flag.source.media.includes(mediaType);

interface OrderedPart extends FormPart {
  readonly order: number;
}

interface PartContext {
  readonly alternative: MediaAlternative;
  readonly defs: Defs;
  readonly key: string;
  readonly schemas: PartSchemas;
}

// The reason a body's multipart alternative is not one the writer sends, or `undefined`.
const alternativeProblem = (
  alternatives: readonly MediaAlternative[],
  alternative: MediaAlternative,
): string | undefined => {
  const { mediaType } = alternative;
  if (alternatives.length > 1) {
    return `${mediaType} beside other request media`;
  }

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
const partOf = (flag: PlannedFlag, context: PartContext): Result.Result<OrderedPart, string> => {
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

  if (rule.nested !== undefined) {
    return Result.fail(`nested parts in multipart part ${pointer}`);
  }

  if (rule.headers.length > 0) {
    return Result.fail(`part headers for multipart part ${pointer}`);
  }

  if (rule.serialization !== undefined) {
    return Result.fail(`a style for multipart part ${pointer}`);
  }

  const [contentType] = rule.contentType;
  if (contentType === undefined || rule.contentType.length > 1 || contentType.includes("*")) {
    return Result.fail(`one content type for multipart part ${pointer}`);
  }

  if (isEncoded(context.defs, context.schemas.properties.get(name), context.key)) {
    return Result.fail(`the contentEncoding of multipart part ${pointer}`);
  }

  return Result.succeed({ contentType, flag, name, order });
};

const byOrder = Order.mapInput(Order.Number, (part: OrderedPart) => part.order);

/**
 * The parts a `multipart/form-data` command sends, in Encoding order, or the reason the runtime
 * writer cannot send it exactly (design 6.3; a `CliRefusal` subject). Refused, not guessed: a
 * multipart alternative beside other request media or under a range key, another multipart
 * subtype, 3.2 positional parts, a nested part, part headers, a part style, a part whose
 * `contentType` is not one concrete media type, a `contentEncoding` part, and a required part the
 * names plan gave no flag.
 */
export const formParts = (
  command: PlannedCommand,
  defs: Defs,
): Result.Result<readonly FormPart[], string> => {
  const alternatives = command.operation.body?.alternatives ?? [];
  const alternative = alternatives.find((candidate) => candidate.codec === "multipart");
  if (alternative === undefined) {
    return Result.fail("a multipart request body");
  }

  const problem = alternativeProblem(alternatives, alternative);
  if (problem !== undefined) {
    return Result.fail(problem);
  }

  const key = alternative.schema?.key ?? "";
  const context: PartContext = { alternative, defs, key, schemas: partSchemas(defs, key) };
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

  return Result.succeed(
    Arr.sort(parts, byOrder).map(({ contentType, flag, name }) => ({ contentType, flag, name })),
  );
};

interface BodyParts {
  readonly entry?: readonly [string, Expr];
  readonly fields: readonly Field[];
}

// The body is always present in `Input` when the operation declares one: an optional body with
// no input is `HttpBody.empty`, which `Serialize.request` sends without `Content-Type`. The
// content type is an input when the operator chooses it: several alternatives, or a range key.
// A multipart body the writer can send is its part values, streamed by `Serialize.formData`.
const bodyParts = (command: PlannedCommand, defs: Defs): BodyParts => {
  const { operation } = command;
  const alternatives = operation.body?.alternatives ?? [];
  const [first] = alternatives;
  if (first === undefined) {
    return { fields: [] };
  }

  const input = ident(I("input"));
  const value = member(input, M("body"));
  const form = first.codec === "multipart" ? formParts(command, defs) : undefined;
  if (form !== undefined && Result.isSuccess(form)) {
    const options = obj([
      ["parts", arr(form.success.map((part) => arr([str(part.name), str(part.contentType)])))],
      ["required", bool(operation.body?.required ?? false)],
    ]);

    return {
      entry: ["body", fn("formData", [value, options])],
      fields: [{ key: "body", optional: false, type: typeRef(I("Serialize"), [M("FormFields")]) }],
    };
  }

  const body: Field = { key: "body", optional: false, type: typeRef(I("Serialize"), [M("Body")]) };
  const types = mediaTypes(alternatives);
  if (alternatives.length === 1 && !isRange(first.mediaType)) {
    return { entry: ["body", fn("body", [str(first.mediaType), value])], fields: [body] };
  }

  const contentType: Field = {
    key: "contentType",
    optional: false,
    type: types.some(isRange)
      ? typeKeyword("string")
      : typeUnion(types.map((type) => typeLiteral(type))),
  };

  return {
    entry: ["body", fn("body", [member(input, M("contentType")), value])],
    fields: [body, contentType],
  };
};

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

interface CommandContext {
  readonly bound: ApiEmitInput["boundOrigins"];
  readonly defs: Defs;
  readonly document: (uri: string) => string;
  readonly memo: Map<string, boolean>;
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
      parameterParts(entry, context.defs, context.memo),
    );
    const body = bodyParts(command, context.defs);
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

    if (operation.servers.some((server) => server.level !== "root")) {
      meta.push(["servers", serversTable(operation.servers, context.bound)]);
    }

    const declarations: readonly Statement[] =
      fields.length === 0 ? [] : [{ _tag: "Interface", fields, name: inputName }];

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
// alone; its alias commands call them (design 4.4).
const primaries = (commands: readonly PlannedCommand[]): readonly PlannedCommand[] =>
  commands.filter((command) => command.alias === undefined);

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

const runtimeScheme = (scheme: SecurityScheme, env: string): Effect.Effect<Expr, ApiEmitError> => {
  const { kind } = scheme;
  if (kind.type === "apiKey") {
    return Effect.succeed(
      obj([
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
