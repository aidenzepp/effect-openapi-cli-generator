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

      let { content } = file;
      let stable = false;
      // Oxfmt can reflow nested JSDoc after the first pass changes its indentation.
      for (let pass = 0; pass < 4; pass += 1) {
        const input = content;
        const result = yield* Effect.tryPromise({
          catch: (cause) =>
            new GenerationError({
              code: "format",
              hint: "",
              location: file.path,
              message: String(cause),
            }),
          try: () =>
            format(file.path, input, {
              endOfLine: "lf",
              jsdoc: { commentLineStrategy: "multiline", lineWrappingStyle: "balance" },
              sortImports: { newlinesBetween: false },
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

        const next = `${result.code.trimEnd()}\n`;
        if (next === content) {
          stable = true;
          break;
        }

        content = next;
      }
      if (!stable) {
        return yield* new GenerationError({
          code: "format",
          hint: "Inspect the formatter result for unstable formatting.",
          location: file.path,
          message: "Formatting did not stabilize within four passes.",
        });
      }

      files.push({ content, path: file.path });
    }

    return { files };
  });
