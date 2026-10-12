import { Effect, Schema } from "effect";
import { GenerationError } from "./errors.js";

/**
 * Constructs a JSON field decoder with consistent location-bearing errors.
 *
 * @param schema The native validator for the expected field.
 * @param message The diagnostic for an invalid field.
 * @returns A reader accepting the source value and its JSON Pointer.
 */
const reader =
  <A extends Schema.Json>(schema: Schema.Codec<A>, message: string) =>
  (value: Schema.Json | undefined, location: string): Effect.Effect<A, GenerationError> =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        () =>
          new GenerationError({
            code: "invalid_input",
            hint: "Correct the value at this JSON Pointer.",
            location,
            message,
          }),
      ),
    );

/**
 * Decodes JSON objects and reports the source pointer on failure.
 */
export const object = reader(Schema.JsonObject, "Expected an object.");

/**
 * Decodes JSON arrays without changing member values.
 */
export const array = reader(Schema.Array(Schema.Json), "Expected an array.");

/**
 * Decodes string fields without coercing other JSON primitives.
 */
export const string = reader(Schema.String, "Expected a string.");

/**
 * Decodes explicit booleans without truthiness conversion.
 */
export const boolean = reader(Schema.Boolean, "Expected a boolean.");
