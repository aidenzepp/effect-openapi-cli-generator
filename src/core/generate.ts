import { Effect, Schema } from "effect";
import { emit } from "./emit.js";
import { normalize } from "./normalize.js";
import type { GenerateOptions } from "./model.js";

import { GenerationError } from "./errors.js";

/**
 * Generates a standalone Effect CLI from untrusted parsed JSON.
 * This boundary requires no filesystem or network services; the executable owns IO.
 *
 * @param document The parsed OpenAPI 3.0 or 3.1 document.
 * @param options Optional executable naming override.
 * @returns Formatted source files or a location-bearing GenerationError.
 */
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
