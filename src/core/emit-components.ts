import { Array, Order } from "effect";
import { identifierAllocator } from "./identifiers.js";
import { parameterHelp, parameterSource } from "./emit-flag.js";
import { hasSchemaReference, schemaSource } from "./emit-schema.js";
import type { ApiModel, Parameter, RequestBody } from "./model.js";
import { comment, description, internalReference, literal } from "./source-text.js";

/**
 * Allocate category-local names from explicit pointers, never structural equality.
 */
const componentNames = (pointers: readonly string[]) => {
  const allocate = identifierAllocator();

  return new Map(
    Array.sort(pointers, Order.String).map((pointer) => [
      pointer,
      allocate(
        (pointer.split("/").at(-1) ?? "Component").replaceAll("~1", "/").replaceAll("~0", "~"),
        "",
        true,
      ),
    ]),
  );
};

/**
 * Apply reference-site help while retaining the canonical shared flag.
 */
const parameterUse = (parameter: Parameter, name: string): string => {
  const target = parameter.reference?.parameter;
  const value = internalReference(name, target?.docs.deprecated === true);

  return target && description(parameter.docs) !== description(target.docs)
    ? `${value}.pipe(Flag.withDescription(${literal(parameterHelp(parameter))}))`
    : value;
};

/**
 * Keep explicit parameter aliases and definitions in their source category.
 */
export const parameterComponents = (
  model: ApiModel,
  schemaReference: (pointer: string) => string,
) => {
  const definitions = new Map<string, Parameter>();
  const visit = (parameter: Parameter): void => {
    if (parameter.reference && !definitions.has(parameter.reference.pointer)) {
      visit(parameter.reference.parameter);
      definitions.set(parameter.reference.pointer, parameter.reference.parameter);
    }
  };
  for (const operation of model.operations) {
    for (const parameter of operation.parameters) {
      visit(parameter);
    }
  }
  const names = componentNames([...definitions.keys()]);
  const entries = [...definitions].map(
    ([pointer, parameter]) =>
      `${comment(parameter.docs)}export const ${names.get(pointer)} = ${parameter.reference ? parameterUse(parameter, names.get(parameter.reference.pointer) ?? "") : parameterSource(parameter, schemaReference)};`,
  );
  const usesSchema = [...definitions.values()].some(
    (parameter) =>
      !parameter.reference &&
      (parameter.schema.kind === "array" ||
        (parameter.schema.reference === undefined && (parameter.schema.checks?.length ?? 0) > 0)),
  );
  const usesSchemas = [...definitions.values()].some(
    (parameter) => !parameter.reference && hasSchemaReference(parameter.schema),
  );

  return {
    reference: (parameter: Parameter): string =>
      parameter.reference
        ? parameterUse(parameter, `Parameters.${names.get(parameter.reference.pointer)}`)
        : parameterSource(parameter, schemaReference),
    source: entries.length
      ? `${usesSchema ? 'import { Schema } from "effect";\n' : ""}import { Flag } from "effect/cli";\n${usesSchemas ? 'import * as Schemas from "./schemas.js";\n' : ""}\n${entries.join("\n\n")}`
      : undefined,
  };
};

/**
 * Reuse explicit JSON request-body validators; requiredness and encoding stay in handlers.
 */
export const requestBodyComponents = (
  model: ApiModel,
  schemaReference: (pointer: string) => string,
  schemaName: (pointer: string) => string,
) => {
  const definitions = new Map<string, RequestBody>();
  const visit = (body: RequestBody): void => {
    if (body.reference && !definitions.has(body.reference.pointer)) {
      visit(body.reference.body);
      definitions.set(body.reference.pointer, body.reference.body);
    }
  };
  for (const operation of model.operations) {
    if (operation.body && !operation.body.multipart) {
      visit(operation.body);
    }
  }
  const names = componentNames([...definitions.keys()]);
  const entries = [...definitions].map(([pointer, body]) => {
    const name = names.get(pointer);
    if (body.reference) {
      return `${comment(body.docs)}export const ${name} = ${internalReference(names.get(body.reference.pointer) ?? "", body.reference.body.docs.deprecated === true)};`;
    }

    if (body.schema.reference) {
      const target = schemaName(body.schema.reference.pointer);

      return `${comment(body.docs)}${body.schema.docs.deprecated === true ? "// oxlint-disable-next-line typescript/no-deprecated -- Preserve the supported upstream schema identity.\n" : ""}export const { ${target}${target === name ? "" : `: ${name}`} } = Schemas;`;
    }

    return `${comment(body.docs)}export const ${name} = ${schemaSource(body.schema, schemaReference)};`;
  });
  const schemas = [...definitions.values()].some(
    (body) => !body.reference && hasSchemaReference(body.schema),
  );
  const native = [...definitions.values()].some(
    (body) => !body.reference && body.schema.reference === undefined,
  );

  return {
    reference: (body: RequestBody) =>
      body.reference && !body.multipart
        ? internalReference(
            `RequestBodies.${names.get(body.reference.pointer)}`,
            body.reference.body.docs.deprecated === true,
          )
        : schemaSource(body.schema, schemaReference),
    source: entries.length
      ? `${native ? 'import { Schema } from "effect";\n' : ""}${schemas ? 'import * as Schemas from "./schemas.js";\n' : ""}\n${entries.join("\n\n")}`
      : undefined,
  };
};
