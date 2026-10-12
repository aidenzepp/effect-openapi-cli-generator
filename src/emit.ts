import { Array, Effect, Order, Schema } from "effect";
import { resolveName } from "./commands.js";
import { formatApplication } from "./format.js";
import type { ApiModel, Documentation, GenerateOptions, Parameter, WireSchema } from "./model.js";
import { runtimeSource } from "./runtime-source.js";

const literal = (value: Schema.Json): string => {
  if (Schema.is(Schema.String)(value) && value.includes(`\${`)) {
    return `\`${value
      .replaceAll("\\", "\\\\")
      .replaceAll("`", "\\`")
      .replaceAll("\r", "\\r")
      .replaceAll(`\${`, `\\\${`)
      .replaceAll(/[\uD800-\uDFFF]/gu, (unit) => JSON.stringify(unit).slice(1, -1))}\``;
  }
  if (Schema.is(Schema.Array(Schema.Json))(value)) {
    return `[${value.map(literal).join(",")}]`;
  }
  return JSON.stringify(value);
};
const propertyKey = (name: string) =>
  name === "__proto__" || name.includes(`\${`) ? `[${literal(name)}]` : JSON.stringify(name);
const escapeComment = (text: string) => text.replaceAll("*/", "*\\/").replaceAll(/^\s*@/gmu, "\\@");
const description = (docs: Documentation) =>
  [docs.title, docs.description].filter(Boolean).join("\n");
const comment = (docs: Documentation): string => {
  const lines = description(docs).split("\n").filter(Boolean).map(escapeComment);
  if (docs.deprecated === true) {
    lines.push("@deprecated");
  }
  if (docs.externalDocs) {
    lines.push(
      `@see ${escapeComment(docs.externalDocs.url)} ${escapeComment(docs.externalDocs.description ?? "")}`,
    );
  }
  return lines.length > 0 ? `/**\n${lines.map((line) => ` * ${line}`).join("\n")}\n */\n` : "";
};
const schemaSource = (schema: WireSchema): string => {
  let expression: string;
  switch (schema.kind) {
    case "object": {
      const fields = Array.sort(
        schema.properties,
        (a: { readonly name: string }, b: { readonly name: string }) => {
          if (a.name < b.name) {
            return -1;
          }
          if (a.name > b.name) {
            return 1;
          }
          return 0;
        },
      )
        .map(
          (property) =>
            `${comment(property.schema.docs)}${propertyKey(property.name)}: ${property.required ? schemaSource(property.schema) : `Schema.optionalKey(${schemaSource(property.schema)})`}`,
        )
        .join(",\n");
      const struct = `Schema.Struct({${fields}})`;
      expression = schema.additionalProperties
        ? `Schema.StructWithRest(${struct}, [Schema.Record(Schema.String, Schema.Json)])`
        : struct;
      break;
    }
    case "array": {
      expression = `Schema.Array(${schemaSource(schema.items)})`;
      break;
    }
    case "boolean":
    case "integer":
    case "null":
    case "number":
    case "string": {
      const names = {
        boolean: "Boolean",
        integer: "Int",
        null: "Null",
        number: "Finite",
        string: "String",
      };
      if (schema.enum) {
        const values = schema.enum.filter((value) => value !== null);
        expression = values.length === 0 ? "Schema.Null" : `Schema.Literals(${literal(values)})`;
        if (values.length > 0 && schema.enum.includes(null)) {
          expression = `Schema.NullOr(${expression})`;
        }
      } else {
        expression = `Schema.${names[schema.kind]}`;
      }
      break;
    }
    default: {
      return schema;
    }
  }
  return schema.nullable && !("enum" in schema && schema.enum)
    ? `Schema.NullOr(${expression})`
    : expression;
};
const parameterSource = (parameter: Parameter): string => {
  const api = parameter.binding === "argument" ? "Argument" : "Flag";
  const name = literal(parameter.flagName);
  const { schema } = parameter;
  let expression: string;
  if (schema.kind === "boolean") {
    expression = `${api}.Literals(${name}, ["true", "false"]).pipe(${api}.map((value) => value === "true"))`;
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

export const emit = (model: ApiModel, options?: GenerateOptions) =>
  Effect.gen(function* emitEffect1() {
    const name = yield* resolveName(model.title, options);
    const rootDocs =
      model.description === undefined
        ? { title: model.title }
        : { description: model.description, title: model.title };
    const lines = [
      "#!/usr/bin/env node",
      'import { Config, Effect, Option, Schema } from "effect";',
      'import { Argument, CliError, Command, Flag } from "effect/cli";',
      'import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";',
      'import { executeRequest, pathValue, readBody, validateBaseUrl } from "./runtime.js";',
      `${comment(rootDocs)}const root = Command.make(${literal(name)}).pipe(Command.withDescription(${literal([model.title, model.description].filter(Boolean).join("\n"))}), Command.withSharedFlags({baseUrl: Flag.String("base-url").pipe(Flag.mapEffect((value) => validateBaseUrl(value).pipe(Effect.mapError((cause) => new CliError.InvalidValue({expected: "HTTP(S) URL without credentials, query or fragment", kind: "flag", option: "base-url", value: cause.value})))))}));`,
    ];
    const leaves = new Map<string, string>();
    for (const [index, operation] of model.operations.entries()) {
      const entries = operation.parameters.map((parameter, position) => {
        const identifier = `parameter${index}_${position}`;
        lines.push(
          `${comment(parameter.docs)}const ${identifier} = ${parameterSource(parameter)};`,
        );
        return `value${position}: ${identifier}`;
      });
      if (operation.body) {
        lines.push(
          `${comment(operation.body.schema.docs)}const schema${index} = ${schemaSource(operation.body.schema)};`,
        );
        entries.unshift(
          'body: Flag.String("body").pipe(Flag.optional)',
          'bodyFile: Flag.String("body-file").pipe(Flag.optional)',
        );
      }
      const statements = [
        "const { baseUrl } = yield* root;",
        "const base = yield* Config.succeed(baseUrl);",
        `${operation.parameters.some((parameter) => parameter.location === "path") ? "let" : "const"} path = ${literal(operation.path)};`,
        "const query = new URLSearchParams();",
      ];
      for (const [position, parameter] of operation.parameters.entries()) {
        const value = `input.value${position}`;
        if (parameter.location === "path") {
          statements.push(
            `path = path.replace(${literal(`{${parameter.wireName}}`)}, yield* pathValue(${value}));`,
          );
        } else if (parameter.required) {
          statements.push(
            `query.append(${literal(parameter.wireName)}, ${parameter.schema.kind === "string" ? value : `String(${value})`});`,
          );
        } else {
          statements.push(
            `if (Option.isSome(${value})) { query.append(${literal(parameter.wireName)}, ${parameter.schema.kind === "string" ? `${value}.value` : `String(${value}.value)`}); }`,
          );
        }
      }
      statements.push(
        "const suffix = query.toString();",
        `const url = \`\${base}\${path}\${suffix.length > 0 ? \`?\${suffix}\` : ""}\`;`,
        operation.body
          ? `const body = yield* readBody(input, ${operation.body.required}, schema${index});`
          : "const body = Option.none();",
        `yield* executeRequest(${literal(operation.method)}, url, body);`,
      );
      lines.push(
        `${comment(operation.docs)}const operation${index} = Command.make(${literal(operation.commandPath.at(-1) ?? "")}, {${Array.sort(entries, Order.String).join(",")}}, (${entries.length > 0 ? "input" : ""}) => Effect.gen(function* runOperation${index}() {${statements.join("\n")}}).pipe(Effect.mapError((cause) => new CliError.UserError({cause, userMessage: cause.message})))).pipe(Command.withDescription(${literal(description(operation.docs))}));`,
      );
      leaves.set(operation.commandPath.join("/"), `operation${index}`);
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
    const children = (parent: string) =>
      [...leaves]
        .filter(([path]) => path.split("/").slice(0, -1).join("/") === parent)
        .map(([, identifier]) => identifier);
    for (const [index, group] of groups.entries()) {
      lines.push(
        `const group${index} = Command.make(${literal(group.split("/").at(-1) ?? "")}).pipe(Command.withSubcommands([${children(group).join(",")}]));`,
      );
      leaves.set(group, `group${index}`);
    }
    lines.push(
      `const command = root.pipe(Command.withSubcommands([${children("").join(",")}]));`,
      'Command.run(command, {version: "0.0.0"}).pipe(Effect.provide(NodeHttpClient.layerNodeHttp), Effect.provide(NodeServices.layer), NodeRuntime.runMain({disableErrorReporting: true}));',
    );
    return yield* formatApplication({
      files: [
        { content: lines.join("\n\n"), path: "src/main.ts" },
        { content: runtimeSource, path: "src/runtime.ts" },
        {
          content: JSON.stringify({
            bin: { [name]: "./dist/main.js" },
            dependencies: { "@effect/platform-node": "4.0.3", effect: "4.0.3" },
            devDependencies: { "@types/node": "26.6.4", typescript: "7.0.2" },
            name,
            private: true,
            scripts: { build: "tsc -p tsconfig.json", start: "node dist/main.js" },
            type: "module",
            version: "0.0.0",
          }),
          path: "package.json",
        },
        {
          content: JSON.stringify({
            compilerOptions: {
              declaration: false,
              module: "NodeNext",
              moduleResolution: "NodeNext",
              outDir: "dist",
              rootDir: "src",
              strict: true,
              target: "ES2022",
              types: ["node"],
            },
            include: ["src/**/*.ts"],
          }),
          path: "tsconfig.json",
        },
        { content: "node_modules/\ndist/\n", path: ".gitignore" },
      ],
    });
  });
