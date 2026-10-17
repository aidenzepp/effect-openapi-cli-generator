import { Array, Effect, Order, Schema } from "effect";
import { GenerationError } from "./errors.js";
import type { SecurityRequirement } from "./model.js";
import { pointerSegment, resolveReference } from "./references.js";

/**
 * Decode supported transport definitions independently from requirement selection.
 */
const decodeScheme = (
  source: Schema.JsonObject,
  key: string,
  location: string,
): Effect.Effect<SecurityRequirement, GenerationError> => {
  const fail = (message: string) =>
    Effect.fail(
      new GenerationError({
        code: "unsupported",
        hint: "Use an HTTP bearer, HTTP Basic or API-key scheme.",
        location,
        message,
      }),
    );

  return Effect.gen(function* decodeSchemeDefinition() {
    const flagName = key
      .replaceAll(/(?<first>[A-Z]+)(?<second>[A-Z][a-z])/gu, "$<first>-$<second>")
      .replaceAll(/(?<first>[a-z0-9])(?<second>[A-Z])/gu, "$<first>-$<second>")
      .replaceAll(/[^a-zA-Z0-9]+/gu, "-")
      .replaceAll(/^-|-$/gu, "")
      .toLowerCase();
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(flagName)) {
      return yield* fail("Security scheme name does not produce a safe flag.");
    }

    if (source.description !== undefined && !Schema.is(Schema.String)(source.description)) {
      return yield* fail("Security description must be a string.");
    }

    const docs = Schema.is(Schema.String)(source.description)
      ? { description: source.description }
      : {};
    if (source.type === "http" && Schema.is(Schema.String)(source.scheme)) {
      const kind = source.scheme.toLowerCase();
      if (kind === "bearer" || kind === "basic") {
        return { docs, flagName, key, kind };
      }
    }

    if (
      source.type === "apiKey" &&
      Schema.is(Schema.String)(source.name) &&
      (source.in === "header" || source.in === "query" || source.in === "cookie")
    ) {
      return { docs, flagName, key, kind: "apiKey", location: source.in, name: source.name };
    }

    return yield* fail("Unsupported security scheme.");
  });
};

/**
 * Decode one effective requirement, rejecting unsupported alternatives or combinations.
 */
export const normalizeSecurity = (
  document: Schema.Json,
  input: Schema.Json | undefined,
  location: string,
): Effect.Effect<SecurityRequirement | null, GenerationError> =>
  Effect.gen(function* decodeSecurity() {
    const fail = (message: string) =>
      Effect.fail(
        new GenerationError({
          code: "unsupported",
          hint: "Use one HTTP bearer, HTTP Basic or API-key requirement, or an empty security array.",
          location,
          message,
        }),
      );
    if (input === undefined) {
      return null;
    }

    if (!Schema.is(Schema.Array(Schema.Json))(input)) {
      return yield* fail("Expected a security array.");
    }

    if (input.length === 0) {
      return null;
    }

    const [requirement] = input;
    if (input.length !== 1 || !Schema.is(Schema.JsonObject)(requirement)) {
      return yield* fail("Security alternatives are unsupported.");
    }

    const names = Array.sort(Object.keys(requirement), Order.String);
    if (names.length === 0) {
      return null;
    }

    const [key] = names;
    if (names.length !== 1 || key === undefined) {
      return yield* fail("Security combinations are unsupported.");
    }

    const scopes = requirement[key];
    if (!Schema.is(Schema.Array(Schema.Json))(scopes) || scopes.length !== 0) {
      return yield* fail("Scopes are unsupported for these security schemes.");
    }

    const resolved = yield* resolveReference(
      document,
      `#/components/securitySchemes/${pointerSegment(key)}`,
      location,
      new Set(),
    );
    let source = resolved.value;
    let active = resolved.activeRefs;
    while (Schema.is(Schema.JsonObject)(source) && Schema.is(Schema.String)(source.$ref)) {
      const target = yield* resolveReference(document, source.$ref, location, active);
      source = target.value;
      active = target.activeRefs;
    }
    if (!Schema.is(Schema.JsonObject)(source)) {
      return yield* fail("Expected a security scheme object.");
    }

    return yield* decodeScheme(source, key, location);
  });
