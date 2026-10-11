import { Effect } from "effect";
import { emit } from "./emit.js";
import { normalize } from "./normalize.js";
import type { GenerateOptions } from "./model.js";
export { GenerationError } from "./errors.js";
export type { GenerateOptions, GeneratedApplication, GeneratedFile } from "./model.js";
export const generate = (document: unknown, options?: GenerateOptions) =>
  normalize(document).pipe(Effect.flatMap((model) => emit(model, options)));
