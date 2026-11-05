import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option, Sink, Stdio, Stream } from "effect";
import { Command } from "effect/cli";
import { HttpBody } from "effect/http";
import * as FileBodyModule from "../../src/runtime-src/runtime/file-body.ts";
import { FileBody } from "../../src/runtime-src/runtime/file-body.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";

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

const none = Option.none<string>();

const stdinOf = (...chunks: readonly Uint8Array[]): Layer.Layer<Stdio.Stdio> =>
  Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stderr: () => Sink.drain,
      stdin: Stream.fromIterable(chunks),
      stdout: () => Sink.drain,
    }),
  );

const fileLayer = Layer.mergeAll(defaultLayer, BunFileSystem.layer);

const inputLayer = (...chunks: readonly Uint8Array[]) =>
  Layer.mergeAll(fileLayer, stdinOf(...chunks), Input.stdinClaimLayer);

const withTempFile = <A, E, R>(
  content: Uint8Array,
  use: (path: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* temp() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* fs.makeTempFileScoped();

    yield* fs.writeFile(path, content);

    return yield* use(path);
  }).pipe(Effect.scoped);

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const readBody = (body: HttpBody.HttpBody): Effect.Effect<Uint8Array> => {
  if (body._tag === "Uint8Array") {
    return Effect.succeed(body.body);
  }

  return body._tag === "Stream" ? readAll(body) : Effect.succeed(new Uint8Array());
};

const overLimitChunks = (): readonly Uint8Array[] => {
  const chunk = new Uint8Array(1024 * 1024);

  return Array.from({ length: Input.maxBodyBytes / chunk.length + 1 }, () => chunk);
};

interface Flags {
  body: Option.Option<string>;
  bodyFile: Option.Option<string>;
}

const parse = (...args: readonly string[]) =>
  Effect.gen(function* parsed() {
    let seen: Flags | undefined;
    const command = Command.make(
      "x",
      { body: Input.bodyFlag, bodyFile: Input.bodyFileFlag },
      (flags) =>
        Effect.sync(() => {
          seen = flags;
        }),
    );

    yield* Command.runWith(command, { version: "0" })(args);

    return seen;
  }).pipe(Effect.provide(BunServices.layer), Effect.runPromise);

describe("Input flags", () => {
  test("both flags are optional and take a value", async () => {
    const seen = await parse();

    expect(Option.isNone(seen?.body ?? Option.some(""))).toBe(true);
    expect(Option.isNone(seen?.bodyFile ?? Option.some(""))).toBe(true);
  });

  test("--body-file - keeps - as a literal value", async () => {
    const seen = await parse("--body-file", "-");

    expect(Option.getOrUndefined(seen?.bodyFile ?? Option.none())).toBe("-");
  });

  test("--body takes the text as given", async () => {
    const seen = await parse("--body", ' {"a": 1} ');

    expect(Option.getOrUndefined(seen?.body ?? Option.none())).toBe(' {"a": 1} ');
  });
});

describe("Input.binaryBody", () => {
  test("a file becomes a stream with the file's exact bytes and size", async () => {
    const result = await run(
      withTempFile(bytes, (path) =>
        Input.binaryBody({ body: none, bodyFile: Option.some(path), required: true }).pipe(
          Effect.flatMap((body) =>
            Effect.map(readBody(body), (read) => ({
              contentLength: body._tag === "Stream" ? body.contentLength : undefined,
              read,
            })),
          ),
        ),
      ).pipe(Effect.provide(inputLayer())),
    );

    expect(result.contentLength).toBe(bytes.length);
    expect([...result.read]).toEqual([...bytes]);
  });

  test("- reads stdin as a stream, bytes verbatim", async () => {
    const read = await run(
      Input.binaryBody({ body: none, bodyFile: Option.some("-"), required: true }).pipe(
        Effect.flatMap(readBody),
        Effect.provide(inputLayer(bytes.slice(0, 4), bytes.slice(4))),
      ),
    );

    expect([...read]).toEqual([...bytes]);
  });

  test("--body is a UsageError naming the flag", async () => {
    const error = await run(
      Input.binaryBody({ body: Option.some("x"), bodyFile: none, required: true }).pipe(
        Effect.flip,
        Effect.provide(inputLayer()),
      ),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body");
  });

  test("--body with --body-file is a UsageError", async () => {
    const error = await run(
      Input.binaryBody({ body: Option.some("x"), bodyFile: Option.some("-"), required: true }).pipe(
        Effect.flip,
        Effect.provide(inputLayer()),
      ),
    );

    expect(error._tag).toBe("UsageError");
  });

  test("an unreadable file is a UsageError naming the flag, never the path", async () => {
    const path = "/nonexistent/input-test-secret-path";
    const error = await run(
      Input.binaryBody({ body: none, bodyFile: Option.some(path), required: true }).pipe(
        Effect.flip,
        Effect.provide(inputLayer()),
      ),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body-file");
    expect(error.message).not.toContain("input-test-secret-path");
  });

  test("an over-limit file is refused before any byte is read", async () => {
    const huge = Layer.succeed(FileBody, {
      open: () => Effect.succeed(HttpBody.stream(Stream.empty, undefined, Input.maxBodyBytes + 1)),
    });
    const error = await run(
      Input.binaryBody({ body: none, bodyFile: Option.some("big"), required: true }).pipe(
        Effect.flip,
        Effect.provide(Layer.mergeAll(huge, stdinOf(), Input.stdinClaimLayer)),
      ),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body-file");
  });

  test("stdin over the limit fails the stream", async () => {
    const failed = await run(
      Input.binaryBody({ body: none, bodyFile: Option.some("-"), required: true }).pipe(
        Effect.flatMap((body) => Effect.exit(readBody(body))),
        Effect.provide(inputLayer(...overLimitChunks())),
      ),
    );

    expect(failed._tag).toBe("Failure");
  });

  test("a required body with no input sends {} and an optional one sends nothing", async () => {
    const required = await run(
      Input.binaryBody({ body: none, bodyFile: none, required: true }).pipe(
        Effect.flatMap(readBody),
        Effect.provide(inputLayer()),
      ),
    );
    const optional = await run(
      Input.binaryBody({ body: none, bodyFile: none, required: false }).pipe(
        Effect.provide(inputLayer()),
      ),
    );

    expect(new TextDecoder().decode(required)).toBe("{}");
    expect(optional._tag).toBe("Empty");
  });
});

describe("Input.readBodyFile", () => {
  const verbatim = new TextEncoder().encode('  {"b": 1,\n "a":12345678901234567890 }\r\n');

  test("a file is read verbatim, whitespace and key order kept", async () => {
    const read = await run(
      withTempFile(verbatim, Input.readBodyFile).pipe(Effect.provide(inputLayer())),
    );

    expect([...read]).toEqual([...verbatim]);
  });

  test("- reads stdin verbatim", async () => {
    const read = await run(Input.readBodyFile("-").pipe(Effect.provide(inputLayer(verbatim))));

    expect([...read]).toEqual([...verbatim]);
  });

  test("a missing file is a UsageError naming the flag, never the path", async () => {
    const error = await run(
      Input.readBodyFile("/nonexistent/input-test-secret-path").pipe(
        Effect.flip,
        Effect.provide(inputLayer()),
      ),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body-file");
    expect(error.message).not.toContain("input-test-secret-path");
  });

  test("stdin over the limit is a UsageError", async () => {
    const error = await run(
      Input.readBodyFile("-").pipe(Effect.flip, Effect.provide(inputLayer(...overLimitChunks()))),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body-file");
  });
});

describe("one stdin consumer", () => {
  test("a second claimant is refused with a UsageError that names flags only", async () => {
    const error = await run(
      Effect.gen(function* claims() {
        const claim = yield* Input.StdinClaim;

        yield* claim.claim("body-file");

        return yield* Effect.flip(claim.claim("bearer-auth-file"));
      }).pipe(Effect.provide(Input.stdinClaimLayer)),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("bearer-auth-file");
  });

  test("two reads of - in one invocation: the second is refused", async () => {
    const error = await run(
      Effect.gen(function* twice() {
        yield* Input.binaryBody({ body: none, bodyFile: Option.some("-"), required: true });

        return yield* Effect.flip(Input.readBodyFile("-"));
      }).pipe(Effect.provide(inputLayer(bytes))),
    );

    expect(error._tag).toBe("UsageError");
  });

  test("separate invocations (layers) each get one claim", async () => {
    const once = Input.binaryBody({ body: none, bodyFile: Option.some("-"), required: true });

    await run(once.pipe(Effect.provide(inputLayer(bytes))));
    await run(once.pipe(Effect.provide(inputLayer(bytes))));
  });
});
