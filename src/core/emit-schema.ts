import { Array } from "effect";
import type { WireSchema } from "./model.js";
import { comment, literal, propertyKey } from "./source-text.js";

/**
 * Renders the normalized wire schema as a native Effect validator.
 * Property keys retain exact spelling, including prototype-sensitive names.
 *
 * @param schema The validated supported schema and its documentation.
 * @returns A TypeScript expression preserving required fields and allowed JSON values.
 */
export const schemaSource = (schema: WireSchema): string => {
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
        .map((property) => {
          const documentation = comment(property.schema.docs);
          const registrationNotice =
            property.schema.docs.deprecated === true
              ? "// oxlint-disable-next-line typescript/no-deprecated -- Required schema registration for a supported deprecated API field.\n"
              : "";
          const schemaExpression = schemaSource(property.schema);
          const validator = property.required
            ? schemaExpression
            : `Schema.optionalKey(${schemaExpression})`;

          return `${documentation}${registrationNotice}${propertyKey(property.name)}: ${validator}`;
        })
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
