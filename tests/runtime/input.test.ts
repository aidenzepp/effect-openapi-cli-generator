import { describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Stream } from "effect";
import { HttpBody } from "effect/http";
import * as FileBodyModule from "../../src/runtime-src/runtime/file-body.ts";
import { FileBody } from "../../src/runtime-src/runtime/file-body.ts";

const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255, 10, 13, 0x7b]);

const streamOf = (body: HttpBody.HttpBody): HttpBody.Stream => {
  if (body._tag !== "Stream") {
    throw new Error(`expected a stream body, got ${body._tag}`);
  }

  return body;
};

const readAll = (body: HttpBody.Stream): Effect.Effect<Uint8Array> =>
  Stream.runCollect(body.stream).pipe(
    Effect.map((chunks) => Buffer.concat(chunks)),
    Effect.orDie,
  );

const defaultLayer = FileBodyModule.layer.pipe(Layer.provide(BunFileSystem.layer));

describe("FileBody", () => {
  test("the default layer yields a body with the file's exact bytes and size", async () => {
    const result = await Effect.gen(function* read() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* fs.makeTempFileScoped();

      yield* fs.writeFile(path, bytes);

      const fileBody = yield* FileBody;
      const body = streamOf(yield* fileBody.open(path));

      return { contentLength: body.contentLength, read: yield* readAll(body) };
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(defaultLayer, BunFileSystem.layer)),
      Effect.runPromise,
    );

    expect(result.contentLength).toBe(bytes.length);
    expect([...result.read]).toEqual([...bytes]);
  });

  test("a missing file fails with a PlatformError", async () => {
    const error = await Effect.gen(function* open() {
      const fileBody = yield* FileBody;

      return yield* fileBody.open("/nonexistent/file-body-test-path").pipe(Effect.flip);
    }).pipe(Effect.provide(defaultLayer), Effect.runPromise);

    expect(error._tag).toBe("PlatformError");
  });

  test("a test layer can replace the service", async () => {
    const replaced = Layer.succeed(FileBody, {
      open: () => Effect.succeed(HttpBody.text("replaced")),
    });
    const body = await Effect.gen(function* open() {
      const fileBody = yield* FileBody;

      return yield* fileBody.open("ignored");
    }).pipe(Effect.provide(replaced), Effect.runPromise);

    expect(body._tag).toBe("Uint8Array");
  });
});
