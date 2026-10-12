import { Effect, Schema } from "effect";
import { emit } from "./emit.js";
import { normalize } from "./normalize.js";
import type { GenerateOptions } from "./model.js";

import { GenerationError } from "./errors.js";

export { GenerationError } from "./errors.js";
export type { GenerateOptions, GeneratedApplication, GeneratedFile } from "./model.js";
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public untrusted boundary is immediately decoded with Schema.Json.
export const generate = (document: unknown, options?: GenerateOptions) =>
  Schema.decodeUnknownEffect(Schema.Json)(document).pipe(
    Effect.mapError(
      () =>
        new GenerationError({
          code: "invalid_input",
          hint: "Supply a parsed JSON document.",
          location: "",
          message: "Expected a JSON value.",
        }),
    ),
    Effect.flatMap(normalize),
    Effect.flatMap((model) => emit(model, options)),
  );
