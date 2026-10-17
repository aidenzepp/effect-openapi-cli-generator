import { parameterSource } from "./emit-flag.js";
import { multipartFlagSource, multipartBodySource, multipartUsesSchema } from "./emit-multipart.js";
import { Array, Order } from "effect";
import { identifierAllocator } from "./identifiers.js";
import type { multipartComponents } from "./emit-multipart-components.js";
import type { parameterComponents, requestBodyComponents } from "./emit-components.js";
import { hasSchemaReference } from "./emit-schema.js";
import type { ApiModel, MultipartField, Operation, Parameter } from "./model.js";
import { comment, description, internalReference, literal, propertyKey } from "./source-text.js";

/**
 * Allocate flags only for schemes used by selected operations.
 */
const authenticationSource = (model: ApiModel) => {
  const requirements = new Map(
    model.operations.flatMap((operation) =>
      operation.security ? [[operation.security.key, operation.security] as const] : [],
    ),
  );
  const allocate = identifierAllocator();
  const names = new Map<string, string[]>();
  const lines: string[] = [];
  for (const key of Array.sort([...requirements.keys()], Order.String)) {
    const security = requirements.get(key);
    if (!security) {
      continue;
    }

    const fields = security.kind === "basic" ? ["username", "password"] : [""];
    const identifiers: string[] = [];
    for (const field of fields) {
      const name = allocate(`${key} ${field}`, "", true);
      identifiers.push(name);

      const flag = `${security.flagName}${field ? `-${field}` : ""}`;
      const fallback = {
        apiKey: "API key for authentication.",
        basic: `Basic authentication ${field}.`,
        bearer: "Bearer token for authentication.",
      };
      const help =
        security.docs.description === undefined
          ? fallback[security.kind]
          : description(security.docs);
      lines.push(
        `${comment({ description: help })}export const ${name} = Flag.Redacted(${literal(flag)}).pipe(Flag.withDescription(${literal(help)}));`,
      );
    }
    names.set(key, identifiers);
  }

  return {
    names,
    source: lines.length
      ? `import { Flag } from "effect/cli";\n\n${lines.join("\n\n")}\n`
      : undefined,
  };
};

/**
 * Preserve each complete path segment, including mixed static text and placeholders.
 */
const pathSource = (operation: Operation, inputs: ReadonlyMap<Parameter, string>): string =>
  operation.path
    .slice(1)
    .split("/")
    .map((segment) => {
      const parts: string[] = [];
      let end = 0;
      for (const match of segment.matchAll(/\{(?<name>[^{}]+)\}/gu)) {
        if (match.index > end) {
          parts.push(literal(decodeURIComponent(segment.slice(end, match.index))));
        }

        const parameter = operation.parameters.find(
          (entry) => entry.location === "path" && entry.wireName === match.groups?.name,
        );
        if (parameter) {
          const value = inputs.get(parameter) ?? "";
          parts.push(parameter.schema.kind === "string" ? value : `String(${value})`);
        }

        end = match.index + match[0].length;
      }
      if (end < segment.length) {
        parts.push(literal(decodeURIComponent(segment.slice(end))));
      }

      return parts.length ? parts.join(" + ") : '""';
    })
    .join(", ");

/**
 * Render scalar header and query fields in stable wire-name order.
 */
const parameterPipes = (operation: Operation, inputs: ReadonlyMap<Parameter, string>): string[] => {
  const pipes: string[] = [];
  for (const location of ["header", "query"] as const) {
    const fields = Array.sort(
      operation.parameters,
      Order.mapInput(Order.String, (parameter: Parameter) => parameter.wireName),
    )
      .filter((parameter) => parameter.location === location && parameter.schema.kind !== "array")
      .map((parameter) => {
        const name = inputs.get(parameter) ?? "";
        let value = parameter.required ? name : `Option.getOrUndefined(${name})`;
        if (location === "header" && parameter.schema.kind !== "string") {
          value = parameter.required
            ? `String(${name})`
            : `Option.getOrUndefined(Option.map(String)(${name}))`;
        }

        return parameter.wireName === value
          ? value
          : `${propertyKey(parameter.wireName)}: ${value}`;
      });
    if (fields.length) {
      pipes.push(
        `HttpClientRequest.${location === "header" ? "setHeaders" : "setUrlParams"}({${fields.join(", ")}})`,
      );
    }
  }

  return pipes;
};

/**
 * Build the direct request pipeline, mapping typed failures once at its boundary.
 */
const handlerSource = (
  operation: Operation,
  inputs: ReadonlyMap<Parameter, string>,
  multipartInputs: ReadonlyMap<MultipartField, string>,
  securityNames: readonly string[],
  reference: (pointer: string) => string,
  bodies: ReturnType<typeof requestBodyComponents>,
): string => {
  const pipes: string[] = [];
  pipes.push(...parameterPipes(operation, inputs));
  if (operation.security?.kind === "bearer") {
    pipes.push(`HttpClientRequest.bearerToken(${securityNames[0]})`);
  }

  pipes.push(`Url.appendPathSegments(${pathSource(operation, inputs)})`);
  for (const parameter of operation.parameters.filter((entry) => entry.schema.kind === "array")) {
    const input = inputs.get(parameter) ?? "";
    const value = parameter.required ? input : `Option.getOrUndefined(${input})`;
    pipes.push(
      `Effect.flatMap(Query.setArray(${literal(parameter.wireName)}, ${value}, ${parameter.explode === true}))`,
    );
  }

  const { security } = operation;
  if (security?.kind === "basic") {
    pipes.push(
      `Effect.flatMap(BuiltinAuth.basicAuth({ password: ${securityNames[1]}, username: ${securityNames[0]} }))`,
    );
  }

  if (security?.kind === "apiKey") {
    pipes.push(
      `Effect.flatMap(BuiltinAuth.${security.location}ApiKey(${literal(security.name)}, ${securityNames[0]}))`,
    );
  }

  if (operation.body?.multipart) {
    pipes.push(multipartBodySource(operation.body, multipartInputs));
  } else if (operation.body) {
    pipes.push(
      `Effect.flatMap(Body.withBody(body, bodyFile, ${operation.body.required}, ${bodies.reference(operation.body)}))`,
    );
  }

  pipes.push(
    "Effect.flatMap(Http.runRequest)",
    "Effect.mapError(Errors.toCliError)",
    `Effect.withSpan(${literal(operation.operationId)})`,
  );

  const fields = [
    "baseUrl: apiUrl",
    ...inputs.values(),
    ...securityNames,
    ...multipartInputs.values(),
    ...(operation.body?.multipart?.additionalFields === true ? ["additionalFields"] : []),
    ...(operation.body !== undefined && operation.body.multipart === undefined
      ? ["body", "bodyFile"]
      : []),
  ];

  return `({ ${Array.sort(fields, Order.String).join(", ")} }) => ${operation.method === "TRACE" ? `HttpClientRequest.make("TRACE")` : `HttpClientRequest.${operation.method.toLowerCase()}`}(apiUrl).pipe(${pipes.join(",\n")})`;
};

/**
 * Render a command with inline API inputs and specification-owned authentication flags.
 */
const operationSource = (
  operation: Operation,
  identifier: string,
  auth: ReturnType<typeof authenticationSource>,
  reference: (pointer: string) => string,
  parameters: ReturnType<typeof parameterComponents>,
  bodies: ReturnType<typeof requestBodyComponents>,
  multipart: ReturnType<typeof multipartComponents>,
) => {
  const inputs = new Map<Parameter, string>();
  const multipartInputs = new Map<MultipartField, string>();
  const local = identifierAllocator();
  for (const reserved of ["apiUrl", "baseUrl", "body", "bodyFile", "additionalFields", "files"]) {
    local(reserved);
  }
  const securityNames =
    (operation.security ? auth.names.get(operation.security.key) : undefined) ?? [];
  const securityInputs = securityNames.map((entry) => local(entry));
  const flags = new Map([["baseUrl", "Url.baseUrl"]]);
  for (const [index, source] of securityNames.entries()) {
    flags.set(securityInputs[index] ?? source, `SecuritySchemes.${source}`);
  }
  for (const parameter of operation.parameters) {
    const input = local(parameter.flagName);
    inputs.set(parameter, input);
    flags.set(input, parameters.reference(parameter));
  }
  if (operation.body?.multipart) {
    for (const field of operation.body.multipart.fields) {
      const input = local(field.flagName);
      multipartInputs.set(field, input);
      flags.set(input, multipart.field(operation.body, field));
    }
    if (operation.body.multipart.additionalFields) {
      flags.set(
        "additionalFields",
        'Flag.String("additional-fields").pipe(Flag.withSchema(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))), Flag.withDescription("Additional multipart text fields as a JSON object; declared names cannot be overridden."), Flag.optional)',
      );
    }
  } else if (operation.body) {
    const help = description(operation.body.docs);
    flags.set(
      "body",
      `Flag.String("body").pipe(Flag.mapEffect((value) => Schema.decodeUnknownEffect(Schema.fromJsonString(${bodies.reference(operation.body)}))(value, { onExcessProperty: "error", reportInput: false }).pipe(Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })))), Flag.withDescription(${literal(help)}), Flag.optional)`,
    );
    flags.set(
      "bodyFile",
      'Flag.String("body-file").pipe(Flag.withDescription("Read a JSON request body from a file; exclusive with --body."), Flag.optional)',
    );
  }

  const fields =
    (operation.body?.multipart ? multipart.empty(operation.body) : "") +
    Array.sort([...flags.keys()], Order.String)
      .map((key) => `${key}: ${flags.get(key)}`)
      .join(",\n");
  const help = description(operation.docs);

  return `${comment(operation.docs)}const ${identifier} = Command.make(${literal(operation.commandPath.at(-1) ?? "")}, {${fields}}, ${handlerSource(operation, inputs, multipartInputs, securityInputs, reference, bodies)})${help ? `.pipe(Command.withDescription(${literal(help)}))` : ""};`;
};

/**
 * Select imports from the capabilities emitted by the command module.
 */
const commandImports = (
  model: ApiModel,
  reference: (pointer: string) => string,
  hasAuth: boolean,
  parameters: ReturnType<typeof parameterComponents>,
  bodies: ReturnType<typeof requestBodyComponents>,
  multipart: ReturnType<typeof multipartComponents>,
): readonly string[] => {
  const needsBody = model.operations.some(
    (operation) => operation.body !== undefined && operation.body.multipart === undefined,
  );
  const needsMultipart = model.operations.some((operation) => operation.body?.multipart);
  const needsAuthBuiltin = model.operations.some(
    (operation) => operation.security !== undefined && operation.security.kind !== "bearer",
  );
  const needsOption =
    needsMultipart ||
    model.operations.some((operation) =>
      operation.parameters.some((parameter) => !parameter.required),
    );
  const effectImports = [
    "Effect",
    ...(needsOption ? ["Option"] : []),
    ...(model.operations.some(
      (operation) =>
        (operation.body !== undefined && !operation.body.multipart) ||
        operation.body?.multipart?.additionalFields === true ||
        (!multipart.shared(operation.body) &&
          operation.body?.multipart?.fields.some((field) =>
            multipartFlagSource(field, operation.body?.required === true, reference).includes(
              "Schema.",
            ),
          ) === true) ||
        operation.parameters.some(
          (parameter) =>
            !parameter.reference && parameterSource(parameter, reference).includes("Schema."),
        ),
    )
      ? ["Schema"]
      : []),
  ];
  const cliImports = [
    ...(needsBody ? ["CliError"] : []),
    "Command",
    ...(model.operations.some(
      (operation) =>
        operation.parameters.some(
          (parameter) =>
            !parameter.reference ||
            description(parameter.docs) !== description(parameter.reference.parameter.docs),
        ) ||
        (operation.body !== undefined &&
          (operation.body.multipart === undefined ||
            operation.body.multipart.fields.some(
              (field) =>
                !multipart.shared(operation.body) ||
                (operation.body?.required === false && field.required),
            ) ||
            operation.body.multipart.additionalFields)),
    )
      ? ["Flag"]
      : []),
  ];
  const imports = [
    `import { ${effectImports.join(", ")} } from "effect";`,
    `import { ${cliImports.join(", ")} } from "effect/cli";`,
    'import { HttpClientRequest } from "effect/http";',
    ...(hasAuth ? ['import * as SecuritySchemes from "./components/security-schemes.js";'] : []),
    ...(needsAuthBuiltin ? ['import * as BuiltinAuth from "./builtins/auth.js";'] : []),
    ...(needsBody ? ['import * as Body from "./builtins/body.js";'] : []),
    ...(needsMultipart ? ['import * as Multipart from "./builtins/multipart.js";'] : []),
    'import * as Errors from "./builtins/errors.js";',
    'import * as Http from "./builtins/http.js";',
    'import * as Url from "./builtins/url.js";',
    ...(model.operations.some((operation) =>
      operation.parameters.some((parameter) => parameter.schema.kind === "array"),
    )
      ? ['import * as Query from "./builtins/query.js";']
      : []),
    ...(model.operations.some(
      (operation) =>
        operation.parameters.some(
          (parameter) => !parameter.reference && hasSchemaReference(parameter.schema),
        ) ||
        (operation.body?.multipart
          ? !multipart.shared(operation.body) &&
            operation.body.multipart.fields.some(
              (field) => multipartUsesSchema(field) && hasSchemaReference(field.schema),
            )
          : operation.body !== undefined &&
            !operation.body.reference &&
            hasSchemaReference(operation.body.schema)),
    )
      ? ['import * as Schemas from "./components/schemas.js";']
      : []),
    ...(multipart.source === undefined
      ? []
      : ['import * as MultipartComponents from "./components/multipart.js";']),
    ...(parameters.source === undefined
      ? []
      : ['import * as Parameters from "./components/parameters.js";']),
    ...(bodies.source === undefined
      ? []
      : ['import * as RequestBodies from "./components/request-bodies.js";']),
  ];

  return imports;
};

/**
 * Render operation/group declarations and a separate root runtime assembly.
 */
export const commandSource = (
  model: ApiModel,
  name: string,
  reference: (pointer: string) => string,
  parameters: ReturnType<typeof parameterComponents>,
  bodies: ReturnType<typeof requestBodyComponents>,
  multipart: ReturnType<typeof multipartComponents>,
) => {
  const auth = authenticationSource(model);
  const allocate = identifierAllocator();
  const declarations: string[] = [];
  const entries: { path: readonly string[]; name: string; deprecated: boolean }[] = [];
  for (const operation of model.operations) {
    const identifier = allocate(operation.operationId, "Command");
    declarations.push(
      operationSource(operation, identifier, auth, reference, parameters, bodies, multipart),
    );
    entries.push({
      deprecated: operation.docs.deprecated === true,
      name: identifier,
      path: operation.commandPath,
    });
  }
  const groups = new Map<string, readonly string[]>();
  for (const operation of model.operations) {
    for (let length = 1; length < operation.commandPath.length; length += 1) {
      const path = operation.commandPath.slice(0, length);
      groups.set(JSON.stringify(path), path);
    }
  }
  const ordered = Array.sort(
    [...groups.values()],
    (a: readonly string[], b: readonly string[]) =>
      Order.Number(b.length, a.length) || Order.String(JSON.stringify(a), JSON.stringify(b)),
  );
  for (const path of ordered) {
    const identifier = allocate(path.join(" "), "Command", true);
    const children = entries.filter(
      (entry) =>
        entry.path.length === path.length + 1 &&
        path.every((segment, index) => entry.path[index] === segment),
    );
    declarations.push(
      `${path.length === 1 ? "export " : ""}const ${identifier} = Command.make(${literal(path.at(-1) ?? "")}).pipe(Command.withSubcommands([${children.map((entry) => internalReference(entry.name, entry.deprecated)).join(", ")}]));`,
    );
    entries.push({ deprecated: false, name: identifier, path });
  }
  const roots = entries.filter((entry) => entry.path.length === 1);
  // Operations at the root are cross-module contracts too.
  for (const root of roots) {
    const index = declarations.findIndex((line) => line.includes(`const ${root.name} =`));
    const declaration = declarations[index];
    if (declaration !== undefined && !declaration.includes(`export const ${root.name}`)) {
      declarations[index] = declaration.replace(
        `const ${root.name} =`,
        `export const ${root.name} =`,
      );
    }
  }
  const imports = commandImports(
    model,
    reference,
    auth.source !== undefined,
    parameters,
    bodies,
    multipart,
  );
  const main = `#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import * as Commands from "./commands.js";

/** Assemble the API command tree and provide the Node runtime services. */
const rootCommand = Command.make(${literal(name)}).pipe(${model.description === undefined ? "" : `Command.withDescription(${literal(model.description)}),`}Command.withSubcommands([${roots.map((entry) => internalReference(`Commands.${entry.name}`, entry.deprecated)).join(", ")} ]));

Command.run(rootCommand, { version: "0.0.0" }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp), Effect.provide(NodeServices.layer), NodeRuntime.runMain({ disableErrorReporting: true }));
`;

  return {
    auth: auth.source,
    commands: `${imports.join("\n")}\n\n${declarations.join("\n\n")}\n`,
    main,
  };
};
