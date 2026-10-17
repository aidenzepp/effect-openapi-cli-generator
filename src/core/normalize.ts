import { array, boolean, object, string } from "./input.js";
import { Array as EffectArray, Effect, Order, Schema } from "effect";
import { mapCommands } from "./commands.js";
import { GenerationError } from "./errors.js";
import type {
  RequestBody,
  MultipartField,
  WireSchema,
  ApiModel,
  CommandProjection,
  Documentation,
  HttpMethod,
  Operation,
  Parameter,
  SecurityRequirement,
} from "./model.js";
import { pointerSegment, resolveReference } from "./references.js";
import { normalizeSecurity } from "./security.js";
import { normalizeSchema } from "./schema.js";

/**
 * The local annotation accumulator before exposing immutable model documentation.
 */
type MutableDocumentation = { -readonly [K in keyof Documentation]: Documentation[K] };

/**
 * The HTTP methods preserved by normalized operations and generated handlers.
 */
const methods = ["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"] as const;

/**
 * Native global and generated request flags unavailable to API parameter flags.
 */
const reservedFlags = new Set([
  "base-url",
  "body",
  "body-file",
  "help",
  "h",
  "version",
  "v",
  "wizard",
  "completions",
  "log-level",
  "no-help",
  "no-h",
  "no-version",
  "no-v",
  "no-wizard",
]);

/**
 * Reads only a JSON object's own member.
 *
 * @param value The decoded source object.
 * @param key The exact wire property.
 * @returns The own value or undefined.
 */
const own = (value: Schema.JsonObject, key: string): Schema.Json | undefined =>
  Object.hasOwn(value, key) ? value[key] : undefined;

/**
 * Reports a violated OpenAPI request contract at its source pointer.
 *
 * @param location The source JSON Pointer.
 * @param message The specific failed contract.
 * @param code Whether input is invalid or unsupported.
 * @returns A typed failed generation effect.
 */
const fail = (
  location: string,
  message: string,
  code: "invalid_input" | "unsupported" = "invalid_input",
) =>
  Effect.fail(
    new GenerationError({
      code,
      hint: "Use the documented OpenAPI request subset and unique command/flag names.",
      location,
      message,
    }),
  );

/**
 * Rejects unsupported request fields while allowing extension metadata.
 *
 * @param value The source object.
 * @param allowed Supported structural fields.
 * @param location The object's JSON Pointer.
 * @returns Completion when every field is supported.
 */
const keys = (value: Schema.JsonObject, allowed: readonly string[], location: string) =>
  Effect.gen(function* validateAllowedKeys() {
    for (const key of EffectArray.sort(Object.keys(value), Order.String)) {
      if (!allowed.includes(key) && !key.startsWith("x-")) {
        yield* fail(
          `${location}/${pointerSegment(key)}`,
          `Unsupported request field: ${key}.`,
          "unsupported",
        );
      }
    }
  });

/**
 * Decodes API annotations for generated comments and command help.
 *
 * @param value The source object.
 * @param location Its JSON Pointer.
 * @returns Validated documentation without interpreting its text.
 */
const docs = (
  value: Schema.JsonObject,
  location: string,
): Effect.Effect<Documentation, GenerationError> =>
  Effect.gen(function* decodeDocumentation() {
    const result: MutableDocumentation = {};
    for (const key of ["title", "summary", "description"] as const) {
      if (Object.hasOwn(value, key) && !Schema.is(Schema.String)(value[key])) {
        return yield* fail(`${location}/${key}`, "Expected a string.");
      }
    }
    if (Schema.is(Schema.String)(value.title)) {
      result.title = value.title;
    }

    const description = [value.summary, value.description]
      .filter((text): text is string => Schema.is(Schema.String)(text))
      .join("\n");
    if (Object.hasOwn(value, "summary") || Object.hasOwn(value, "description")) {
      result.description = description;
    }

    if (Object.hasOwn(value, "deprecated")) {
      if (!Schema.is(Schema.Boolean)(value.deprecated)) {
        return yield* fail(`${location}/deprecated`, "Expected a boolean.");
      }

      result.deprecated = yield* boolean(value.deprecated, `${location}/deprecated`);
    }

    if (Object.hasOwn(value, "externalDocs")) {
      const external = yield* object(value.externalDocs, `${location}/externalDocs`);
      if (!Schema.is(Schema.String)(external.url)) {
        return yield* fail(`${location}/externalDocs/url`, "Expected a URL string.");
      }

      if (
        Object.hasOwn(external, "description") &&
        !Schema.is(Schema.String)(external.description)
      ) {
        return yield* fail(`${location}/externalDocs/description`, "Expected a string.");
      }

      result.externalDocs = {
        url: external.url,
      };
      if (Schema.is(Schema.String)(external.description)) {
        result.externalDocs = { ...result.externalDocs, description: external.description };
      }
    }

    return result;
  });

/**
 * Resolves local object references and applies permitted documentation siblings.
 *
 * @param document The complete OpenAPI document.
 * @param value The object or reference to resolve.
 * @param location Its source pointer.
 * @param active Canonical references already on this recursion path.
 * @returns The resolved object and its canonical source pointer.
 */
interface ObjectReference {
  readonly pointer: string;
  readonly value: Schema.JsonObject;
  readonly target?: ObjectReference;
}

const dereference = (
  document: Schema.Json,
  value: Schema.Json | undefined,
  location: string,
  active: ReadonlySet<string> = new Set(),
): Effect.Effect<
  {
    value: Schema.JsonObject;
    location: string;
    reference?: ObjectReference;
  },
  GenerationError
> =>
  Effect.gen(function* dereferenceObject() {
    const source = yield* object(value, location);
    if (!Object.hasOwn(source, "$ref")) {
      return { location, value: source };
    }

    yield* keys(source, ["$ref", "summary", "description"], location);
    yield* docs(source, location);
    if (!Schema.is(Schema.String)(source.$ref)) {
      return yield* fail(`${location}/$ref`, "Expected a reference string.");
    }

    const target = yield* resolveReference(document, source.$ref, `${location}/$ref`, active);
    const resolved = yield* dereference(document, target.value, target.location, target.activeRefs);
    const merged = Object.fromEntries(Object.entries(resolved.value));
    for (const key of ["summary", "description"]) {
      if (Object.hasOwn(source, key) && source[key] !== undefined) {
        merged[key] = source[key];
      }
    }

    return {
      location: resolved.location,
      reference: resolved.reference
        ? { pointer: target.location, target: resolved.reference, value: resolved.value }
        : { pointer: target.location, value: resolved.value },
      value: merged,
    };
  });

/**
 * Retain a parameter alias chain without copying a reference-site description into its target.
 */
const parameterReference = (
  parameter: Parameter,
  reference: ObjectReference | undefined,
): Effect.Effect<Parameter, GenerationError> =>
  Effect.gen(function* retainParameterReference() {
    if (!reference) {
      return parameter;
    }

    const canonical = { ...parameter, docs: yield* docs(reference.value, reference.pointer) };
    const target = yield* parameterReference(canonical, reference.target);

    return { ...parameter, reference: { parameter: target, pointer: reference.pointer } };
  });

/**
 * Retain request-body aliases independently of their use-site annotations.
 */
const bodyReference = (
  body: RequestBody,
  reference: ObjectReference | undefined,
): Effect.Effect<RequestBody, GenerationError> =>
  Effect.gen(function* retainBodyReference() {
    if (!reference) {
      return body;
    }

    const canonical = { ...body, docs: yield* docs(reference.value, reference.pointer) };
    const target = yield* bodyReference(canonical, reference.target);

    return { ...body, reference: { body: target, pointer: reference.pointer } };
  });

/**
 * Converts a wire parameter name to a safe CLI spelling.
 *
 * @param name The unchanged original parameter name.
 * @param location Its source pointer.
 * @returns A flag spelling or a typed failure; the wire name remains separate.
 */
const flagName = (name: string, location: string): Effect.Effect<string, GenerationError> => {
  const normalized = name
    .trim()
    .replaceAll(/(?<first>[A-Z]+)(?<second>[A-Z][a-z])/gu, "$<first>-$<second>")
    .replaceAll(/(?<first>[a-z0-9])(?<second>[A-Z])/gu, "$<first>-$<second>")
    .replaceAll("_", "-")
    .toLowerCase();

  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(normalized)
    ? Effect.succeed(normalized)
    : fail(location, "Parameter name does not produce a safe flag name.");
};

/**
 * Recognize primitive values that have an unambiguous scalar parameter representation.
 */
const scalarParameter = (schema: WireSchema): boolean =>
  ["string", "integer", "number", "boolean"].includes(schema.kind) &&
  !schema.nullable &&
  !("enum" in schema && schema.enum !== undefined && schema.kind !== "string");

/**
 * Validates scalar parameter serialization and preserves wire identity.
 *
 * @param document The complete OpenAPI document.
 * @param source The dereferenced parameter.
 * @param at Its canonical pointer.
 * @param version The OpenAPI schema dialect.
 * @param name The original parameter name.
 * @param parameterIn The supported wire location.
 * @returns A parameter with explicit wire schema and CLI spelling.
 */
const normalizeParameter = (
  document: Schema.Json,
  source: Schema.JsonObject,
  at: string,
  version: "3.0" | "3.1",
  name: string,
  parameterIn: "path" | "query" | "header",
): Effect.Effect<Parameter, GenerationError> =>
  Effect.gen(function* decodeParameter() {
    yield* keys(
      source,
      [
        "name",
        "in",
        "description",
        "title",
        "summary",
        "deprecated",
        "externalDocs",
        "required",
        "style",
        "explode",
        "allowReserved",
        "allowEmptyValue",
        "schema",
        "example",
        "examples",
      ],
      at,
    );
    if (Object.hasOwn(source, "required") && !Schema.is(Schema.Boolean)(source.required)) {
      return yield* fail(`${at}/required`, "Expected a boolean.");
    }

    if (parameterIn === "path" && source.required !== true) {
      return yield* fail(`${at}/required`, "Path parameters must be required.");
    }

    const style = parameterIn === "query" ? "form" : "simple";
    if (Object.hasOwn(source, "style") && source.style !== style) {
      return yield* fail(
        `${at}/style`,
        `Only ${style} serialization is supported here.`,
        "unsupported",
      );
    }

    for (const key of ["explode", "allowReserved", "allowEmptyValue"]) {
      if (Object.hasOwn(source, key) && !Schema.is(Schema.Boolean)(source[key])) {
        return yield* fail(`${at}/${key}`, "Expected a boolean.");
      }

      if (key !== "explode" && source[key] === true) {
        return yield* fail(`${at}/${key}`, `${key} is unsupported.`, "unsupported");
      }
    }
    const schema = yield* normalizeSchema(document, source.schema, `${at}/schema`, version);
    const scalar = scalarParameter(schema);
    const queryArray =
      schema.kind === "array" &&
      parameterIn === "query" &&
      !schema.nullable &&
      scalarParameter(schema.items);
    if (!scalar && !queryArray) {
      return yield* fail(
        `${at}/schema`,
        "Parameters support nonnullable primitives and form query arrays of primitives.",
        "unsupported",
      );
    }

    const parameter: Parameter = {
      binding: "flag",
      docs: yield* docs(source, at),
      flagName: yield* flagName(name, `${at}/name`),
      location: parameterIn,
      required: source.required === true,
      schema,
      wireName: name,
    };

    return queryArray ? { ...parameter, explode: source.explode !== false } : parameter;
  });

/**
 * Decodes parameters and applies operation-level identity overrides.
 *
 * @param document The complete source document.
 * @param input The optional parameter list.
 * @param location Its JSON Pointer.
 * @param version The OpenAPI dialect.
 * @param overridden Location/name identities supplied by the operation.
 * @returns Validated parameters excluding overridden path-item entries.
 */
const parameterList = (
  document: Schema.Json,
  input: Schema.Json | undefined,
  location: string,
  version: "3.0" | "3.1",
  overridden: ReadonlySet<string> = new Set(),
): Effect.Effect<readonly Parameter[], GenerationError> =>
  Effect.gen(function* normalizeParameters() {
    if (input === undefined) {
      return [];
    }

    const entries = yield* array(input, location);
    const result: Parameter[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const resolved = yield* dereference(document, entry, `${location}/${index}`);
      const source = resolved.value;
      const at = resolved.location;
      if (!Schema.is(Schema.String)(source.name) || source.name.length === 0) {
        return yield* fail(`${at}/name`, "Expected a nonempty parameter name.");
      }

      if (source.in !== "path" && source.in !== "query" && source.in !== "header") {
        return yield* fail(
          `${at}/in`,
          "Only scalar path, query and header parameters are supported.",
          "unsupported",
        );
      }

      const identity = JSON.stringify([source.in, source.name]);
      if (seen.has(identity)) {
        return yield* fail(at, "Duplicate parameter in the same list.");
      }

      seen.add(identity);
      if (overridden.has(identity)) {
        continue;
      }

      const parameter = yield* normalizeParameter(
        document,
        source,
        at,
        version,
        source.name,
        source.in,
      );
      result.push(yield* parameterReference(parameter, resolved.reference));
    }

    return result;
  });

/**
 * Detects ASCII controls that would change URL interpretation.
 *
 * @param value The original API path.
 * @returns Whether a control character is present.
 */
const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point < 32 || point === 127)) {
      return true;
    }
  }

  return false;
};

/**
 * Validates a literal API path and extracts unique placeholders in order.
 *
 * @param path The original OpenAPI path.
 * @param location Its source pointer.
 * @returns The ordered placeholder names or a typed path failure.
 */
const pathNames = (
  path: string,
  location: string,
): Effect.Effect<readonly string[], GenerationError> =>
  Effect.gen(function* validatePathTemplate() {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[?#\\\s]/u.test(path) ||
      hasControlCharacter(path)
    ) {
      return yield* fail(
        location,
        "Path must be an absolute API path without query, fragment, backslash or whitespace.",
        "unsupported",
      );
    }

    if (path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/iu.test(segment))) {
      return yield* fail(location, "URL dot segments are unsupported.", "unsupported");
    }

    if (/%(?![0-9a-f]{2})/iu.test(path)) {
      return yield* fail(location, "Malformed percent escape in path.");
    }

    yield* Effect.try({
      catch: () =>
        new GenerationError({
          code: "unsupported",
          hint: "Use a path with valid UTF-8 percent escapes.",
          location,
          message: "The path contains invalid encoded Unicode.",
        }),
      try: () => decodeURIComponent(path),
    });

    const staticPath = path.replaceAll(/\{[^{}]+\}/gu, "");
    if (/[%:;@&=+$,[\]]/u.test(staticPath)) {
      return yield* fail(
        location,
        "Static reserved URI syntax and percent escapes are unsupported; the generator cannot preserve their exact spelling with segment encoding.",
        "unsupported",
      );
    }

    const names: string[] = [];
    const remainder = path.replaceAll(/\{(?<name>[^{}/]+)\}/gu, (_, name: string) => {
      names.push(name);

      return "";
    });
    if (/[{}]/u.test(remainder)) {
      return yield* fail(location, "Malformed path placeholder.");
    }

    if (new Set(names).size !== names.length) {
      return yield* fail(location, "Duplicate path parameter placeholder.");
    }

    return names;
  });

/**
 * Resolve transport annotations through the already validated reference/allOf subset.
 */
const multipartSchema = (
  document: Schema.Json,
  input: Schema.Json | undefined,
  location: string,
): Effect.Effect<{ value: Schema.JsonObject; location: string }, GenerationError> =>
  Effect.gen(function* resolveMultipartSchema() {
    const resolved = yield* dereference(document, input, location);
    if (Schema.is(Schema.Array(Schema.JsonObject))(resolved.value.allOf)) {
      const index = resolved.value.allOf.findIndex((member) => Object.hasOwn(member, "$ref"));
      if (index !== -1) {
        const target = yield* multipartSchema(
          document,
          resolved.value.allOf[index],
          `${resolved.location}/allOf/${index}`,
        );
        const formats = new Set(
          [
            target.value.format,
            resolved.value.format,
            ...resolved.value.allOf.map((member) => member.format),
          ].filter((format) => format !== undefined),
        );
        if (formats.size > 1) {
          return yield* fail(
            location,
            "Conflicting multipart format annotations are unsupported.",
            "unsupported",
          );
        }

        const [format] = formats;

        return format === undefined
          ? target
          : { ...target, value: { ...Object.fromEntries(Object.entries(target.value)), format } };
      }
    }

    return resolved;
  });

/**
 * Map one multipart property while keeping file-path and content constraints separate.
 */
const multipartField = (
  document: Schema.Json,
  input: Schema.Json | undefined,
  property: { readonly name: string; readonly required: boolean; readonly schema: WireSchema },
  at: string,
): Effect.Effect<MultipartField, GenerationError> =>
  Effect.gen(function* normalizeMultipartField() {
    const raw = yield* multipartSchema(document, input, at);
    const arrayField = property.schema.kind === "array";
    const item = arrayField
      ? yield* multipartSchema(document, raw.value.items, `${raw.location}/items`)
      : raw;
    const fieldSchema =
      arrayField && property.schema.kind === "array" ? property.schema.items : property.schema;
    const binary = item.value.format === "binary" && fieldSchema.kind === "string";
    if (
      binary &&
      ((fieldSchema.checks?.length ?? 0) > 0 ||
        ("enum" in fieldSchema && fieldSchema.enum !== undefined))
    ) {
      return yield* fail(
        at,
        "Binary multipart content constraints cannot be applied to a local file path.",
        "unsupported",
      );
    }

    if (
      property.schema.nullable ||
      fieldSchema.nullable ||
      (!binary && (arrayField || !scalarParameter(fieldSchema)))
    ) {
      return yield* fail(
        at,
        "Multipart supports nonnullable primitive fields and binary file fields or arrays.",
        "unsupported",
      );
    }

    let kind: MultipartField["kind"] = "text";
    if (binary) {
      kind = arrayField ? "files" : "file";
    }

    return {
      flagName: yield* flagName(property.name, at),
      kind,
      name: property.name,
      required: property.required,
      schema: property.schema,
    };
  });

/**
 * Normalize explicit multipart parts without interpreting descriptions as transport rules.
 */
const multipartFields = (
  document: Schema.Json,
  input: Schema.Json | undefined,
  schema: WireSchema,
  location: string,
): Effect.Effect<NonNullable<NonNullable<Operation["body"]>["multipart"]>, GenerationError> =>
  Effect.gen(function* normalizeMultipartFields() {
    if (schema.kind !== "object" || schema.nullable) {
      return yield* fail(
        location,
        "Multipart bodies require a nonnullable object schema.",
        "unsupported",
      );
    }

    if (schema.additionalProperties !== true && schema.additionalProperties !== false) {
      return yield* fail(
        location,
        "Typed additional multipart properties are unsupported.",
        "unsupported",
      );
    }

    const resolved = yield* multipartSchema(document, input, location);
    const properties = yield* object(
      resolved.value.properties ?? {},
      `${resolved.location}/properties`,
    );
    const fields: MultipartField[] = [];
    for (const property of schema.properties) {
      const at = `${resolved.location}/properties/${pointerSegment(property.name)}`;
      fields.push(yield* multipartField(document, properties[property.name], property, at));
    }

    return { additionalFields: schema.additionalProperties, fields };
  });

/**
 * Accepts a single JSON body contract for supported HTTP methods.
 *
 * @param document The complete source document.
 * @param input The optional body object or reference.
 * @param location Its source pointer.
 * @param version The schema dialect.
 * @param method The original HTTP method.
 * @returns The requiredness and wire schema, or no body contract.
 */
const requestBody = (
  document: Schema.Json,
  input: Schema.Json | undefined,
  location: string,
  version: "3.0" | "3.1",
  method: HttpMethod,
): Effect.Effect<Operation["body"], GenerationError> =>
  Effect.gen(function* normalizeRequestBody() {
    if (input === undefined) {
      return input;
    }

    if (method === "GET" || method === "HEAD") {
      return yield* fail(location, `${method} request bodies are unsupported.`, "unsupported");
    }

    const resolved = yield* dereference(document, input, location);
    const source = resolved.value;
    const at = resolved.location;
    yield* keys(source, ["description", "summary", "required", "content"], at);
    if (Object.hasOwn(source, "required") && !Schema.is(Schema.Boolean)(source.required)) {
      return yield* fail(`${at}/required`, "Expected a boolean.");
    }

    const content = yield* object(source.content, `${at}/content`);
    const [mediaType] = Object.keys(content);
    if (
      Object.keys(content).length !== 1 ||
      (mediaType !== "application/json" && mediaType !== "multipart/form-data")
    ) {
      return yield* fail(
        `${at}/content`,
        "Only a single application/json or multipart/form-data media type is supported.",
        "unsupported",
      );
    }

    const mediaAt = `${at}/content/${pointerSegment(mediaType)}`;
    const media = yield* object(content[mediaType], mediaAt);
    yield* keys(media, ["schema", "example", "examples"], mediaAt);

    const schema = yield* normalizeSchema(document, media.schema, `${mediaAt}/schema`, version);
    const body = { docs: yield* docs(source, at), required: source.required === true, schema };
    if (mediaType === "multipart/form-data") {
      return yield* bodyReference(
        {
          ...body,
          multipart: yield* multipartFields(document, media.schema, schema, `${mediaAt}/schema`),
        },
        resolved.reference,
      );
    }

    return yield* bodyReference(body, resolved.reference);
  });

/**
 * Checks response declarations without inventing response decoding behavior.
 *
 * @param document The complete source document.
 * @param input The response map.
 * @param location Its source pointer.
 * @returns Completion when response declarations satisfy the supported subset.
 */
const responses = (document: Schema.Json, input: Schema.Json | undefined, location: string) =>
  Effect.gen(function* validateResponses() {
    const source = yield* object(input, location);
    if (Object.keys(source).length === 0) {
      return yield* fail(location, "Expected at least one response.");
    }

    for (const status of EffectArray.sort(Object.keys(source), Order.String)) {
      if (status.startsWith("x-")) {
        continue;
      }

      if (!/^(?:default|[1-5](?:[0-9]{2}|XX))$/u.test(status)) {
        return yield* fail(`${location}/${pointerSegment(status)}`, "Invalid response status.");
      }

      const resolved = yield* dereference(
        document,
        source[status],
        `${location}/${pointerSegment(status)}`,
      );
      if (Object.hasOwn(resolved.value, "links")) {
        return yield* fail(
          `${resolved.location}/links`,
          "Response links are unsupported.",
          "unsupported",
        );
      }

      if (!Schema.is(Schema.String)(resolved.value.description)) {
        return yield* fail(`${resolved.location}/description`, "Expected a response description.");
      }

      if (Object.hasOwn(resolved.value, "content")) {
        yield* object(resolved.value.content, `${resolved.location}/content`);
      }

      if (Object.hasOwn(resolved.value, "headers")) {
        yield* object(resolved.value.headers, `${resolved.location}/headers`);
      }
    }

    return yield* Effect.void;
  });

/**
 * Expands command projections while detecting address and flag collisions.
 *
 * @param source The decoded operation metadata.
 * @param path The unchanged HTTP route.
 * @param method The original HTTP method.
 * @param opAt The operation pointer.
 * @param projections Selected command addresses.
 * @param names Ordered path placeholders.
 * @param ordered Merged parameter declarations.
 * @param body The optional JSON body contract.
 * @param documentation Validated API annotations.
 * @param addresses Previously claimed command addresses.
 * @param operations The destination operation model.
 * @returns Completion after appending each valid projection.
 */
const projectOperations = (
  source: Schema.JsonObject,
  path: string,
  method: HttpMethod,
  opAt: string,
  projections: readonly CommandProjection[],
  names: readonly string[],
  ordered: readonly Parameter[],
  body: Operation["body"],
  documentation: Documentation,
  security: SecurityRequirement | undefined,
  addresses: string[][],
  operations: Operation[],
) =>
  Effect.gen(function* expandCommandProjections() {
    for (const projection of projections) {
      const command = [...projection.commandPath];
      if (
        addresses.some((other) =>
          other
            .slice(0, Math.min(other.length, command.length))
            .every((part, index) => part === command[index]),
        )
      ) {
        return yield* fail(opAt, "Duplicate command address or command/group prefix collision.");
      }

      addresses.push(command);

      const action = command.at(-1);
      if (action === undefined) {
        return yield* fail(opAt, "Empty command path.");
      }

      const used = new Set(reservedFlags);
      if (security) {
        for (const flag of security.kind === "basic"
          ? [`${security.flagName}-username`, `${security.flagName}-password`]
          : [security.flagName]) {
          if (used.has(flag)) {
            return yield* fail(opAt, `Reserved security flag: ${flag}.`);
          }

          used.add(flag);
        }
      }

      const parameters: Parameter[] = [];
      for (const parameter of ordered) {
        const binding = "flag";
        if (binding === "flag") {
          if (used.has(parameter.flagName)) {
            return yield* fail(
              `${opAt}/parameters`,
              `Duplicate or reserved effective flag: ${parameter.flagName}.`,
            );
          }

          used.add(parameter.flagName);
        }

        parameters.push({ ...parameter, binding });
      }
      if (body?.multipart) {
        const flags = body.multipart.fields.map((field) => field.flagName);
        if (body.multipart.additionalFields) {
          flags.push("additional-fields");
        }

        for (const flag of flags) {
          if (used.has(flag)) {
            return yield* fail(
              `${opAt}/requestBody`,
              `Duplicate or reserved multipart flag: ${flag}.`,
            );
          }

          used.add(flag);
        }
      }

      operations.push({
        body,
        commandPath: command,
        docs: documentation,
        method,
        operationId: Object.hasOwn(source, "operationId")
          ? yield* string(source.operationId, `${opAt}/operationId`)
          : `${method} ${path}`,
        parameters,
        path,
        security,
      });
    }

    return yield* Effect.void;
  });

/**
 * Validates one selected operation before adding its command projections.
 *
 * @param document The complete OpenAPI document.
 * @param root The document root supplying inherited security.
 * @param item The enclosing path item.
 * @param source The decoded operation.
 * @param path The original API path.
 * @param method The original HTTP method.
 * @param at The path-item pointer.
 * @param opAt The operation pointer.
 * @param version The schema dialect.
 * @param projections The selected command addresses.
 * @param templates Previously claimed canonical path templates.
 * @param addresses Previously claimed command paths.
 * @param operations The accumulated normalized operations.
 * @returns Completion after preserving the operation's wire contract.
 */
const normalizeOperation = (
  document: Schema.Json,
  root: Schema.JsonObject,
  item: Schema.JsonObject,
  source: Schema.JsonObject,
  path: string,
  method: HttpMethod,
  at: string,
  opAt: string,
  version: "3.0" | "3.1",
  projections: readonly CommandProjection[],
  templates: Map<string, string>,
  addresses: string[][],
  operations: Operation[],
) =>
  Effect.gen(function* decodeOperation() {
    yield* keys(
      item,
      ["summary", "description", "servers", "parameters", ...methods.map((m) => m.toLowerCase())],
      at,
    );
    yield* keys(
      source,
      [
        "tags",
        "summary",
        "description",
        "externalDocs",
        "operationId",
        "parameters",
        "requestBody",
        "responses",
        "deprecated",
        "security",
        "servers",
      ],
      opAt,
    );

    const security =
      (yield* normalizeSecurity(
        document,
        Object.hasOwn(source, "security") ? source.security : own(root, "security"),
        Object.hasOwn(source, "security") ? `${opAt}/security` : "/security",
      )) ?? undefined;

    const names = yield* pathNames(path, at);
    const template = path.replaceAll(/\{[^{}]+\}/gu, "{}");
    if (templates.has(template) && templates.get(template) !== path) {
      return yield* fail(at, "Ambiguous duplicate path template.");
    }

    templates.set(template, path);

    const local = yield* parameterList(
      document,
      own(source, "parameters"),
      `${opAt}/parameters`,
      version,
    );
    const overrides = new Set(
      local.map((parameter) => JSON.stringify([parameter.location, parameter.wireName])),
    );
    const inherited = yield* parameterList(
      document,
      own(item, "parameters"),
      `${at}/parameters`,
      version,
      overrides,
    );
    const merged = new Map<string, Parameter>();
    for (const parameter of [...inherited, ...local]) {
      merged.set(JSON.stringify([parameter.location, parameter.wireName]), parameter);
    }
    const all = [...merged.values()];
    if (security) {
      const location = security.kind === "apiKey" ? security.location : "header";
      const name = security.kind === "apiKey" ? security.name : "authorization";
      if (
        all.some(
          (parameter) =>
            parameter.location === location &&
            (location === "header"
              ? parameter.wireName.toLowerCase() === name.toLowerCase()
              : parameter.wireName === name),
        )
      ) {
        return yield* fail(
          `${opAt}/parameters`,
          "An API parameter conflicts with the active authentication wire field.",
          "unsupported",
        );
      }
    }

    const pathParameters = all.filter((parameter) => parameter.location === "path");
    if (
      pathParameters.length !== names.length ||
      pathParameters.some((parameter) => !names.includes(parameter.wireName))
    ) {
      return yield* fail(
        `${opAt}/parameters`,
        "Path parameters must exactly match path placeholders.",
      );
    }

    const ordered: Parameter[] = [];
    for (const name of names) {
      const parameter = pathParameters.find((candidate) => candidate.wireName === name);
      if (parameter === undefined) {
        return yield* fail(`${opAt}/parameters`, "Missing path parameter.");
      }

      ordered.push(parameter);
    }
    ordered.push(...all.filter((parameter) => parameter.location !== "path"));

    const body = yield* requestBody(
      document,
      own(source, "requestBody"),
      `${opAt}/requestBody`,
      version,
      method,
    );
    yield* responses(document, source.responses, `${opAt}/responses`);

    const documentation = yield* docs(source, opAt);
    yield* projectOperations(
      source,
      path,
      method,
      opAt,
      projections,
      names,
      ordered,
      body,
      documentation,
      security,
      addresses,
      operations,
    );

    return yield* Effect.void;
  });

/**
 * Normalizes the supported OpenAPI subset into explicit commands and wire contracts.
 *
 * @param document The schema-checked JSON input.
 * @returns A deterministic API model or a location-bearing rejection.
 */
export const normalize = (document: Schema.Json): Effect.Effect<ApiModel, GenerationError> =>
  Effect.gen(function* normalizeDocument() {
    const root = yield* object(document, "");
    if (!Schema.is(Schema.String)(root.openapi) || !/^3\.[01]\.\d+$/u.test(root.openapi)) {
      return yield* fail("/openapi", "Only OpenAPI 3.0.x and 3.1.x are supported.", "unsupported");
    }

    const version = root.openapi.startsWith("3.0.") ? "3.0" : "3.1";
    yield* keys(
      root,
      [
        "openapi",
        "info",
        "paths",
        "servers",
        "components",
        "security",
        "tags",
        "externalDocs",
        "webhooks",
      ],
      "",
    );

    if (Object.hasOwn(root, "webhooks")) {
      if (version !== "3.1") {
        return yield* fail("/webhooks", "Inbound webhooks require OpenAPI 3.1.", "unsupported");
      }

      yield* object(root.webhooks, "/webhooks");
    }

    const info = yield* object(root.info, "/info");
    if (!Schema.is(Schema.String)(info.title) || info.title.trim() === "") {
      return yield* fail("/info/title", "Expected a nonempty title.");
    }

    if (!Schema.is(Schema.String)(info.version) || info.version === "") {
      return yield* fail("/info/version", "Expected an API version string.");
    }

    if (Object.hasOwn(info, "description") && !Schema.is(Schema.String)(info.description)) {
      return yield* fail("/info/description", "Expected a string.");
    }

    const paths = yield* object(root.paths, "/paths");
    const operations: Operation[] = [];
    const addresses: string[][] = [];
    const templates = new Map<string, string>();
    for (const path of EffectArray.sort(Object.keys(paths), Order.String)) {
      if (path.startsWith("x-")) {
        continue;
      }

      const at = `/paths/${pointerSegment(path)}`;
      const item = yield* object(paths[path], at);
      for (const method of methods) {
        const key = method.toLowerCase();
        if (!Object.hasOwn(item, key)) {
          continue;
        }

        const opAt = `${at}/${key}`;
        const source = yield* object(item[key], opAt);
        const projections = yield* mapCommands(source, opAt, { method, path });
        if (projections.length === 0) {
          continue;
        }

        yield* normalizeOperation(
          document,
          root,
          item,
          source,
          path,
          method,
          at,
          opAt,
          version,
          projections,
          templates,
          addresses,
          operations,
        );
      }
    }
    if (operations.length === 0) {
      return yield* fail("/paths", "No operations selected by command metadata.");
    }

    return {
      description: Schema.is(Schema.String)(info.description) ? info.description : undefined,
      operations,
      title: info.title,
    };
  });
