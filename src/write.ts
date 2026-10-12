import { Effect, FileSystem, Path } from "effect";
import { OutputError } from "./errors.js";
import type { GeneratedApplication } from "./model.js";

export const writeApplication = (application: GeneratedApplication, output: string) =>
  Effect.gen(function* () {
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
          path: file.path,
          message: "Generated file path must be a safe relative path",
        });
      }
    }
    const io = (error: { readonly message: string }) =>
      new OutputError({ code: "io", path: target, message: error.message });
    yield* Effect.acquireUseRelease(
      fs.makeDirectory(target).pipe(
        Effect.mapError(
          (error) =>
            new OutputError({
              code: error.reason._tag === "AlreadyExists" ? "exists" : "io",
              path: target,
              message: error.message,
            }),
        ),
      ),
      () =>
        Effect.forEach(
          application.files,
          (file) =>
            Effect.gen(function* () {
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
