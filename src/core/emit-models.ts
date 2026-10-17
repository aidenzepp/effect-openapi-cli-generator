import { Array, Order } from "effect";
import { identifierAllocator } from "./identifiers.js";
import { schemaSource } from "./emit-schema.js";
import type { ApiModel, WireSchema } from "./model.js";
import { comment } from "./source-text.js";

/**
 * Collect explicit request references only, with dependency declarations preceding consumers.
 */
export const modelSource = (model: ApiModel) => {
  const definitions = new Map<string, WireSchema>();
  const external = new Set<string>();
  const visit = (schema: WireSchema, exported: boolean): void => {
    if (schema.reference) {
      const { pointer, schema: target } = schema.reference;
      if (exported) {
        external.add(pointer);
      }

      if (!definitions.has(pointer)) {
        visit(target, false);
        definitions.set(pointer, target);
      }

      return;
    }

    if (schema.kind === "object") {
      for (const field of schema.properties) {
        visit(field.schema, exported);
      }
      if (schema.additionalProperties !== true && schema.additionalProperties !== false) {
        visit(schema.additionalProperties, exported);
      }
    } else if (schema.kind === "array") {
      visit(schema.items, exported);
    } else if (schema.kind === "oneOf") {
      for (const member of schema.members) {
        visit(member, exported);
      }
    }
  };
  for (const operation of model.operations) {
    for (const parameter of operation.parameters) {
      visit(parameter.schema, true);
    }
    if (operation.body) {
      visit(operation.body.schema, true);
    }
  }
  const allocate = identifierAllocator();
  const names = new Map(
    Array.sort([...definitions.keys()], Order.String).map((pointer) => [
      pointer,
      allocate(
        (pointer.split("/").at(-1) ?? "Model").replaceAll("~1", "/").replaceAll("~0", "~"),
        "",
        true,
      ),
    ]),
  );
  const reference = (pointer: string) => names.get(pointer) ?? "";
  const declarations = [...definitions].map(
    ([pointer, schema]) =>
      `${comment(schema.docs)}${external.has(pointer) ? "export " : ""}const ${reference(pointer)} = ${schemaSource(schema, reference)};`,
  );

  return {
    reference: (pointer: string) => `Models.${reference(pointer)}`,
    source:
      declarations.length > 0
        ? `import { Schema } from "effect";\n\n${declarations.join("\n\n")}\n`
        : undefined,
  };
};
