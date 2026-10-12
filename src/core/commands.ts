import { Effect, Schema } from "effect";
import { GenerationError } from "./errors.js";
import type { CommandProjection, GenerateOptions } from "./model.js";

/**
 * The upstream extension that supplies command group segments.
 */
const groupKey = "x-fern-sdk-group-name";

/**
 * The upstream extension that overrides the action token.
 */
const methodKey = "x-fern-sdk-method-name";

/**
 * The extension whose projections replace the primary command address.
 */
const aliasesKey = "x-forge-aliases";

/**
 * The accepted executable and command-token grammar.
 */
const safeToken = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/**
 * Native global command names unavailable to generated executable names.
 */
const reservedNames = new Set(["help", "h", "version", "v", "wizard", "completions", "log-level"]);

/**
 * Recognizes JSON objects before reading operation metadata.
 *
 * @param value The untrusted JSON member.
 * @returns Whether the value supports own metadata properties.
 */
const isRecord = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Schema.is(Schema.JsonObject)(value);

/**
 * Reads metadata without inheriting prototype properties.
 *
 * @param record The source JSON object.
 * @param key The exact metadata key.
 * @returns The own value, or undefined when absent.
 */
const own = (record: Schema.JsonObject, key: string): Schema.Json | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * Separates camel-case words while retaining acronym boundaries.
 *
 * @param value Source naming metadata.
 * @returns A hyphen-delimited spelling ready for token validation.
 */
const separateWords = (value: string): string =>
  value
    .replaceAll(/(?<first>[A-Z]+)(?<second>[A-Z][a-z])/gu, "$<first>-$<second>")
    .replaceAll(/(?<first>[a-z0-9])(?<second>[A-Z])/gu, "$<first>-$<second>");

/**
 * Creates a location-bearing command metadata failure.
 *
 * @param location The JSON Pointer to the invalid field.
 * @param message The violated naming contract.
 * @returns A failed generation effect.
 */
const invalid = (location: string, message: string) =>
  Effect.fail(
    new GenerationError({
      code: "invalid_input",
      hint: "Use nonempty command tokens containing letters, digits, and hyphens.",
      location,
      message,
    }),
  );

/**
 * Normalizes and validates one command address segment.
 *
 * @param value Untrusted source metadata.
 * @param location The source JSON Pointer.
 * @returns A safe token or a typed metadata failure.
 */
const token = (
  value: Schema.Json | undefined,
  location: string,
): Effect.Effect<string, GenerationError> => {
  if (!Schema.is(Schema.String)(value)) {
    return invalid(location, "Command metadata must be a string.");
  }

  const normalized = separateWords(value.trim()).replaceAll("_", "-").toLowerCase();

  return safeToken.test(normalized)
    ? Effect.succeed(normalized)
    : invalid(location, "Command metadata contains an empty or unsafe token.");
};

/**
 * Derives one command address independently of the HTTP method.
 *
 * @param source Metadata containing group and optional action.
 * @param operationId The fallback action source.
 * @param location The source metadata pointer.
 * @returns A validated command projection.
 */
const projection = (
  source: Schema.JsonObject,
  operationId: string,
  location: string,
): Effect.Effect<CommandProjection, GenerationError> =>
  Effect.gen(function* decodeCommandProjection() {
    const group = own(source, groupKey);
    if (!Schema.is(Schema.String)(group) && !Schema.is(Schema.Array(Schema.Json))(group)) {
      return yield* invalid(
        `${location}/${groupKey}`,
        "A group must be a dotted string or a nonempty string array.",
      );
    }

    const segments: readonly Schema.Json[] = Schema.is(Schema.String)(group)
      ? group.split(".")
      : group;
    if (segments.length === 0) {
      return yield* invalid(
        `${location}/${groupKey}`,
        "A group must contain at least one segment.",
      );
    }

    const path: string[] = [];
    for (const [index, segment] of segments.entries()) {
      path.push(
        yield* token(
          segment,
          `${location}/${groupKey}${Schema.is(Schema.Array(Schema.Json))(group) ? `/${index}` : ""}`,
        ),
      );
    }
    const method = own(source, methodKey);
    if (method !== undefined && !Schema.is(Schema.String)(method)) {
      return yield* invalid(`${location}/${methodKey}`, "Method metadata must be a string.");
    }

    const last = operationId.split(/[-_]+/u).at(-1);
    const fallback = last === undefined || last === "" ? "get" : last;
    path.push(
      yield* token(
        method === undefined || method === "" ? fallback : method,
        `${location}/${methodKey}`,
      ),
    );

    return { commandPath: path };
  });

/**
 * Selects primary or alias command projections for one operation.
 *
 * @param operation The untrusted operation object.
 * @param location Its JSON Pointer.
 * @returns Validated projections, or an empty selection when required metadata is absent.
 */
export const mapCommands = (
  operation: Schema.Json,
  location: string,
): Effect.Effect<readonly CommandProjection[], GenerationError> =>
  Effect.gen(function* deriveCommandAddresses() {
    if (!isRecord(operation)) {
      return yield* invalid(location, "An operation must be an object.");
    }

    const operationId = own(operation, "operationId");
    if (!Schema.is(Schema.String)(operationId)) {
      return [];
    }

    if (Object.hasOwn(operation, aliasesKey)) {
      const aliases = own(operation, aliasesKey);
      if (!Schema.is(Schema.Array(Schema.Json))(aliases)) {
        return yield* invalid(`${location}/${aliasesKey}`, "Aliases must be an array.");
      }

      const projections: CommandProjection[] = [];
      for (const [index, alias] of aliases.entries()) {
        const aliasLocation = `${location}/${aliasesKey}/${index}`;
        if (!isRecord(alias)) {
          return yield* invalid(aliasLocation, "An alias must be an object with group metadata.");
        }

        projections.push(yield* projection(alias, operationId, aliasLocation));
      }

      return projections;
    }

    if (!Object.hasOwn(operation, groupKey)) {
      return [];
    }

    return [yield* projection(operation, operationId, location)];
  });

/**
 * Resolves a safe executable name from an override or API title.
 *
 * @param title The original API title.
 * @param options The optional explicit executable name.
 * @returns A nonreserved name or an actionable generation failure.
 */
export const resolveName = (
  title: string,
  options?: GenerateOptions,
): Effect.Effect<string, GenerationError> => {
  const explicit = options?.name !== undefined;
  const name = explicit
    ? options.name
    : separateWords(title)
        .replaceAll(/[^A-Za-z0-9]+/gu, "-")
        .replaceAll(/^-+|-+$/gu, "")
        .toLowerCase();
  if (Schema.is(Schema.String)(name) && safeToken.test(name) && !reservedNames.has(name)) {
    return Effect.succeed(name);
  }

  return Effect.fail(
    new GenerationError({
      code: explicit ? "invalid_options" : "invalid_input",
      hint: "Supply --name using lowercase letters, digits, and single hyphens, starting with a letter; avoid native global command names.",
      location: explicit ? "/options/name" : "/info/title",
      message: explicit
        ? "The executable name is invalid or reserved."
        : "The API title does not produce a safe executable name.",
    }),
  );
};
