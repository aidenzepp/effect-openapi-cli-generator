import { Effect } from "effect";
import { mapCommands } from "./commands.js";
import { GenerationError } from "./errors.js";
import type { ApiModel, Documentation, HttpMethod, Operation, Parameter } from "./model.js";
import { pointerSegment, resolveReference } from "./references.js";
import { normalizeSchema } from "./schema.js";

const methods = ["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"] as const;
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
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;
const fail = (
  location: string,
  message: string,
  code: "invalid_input" | "unsupported" = "invalid_input",
) =>
  Effect.fail(
    new GenerationError({
      code,
      location,
      message,
      hint: "Use the documented OpenAPI request subset and unique command/flag names.",
    }),
  );
const object = (
  value: unknown,
  location: string,
): Effect.Effect<Record<string, unknown>, GenerationError> =>
  record(value) ? Effect.succeed(value) : fail(location, "Expected an object.");
const keys = (value: Record<string, unknown>, allowed: ReadonlyArray<string>, location: string) =>
  Effect.gen(function* () {
    for (const key of Object.keys(value).sort())
      if (!allowed.includes(key) && !key.startsWith("x-"))
        yield* fail(
          `${location}/${pointerSegment(key)}`,
          `Unsupported request field: ${key}.`,
          "unsupported",
        );
  });
const docs = (
  value: Record<string, unknown>,
  location: string,
): Effect.Effect<Documentation, GenerationError> =>
  Effect.gen(function* () {
    const result: {
      title?: string;
      description?: string;
      deprecated?: boolean;
      externalDocs?: { url: string; description?: string };
    } = {};
    for (const key of ["title", "summary", "description"] as const)
      if (Object.hasOwn(value, key) && typeof value[key] !== "string")
        return yield* fail(`${location}/${key}`, "Expected a string.");
    if (typeof value.title === "string") result.title = value.title;
    const description = [value.summary, value.description]
      .filter((text): text is string => typeof text === "string")
      .join("\n");
    if (Object.hasOwn(value, "summary") || Object.hasOwn(value, "description"))
      result.description = description;
    if (Object.hasOwn(value, "deprecated")) {
      if (typeof value.deprecated !== "boolean")
        return yield* fail(`${location}/deprecated`, "Expected a boolean.");
      result.deprecated = value.deprecated;
    }
    if (Object.hasOwn(value, "externalDocs")) {
      const external = yield* object(value.externalDocs, `${location}/externalDocs`);
      if (typeof external.url !== "string")
        return yield* fail(`${location}/externalDocs/url`, "Expected a URL string.");
      if (Object.hasOwn(external, "description") && typeof external.description !== "string")
        return yield* fail(`${location}/externalDocs/description`, "Expected a string.");
      result.externalDocs = {
        url: external.url,
        ...(typeof external.description === "string" ? { description: external.description } : {}),
      };
    }
    return result;
  });

const dereference = (
  document: unknown,
  value: unknown,
  location: string,
  active: ReadonlySet<string> = new Set(),
): Effect.Effect<{ value: Record<string, unknown>; location: string }, GenerationError> =>
  Effect.gen(function* () {
    const source = yield* object(value, location);
    if (!Object.hasOwn(source, "$ref")) return { value: source, location };
    yield* keys(source, ["$ref", "summary", "description"], location);
    yield* docs(source, location);
    if (typeof source.$ref !== "string")
      return yield* fail(`${location}/$ref`, "Expected a reference string.");
    const target = yield* resolveReference(document, source.$ref, `${location}/$ref`, active);
    const resolved = yield* dereference(document, target.value, target.location, target.activeRefs);
    return {
      value: {
        ...resolved.value,
        ...(Object.hasOwn(source, "summary") ? { summary: source.summary } : {}),
        ...(Object.hasOwn(source, "description") ? { description: source.description } : {}),
      },
      location: resolved.location,
    };
  });

const flagName = (name: string, location: string): Effect.Effect<string, GenerationError> => {
  const normalized = name
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(normalized)
    ? Effect.succeed(normalized)
    : fail(location, "Parameter name does not produce a safe flag name.");
};

const parameterList = (
  document: unknown,
  input: unknown,
  location: string,
  version: "3.0" | "3.1",
  overridden: ReadonlySet<string> = new Set(),
): Effect.Effect<ReadonlyArray<Parameter>, GenerationError> =>
  Effect.gen(function* () {
    if (input === undefined) return [];
    if (!Array.isArray(input)) return yield* fail(location, "Expected a parameter array.");
    const result: Parameter[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of input.entries()) {
      const resolved = yield* dereference(document, entry, `${location}/${index}`);
      const source = resolved.value;
      const at = resolved.location;
      if (typeof source.name !== "string" || source.name.length === 0)
        return yield* fail(`${at}/name`, "Expected a nonempty parameter name.");
      if (source.in !== "path" && source.in !== "query")
        return yield* fail(
          `${at}/in`,
          "Only path and query parameters are supported.",
          "unsupported",
        );
      const identity = JSON.stringify([source.in, source.name]);
      if (seen.has(identity)) return yield* fail(at, "Duplicate parameter in the same list.");
      seen.add(identity);
      if (overridden.has(identity)) continue;
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
      if (Object.hasOwn(source, "required") && typeof source.required !== "boolean")
        return yield* fail(`${at}/required`, "Expected a boolean.");
      if (source.in === "path" && source.required !== true)
        return yield* fail(`${at}/required`, "Path parameters must be required.");
      const style = source.in === "path" ? "simple" : "form";
      if (Object.hasOwn(source, "style") && source.style !== style)
        return yield* fail(
          `${at}/style`,
          `Only ${style} serialization is supported here.`,
          "unsupported",
        );
      for (const key of ["explode", "allowReserved", "allowEmptyValue"]) {
        if (Object.hasOwn(source, key) && typeof source[key] !== "boolean")
          return yield* fail(`${at}/${key}`, "Expected a boolean.");
        if (key !== "explode" && source[key] === true)
          return yield* fail(`${at}/${key}`, `${key} is unsupported.`, "unsupported");
      }
      const schema = yield* normalizeSchema(document, source.schema, `${at}/schema`, version);
      if (
        schema.kind === "object" ||
        schema.kind === "array" ||
        schema.kind === "null" ||
        schema.nullable ||
        (schema.enum !== undefined && schema.kind !== "string")
      )
        return yield* fail(
          `${at}/schema`,
          "Parameters support nonnullable primitives and string enums only.",
          "unsupported",
        );
      result.push({
        wireName: source.name,
        flagName: yield* flagName(source.name, `${at}/name`),
        location: source.in,
        required: source.required === true,
        schema,
        docs: yield* docs(source, at),
        binding: "flag",
      });
    }
    return result;
  });

const pathNames = (
  path: string,
  location: string,
): Effect.Effect<ReadonlyArray<string>, GenerationError> =>
  Effect.gen(function* () {
    if (!path.startsWith("/") || path.startsWith("//") || /[?#\\\s\u0000-\u001f\u007f]/u.test(path))
      return yield* fail(
        location,
        "Path must be an absolute API path without query, fragment, backslash or whitespace.",
        "unsupported",
      );
    if (path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment)))
      return yield* fail(location, "URL dot segments are unsupported.", "unsupported");
    if (/%(?![0-9a-f]{2})/i.test(path))
      return yield* fail(location, "Malformed percent escape in path.");
    const names: string[] = [];
    const remainder = path.replace(/\{([^{}\/]+)\}/g, (_, name: string) => {
      names.push(name);
      return "";
    });
    if (/[{}]/.test(remainder)) return yield* fail(location, "Malformed path placeholder.");
    if (new Set(names).size !== names.length)
      return yield* fail(location, "Duplicate path parameter placeholder.");
    return names;
  });

const requestBody = (
  document: unknown,
  input: unknown,
  location: string,
  version: "3.0" | "3.1",
  method: HttpMethod,
): Effect.Effect<Operation["body"], GenerationError> =>
  Effect.gen(function* () {
    if (input === undefined) return undefined;
    if (method === "GET" || method === "HEAD")
      return yield* fail(location, `${method} request bodies are unsupported.`, "unsupported");
    const resolved = yield* dereference(document, input, location);
    const source = resolved.value;
    const at = resolved.location;
    yield* keys(source, ["description", "summary", "required", "content"], at);
    if (Object.hasOwn(source, "required") && typeof source.required !== "boolean")
      return yield* fail(`${at}/required`, "Expected a boolean.");
    const content = yield* object(source.content, `${at}/content`);
    if (Object.keys(content).length !== 1 || !Object.hasOwn(content, "application/json"))
      return yield* fail(
        `${at}/content`,
        "Only a single application/json media type is supported.",
        "unsupported",
      );
    const mediaAt = `${at}/content/application~1json`;
    const media = yield* object(content["application/json"], mediaAt);
    yield* keys(media, ["schema", "example", "examples"], mediaAt);
    return {
      required: source.required === true,
      schema: yield* normalizeSchema(document, media.schema, `${mediaAt}/schema`, version),
    };
  });

const responses = (document: unknown, input: unknown, location: string) =>
  Effect.gen(function* () {
    const source = yield* object(input, location);
    if (Object.keys(source).length === 0)
      return yield* fail(location, "Expected at least one response.");
    for (const status of Object.keys(source).sort()) {
      if (status.startsWith("x-")) continue;
      if (!/^(?:default|[1-5](?:[0-9]{2}|XX))$/.test(status))
        return yield* fail(`${location}/${pointerSegment(status)}`, "Invalid response status.");
      const resolved = yield* dereference(
        document,
        source[status],
        `${location}/${pointerSegment(status)}`,
      );
      if (Object.hasOwn(resolved.value, "links"))
        return yield* fail(
          `${resolved.location}/links`,
          "Response links are unsupported.",
          "unsupported",
        );
      if (typeof resolved.value.description !== "string")
        return yield* fail(`${resolved.location}/description`, "Expected a response description.");
      if (Object.hasOwn(resolved.value, "content"))
        yield* object(resolved.value.content, `${resolved.location}/content`);
      if (Object.hasOwn(resolved.value, "headers"))
        yield* object(resolved.value.headers, `${resolved.location}/headers`);
    }
  });

export const normalize = (document: unknown): Effect.Effect<ApiModel, GenerationError> =>
  Effect.gen(function* () {
    const root = yield* object(document, "");
    if (typeof root.openapi !== "string" || !/^3\.[01]\.\d+$/.test(root.openapi))
      return yield* fail("/openapi", "Only OpenAPI 3.0.x and 3.1.x are supported.", "unsupported");
    const version = root.openapi.startsWith("3.0.") ? "3.0" : "3.1";
    yield* keys(
      root,
      ["openapi", "info", "paths", "servers", "components", "security", "tags", "externalDocs"],
      "",
    );
    const info = yield* object(root.info, "/info");
    if (typeof info.title !== "string" || info.title.trim() === "")
      return yield* fail("/info/title", "Expected a nonempty title.");
    if (typeof info.version !== "string" || info.version === "")
      return yield* fail("/info/version", "Expected an API version string.");
    if (Object.hasOwn(info, "description") && typeof info.description !== "string")
      return yield* fail("/info/description", "Expected a string.");
    const paths = yield* object(root.paths, "/paths");
    const operations: Operation[] = [];
    const addresses: string[][] = [];
    const templates = new Map<string, string>();
    for (const path of Object.keys(paths).sort()) {
      if (path.startsWith("x-")) continue;
      const at = `/paths/${pointerSegment(path)}`;
      const item = yield* object(paths[path], at);
      for (const method of methods) {
        const key = method.toLowerCase();
        if (!Object.hasOwn(item, key)) continue;
        const opAt = `${at}/${key}`;
        const source = yield* object(item[key], opAt);
        const projections = yield* mapCommands(source, opAt);
        if (projections.length === 0) continue;
        yield* keys(
          item,
          [
            "summary",
            "description",
            "servers",
            "parameters",
            ...methods.map((m) => m.toLowerCase()),
          ],
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
        const security = Object.hasOwn(source, "security")
          ? source.security
          : own(root, "security");
        if (security !== undefined && (!Array.isArray(security) || security.length !== 0))
          return yield* fail(
            Object.hasOwn(source, "security") ? `${opAt}/security` : "/security",
            "Security requirements are unsupported; use an explicit empty security array.",
            "unsupported",
          );
        const names = yield* pathNames(path, at);
        const template = path.replace(/\{[^{}]+\}/g, "{}");
        if (templates.has(template) && templates.get(template) !== path)
          return yield* fail(at, "Ambiguous duplicate path template.");
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
        for (const parameter of [...inherited, ...local])
          merged.set(JSON.stringify([parameter.location, parameter.wireName]), parameter);
        const all = [...merged.values()];
        const pathParameters = all.filter((parameter) => parameter.location === "path");
        if (
          pathParameters.length !== names.length ||
          pathParameters.some((parameter) => !names.includes(parameter.wireName))
        )
          return yield* fail(
            `${opAt}/parameters`,
            "Path parameters must exactly match path placeholders.",
          );
        const ordered = [
          ...names.map((name) => pathParameters.find((parameter) => parameter.wireName === name)!),
          ...all.filter((parameter) => parameter.location === "query"),
        ];
        const body = yield* requestBody(
          document,
          own(source, "requestBody"),
          `${opAt}/requestBody`,
          version,
          method,
        );
        yield* responses(document, source.responses, `${opAt}/responses`);
        const documentation = yield* docs(source, opAt);
        for (const projection of projections) {
          const command = [...projection.commandPath];
          if (
            addresses.some((other) =>
              other
                .slice(0, Math.min(other.length, command.length))
                .every((part, index) => part === command[index]),
            )
          )
            return yield* fail(
              opAt,
              "Duplicate command address or command/group prefix collision.",
            );
          addresses.push(command);
          const action = command.at(-1)!;
          const subject =
            action === "list" || action === "bulk" || action.startsWith("bulk-")
              ? undefined
              : names.at(-1);
          const used = new Set(reservedFlags);
          const parameters: Parameter[] = [];
          for (const parameter of ordered) {
            const binding =
              parameter.location === "path" && parameter.wireName === subject ? "argument" : "flag";
            if (binding === "flag") {
              if (used.has(parameter.flagName))
                return yield* fail(
                  `${opAt}/parameters`,
                  `Duplicate or reserved effective flag: ${parameter.flagName}.`,
                );
              used.add(parameter.flagName);
            }
            parameters.push({ ...parameter, binding });
          }
          operations.push({
            commandPath: command,
            operationId: source.operationId as string,
            method,
            path,
            parameters,
            docs: documentation,
            body,
          });
        }
      }
    }
    if (operations.length === 0)
      return yield* fail("/paths", "No operations selected by command metadata.");
    return {
      title: info.title,
      description: typeof info.description === "string" ? info.description : undefined,
      operations,
    };
  });
