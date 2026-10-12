import { Array as EffectArray, Effect, Order, Schema } from "effect";
import { GenerationError } from "./errors.js";
import type { Documentation, JsonScalar, WireSchema } from "./model.js";
import { pointerSegment, resolveReference } from "./references.js";

/**
 * The annotation accumulator used while decoding schema documentation.
 */
type MutableDocumentation = { -readonly [K in keyof Documentation]: Documentation[K] };

/**
 * Recognizes schema objects without treating arrays as records.
 *
 * @param value The untrusted JSON member.
 * @returns Whether the value is a JSON object.
 */
const record = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Schema.is(Schema.JsonObject)(value);

/**
 * Schema annotations that do not impose additional wire validation.
 */
const annotations = new Set([
  "title",
  "description",
  "deprecated",
  "default",
  "example",
  "examples",
  "externalDocs",
  "$comment",
]);

/**
 * Schema keywords represented by the supported WireSchema model.
 */
const structural = new Set([
  "type",
  "nullable",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
]);

/**
 * Recognizes metadata fields that do not alter validation.
 *
 * @param key The source keyword.
 * @returns Whether the field is an annotation or extension.
 */
const annotation = (key: string) => annotations.has(key) || key.startsWith("x-");

/**
 * Reports an invalid or unsupported schema constraint.
 *
 * @param location The source JSON Pointer.
 * @param message The violated constraint.
 * @param code The diagnostic category.
 * @returns A typed failed generation effect.
 */
const invalid = (
  location: string,
  message: string,
  code: "invalid_input" | "unsupported" = "invalid_input",
) =>
  Effect.fail(
    new GenerationError({
      code,
      hint:
        code === "unsupported"
          ? "Use the documented primitive, object, array and enum schema subset."
          : "Correct the value at this JSON Pointer.",
      location,
      message,
    }),
  );

/**
 * Decodes schema annotations while preserving their exact text.
 *
 * @param input The source schema object.
 * @param location Its JSON Pointer.
 * @returns Validated documentation for source emission.
 */
const documentation = (
  input: Schema.JsonObject,
  location: string,
): Effect.Effect<Documentation, GenerationError> =>
  Effect.gen(function* decodeSchemaDocumentation() {
    const docs: MutableDocumentation = {};
    for (const key of ["deprecated", "description", "externalDocs", "title"] as const) {
      if (!Object.hasOwn(input, key)) {
        continue;
      }

      const value = input[key];
      if (key === "deprecated") {
        if (!Schema.is(Schema.Boolean)(value)) {
          return yield* invalid(`${location}/${key}`, "Expected a boolean.");
        }

        docs.deprecated = value;
      } else if (key === "externalDocs") {
        if (!record(value)) {
          return yield* invalid(`${location}/${key}`, "Expected external documentation object.");
        }

        if (Object.hasOwn(value, "description") && !Schema.is(Schema.String)(value.description)) {
          return yield* invalid(`${location}/${key}/description`, "Expected a string.");
        }

        if (!Schema.is(Schema.String)(value.url)) {
          return yield* invalid(`${location}/${key}/url`, "Expected a URL string.");
        }

        docs.externalDocs = {
          url: value.url,
        };
        if (Schema.is(Schema.String)(value.description)) {
          docs.externalDocs = { ...docs.externalDocs, description: value.description };
        }
      } else {
        if (!Schema.is(Schema.String)(value)) {
          return yield* invalid(`${location}/${key}`, "Expected a string.");
        }

        docs[key] = value;
      }
    }

    return docs;
  });

/**
 * Resolves primitive type and nullability according to the OpenAPI dialect.
 *
 * @param schema The source schema.
 * @param location Its JSON Pointer.
 * @param version The OpenAPI dialect.
 * @returns The supported kind and explicit nullable flag.
 */
const schemaKind = (schema: Schema.JsonObject, location: string, version: "3.0" | "3.1") =>
  Effect.gen(function* decodeSchemaKind() {
    let kind: Schema.Json | undefined = schema.type;
    let nullable = false;
    if (Schema.is(Schema.Array(Schema.Json))(kind)) {
      if (version !== "3.1" || kind.length !== 2 || !kind.includes("null") || kind[0] === kind[1]) {
        return yield* invalid(
          `${location}/type`,
          "Only one type plus null is supported.",
          "unsupported",
        );
      }

      kind = kind.find((entry) => entry !== "null");
      nullable = true;
    }

    if (
      kind !== "string" &&
      kind !== "number" &&
      kind !== "integer" &&
      kind !== "boolean" &&
      kind !== "null" &&
      kind !== "object" &&
      kind !== "array"
    ) {
      return yield* invalid(
        `${location}/type`,
        "Expected an explicit supported type.",
        "unsupported",
      );
    }

    if (kind === "null") {
      if (version === "3.0") {
        return yield* invalid(
          `${location}/type`,
          "OpenAPI 3.0 does not support null type.",
          "unsupported",
        );
      }

      nullable = true;
    }

    if (Object.hasOwn(schema, "nullable")) {
      if (version !== "3.0") {
        return yield* invalid(
          `${location}/nullable`,
          "OpenAPI 3.1 uses null types instead of nullable.",
          "unsupported",
        );
      }

      if (!Schema.is(Schema.Boolean)(schema.nullable)) {
        return yield* invalid(`${location}/nullable`, "Expected a boolean.");
      }

      ({ nullable } = schema);
    }

    return { kind, nullable } satisfies { kind: WireSchema["kind"]; nullable: boolean };
  });

/**
 * Decodes an enum member without coercion.
 *
 * @param value The original enum value.
 * @param location Its source pointer.
 * @returns The same scalar value or a typed failure.
 */
const scalar = (value: Schema.Json, location: string): Effect.Effect<JsonScalar, GenerationError> =>
  Schema.decodeUnknownEffect(
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  )(value).pipe(
    Effect.mapError(
      () =>
        new GenerationError({
          code: "invalid_input",
          hint: "Use a scalar enum.",
          location,
          message: "Expected a scalar.",
        }),
    ),
  );

/**
 * Checks whether an enum value belongs to the declared primitive domain.
 *
 * @param value The original JSON value.
 * @param kind The declared primitive kind.
 * @param nullable Whether null is allowed by the schema.
 * @returns Whether the enum member respects type and nullability.
 */
const scalarMatches = (value: Schema.Json, kind: string, nullable: boolean): boolean => {
  if (value === null) {
    return nullable;
  }

  if (kind === "integer") {
    return Schema.is(Schema.Number)(value) && Number.isInteger(value);
  }

  if (kind === "number") {
    return Schema.is(Schema.Number)(value) && Number.isFinite(value);
  }

  if (kind === "string") {
    return Schema.is(Schema.String)(value);
  }

  return kind === "boolean" && Schema.is(Schema.Boolean)(value);
};

/**
 * Validates unique scalar enum members against type and nullability.
 *
 * @param schema The source schema.
 * @param location Its JSON Pointer.
 * @param kind The resolved primitive kind.
 * @param nullable Whether the type permits null.
 * @returns Exact enum values, or undefined when no enum is declared.
 */
const enumValues = (schema: Schema.JsonObject, location: string, kind: string, nullable: boolean) =>
  Effect.gen(function* decodeEnumValues() {
    let values: JsonScalar[] | undefined;
    if (Object.hasOwn(schema, "enum")) {
      if (!Schema.is(Schema.Array(Schema.Json))(schema.enum) || schema.enum.length === 0) {
        return yield* invalid(`${location}/enum`, "Expected a nonempty scalar enum.");
      }

      values = [];
      for (const [index, value] of schema.enum.entries()) {
        const matches = scalarMatches(value, kind, nullable);
        if (!matches || values.some((entry) => entry === value)) {
          return yield* invalid(
            `${location}/enum/${index}`,
            "Enum values must be unique and match the declared type and nullability.",
          );
        }

        values.push(yield* scalar(value, `${location}/enum/${index}`));
      }
    }

    return values;
  });

/**
 * Normalizes object fields, requiredness, and boolean additional-properties policy.
 *
 * @param document The complete source document.
 * @param schema The decoded object schema.
 * @param location Its source pointer.
 * @param version The OpenAPI dialect.
 * @param activeRefs The current reference ancestry.
 * @param docs Validated schema annotations.
 * @param nullable Whether the object permits null.
 * @param normalizeChild The recursive field normalizer.
 * @returns An object wire schema or a typed unsupported-input failure.
 */
const objectSchema = (
  document: Schema.Json,
  schema: Schema.JsonObject,
  location: string,
  version: "3.0" | "3.1",
  activeRefs: ReadonlySet<string>,
  docs: Documentation,
  nullable: boolean,
  normalizeChild: typeof normalizeSchema,
): Effect.Effect<WireSchema, GenerationError> =>
  Effect.gen(function* normalizeObjectSchema() {
    if (Object.hasOwn(schema, "enum")) {
      return yield* invalid(`${location}/enum`, "Object enums are unsupported.", "unsupported");
    }

    if (
      Object.hasOwn(schema, "additionalProperties") &&
      !Schema.is(Schema.Boolean)(schema.additionalProperties)
    ) {
      return yield* invalid(
        `${location}/additionalProperties`,
        "Only boolean additionalProperties is supported.",
        "unsupported",
      );
    }

    const properties = Object.hasOwn(schema, "properties") ? schema.properties : {};
    if (!record(properties)) {
      return yield* invalid(`${location}/properties`, "Expected a properties object.");
    }

    const required = Object.hasOwn(schema, "required") ? schema.required : [];
    if (!Schema.is(Schema.Array(Schema.Json))(required)) {
      return yield* invalid(`${location}/required`, "Expected an array of property names.");
    }

    const seen = new Set<string>();
    for (const [index, name] of required.entries()) {
      if (!Schema.is(Schema.String)(name) || seen.has(name) || !Object.hasOwn(properties, name)) {
        return yield* invalid(
          `${location}/required/${index}`,
          "Required names must be unique declared properties.",
        );
      }

      seen.add(name);
    }
    const normalized: { name: string; required: boolean; schema: WireSchema }[] = [];
    for (const name of EffectArray.sort(Object.keys(properties), Order.String)) {
      normalized.push({
        name,
        required: seen.has(name),
        schema: yield* normalizeChild(
          document,
          properties[name],
          `${location}/properties/${pointerSegment(name)}`,
          version,
          activeRefs,
        ),
      });
    }

    return {
      additionalProperties: schema.additionalProperties !== false,
      docs,
      kind: "object",
      nullable,
      properties: normalized,
    };
  });

/**
 * Normalizes a supported request schema and rejects constraints it cannot preserve.
 *
 * @param document The complete source document.
 * @param schema The untrusted schema member.
 * @param location Its source pointer.
 * @param version The OpenAPI dialect.
 * @param activeRefs The current canonical reference ancestry.
 * @returns A wire schema with exact primitive, enum, object, and array semantics.
 */
export const normalizeSchema = (
  document: Schema.Json,
  schema: Schema.Json | undefined,
  location: string,
  version: "3.0" | "3.1",
  activeRefs: ReadonlySet<string> = new Set(),
): Effect.Effect<WireSchema, GenerationError> =>
  Effect.gen(function* normalizeWireSchema() {
    if (!record(schema)) {
      return yield* invalid(location, "Expected a schema object.");
    }

    const hasRef = Object.hasOwn(schema, "$ref");
    for (const key of EffectArray.sort(Object.keys(schema), Order.String)) {
      if (key === "$ref") {
        continue;
      }

      if (!annotation(key) && (hasRef || !structural.has(key))) {
        return yield* invalid(
          `${location}/${pointerSegment(key)}`,
          `Unsupported schema keyword: ${key}.`,
          "unsupported",
        );
      }
    }
    const docs = yield* documentation(schema, location);
    if (hasRef) {
      if (!Schema.is(Schema.String)(schema.$ref)) {
        return yield* invalid(`${location}/$ref`, "Expected a reference string.");
      }

      const resolved = yield* resolveReference(
        document,
        schema.$ref,
        `${location}/$ref`,
        activeRefs,
      );
      const result = yield* normalizeSchema(
        document,
        resolved.value,
        resolved.location,
        version,
        resolved.activeRefs,
      );

      return { ...result, docs: { ...result.docs, ...docs } };
    }

    const { kind, nullable } = yield* schemaKind(schema, location, version);
    for (const key of ["additionalProperties", "items", "properties", "required"]) {
      if (Object.hasOwn(schema, key) && (key === "items" ? kind !== "array" : kind !== "object")) {
        return yield* invalid(
          `${location}/${key}`,
          `Keyword ${key} is incompatible with type ${kind}.`,
          "unsupported",
        );
      }
    }
    if (kind === "object") {
      return yield* objectSchema(
        document,
        schema,
        location,
        version,
        activeRefs,
        docs,
        nullable,
        normalizeSchema,
      );
    }

    if (kind === "array") {
      if (Object.hasOwn(schema, "enum")) {
        return yield* invalid(`${location}/enum`, "Array enums are unsupported.", "unsupported");
      }

      return {
        docs,
        items: yield* normalizeSchema(
          document,
          schema.items,
          `${location}/items`,
          version,
          activeRefs,
        ),
        kind,
        nullable,
      };
    }

    const values = yield* enumValues(schema, location, kind, nullable);

    return { docs, enum: values, kind, nullable };
  });
