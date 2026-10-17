import { defaultHelp } from "./emit-help.js";
import type { MultipartField, Operation } from "./model.js";
import { parameterSource } from "./emit-flag.js";
import { schemaSource } from "./emit-schema.js";
import { description, literal, propertyKey } from "./source-text.js";

/**
 * Whether this transport field consumes its schema in a native flag validator.
 */
export const multipartUsesSchema = (field: MultipartField): boolean =>
  field.kind !== "file" &&
  (field.schema.reference !== undefined || (field.schema.checks?.length ?? 0) > 0);

/**
 * Render multipart transport inputs without applying content checks to local paths.
 */
export const multipartFlagSource = (
  field: MultipartField,
  requiredBody: boolean,
  reference: (pointer: string) => string,
): string => {
  const required = requiredBody && field.required;
  const help = [
    description(field.schema.docs),
    defaultHelp(
      field.schema,
      field.required,
      "this field is still required when its body is supplied",
    ),
    field.kind !== "text" && field.schema.docs.default !== undefined
      ? "Default applies to uploaded content; supply a local file path explicitly."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (field.kind === "text") {
    return parameterSource(
      {
        binding: "flag",
        docs: field.schema.docs,
        flagName: field.flagName,
        location: "query",
        required,
        schema: field.schema,
        wireName: field.name,
      },
      reference,
      help,
    );
  }

  const pipes = [];
  if (field.kind === "files") {
    pipes.push("Flag.atLeast(1)");
    if (field.schema.reference || (field.schema.checks?.length ?? 0) > 0) {
      pipes.push(`Flag.withSchema(${schemaSource(field.schema, reference)})`);
    }
  }

  if (help) {
    pipes.push(`Flag.withDescription(${literal(help)})`);
  }

  if (!required) {
    pipes.push("Flag.optional");
  }

  return `Flag.File(${literal(field.flagName)}, { mustExist: true })${pipes.length ? `.pipe(${pipes.join(", ")})` : ""}`;
};

/**
 * Construct native FormData from prepared files and unchanged text values.
 */
export const multipartBodySource = (
  body: NonNullable<Operation["body"]>,
  inputs: ReadonlyMap<MultipartField, string>,
): string => {
  const files: string[] = [];
  const fields: string[] = [];
  const required: string[] = [];
  for (const [field, input] of inputs) {
    const value = body.required && field.required ? input : `Option.getOrUndefined(${input})`;
    if (field.required) {
      required.push(field.name);
    }

    if (field.kind === "text") {
      const key = propertyKey(field.name);
      fields.push(field.name === value ? value : `${key}: ${value}`);
    } else {
      files.push(`${input}: Multipart.${field.kind === "file" ? "file" : "files"}(${value})`);
      fields.push(`${propertyKey(field.name)}: files.${input}`);
    }
  }
  const extras = body.multipart?.additionalFields === true ? "additionalFields" : "Option.none()";
  const encode = `Multipart.withBody({ ${fields.join(", ")} }, ${extras}, ${literal(required)}, ${body.required})`;

  return files.length > 0
    ? `Effect.flatMap((request) => Effect.all({ ${files.join(", ")} }).pipe(Effect.flatMap((files) => ${encode}(request))))`
    : `Effect.flatMap(${encode})`;
};
