import { Array, Order, RegExp as EffectRegExp } from "effect";
import type { WireSchema } from "./model.js";
import { comment, internalReference, literal, propertyKey } from "./source-text.js";

/**
 * Emit the exact validated regex as a Unicode literal, escaping literal delimiters.
 */
const regexSource = (pattern: string): string => new RegExp(pattern, "u").toString();

/**
 * Determine null acceptance independently from non-null native checks.
 */
const nullableSchema = (schema: WireSchema): boolean =>
  schema.kind !== "json" &&
  schema.kind !== "null" &&
  ("enum" in schema && schema.enum !== undefined ? schema.enum.includes(null) : schema.nullable);

/**
 * Additional-property validation applies only to keys absent from the declared property map.
 */
const additionalKeySource = (schema: Extract<WireSchema, { kind: "object" }>): string => {
  if (schema.additionalProperties === true || schema.properties.length === 0) {
    return "Schema.String";
  }

  const keys = schema.properties.map((property) => EffectRegExp.escape(property.name)).join("|");

  return `Schema.String.check(Schema.isPattern(${regexSource(String.raw`^(?!(?:${keys})(?![\s\S]))`)}))`;
};

/**
 * Render explicit object fields and their additional-property contract.
 */
const objectSource = (
  schema: Extract<WireSchema, { kind: "object" }>,
  reference: (pointer: string) => string,
  render: typeof schemaSource,
): string => {
  const fields = Array.sort(
    schema.properties,
    Order.mapInput(Order.String, (property: { readonly name: string }) => property.name),
  )
    .map((property) => {
      const documentation = comment(property.schema.docs);
      const registrationNotice =
        property.schema.docs.deprecated === true
          ? "// oxlint-disable-next-line typescript/no-deprecated -- Required schema registration for a supported deprecated API field.\n"
          : "";
      const schemaExpression = render(property.schema, reference);
      const validator = property.required
        ? schemaExpression
        : `Schema.optionalKey(${schemaExpression})`;

      return `${documentation}${registrationNotice}${propertyKey(property.name)}: ${validator}`;
    })
    .join(",\n");
  const struct =
    schema.properties.length === 0 && schema.additionalProperties === false
      ? "Schema.Record(Schema.String, Schema.Never)"
      : `Schema.Struct({${fields}})`;

  return schema.additionalProperties === false
    ? struct
    : `Schema.StructWithRest(${struct}, [Schema.Record(${additionalKeySource(schema)}, ${schema.additionalProperties === true ? "Schema.Json" : render(schema.additionalProperties, reference)})])`;
};

/**
 * Renders the normalized wire schema as a native Effect validator.
 * Property keys retain exact spelling, including prototype-sensitive names.
 *
 * @param schema The validated supported schema and its documentation.
 * @returns A TypeScript expression preserving required fields and allowed JSON values.
 */
export const schemaSource = (
  schema: WireSchema,
  reference: (pointer: string) => string = () => "",
): string => {
  const referenced = schema.reference === undefined ? "" : reference(schema.reference.pointer);
  if (referenced) {
    return internalReference(referenced, schema.docs.deprecated === true);
  }

  let expression: string;
  switch (schema.kind) {
    case "json": {
      expression = "Schema.Json";
      break;
    }
    case "union": {
      expression = `Schema.Union([${schema.members.map((member) => schemaSource(member, reference)).join(", ")}])`;
      break;
    }
    case "oneOf": {
      expression = `Schema.Union([${schema.members.map((member) => schemaSource(member, reference)).join(", ")}], { mode: "oneOf" })`;
      break;
    }
    case "object": {
      expression = objectSource(schema, reference, schemaSource);
      break;
    }
    case "array": {
      expression = `Schema.Array(${schemaSource(schema.items, reference)})`;
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
      const values = schema.enum?.filter((value) => value !== null);
      expression =
        values === undefined
          ? `Schema.${names[schema.kind]}`
          : `Schema.Literals(${literal(values)})`;
      break;
    }
    default: {
      return schema;
    }
  }

  if (schema.checks && schema.checks.length > 0) {
    expression += `.check(${schema.checks.map((check) => `Schema.${check.name}(${check.name === "isPattern" ? regexSource(String(check.value)) : literal(check.value)})`).join(", ")})`;
  }

  const allowsNull = nullableSchema(schema);

  return allowsNull ? `Schema.NullOr(${expression})` : expression;
};

/**
 * Whether rendering this schema consumes an explicit shared schema declaration.
 */
export const hasSchemaReference = (schema: WireSchema): boolean => {
  if (schema.reference) {
    return true;
  }

  if (schema.kind === "array") {
    return hasSchemaReference(schema.items);
  }

  if (schema.kind === "object") {
    return (
      schema.properties.some((field) => hasSchemaReference(field.schema)) ||
      (schema.additionalProperties !== true &&
        schema.additionalProperties !== false &&
        hasSchemaReference(schema.additionalProperties))
    );
  }

  return (
    (schema.kind === "oneOf" || schema.kind === "union") && schema.members.some(hasSchemaReference)
  );
};
