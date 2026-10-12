import { Effect } from "effect";
import { resolveName } from "./commands.js";
import { formatApplication } from "./format.js";
import type { ApiModel, Documentation, GenerateOptions, Parameter, WireSchema } from "./model.js";
import { runtimeSource } from "./runtime-source.js";

const literal = (value: unknown) => JSON.stringify(value);
const description = (docs: Documentation) =>
  [docs.title, docs.description].filter(Boolean).join("\n");
const comment = (docs: Documentation): string => {
  const escape = (text: string) => text.replaceAll("*/", "*\\/").replace(/^\s*@/gm, "\\@");
  const lines = description(docs).split("\n").filter(Boolean).map(escape);
  if (docs.deprecated) lines.push("@deprecated");
  if (docs.externalDocs)
    lines.push(
      `@see ${escape(docs.externalDocs.url)} ${escape(docs.externalDocs.description ?? "")}`,
    );
  return lines.length ? `/**\n${lines.map((line) => ` * ${line}`).join("\n")}\n */\n` : "";
};
const schemaSource = (schema: WireSchema): string => {
  let expression: string;
  switch (schema.kind) {
    case "object": {
      const fields = schema.properties
        .map(
          (property) =>
            `${comment(property.schema.docs)}[${literal(property.name)}]: ${property.required ? schemaSource(property.schema) : `Schema.optionalKey(${schemaSource(property.schema)})`}`,
        )
        .join(",\n");
      const struct = `Schema.Struct({${fields}})`;
      expression = schema.additionalProperties
        ? `Schema.StructWithRest(${struct}, [Schema.Record(Schema.String, Schema.Unknown)])`
        : struct;
      break;
    }
    case "array":
      expression = `Schema.Array(${schemaSource(schema.items)})`;
      break;
    default: {
      const names = {
        string: "String",
        boolean: "Boolean",
        integer: "Int",
        number: "Finite",
        null: "Null",
      };
      if (schema.enum) {
        const values = schema.enum.filter((value) => value !== null);
        expression = values.length === 0 ? "Schema.Null" : `Schema.Literals(${literal(values)})`;
        if (values.length > 0 && schema.enum.includes(null))
          expression = `Schema.NullOr(${expression})`;
      } else expression = `Schema.${names[schema.kind]}`;
    }
  }
  return schema.nullable && !("enum" in schema && schema.enum)
    ? `Schema.NullOr(${expression})`
    : expression;
};
const parameterSource = (parameter: Parameter): string => {
  const api = parameter.binding === "argument" ? "Argument" : "Flag";
  const name = literal(parameter.flagName);
  const schema = parameter.schema;
  let expression: string;
  if (schema.kind === "boolean")
    expression = `${api}.Literals(${name}, ["true", "false"]).pipe(${api}.map((value) => value === "true"))`;
  else if (schema.kind === "string" && schema.enum)
    expression = `${api}.Literals(${name}, ${literal(schema.enum)})`;
  else
    expression = `${api}.${schema.kind === "integer" ? "Int" : schema.kind === "number" ? "Finite" : "String"}(${name})`;
  if (description(parameter.docs))
    expression += `.pipe(${api}.withDescription(${literal(description(parameter.docs))}))`;
  if (!parameter.required) expression += ".pipe(Flag.optional)";
  return expression;
};

export const emit = (model: ApiModel, options?: GenerateOptions) =>
  Effect.gen(function* () {
    const name = yield* resolveName(model.title, options);
    const lines = [
      "#!/usr/bin/env node",
      'import { Config, Effect, Option, Schema } from "effect";',
      'import { Argument, CliError, Command, Flag } from "effect/cli";',
      'import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";',
      'import { executeRequest, pathValue, readBody, validateBaseUrl } from "./runtime.js";',
      `${comment({ title: model.title, ...(model.description ? { description: model.description } : {}) })}const root = Command.make(${literal(name)}).pipe(Command.withDescription(${literal([model.title, model.description].filter(Boolean).join("\n"))}), Command.withSharedFlags({baseUrl: Flag.String("base-url").pipe(Flag.mapEffect((value) => validateBaseUrl(value).pipe(Effect.mapError((cause) => new CliError.InvalidValue({option: "base-url", value: cause.value, expected: "HTTP(S) URL without credentials, query or fragment", kind: "flag"})))))}));`,
    ];
    let parameterIndex = 0;
    const leaves = new Map<string, string>();
    for (const [index, operation] of model.operations.entries()) {
      const entries = operation.parameters.map((parameter, position) => {
        const identifier = `parameter${parameterIndex++}`;
        lines.push(
          `${comment(parameter.docs)}const ${identifier} = ${parameterSource(parameter)};`,
        );
        return `value${position}: ${identifier}`;
      });
      if (operation.body) {
        lines.push(
          `${comment(operation.body.schema.docs)}const schema${index} = ${schemaSource(operation.body.schema)};`,
        );
        entries.push(
          'body: Flag.String("body").pipe(Flag.optional)',
          'bodyFile: Flag.String("body-file").pipe(Flag.optional)',
        );
      }
      const statements = [
        "const { baseUrl } = yield* root;",
        "const base = yield* Config.succeed(baseUrl);",
        `let path = ${literal(operation.path)};`,
        "const query = new URLSearchParams();",
      ];
      for (const [position, parameter] of operation.parameters.entries()) {
        const value = `input.value${position}`;
        if (parameter.location === "path")
          statements.push(
            `path = path.replace(${literal(`{${parameter.wireName}}`)}, yield* pathValue(${value}));`,
          );
        else if (parameter.required)
          statements.push(`query.append(${literal(parameter.wireName)}, String(${value}));`);
        else
          statements.push(
            `if (Option.isSome(${value})) query.append(${literal(parameter.wireName)}, String(${value}.value));`,
          );
      }
      statements.push(
        "const suffix = query.toString();",
        'const url = base + path + (suffix ? "?" + suffix : "");',
      );
      statements.push(
        operation.body
          ? `const body = yield* readBody(input, ${operation.body.required}, schema${index});`
          : "const body = Option.none();",
      );
      statements.push(`yield* executeRequest(${literal(operation.method)}, url, body);`);
      lines.push(
        `${comment(operation.docs)}const operation${index} = Command.make(${literal(operation.commandPath.at(-1))}, {${entries.join(",")}}, (${entries.length ? "input" : ""}) => Effect.gen(function* () {${statements.join("\n")}}).pipe(Effect.mapError((cause) => new CliError.UserError({cause, userMessage: cause.message})))).pipe(Command.withDescription(${literal(description(operation.docs))}));`,
      );
      leaves.set(operation.commandPath.join("/"), `operation${index}`);
    }
    const groups = [
      ...new Set(
        model.operations.flatMap((operation) =>
          operation.commandPath
            .slice(0, -1)
            .map((_, index) => operation.commandPath.slice(0, index + 1).join("/")),
        ),
      ),
    ].sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
    const children = (parent: string) =>
      [...leaves]
        .filter(([path]) => path.split("/").slice(0, -1).join("/") === parent)
        .map(([, identifier]) => identifier);
    for (const [index, group] of groups.entries()) {
      lines.push(
        `const group${index} = Command.make(${literal(group.split("/").at(-1))}).pipe(Command.withSubcommands([${children(group).join(",")}]));`,
      );
      leaves.set(group, `group${index}`);
    }
    lines.push(
      `const command = root.pipe(Command.withSubcommands([${children("").join(",")}]));`,
      'Command.run(command, {version: "0.0.0"}).pipe(Effect.provide(NodeHttpClient.layerNodeHttp), Effect.provide(NodeServices.layer), NodeRuntime.runMain({disableErrorReporting: true}));',
    );
    return yield* formatApplication({
      files: [
        { path: "src/main.ts", content: lines.join("\n\n") },
        { path: "src/runtime.ts", content: runtimeSource },
        {
          path: "package.json",
          content: literal({
            name,
            version: "0.0.0",
            private: true,
            type: "module",
            bin: { [name]: "./dist/main.js" },
            scripts: { build: "tsc -p tsconfig.json", start: "node dist/main.js" },
            dependencies: { "@effect/platform-node": "4.0.3", effect: "4.0.3" },
            devDependencies: { typescript: "7.0.2", "@types/node": "26.6.4" },
          }),
        },
        {
          path: "tsconfig.json",
          content: literal({
            compilerOptions: {
              strict: true,
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              rootDir: "src",
              outDir: "dist",
              declaration: false,
              types: ["node"],
            },
            include: ["src/**/*.ts"],
          }),
        },
        { path: ".gitignore", content: "node_modules/\ndist/\n" },
      ],
    });
  });
