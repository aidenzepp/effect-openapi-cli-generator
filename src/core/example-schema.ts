import type { SchemaAST } from "effect";
import { RegExp as EffectRegExp, Schema } from "effect";
import type { WireSchema } from "./model.js";

const checkedSchema = (wire: WireSchema, initial: Schema.Codec<unknown>): Schema.Codec<unknown> => {
  let schema = initial;
  const checks = {
    isGreaterThan: Schema.isGreaterThan,
    isGreaterThanOrEqualTo: Schema.isGreaterThanOrEqualTo,
    isLessThan: Schema.isLessThan,
    isLessThanOrEqualTo: Schema.isLessThanOrEqualTo,
    isMaxCodePoints: Schema.isMaxCodePoints,
    isMaxLength: Schema.isMaxLength,
    isMinCodePoints: Schema.isMinCodePoints,
    isMinLength: Schema.isMinLength,
    isMultipleOf: Schema.isMultipleOf,
  };
  for (const check of wire.checks ?? []) {
    const factory = Object.entries(checks).find(([name]) => name === check.name)?.[1];
    const native =
      check.name === "isPattern"
        ? Schema.isPattern(new RegExp(String(check.value), "u"))
        : factory?.(Number(check.value));
    if (native !== undefined) {
      // SAFETY: normalizeSchema verifies each check domain before this type-erased native assembly.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The normalized schema and check have the same validated domain.
      schema = schema.check(native as SchemaAST.Check<unknown>);
    }
  }
  const nullable =
    wire.kind !== "null" &&
    ("enum" in wire && wire.enum !== undefined ? wire.enum.includes(null) : wire.nullable);

  return nullable ? Schema.NullOr(schema) : schema;
};

const objectSchema = (
  wire: Extract<WireSchema, { kind: "object" }>,
  render: typeof exampleSchema,
): Schema.Codec<unknown> => {
  const fields = Object.fromEntries(
    wire.properties.map((field) => [
      field.name,
      field.required ? render(field.schema) : Schema.optionalKey(render(field.schema)),
    ]),
  );
  const struct = Schema.Struct(fields);
  if (wire.additionalProperties === false) {
    return wire.properties.length === 0 ? Schema.Record(Schema.String, Schema.Never) : struct;
  }

  const names = wire.properties.map((field) => EffectRegExp.escape(field.name)).join("|");
  const key =
    wire.additionalProperties === true || names.length === 0
      ? Schema.String
      : Schema.String.check(
          Schema.isPattern(new RegExp(String.raw`^(?!(?:${names})(?![\s\S]))`, "u")),
        );

  return Schema.StructWithRest(struct, [
    Schema.Record(
      key,
      wire.additionalProperties === true ? Schema.Json : render(wire.additionalProperties),
    ),
  ]);
};

/**
 * Build native validators from the same normalized contract used by source emission.
 */
export const exampleSchema = (wire: WireSchema): Schema.Codec<unknown> => {
  let schema: Schema.Codec<unknown>;
  switch (wire.kind) {
    case "json": {
      return Schema.Json;
    }
    case "oneOf":
    case "union": {
      schema = Schema.Union(wire.members.map(exampleSchema), {
        mode: wire.kind === "oneOf" ? "oneOf" : "anyOf",
      });
      break;
    }
    case "array": {
      schema = Schema.Array(exampleSchema(wire.items));
      break;
    }
    case "object": {
      schema = objectSchema(wire, exampleSchema);
      break;
    }
    case "boolean":
    case "integer":
    case "null":
    case "number":
    case "string": {
      const primitives = {
        boolean: Schema.Boolean,
        integer: Schema.Int,
        null: Schema.Null,
        number: Schema.Finite,
        string: Schema.String,
      };
      schema =
        wire.enum === undefined
          ? primitives[wire.kind]
          : Schema.Literals(wire.enum.filter((value) => value !== null));
      break;
    }
    default: {
      return wire;
    }
  }

  return checkedSchema(wire, schema);
};
