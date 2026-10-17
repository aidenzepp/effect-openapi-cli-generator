import { Array, Order, Schema } from "effect";
import type { Operation, RequestBody, WireSchema } from "./model.js";
import { description } from "./source-text.js";

/**
 * Keep JSON annotations deterministic without changing their values or property names.
 */
const orderedJson = (value: Schema.Json): Schema.Json => {
  if (Schema.is(Schema.Array(Schema.Json))(value)) {
    return value.map(orderedJson);
  }

  if (Schema.is(Schema.JsonObject)(value)) {
    return Object.fromEntries(
      Array.sort(Object.keys(value), Order.String).map((key) => [
        key,
        orderedJson(value[key] ?? null),
      ]),
    );
  }

  return value;
};

const json = (value: Schema.Json) => JSON.stringify(orderedJson(value));

/**
 * Document an explicit schema default without making an optional flag supply a value.
 */
export const defaultHelp = (
  schema: WireSchema,
  required: boolean,
  requirement = "this input is still required",
): string => {
  if (schema.docs.default === undefined) {
    return "";
  }

  return required
    ? `Declared default: ${json(schema.docs.default)}; ${requirement}.`
    : `Server default when omitted: ${json(schema.docs.default)}.`;
};

const segment = (name: string) => name.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * Use instance JSON Pointers for object fields and schema paths for array or union branches.
 */
const bodyDefaults = (body: RequestBody): readonly string[] => {
  const lines: string[] = [];
  const visit = (
    schema: WireSchema,
    pointer: string,
    schemaPath: string,
    branch: boolean,
    required: boolean,
  ): void => {
    if (schema.docs.default !== undefined) {
      const location = branch ? `Schema path ${json(schemaPath)}` : `JSON Pointer ${json(pointer)}`;
      let requirement = "";
      if (required) {
        requirement = pointer === "" ? "; body is required" : "; required in its containing object";
      }

      lines.push(`${location}: ${json(schema.docs.default)}${requirement}.`);
    }

    if (schema.kind === "object") {
      for (const property of schema.properties) {
        const name = segment(property.name);
        visit(
          property.schema,
          `${pointer}/${name}`,
          `${schemaPath}/properties/${name}`,
          branch,
          property.required,
        );
      }
      if (schema.additionalProperties !== true && schema.additionalProperties !== false) {
        visit(
          schema.additionalProperties,
          pointer,
          `${schemaPath}/additionalProperties`,
          true,
          false,
        );
      }
    } else if (schema.kind === "array") {
      visit(schema.items, pointer, `${schemaPath}/items`, true, false);
    } else if (schema.kind === "oneOf" || schema.kind === "union") {
      for (const [index, member] of schema.members.entries()) {
        visit(
          member,
          pointer,
          `${schemaPath}/${schema.kind === "oneOf" ? "oneOf" : "type"}/${index}`,
          true,
          false,
        );
      }
    }
  };
  visit(body.schema, "", "", false, body.required);

  return lines;
};

/**
 * Share nested body default help between JSON input flags without duplicating their schemas.
 */
export const commandHelp = (operation: Operation): string => {
  const body = operation.body && !operation.body.multipart ? bodyDefaults(operation.body) : [];
  const flags =
    operation.parameters.some((parameter) => parameter.schema.docs.default !== undefined) ||
    operation.body?.multipart?.fields.some((field) => field.schema.docs.default !== undefined) ===
      true;

  return [
    description(operation.docs),
    body.length > 0
      ? `JSON body defaults for --body and --body-file:\n${body.join("\n")}\nNested defaults depend on the containing value; schema paths describe array items or individual branches.`
      : "",
    flags || body.length > 0
      ? "Defaults shown are declared by the API; this CLI does not insert them."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

/**
 * Keep JSON input and file input help discoverable without duplicating nested defaults.
 */
export const bodyInputHelp = (body: RequestBody) => {
  const defaults = bodyDefaults(body).length > 0 ? " See body defaults above." : "";
  const required = body.required ? " Supply either --body or --body-file." : "";

  return {
    body: [
      description(body.docs),
      `JSON request body; exclusive with --body-file.${required}${defaults}`,
    ]
      .filter(Boolean)
      .join(" "),
    bodyFile: `Read a JSON request body from a file; exclusive with --body.${required}${defaults}`,
  };
};
