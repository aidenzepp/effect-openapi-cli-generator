import { Effect } from "effect";
import { GenerationError } from "./errors.js";
import type { CommandProjection, GenerateOptions } from "./model.js";

const groupKey = "x-fern-sdk-group-name";
const methodKey = "x-fern-sdk-method-name";
const aliasesKey = "x-forge-aliases";
const safeToken = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const reservedNames = new Set(["help", "h", "version", "v", "wizard", "completions", "log-level"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const separateWords = (value: string): string =>
  value.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/([a-z0-9])([A-Z])/g, "$1-$2");

const invalid = (location: string, message: string) =>
  Effect.fail(
    new GenerationError({
      code: "invalid_input",
      location,
      message,
      hint: "Use nonempty command tokens containing letters, digits, and hyphens.",
    }),
  );

const token = (value: unknown, location: string): Effect.Effect<string, GenerationError> => {
  if (typeof value !== "string") return invalid(location, "Command metadata must be a string.");
  const normalized = separateWords(value.trim()).replace(/_/g, "-").toLowerCase();
  return safeToken.test(normalized)
    ? Effect.succeed(normalized)
    : invalid(location, "Command metadata contains an empty or unsafe token.");
};

const projection = (
  source: Record<string, unknown>,
  operationId: string,
  location: string,
): Effect.Effect<CommandProjection, GenerationError> =>
  Effect.gen(function* () {
    const group = own(source, groupKey);
    if (typeof group !== "string" && !Array.isArray(group)) {
      return yield* invalid(
        `${location}/${groupKey}`,
        "A group must be a dotted string or a nonempty string array.",
      );
    }
    const segments: ReadonlyArray<unknown> = typeof group === "string" ? group.split(".") : group;
    if (segments.length === 0)
      return yield* invalid(
        `${location}/${groupKey}`,
        "A group must contain at least one segment.",
      );
    const path: string[] = [];
    for (const [index, segment] of segments.entries()) {
      path.push(
        yield* token(segment, `${location}/${groupKey}${Array.isArray(group) ? `/${index}` : ""}`),
      );
    }
    const method = own(source, methodKey);
    if (method !== undefined && typeof method !== "string") {
      return yield* invalid(`${location}/${methodKey}`, "Method metadata must be a string.");
    }
    const fallback = operationId.split(/[-_]+/).at(-1) || "get";
    path.push(
      yield* token(
        method === undefined || method === "" ? fallback : method,
        `${location}/${methodKey}`,
      ),
    );
    return { commandPath: path };
  });

export const mapCommands = (
  operation: unknown,
  location: string,
): Effect.Effect<ReadonlyArray<CommandProjection>, GenerationError> =>
  Effect.gen(function* () {
    if (!isRecord(operation)) return yield* invalid(location, "An operation must be an object.");
    const operationId = own(operation, "operationId");
    if (typeof operationId !== "string") return [];
    if (Object.hasOwn(operation, aliasesKey)) {
      const aliases = own(operation, aliasesKey);
      if (!Array.isArray(aliases))
        return yield* invalid(`${location}/${aliasesKey}`, "Aliases must be an array.");
      const projections: CommandProjection[] = [];
      for (const [index, alias] of aliases.entries()) {
        const aliasLocation = `${location}/${aliasesKey}/${index}`;
        if (!isRecord(alias))
          return yield* invalid(aliasLocation, "An alias must be an object with group metadata.");
        projections.push(yield* projection(alias, operationId, aliasLocation));
      }
      return projections;
    }
    if (!Object.hasOwn(operation, groupKey)) return [];
    return [yield* projection(operation, operationId, location)];
  });

export const resolveName = (
  title: string,
  options?: GenerateOptions,
): Effect.Effect<string, GenerationError> => {
  const explicit = options?.name !== undefined;
  const name = explicit
    ? options.name
    : separateWords(title)
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
  if (typeof name === "string" && safeToken.test(name) && !reservedNames.has(name))
    return Effect.succeed(name);
  return Effect.fail(
    new GenerationError({
      code: explicit ? "invalid_options" : "invalid_input",
      location: explicit ? "/options/name" : "/info/title",
      message: explicit
        ? "The executable name is invalid or reserved."
        : "The API title does not produce a safe executable name.",
      hint: "Supply --name using lowercase letters, digits, and single hyphens, starting with a letter; avoid native global command names.",
    }),
  );
};
