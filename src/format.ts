import { Effect } from "effect";
import { format } from "oxfmt";
import { GenerationError } from "./errors.js";
import type { GeneratedApplication } from "./model.js";

export const formatApplication = (
  application: GeneratedApplication,
): Effect.Effect<GeneratedApplication, GenerationError> =>
  Effect.gen(function* () {
    const files = [];
    for (const file of application.files) {
      if (!/\.(?:ts|json)$/.test(file.path)) {
        files.push({ ...file, content: `${file.content.trimEnd()}\n` });
        continue;
      }
      const result = yield* Effect.tryPromise({
        try: () =>
          format(file.path, file.content, {
            endOfLine: "lf",
            jsdoc: { commentLineStrategy: "multiline", lineWrappingStyle: "balance" },
          }),
        catch: (cause) =>
          new GenerationError({
            code: "format",
            location: file.path,
            message: String(cause),
            hint: "",
          }),
      });
      if (result.errors.length > 0)
        return yield* new GenerationError({
          code: "format",
          location: file.path,
          message: JSON.stringify(result.errors),
          hint: "",
        });
      files.push({ path: file.path, content: `${result.code.trimEnd()}\n` });
    }
    return { files };
  });
