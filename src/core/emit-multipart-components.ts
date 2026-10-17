import { componentNames } from "./emit-components.js";
import { multipartFlagSource, multipartUsesSchema } from "./emit-multipart.js";
import { hasSchemaReference } from "./emit-schema.js";
import type { ApiModel, MultipartField, RequestBody, WireSchema } from "./model.js";
import { comment, internalReference, literal, propertyKey } from "./source-text.js";

const multipartPointer = (body: RequestBody | undefined) =>
  body?.schema.reference?.pointer ?? body?.reference?.pointer;

/**
 * Native flag bundles are transport views of explicit multipart schema components.
 */
export const multipartComponents = (
  model: ApiModel,
  schemaReference: (pointer: string) => string,
) => {
  const definitions = new Map<
    string,
    { schema: WireSchema; fields: readonly MultipartField[]; target: string | undefined }
  >();
  const visit = (schema: WireSchema, fields: readonly MultipartField[]): void => {
    if (schema.reference && !definitions.has(schema.reference.pointer)) {
      visit(schema.reference.schema, fields);
      definitions.set(schema.reference.pointer, {
        fields,
        schema: schema.reference.schema,
        target: schema.reference.schema.reference?.pointer,
      });
    }
  };
  const visitBody = (body: RequestBody): void => {
    if (body.schema.reference) {
      visit(body.schema, body.multipart?.fields ?? []);
    } else if (body.reference && !definitions.has(body.reference.pointer)) {
      const target = body.reference.body;
      visitBody(target);
      definitions.set(body.reference.pointer, {
        fields: target.multipart?.fields ?? [],
        schema: { ...target.schema, docs: target.docs },
        target: multipartPointer(target),
      });
    }
  };
  for (const operation of model.operations) {
    if (operation.body?.multipart) {
      visitBody(operation.body);
    }
  }
  const names = componentNames([...definitions.keys()]);
  const entries = [...definitions].map(([pointer, entry]) => {
    const expression =
      entry.target === undefined
        ? `{ ${entry.fields.map((field) => `${propertyKey(field.name)}: ${multipartFlagSource(field, true, schemaReference)}`).join(",\n")} }`
        : internalReference(names.get(entry.target) ?? "", entry.schema.docs.deprecated === true);

    return `${comment(entry.schema.docs)}export const ${names.get(pointer)} = ${expression};`;
  });
  const fields = [...definitions.values()].flatMap((entry) =>
    entry.target === undefined ? entry.fields : [],
  );
  const schema = fields.some((field) => multipartUsesSchema(field) && !field.schema.reference);
  const schemas = fields.some(
    (field) => multipartUsesSchema(field) && hasSchemaReference(field.schema),
  );
  const reference = (body: RequestBody) =>
    internalReference(
      `MultipartComponents.${names.get(multipartPointer(body) ?? "")}`,
      body.schema.docs.deprecated === true,
    );

  return {
    empty: (body: RequestBody) =>
      multipartPointer(body) !== undefined && body.multipart?.fields.length === 0
        ? `...${reference(body)},`
        : "",
    field: (body: RequestBody, field: MultipartField) => {
      if (multipartPointer(body) === undefined) {
        return multipartFlagSource(field, body.required, schemaReference);
      }

      const access = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/u.test(field.name)
        ? `.${field.name}`
        : `[${literal(field.name)}]`;
      const value = `${reference(body)}${access}`;

      return !body.required && field.required ? `${value}.pipe(Flag.optional)` : value;
    },
    shared: (body: RequestBody | undefined) => multipartPointer(body) !== undefined,
    source: entries.length
      ? `${schema ? 'import { Schema } from "effect";\n' : ""}${fields.length ? 'import { Flag } from "effect/cli";\n' : ""}${schemas ? 'import * as Schemas from "./schemas.js";\n' : ""}\n${entries.join("\n\n")}`
      : undefined,
  };
};
