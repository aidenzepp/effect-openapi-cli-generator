import { Effect } from "effect";
import { format } from "oxfmt";
import { GenerationError } from "./errors.js";
import type { GeneratedApplication } from "./model.js";

/**
 * Formats each emitted source or manifest and normalizes trailing newlines.
 *
 * @param application The generated files before final presentation.
 * @returns Formatted files, or a typed formatter failure naming the affected path.
 */
export const formatApplication = (
  application: GeneratedApplication,
): Effect.Effect<GeneratedApplication, GenerationError> =>
  Effect.gen(function* formatGeneratedFiles() {
    const files = [];
    for (const file of application.files) {
      if (!/\.(?:ts|json)$/u.test(file.path)) {
        files.push({ ...file, content: `${file.content.trimEnd()}\n` });
        continue;
      }

      const result = yield* Effect.tryPromise({
        catch: (cause) =>
          new GenerationError({
            code: "format",
            hint: "",
            location: file.path,
            message: String(cause),
          }),
        try: () =>
          format(file.path, file.content, {
            endOfLine: "lf",
            jsdoc: { commentLineStrategy: "multiline", lineWrappingStyle: "balance" },
          }),
      });
      if (result.errors.length > 0) {
        return yield* new GenerationError({
          code: "format",
          hint: "",
          location: file.path,
          message: JSON.stringify(result.errors),
        });
      }

      files.push({ content: `${result.code.trimEnd()}\n`, path: file.path });
    }

    return { files };
  });
