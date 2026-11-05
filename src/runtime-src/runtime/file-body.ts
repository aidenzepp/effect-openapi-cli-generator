import { Context, Effect, FileSystem, Layer } from "effect";
import type { PlatformError } from "effect";
import { HttpBody } from "effect/http";

/**
 * Opens a file as a request body that carries its `Content-Length`. The one runtime service the
 * design names: `bin.ts` provides a `Bun.file` layer, and `layer` is the platform-neutral default.
 */
export class FileBody extends Context.Service<
  FileBody,
  {
    readonly open: (path: string) => Effect.Effect<HttpBody.HttpBody, PlatformError.PlatformError>;
  }
>()("openapi-cli/runtime/FileBody") {}

/**
 * The platform-neutral default: `HttpBody.file` over the provided `FileSystem`.
 */
export const layer: Layer.Layer<FileBody, never, FileSystem.FileSystem> = Layer.effect(
  FileBody,
  Effect.gen(function* build() {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      open: (path) =>
        HttpBody.file(path).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
    };
  }),
);
