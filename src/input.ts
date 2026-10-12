import { Effect, Schema } from "effect";
import { GenerationError } from "./errors.js";

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

export const object = reader(Schema.JsonObject, "Expected an object.");
export const array = reader(Schema.Array(Schema.Json), "Expected an array.");
export const string = reader(Schema.String, "Expected a string.");
export const boolean = reader(Schema.Boolean, "Expected a boolean.");
