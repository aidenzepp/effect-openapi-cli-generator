import { Array, Order } from "effect";
import type { ApiModel, Operation, Parameter } from "./model.js";
import { schemaSource } from "./emit-schema.js";
import { comment, description, internalReference, literal, propertyKey } from "./source-text.js";

/**
 * Allocates readable names in one module-wide namespace. Suffixes distinguish
 * command paths that collapse to the same camel-case spelling.
 *
 * @returns An allocator shared by groups, handlers, parameters, and schemas.
 */
const identifierAllocator = () => {
  const used = new Set(["root", "command"]);

  return (parts: readonly string[], suffix: string): string => {
    const words = parts
      .join("-")
      .split(/[^a-zA-Z0-9]+/u)
      .filter(Boolean);
    const [first = "api", ...rest] = words;
    const stem = first + rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
    const base = `${/^[0-9]/u.test(stem) ? "api" : ""}${stem}${suffix}`;
    let candidate = base;
    let count = 2;
    while (used.has(candidate)) {
      candidate = `${base}${count}`;
      count += 1;
    }
    used.add(candidate);

    return candidate;
  };
};

/**
 * Renders a native flag or positional argument without changing its wire type.
 *
 * @param parameter The validated scalar CLI binding.
 * @returns An Effect CLI declaration, including documentation and optionality.
 */
const parameterSource = (parameter: Parameter): string => {
  const api = parameter.binding === "argument" ? "Argument" : "Flag";
  const name = literal(parameter.flagName);
  const { schema } = parameter;
  let expression: string;
  if (schema.kind === "boolean") {
    expression = `${api}.Literals(${name}, ["true", "false"]).pipe(
      ${api}.map((value) => value === "true")
    )`;
  } else if (schema.kind === "string" && schema.enum) {
    expression = `${api}.Literals(${name}, ${literal(schema.enum)})`;
  } else {
    let primitive = "String";
    if (schema.kind === "integer") {
      primitive = "Int";
    }

    if (schema.kind === "number") {
      primitive = "Finite";
    }

    expression = `${api}.${primitive}(${name})`;
  }

  if (description(parameter.docs)) {
    expression += `.pipe(${api}.withDescription(${literal(description(parameter.docs))}))`;
  }

  if (!parameter.required) {
    expression += ".pipe(Flag.optional)";
  }

  return expression;
};

/**
 * Selects only the native APIs used by this command tree.
 *
 * @param model The operations emitted into a single executable module.
 * @returns Import declarations for the generated module.
 */
const importsFor = (model: ApiModel): string => {
  const parameters = model.operations.flatMap((operation) => operation.parameters);
  const hasBody = model.operations.some((operation) => operation.body !== undefined);
  const usesOption =
    model.operations.some((operation) => operation.body === undefined) ||
    parameters.some((parameter) => parameter.location === "query" && !parameter.required);
  const effectImports = [
    "Effect",
    ...(usesOption ? ["Option"] : []),
    ...(hasBody ? ["Schema"] : []),
  ];
  const cliImports = [
    ...(parameters.some((parameter) => parameter.binding === "argument") ? ["Argument"] : []),
    "CliError",
    "Command",
    "Flag",
  ];
  const runtimeImports = [
    "executeRequest",
    ...(parameters.some((parameter) => parameter.location === "path") ? ["pathValue"] : []),
    ...(hasBody ? ["readBody"] : []),
    "validateBaseUrl",
  ];

  return `import { ${effectImports.join(", ")} } from "effect";
import { ${cliImports.join(", ")} } from "effect/cli";
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { ${runtimeImports.join(", ")} } from "./runtime.js";`;
};

/**
 * Declares the required shared URL flag. Validation runs when parsing a request,
 * so help remains available without configuration.
 *
 * @param model The API documentation shown at the command root.
 * @param name The resolved executable name.
 * @returns The root command declaration.
 */
const rootSource = (model: ApiModel, name: string): string => {
  const docs =
    model.description === undefined
      ? { title: model.title }
      : { description: model.description, title: model.title };

  return `${comment(docs)}const root = Command.make(${literal(name)}).pipe(
  Command.withDescription(${literal([model.title, model.description].filter(Boolean).join("\n"))}),
  Command.withSharedFlags({
    baseUrl: Flag.String("base-url").pipe(
      Flag.mapEffect((value) => validateBaseUrl(value).pipe(
        Effect.mapError((cause) => new CliError.InvalidValue({
          expected: "HTTP(S) URL without credentials, query or fragment",
          kind: "flag",
          option: "base-url",
          value: cause.value,
        }))
      ))
    ),
  })
);`;
};

/**
 * Names input fields separately from generated body flags and wire identities.
 * A path argument and query flag may share their original name without sharing a field.
 *
 * @param parameter The validated parameter binding.
 * @returns A local property spelling with an explicit binding suffix.
 */
const parameterInputKey = (parameter: Parameter): string =>
  `${parameter.flagName}${parameter.binding === "argument" ? "Argument" : "Flag"}`;

/**
 * Builds an operation handler from its original HTTP contract.
 * Local input keys use flag names; wire names are used only at serialization.
 *
 * @param operation The normalized operation and validated parameter bindings.
 * @param bodySchema The allocated body validator name.
 * @returns Ordered handler statements with readable control-flow spacing.
 */
const handlerSource = (operation: Operation, bodySchema: string): string => {
  const statements = [
    "const { baseUrl } = yield* root;",
    `${operation.parameters.some((parameter) => parameter.location === "path") ? "let" : "const"} path = ${literal(operation.path)};`,
    "const query = new URLSearchParams();",
  ];
  for (const parameter of operation.parameters) {
    const key = parameterInputKey(parameter);
    const value = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/u.test(key)
      ? `input.${key}`
      : `input[${literal(key)}]`;
    if (parameter.location === "path") {
      statements.push(
        `path = path.replace(${literal(`{${parameter.wireName}}`)}, yield* pathValue(${value}));`,
      );
    } else if (parameter.required) {
      statements.push(
        `query.append(${literal(parameter.wireName)}, ${parameter.schema.kind === "string" ? value : `String(${value})`});`,
      );
    } else {
      statements.push(`if (Option.isSome(${value})) {
        query.append(${literal(parameter.wireName)}, ${parameter.schema.kind === "string" ? `${value}.value` : `String(${value}.value)`});
      }`);
    }
  }
  statements.push(
    "const suffix = query.toString();",
    // oxlint-disable-next-line no-template-curly-in-string -- Interpolation belongs to the generated handler.
    'const url = `${baseUrl}${path}${suffix.length > 0 ? `?${suffix}` : ""}`;',
    operation.body
      ? `const body = yield* readBody(input, ${operation.body.required}, ${internalReference(bodySchema, operation.body.schema.docs.deprecated === true)});`
      : "const body = Option.none();",
    `yield* executeRequest(${literal(operation.method)}, url, body);`,
  );

  return statements.join("\n\n");
};

/**
 * Renders command declarations in dependency order, then installs Node services.
 * Names are allocated across the complete module to prevent local collisions.
 *
 * @param model The validated command tree and wire contracts.
 * @param name The resolved root command name.
 * @returns Standalone TypeScript source awaiting final formatting.
 */
export const commandSource = (model: ApiModel, name: string): string => {
  const allocate = identifierAllocator();
  const sections = ["#!/usr/bin/env node", importsFor(model), rootSource(model, name)];
  const leaves = new Map<string, string>();
  for (const operation of model.operations) {
    const commandName = allocate(operation.commandPath, "Command");
    const handlerName = allocate(operation.commandPath, "Request");
    const bodySchema = allocate(operation.commandPath, "BodySchema");
    const entries = operation.parameters.map((parameter) => {
      const identifier = allocate(
        [...operation.commandPath, parameter.flagName],
        parameter.binding === "argument" ? "Argument" : "Flag",
      );
      sections.push(
        `${comment(parameter.docs)}const ${identifier} = ${parameterSource(parameter)};`,
      );

      return {
        key: parameterInputKey(parameter),
        source: `${propertyKey(parameterInputKey(parameter))}: ${internalReference(identifier, parameter.docs.deprecated === true)}`,
      };
    });
    if (operation.body) {
      sections.push(
        `${comment(operation.body.schema.docs)}const ${bodySchema} = ${schemaSource(operation.body.schema)};`,
      );
      entries.unshift(
        { key: "body", source: 'body: Flag.String("body").pipe(Flag.optional)' },
        { key: "bodyFile", source: 'bodyFile: Flag.String("body-file").pipe(Flag.optional)' },
      );
    }

    sections.push(`${comment(operation.docs)}const ${commandName} = Command.make(
      ${literal(operation.commandPath.at(-1) ?? "")},
      { ${Array.sort(
        entries,
        Order.mapInput(
          Order.String,
          (entry: { readonly key: string; readonly source: string }) => entry.key,
        ),
      )
        .map((entry) => entry.source)
        .join(",\n")} },
      (${entries.length > 0 ? "input" : ""}) => Effect.gen(function* ${handlerName}() {
        ${handlerSource(operation, bodySchema)}
      }).pipe(
        Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message }))
      )
    ).pipe(Command.withDescription(${literal(description(operation.docs))}));`);
    leaves.set(
      operation.commandPath.join("/"),
      internalReference(commandName, operation.docs.deprecated === true),
    );
  }
  const groups = Array.sort(
    [
      ...new Set(
        model.operations.flatMap((operation) =>
          operation.commandPath
            .slice(0, -1)
            .map((_, index) => operation.commandPath.slice(0, index + 1).join("/")),
        ),
      ),
    ],
    (a: string, b: string) => {
      const comparison = b.split("/").length - a.split("/").length || a.localeCompare(b);

      if (comparison < 0) {
        return -1;
      }

      if (comparison > 0) {
        return 1;
      }

      return 0;
    },
  );
  /**
   * Selects direct descendants after deeper groups have been registered.
   *
   * @param parent The slash-delimited parent address; empty denotes the root.
   * @returns References to the parent's commands in deterministic order.
   */
  const children = (parent: string) =>
    [...leaves]
      .filter(([path]) => path.split("/").slice(0, -1).join("/") === parent)
      .map(([, identifier]) => identifier);
  for (const group of groups) {
    const identifier = allocate(group.split("/"), "Group");
    sections.push(`const ${identifier} = Command.make(${literal(group.split("/").at(-1) ?? "")}).pipe(
      Command.withSubcommands([${children(group).join(",\n")}])
    );`);
    leaves.set(group, identifier);
  }
  sections.push(
    `const command = root.pipe(
    Command.withSubcommands([${children("").join(",\n")}])
  );`,
    `Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeHttpClient.layerNodeHttp),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );`,
  );

  return sections.join("\n\n");
};
