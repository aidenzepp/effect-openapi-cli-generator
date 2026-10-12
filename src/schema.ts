import { Effect } from "effect";
import { GenerationError } from "./errors.js";
import type { Documentation, JsonScalar, WireSchema } from "./model.js";
import { pointerSegment, resolveReference } from "./references.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
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
const structural = new Set([
  "type",
  "nullable",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
]);
const annotation = (key: string) => annotations.has(key) || key.startsWith("x-");
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

function documentation(
  input: Record<string, unknown>,
  location: string,
): Effect.Effect<Documentation, GenerationError> {
  return Effect.gen(function* () {
    const docs: {
      title?: string;
      description?: string;
      deprecated?: boolean;
      externalDocs?: { url: string; description?: string };
    } = {};
    for (const key of ["deprecated", "description", "externalDocs", "title"] as const) {
      if (!Object.hasOwn(input, key)) {
        continue;
      }
      const value = input[key];
      if (key === "deprecated") {
        if (typeof value !== "boolean") {
          return yield* invalid(`${location}/${key}`, "Expected a boolean.");
        }
        docs.deprecated = value;
      } else if (key === "externalDocs") {
        if (!record(value)) {
          return yield* invalid(`${location}/${key}`, "Expected external documentation object.");
        }
        if (Object.hasOwn(value, "description") && typeof value.description !== "string") {
          return yield* invalid(`${location}/${key}/description`, "Expected a string.");
        }
        if (typeof value.url !== "string") {
          return yield* invalid(`${location}/${key}/url`, "Expected a URL string.");
        }
        docs.externalDocs = {
          url: value.url,
          ...(typeof value.description === "string" ? { description: value.description } : {}),
        };
      } else {
        if (typeof value !== "string") {
          return yield* invalid(`${location}/${key}`, "Expected a string.");
        }
        docs[key] = value;
      }
    }
    return docs;
  });
}

export function normalizeSchema(
  document: unknown,
  schema: unknown,
  location: string,
  version: "3.0" | "3.1",
  activeRefs: ReadonlySet<string> = new Set(),
): Effect.Effect<WireSchema, GenerationError> {
  return Effect.gen(function* () {
    if (!record(schema)) {
      return yield* invalid(location, "Expected a schema object.");
    }
    const hasRef = Object.hasOwn(schema, "$ref");
    for (const key of Object.keys(schema).sort()) {
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
      if (typeof schema.$ref !== "string") {
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
    let kind: unknown = schema.type;
    let nullable = false;
    if (Array.isArray(kind)) {
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
      if (typeof schema.nullable !== "boolean") {
        return yield* invalid(`${location}/nullable`, "Expected a boolean.");
      }
      nullable = schema.nullable;
    }
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
      if (Object.hasOwn(schema, "enum")) {
        return yield* invalid(`${location}/enum`, "Object enums are unsupported.", "unsupported");
      }
      if (
        Object.hasOwn(schema, "additionalProperties") &&
        typeof schema.additionalProperties !== "boolean"
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
      if (!Array.isArray(required)) {
        return yield* invalid(`${location}/required`, "Expected an array of property names.");
      }
      const seen = new Set<string>();
      for (const [index, name] of required.entries()) {
        if (typeof name !== "string" || seen.has(name) || !Object.hasOwn(properties, name)) {
          return yield* invalid(
            `${location}/required/${index}`,
            "Required names must be unique declared properties.",
          );
        }
        seen.add(name);
      }
      const normalized: { name: string; required: boolean; schema: WireSchema }[] = [];
      for (const name of Object.keys(properties).sort()) {
        normalized.push({
          name,
          required: seen.has(name),
          schema: yield* normalizeSchema(
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
        kind,
        nullable,
        properties: normalized,
      };
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
    let values: JsonScalar[] | undefined;
    if (Object.hasOwn(schema, "enum")) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
        return yield* invalid(`${location}/enum`, "Expected a nonempty scalar enum.");
      }
      values = [];
      for (const [index, value] of schema.enum.entries()) {
        const matches =
          value === null
            ? nullable
            : kind === "integer"
              ? typeof value === "number" && Number.isInteger(value)
              : kind === "number"
                ? typeof value === "number" && Number.isFinite(value)
                : kind === "null"
                  ? false
                  : typeof value === kind;
        if (!matches || values.includes(value)) {
          return yield* invalid(
            `${location}/enum/${index}`,
            "Enum values must be unique and match the declared type and nullability.",
          );
        }
        values.push(value);
      }
    }
    return { docs, enum: values, kind, nullable };
  });
}
