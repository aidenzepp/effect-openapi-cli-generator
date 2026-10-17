import { Effect, FileSystem, Path } from "effect";
import { CliError } from "effect/cli";

// template:body
/**
 * Read binary bytes without exposing file contents or filesystem causes in CLI errors.
 */
export const file = (path: string | undefined) =>
  path === undefined
    ? Effect.succeed(path)
    : Effect.gen(function* readMultipartFile() {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const bytes = yield* fs.readFile(path).pipe(
          Effect.mapError(
            () =>
              new CliError.UserError({
                cause: undefined,
                userMessage:
                  "A multipart file could not be read. Check the file flag and its permissions; no request was sent.",
              }),
          ),
        );

        return new File([Uint8Array.from(bytes)], paths.basename(path), {
          type: "application/octet-stream",
        });
      });
