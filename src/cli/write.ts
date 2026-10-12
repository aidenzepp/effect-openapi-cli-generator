import { Effect, FileSystem, Path } from "effect";
import { OutputError } from "./errors.js";
import type { GeneratedApplication } from "../core/model.js";

/**
 * Claims an absent output directory and writes only safe relative generated paths.
 * Failed or interrupted writes remove only the directory claimed by this invocation.
 *
 * @param application The generated files to persist.
 * @param output An absent destination whose parent already exists.
 * @returns Completion after all files are written, or a typed output failure.
 */
export const writeApplication = (application: GeneratedApplication, output: string) =>
  Effect.gen(function* claimAndWriteApplication() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.resolve(output);
    for (const file of application.files) {
      if (
        path.isAbsolute(file.path) ||
        file.path.includes("\\") ||
        file.path.includes("\0") ||
        file.path
          .split("/")
          .some((segment) => segment === "" || segment === "." || segment === "..")
      ) {
        return yield* new OutputError({
          code: "io",
          message: "Generated file path must be a safe relative path",
          path: file.path,
        });
      }
    }
    /**
     * Attaches the claimed output directory to filesystem write failures.
     *
     * @param error The platform error from a generated file write.
     * @returns The CLI output failure for the owned target.
     */
    const io = (error: { readonly message: string }) =>
      new OutputError({ code: "io", message: error.message, path: target });

    return yield* Effect.acquireUseRelease(
      fs.makeDirectory(target).pipe(
        Effect.mapError(
          (error) =>
            new OutputError({
              code: error.reason._tag === "AlreadyExists" ? "exists" : "io",
              message: error.message,
              path: target,
            }),
        ),
      ),
      () =>
        Effect.forEach(
          application.files,
          (file) =>
            Effect.gen(function* writeGeneratedFile() {
              const destination = path.join(target, file.path);
              yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
              yield* fs.writeFileString(destination, file.content, { flag: "wx" });
            }),
          { discard: true },
        ).pipe(Effect.mapError(io)),
      (_, exit) =>
        exit._tag === "Failure"
          ? fs.remove(target, { recursive: true }).pipe(Effect.orDie)
          : Effect.void,
    );
  });
