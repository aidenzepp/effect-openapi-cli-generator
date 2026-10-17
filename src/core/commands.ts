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
 * Normalize unconstrained OpenAPI identifiers while preserving explicit-override strictness.
 */
const defaultToken = (value: string, prefix: string): string => {
  const normalized = separateWords(value)
    .replaceAll(/[^a-zA-Z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .toLowerCase();

  return /^[0-9]/u.test(normalized) ? `${prefix}-${normalized}` : normalized;
};

/**
 * Derive an address from operation identity or the explicit HTTP route.
 */
const defaultAddress = (
  operation: Schema.JsonObject,
  location: string,
  route: { readonly path: string; readonly method: string },
): Effect.Effect<readonly string[], GenerationError> =>
  Effect.gen(function* deriveDefaultAddress() {
    const operationId = own(operation, "operationId");
    if (Object.hasOwn(operation, "operationId")) {
      if (!Schema.is(Schema.String)(operationId)) {
        return yield* invalid(`${location}/operationId`, "Operation ID must be a nonempty string.");
      }

      if (operationId.trim() === "") {
        return yield* invalid(`${location}/operationId`, "Operation ID must be a nonempty string.");
      }

      const names = operationId
        .split("/")
        .map((segment) => defaultToken(segment, "operation"))
        .filter((segment) => segment !== "");
      if (names.length > 0) {
        return names;
      }
    }

    const segments = route.path
      .split("/")
      .filter((segment) => segment !== "")
      .map((segment) =>
        defaultToken(segment.replaceAll(/\{(?<name>[^{}]+)\}/gu, "by-$<name>"), "path"),
      );

    return [...segments, route.method.toLowerCase()];
  });

/**
 * Apply optional naming overrides without changing HTTP request semantics.
 */
const projection = (
  source: Schema.JsonObject,
  defaults: readonly string[],
  location: string,
  groupedAction: string,
): Effect.Effect<CommandProjection, GenerationError> =>
  Effect.gen(function* decodeCommandProjection() {
    let groups = defaults.slice(0, -1);
    if (Object.hasOwn(source, groupKey)) {
      const group = own(source, groupKey);
      if (!Schema.is(Schema.String)(group) && !Schema.is(Schema.Array(Schema.Json))(group)) {
        return yield* invalid(
          `${location}/${groupKey}`,
          "A group must be a dotted string or a nonempty string array.",
        );
      }

      const segments = Schema.is(Schema.String)(group) ? group.split(".") : group;
      if (segments.length === 0) {
        return yield* invalid(
          `${location}/${groupKey}`,
          "A group must contain at least one segment.",
        );
      }

      groups = yield* Effect.forEach(
        segments,
        (segment, index) => token(segment, `${location}/${groupKey}/${index}`),
        { concurrency: 1 },
      );
    }

    groups = yield* Effect.forEach(groups, (segment) => token(segment, `${location}/${groupKey}`), {
      concurrency: 1,
    });
    const fallback = Object.hasOwn(source, groupKey) ? groupedAction : defaults.at(-1);
    const method = Object.hasOwn(source, methodKey) ? own(source, methodKey) : fallback;
    const action = yield* token(method, `${location}/${methodKey}`);

    return { commandPath: [...groups, action] };
  });

/**
 * Select all operations by default; explicit aliases replace the default projection.
 */
export const mapCommands = (
  operation: Schema.Json,
  location: string,
  route: { readonly path: string; readonly method: string },
): Effect.Effect<readonly CommandProjection[], GenerationError> =>
  Effect.gen(function* deriveCommandAddresses() {
    if (!isRecord(operation)) {
      return yield* invalid(location, "An operation must be an object.");
    }

    const defaults = yield* defaultAddress(operation, location, route);
    const id = own(operation, "operationId");
    const last = Schema.is(Schema.String)(id) ? id.split(/[-_/]+/u).at(-1) : undefined;
    const groupedAction = defaultToken(
      last === undefined || last === "" ? route.method.toLowerCase() : last,
      "operation",
    );
    if (Object.hasOwn(operation, aliasesKey)) {
      const aliases = own(operation, aliasesKey);
      if (!Schema.is(Schema.Array(Schema.Json))(aliases)) {
        return yield* invalid(`${location}/${aliasesKey}`, "Aliases must be an array.");
      }

      return yield* Effect.forEach(
        aliases,
        (alias, index) =>
          Effect.gen(function* decodeAlias() {
            const at = `${location}/${aliasesKey}/${index}`;
            if (!isRecord(alias)) {
              return yield* invalid(at, "An alias must be an object with group metadata.");
            }

            if (!Object.hasOwn(alias, groupKey)) {
              return yield* invalid(`${at}/${groupKey}`, "An alias must supply group metadata.");
            }

            return yield* projection(alias, defaults, at, groupedAction);
          }),
        { concurrency: 1 },
      );
    }

    return [yield* projection(operation, defaults, location, groupedAction)];
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
