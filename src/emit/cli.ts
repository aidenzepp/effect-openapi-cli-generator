import { Array as Arr, Data, Effect, Option, Order, Result, Schema } from "effect";
import type { AuthorConfig } from "../model/author-config.ts";
import type { Api, MediaAlternative, Operation, Parameter } from "../model/entities.ts";
import { foldIdentifier } from "../names/fold.ts";
import type {
  NamePlan,
  PlannedCommand,
  PlannedFlag,
  PlannedGroup,
  PlannedPositional,
} from "../names/index.ts";
import { envPrefixOf, isBooleanSchema } from "../names/plan.ts";
import { inputKeys } from "./api.ts";
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
 * The plan, model or author config holds something the `cli/` layer cannot express. Text, XML,
 * form and multipart request bodies are `unsupported-body` until their merge exists (follow-up
 * em4c). `unsupported-flag` is a flag with no call-expression form today: an `int64` field (the
 * runtime's digit check fails in `UsageError`, while `Flag.mapEffect` takes `CliError`) and a
 * required boolean parameter (absent would send `false`).
 */
export class CliEmitError extends Data.TaggedError("CliEmitError")<{
  readonly reason:
    | "name-clash"
    | "reserved-segment"
    | "unknown-parent"
    | "unplanned-parameter"
    | "unprintable-name"
    | "unresolved-schema"
    | "unsafe-commands-module"
    | "unsupported-body"
    | "unsupported-flag"
    | "unsupported-parameter";
  readonly subject: string;
}> {}

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
// The walk follows `$ref`, `properties` and `allOf` members, each node once per pointer token
// (so a cycle ends), under one visit budget per field.

const refPrefix = "#/$defs/";

const maxVisits = 10_000;

const StoredSchema = Schema.Struct({
  $ref: Schema.optionalKey(Schema.String),
  allOf: Schema.optionalKey(Schema.Array(Schema.Json)),
  description: Schema.optionalKey(Schema.String),
  format: Schema.optionalKey(Schema.Json),
  maximum: Schema.optionalKey(Schema.Json),
  minimum: Schema.optionalKey(Schema.Json),
  properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  title: Schema.optionalKey(Schema.String),
});

type SchemaNode = typeof StoredSchema.Type;

const decodeNode = Schema.decodeUnknownOption(StoredSchema);

const unescapeToken = (token: string): string => token.replaceAll("~1", "/").replaceAll("~0", "~");

// A bound outside the safe-integer range makes an integer field a digit string (design 4.5).
const unsafeBound = (bound: Schema.Json | undefined): boolean =>
  Schema.is(Schema.Finite)(bound) && Math.abs(bound) > Number.MAX_SAFE_INTEGER;

interface FieldSchema {
  readonly description: string;
  readonly int64: boolean;
}

const own = (
  record: Readonly<Record<string, Schema.Json>>,
  key: string,
): Schema.Json | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

const fieldSchema = (defs: Defs, rootKey: string, pointer: string): FieldSchema => {
  const seen = new Set<Schema.Json>();
  let visits = 0;
  // The node chain a schema reaches through `$ref`, starting at the schema itself.
  const chain = (start: Schema.Json | undefined): readonly SchemaNode[] => {
    const nodes: SchemaNode[] = [];
    let current = start;
    while (current !== undefined && !seen.has(current) && visits < maxVisits) {
      seen.add(current);
      visits += 1;

      const node = decodeNode(current);
      if (Option.isNone(node)) {
        break;
      }

      nodes.push(node.value);

      const ref = node.value.$ref;
      current =
        ref?.startsWith(refPrefix) === true
          ? own(defs, unescapeToken(ref.slice(refPrefix.length)))
          : undefined;
    }

    return nodes;
  };
  const property = (start: Schema.Json | undefined, name: string): Schema.Json | undefined => {
    for (const node of chain(start)) {
      const direct = node.properties === undefined ? undefined : own(node.properties, name);
      if (direct !== undefined) {
        return direct;
      }

      for (const part of node.allOf ?? []) {
        const found = property(part, name);
        if (found !== undefined) {
          return found;
        }
      }
    }

    return undefined;
  };
  const tokens = pointer.split("/").slice(1).map(unescapeToken);
  let target = own(defs, rootKey);
  for (const token of tokens) {
    seen.clear();
    target = target === undefined ? undefined : property(target, token);
  }

  seen.clear();

  const nodes = chain(target);
  const described = nodes.find(
    (node) => node.description !== undefined || node.title !== undefined,
  );

  return {
    description: described?.description ?? described?.title ?? "",
    int64: nodes.some(
      (node) => node.format === "int64" || unsafeBound(node.minimum) || unsafeBound(node.maximum),
    ),
  };
};

// ---------------------------------------------------------------------------------------------
// One command.

interface CommandContext {
  readonly api: Api;
  readonly booleans: Map<string, boolean>;
  readonly defs: Defs;
  readonly domain: NamePlan["domain"];
  readonly namespace: string;
  readonly plan: NamePlan;
}

const parameterOf = (operation: Operation, location: string, wireName: string) =>
  operation.parameters.find(
    (parameter) => parameter.location === location && parameter.wireName === wireName,
  );

const parameterDescription = (parameter: Parameter): string =>
  parameter.docs.description ?? parameter.docs.summary ?? "";

const positionalEntry = (
  operation: Operation,
  positional: PlannedPositional,
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

    const described = describedBy(parameterDescription(parameter));
    const value = pipe(
      fn("Argument.String", str(positional.name)),
      described.length === 0 ? [] : [fn("Argument.withDescription", ...described)],
    );

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

      const head = flag.boolean
        ? fn("Flag.Boolean", str(flag.name))
        : fn("Flag.String", str(flag.name));
      const steps = [
        ...(parameter.required ? [] : [path("Flag.optional")]),
        ...describedBy(parameterDescription(parameter)).map((text) =>
          fn("Flag.withDescription", text),
        ),
      ];

      return [flag.identifier, pipe(head, steps)] as const;
    }

    const alternative = operation.body?.alternatives.find((candidate) =>
      source.media.includes(candidate.mediaType),
    );
    const schema =
      alternative?.schema === undefined
        ? { description: "", int64: false }
        : fieldSchema(context.defs, alternative.schema.key, source.wireName);
    if (schema.int64 && source.kind === "integer") {
      return yield* refuse("unsupported-flag", flag.name);
    }

    const json = source.kind === "json";
    const head =
      json || source.kind === "string"
        ? fn("Flag.String", str(flag.name))
        : flagConstructor(flag, source.kind);
    const steps = [
      ...(json ? [fn("Flag.withSchema", fn("Schema.fromJsonString", path("Schema.Json")))] : []),
      source.repeated ? fn("Flag.atLeast", num(0)) : path("Flag.optional"),
      ...describedBy(schema.description).map((text) => fn("Flag.withDescription", text)),
    ];

    return [flag.identifier, pipe(head, steps)] as const;
  });

const flagValue = (key: string) => memberName(key).pipe(Effect.map((name) => member(flags, name)));

interface BodyPlan {
  readonly args: readonly Entry[];
  readonly domain: readonly string[];
  readonly head: Expr;
  readonly parameter: string;
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
    if (alternative.codec === "binary") {
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

    const fields: Entry[] = [];
    for (const flag of command.flags.filter(isFieldFlag)) {
      if (flag.source._tag === "Body" && flag.source.media.includes(alternative.mediaType)) {
        fields.push([flag.source.wireName, yield* flagValue(flag.identifier)]);
      }
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

    if (!choosesType) {
      const single = yield* alternativeBody(command, first, body.required, context);
      const parameter = first.codec === "binary" ? "loaded" : "merged";

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
    for (const positional of command.positionals) {
      entries.push(yield* positionalEntry(operation, positional, context));
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

// The builder's argument entries for the operation's parameters, keyed by `inputKeys`.
const parameterInputs = (command: PlannedCommand) =>
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
      entries.push([key, parameter.required ? value : fn("Option.getOrUndefined", value)]);
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
    const namespace = ident(yield* identifier(context.namespace));
    const name = yield* identifier(command.identifier);
    const meta = member(namespace, yield* memberName(`${command.identifier}Meta`));
    const choices = choicesOf(command.operation);
    const config = yield* configOf(command, choices, context);
    const body = yield* bodyPlan(command, meta, choices.choosesType, context);
    const inputs: Entry[] = [
      ...Option.match(body, { onNone: () => [], onSome: (plan) => plan.args }),
      ...(yield* parameterInputs(command)),
    ];
    const builder = member(namespace, yield* memberName(command.identifier));
    const built = call(builder, inputs.length === 0 ? [] : [obj(inputs)]);
    const send = fn(
      "Effect.flatMap",
      fn("Output.send", ...(choices.accepts ? [meta, path("flags.accept")] : [meta])),
    );
    const handled = Option.match(body, {
      onNone: () => pipe(built, [send]),
      onSome: (plan) =>
        pipe(plan.head, [fn("Effect.flatMap", arrow([{ name: I(plan.parameter) }], built)), send]),
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

const runtimeNamespaces: readonly (readonly [string, string])[] = [
  ["Auth", "../runtime/auth.ts"],
  ["BaseUrl", "../runtime/base-url.ts"],
  ["Describe", "../runtime/describe.ts"],
  ["Input", "../runtime/input.ts"],
  ["Negotiate", "../runtime/negotiate.ts"],
  ["Output", "../runtime/output.ts"],
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

const commandsOf = (commands: readonly PlannedCommand[], context: CommandContext) =>
  Effect.gen(function* emit() {
    const parts = yield* Effect.all(commands.map((command) => commandStatement(command, context)));

    return {
      domain: Arr.dedupe(parts.flatMap((part) => part.domain)),
      statements: parts.map((part) => part.statement),
    };
  });

const groupFile = (
  group: PlannedGroup,
  children: readonly PlannedGroup[],
  base: Omit<CommandContext, "namespace">,
) =>
  Effect.gen(function* file() {
    const context: CommandContext = { ...base, namespace: group.namespace };
    const { domain, statements } = yield* commandsOf(group.commands, context);
    const subcommands = [
      ...group.commands.map((command) => ident(I(command.identifier))),
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
      { from: `../api/${group.segment}.ts`, kind: "Namespace", name: group.namespace },
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
  base: Omit<CommandContext, "namespace">,
  config: AuthorConfig,
) =>
  Effect.gen(function* file() {
    const { plan } = base;
    const context: CommandContext = { ...base, namespace: "Root" };
    const { domain, statements } = yield* commandsOf(plan.root, context);
    const author = yield* authorCommands(config);
    const prefix = str(envPrefixOf(config));
    const subcommands = [
      ...topLevel.map((group) => member(ident(I(cliAlias(group))), M("group"))),
      ...plan.root.map((command) => ident(I(command.identifier))),
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
      ...(plan.root.length === 0
        ? []
        : [{ from: "../api/root.ts", kind: "Namespace" as const, name: "Root" }]),
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
 * per planned group with one `Command.make` per operation (inline `Flag` and `Argument`
 * constructors, three-state booleans, a handler that builds the body, calls the `api/` builder
 * with `inputKeys` and runs `Output.send`), its describe binding and help notes, and `group`;
 * and `cli/root.ts` with the untagged commands, the root command and its global settings, the
 * author-owned commands, and `services`. Files are sorted by path.
 */
export const emitCli = (
  input: CliEmitInput,
): Effect.Effect<readonly EmittedFile[], CliEmitError | PrinterError> =>
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

    const base: Omit<CommandContext, "namespace"> = {
      api,
      booleans: new Map(),
      defs: Option.match(decodeDefs(api.schemas.document), {
        onNone: () => ({}),
        onSome: (store) => store.$defs,
      }),
      domain: plan.domain,
      plan,
    };
    // A group is emitted when it holds a command or an emitted child group.
    const emitted = new Set<string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const group of plan.groups) {
        const hasChild = plan.groups.some(
          (child) => child.parent === group.tag && emitted.has(child.tag),
        );
        if (!emitted.has(group.tag) && (group.commands.length > 0 || hasChild)) {
          emitted.add(group.tag);
          grew = true;
        }
      }
    }

    const groups = plan.groups.filter((group) => emitted.has(group.tag));
    const childrenOf = (group: PlannedGroup) =>
      groups.filter((child) => child.parent === group.tag);
    const files: EmittedFile[] = [
      ...(yield* Effect.all(groups.map((group) => groupFile(group, childrenOf(group), base)))),
    ];
    files.push(
      yield* rootFile(
        groups.filter((group) => group.parent === undefined),
        base,
        config,
      ),
    );

    return Arr.sort(files, byPath);
  });
