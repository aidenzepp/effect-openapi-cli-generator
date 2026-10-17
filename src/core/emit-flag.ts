import type { Parameter } from "./model.js";
import { schemaSource } from "./emit-schema.js";
import { description, literal } from "./source-text.js";

/**
 * Render one API flag with its schema and source-owned help at the command boundary.
 */
export const parameterSource = (
  parameter: Parameter,
  reference: (pointer: string) => string,
): string => {
  const { schema } = parameter;
  let source = `Flag.String(${literal(parameter.flagName)})`;
  if (schema.kind === "string" && schema.enum !== undefined) {
    source = `Flag.Literals(${literal(parameter.flagName)}, ${literal(schema.enum)})`;
  } else if (schema.kind === "integer") {
    source = `Flag.Int(${literal(parameter.flagName)})`;
  } else if (schema.kind === "number") {
    source = `Flag.Finite(${literal(parameter.flagName)})`;
  } else if (schema.kind === "boolean") {
    source = `Flag.Literals(${literal(parameter.flagName)}, ["true", "false"]).pipe(Flag.map((value) => value === "true"))`;
  }

  const constrained = schema.reference !== undefined || (schema.checks?.length ?? 0) > 0;
  const pipes: string[] = [];
  if (schema.kind === "array") {
    pipes.push(
      `Flag.withSchema(Schema.fromJsonString(${schemaSource(schema, reference)}))`,
      'Flag.withMetavar("JSON_ARRAY")',
    );
  } else if (constrained) {
    pipes.push(`Flag.withSchema(${schemaSource(schema, reference)})`);
  }

  const help = description(parameter.docs);
  if (help) {
    pipes.push(`Flag.withDescription(${literal(help)})`);
  }

  if (!parameter.required) {
    pipes.push("Flag.optional");
  }

  return pipes.length > 0 ? `${source}.pipe(${pipes.join(",\n")})` : source;
};
