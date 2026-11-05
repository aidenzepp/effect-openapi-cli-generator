import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option, Schema, Sink, Stdio, Stream } from "effect";
import { Command } from "effect/cli";
import { HttpBody } from "effect/http";
import * as FileBodyModule from "../../src/runtime-src/runtime/file-body.ts";
import { FileBody } from "../../src/runtime-src/runtime/file-body.ts";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
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

const withFifo = <A, E, R>(writer: string, use: (path: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* fifo() {
    const fs = yield* FileSystem.FileSystem;
    const path = `${yield* fs.makeTempDirectoryScoped()}/fifo`;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        Bun.spawnSync(["mkfifo", path]);

        return Bun.spawn(["sh", "-c", `${writer} > "$1"`, "sh", path], { stderr: "ignore" });
      }),
      (writerProcess) =>
        Effect.sync(() => {
          writerProcess.kill();
        }),
    );

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

  test("- reads stdin into memory, bytes verbatim", async () => {
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

  test("a file declared over the limit is refused before any byte is read", async () => {
    const huge = Layer.succeed(FileBody, {
      open: () => Effect.succeed(HttpBody.stream(Stream.empty, undefined, Input.maxBodyBytes + 1)),
    });
    const error = await run(
      withTempFile(bytes, (path) =>
        Input.binaryBody({ body: none, bodyFile: Option.some(path), required: true }).pipe(
          Effect.flip,
        ),
      ).pipe(
        Effect.provide(Layer.mergeAll(huge, BunFileSystem.layer, stdinOf(), Input.stdinClaimLayer)),
      ),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body-file");
  });

  test("a regular file over the limit is refused at flag time", async () => {
    const error = await run(
      withTempFile(bytes, (path) =>
        Effect.gen(function* big() {
          const fs = yield* FileSystem.FileSystem;

          yield* fs.truncate(path, Input.maxBodyBytes + 1);

          return yield* Effect.flip(
            Input.binaryBody({ body: none, bodyFile: Option.some(path), required: true }),
          );
        }),
      ).pipe(Effect.provide(inputLayer())),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body-file");
  });

  test("the limit counts bytes read: a stream longer than its declared size fails as a UsageError", async () => {
    const lying = Layer.succeed(FileBody, {
      open: () =>
        Effect.succeed(HttpBody.stream(Stream.fromIterable(overLimitChunks()), undefined, 1)),
    });
    const error = await run(
      withTempFile(bytes, (path) =>
        Input.binaryBody({ body: none, bodyFile: Option.some(path), required: true }).pipe(
          Effect.flatMap((body) =>
            body._tag === "Stream" ? Stream.runDrain(body.stream) : Effect.void,
          ),
          Effect.flip,
        ),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(lying, BunFileSystem.layer, stdinOf(), Input.stdinClaimLayer),
        ),
      ),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error instanceof UsageError ? error.flag : undefined).toBe("body-file");
  });

  test("a FIFO over the limit is refused at flag time and points to -", async () => {
    const error = await run(
      withFifo(`head -c ${Input.maxBodyBytes + 1} /dev/zero`, (path) =>
        Input.binaryBody({ body: none, bodyFile: Option.some(path), required: true }).pipe(
          Effect.flip,
        ),
      ).pipe(Effect.provide(inputLayer())),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body-file");
    expect(error.message).toContain("--body-file -");
  });

  test("a file without read permission is a UsageError at flag time, never the path", async () => {
    const error = await run(
      withTempFile(bytes, (path) =>
        Effect.gen(function* locked() {
          const fs = yield* FileSystem.FileSystem;

          yield* fs.chmod(path, 0o000);

          return yield* Effect.flip(
            Input.binaryBody({ body: none, bodyFile: Option.some(path), required: true }),
          );
        }),
      ).pipe(Effect.provide(inputLayer())),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body-file");
    expect(error.message).not.toContain("/");
  });

  test("a directory is a UsageError at flag time, never the path", async () => {
    const error = await run(
      Effect.gen(function* directory() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* fs.makeTempDirectoryScoped();

        return yield* Effect.flip(
          Input.binaryBody({ body: none, bodyFile: Option.some(path), required: true }),
        );
      }).pipe(Effect.scoped, Effect.provide(inputLayer())),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body-file");
    expect(error.message).not.toContain("/");
  });

  test("stdin over the limit is a UsageError naming --body-file at flag time", async () => {
    const error = await run(
      Input.binaryBody({ body: none, bodyFile: Option.some("-"), required: true }).pipe(
        Effect.flip,
        Effect.provide(inputLayer(...overLimitChunks())),
      ),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body-file");
  });

  test("a required body with no input is a UsageError naming --body-file; an optional one is empty", async () => {
    const error = await run(
      Input.binaryBody({ body: none, bodyFile: none, required: true }).pipe(
        Effect.flip,
        Effect.provide(inputLayer()),
      ),
    );
    const optional = await run(
      Input.binaryBody({ body: none, bodyFile: none, required: false }).pipe(
        Effect.provide(inputLayer()),
      ),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body-file");
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

const decoder = new TextDecoder();

const Person = Schema.Struct({
  address: Schema.optionalKey(Schema.Struct({ city: Schema.optionalKey(Schema.String) })),
  count: Schema.optionalKey(Schema.Number),
  name: Schema.String,
});

const merge = (options: {
  readonly body?: string;
  readonly bodyFile?: string;
  readonly fields?: Parameters<typeof Input.mergeBody>[0]["fields"];
  readonly required?: boolean;
  readonly schema?: Schema.Top;
}) =>
  Input.mergeBody({
    body: Option.fromNullishOr(options.body),
    bodyFile: Option.fromNullishOr(options.bodyFile),
    fields: options.fields ?? {},
    required: options.required ?? true,
    schema: options.schema ?? Schema.Unknown,
  });

const mergedText = (...args: Parameters<typeof merge>) =>
  merge(...args).pipe(
    Effect.flatMap(readBody),
    Effect.map((read) => decoder.decode(read)),
    Effect.provide(inputLayer()),
  );

const failure = (...args: Parameters<typeof merge>) =>
  merge(...args).pipe(Effect.flip, Effect.provide(inputLayer()));

describe("Input.mergeBody", () => {
  test("--body with --body-file is a UsageError naming the flag", async () => {
    const error = await run(failure({ body: "{}", bodyFile: "x" }));

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body");
  });

  test("the field /__proto__/x merges into an own key and Object.prototype is untouched", async () => {
    const text = await run(
      mergedText({ fields: { "/__proto__/x": Option.some("1") }, required: false }),
    );

    expect(text).toBe('{"__proto__":{"x":"1"}}');
    expect(Object.hasOwn(Object.prototype, "x")).toBe(false);
    expect("x" in {}).toBe(false);
  });

  test("constructor and prototype are ordinary own keys, also from the body", async () => {
    const text = await run(
      mergedText({
        body: '{"constructor":{"a":1},"__proto__":{"b":2}}',
        fields: { "/constructor/c": Option.some("3"), "/prototype/d": Option.some("4") },
      }),
    );

    expect(text).toBe('{"constructor":{"a":1,"c":"3"},"__proto__":{"b":2},"prototype":{"d":"4"}}');
    expect(Object.hasOwn(Object.prototype, "b")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "c")).toBe(false);
  });

  test("a property name containing . or / (pointer /a~1b, /c~0d, /e.f) lands under one key", async () => {
    const text = await run(
      mergedText({
        fields: {
          "/a~1b": Option.some("1"),
          "/c~0d": Option.some("2"),
          "/e.f": Option.some("3"),
          "/g/h~1i": Option.some("4"),
        },
      }),
    );

    expect(JSON.parse(text)).toEqual({ "a/b": "1", "c~d": "2", "e.f": "3", g: { "h/i": "4" } });
  });

  test("a field flag overrides the body at its pointer and keeps the rest", async () => {
    const text = await run(
      mergedText({
        body: '{"name":"body","address":{"city":"X","zip":"1"},"keep":true}',
        fields: { "/address/city": Option.some("flag"), "/name": Option.some("flag") },
      }),
    );

    expect(JSON.parse(text)).toEqual({
      address: { city: "flag", zip: "1" },
      keep: true,
      name: "flag",
    });
  });

  test("a field flag replaces a non-object body value on its path", async () => {
    const text = await run(
      mergedText({ body: '{"address":"x"}', fields: { "/address/city": Option.some("c") } }),
    );

    expect(JSON.parse(text)).toEqual({ address: { city: "c" } });
  });

  test("a field flag cannot be merged into a body that is not an object", async () => {
    const error = await run(failure({ body: "[1]", fields: { "/name": Option.some("a") } }));

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body");
  });

  test("a missing required property after the merge is a UsageError, a supplied one is not", async () => {
    const error = await run(failure({ fields: { "/count": Option.some(2) }, schema: Person }));

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body");

    const text = await run(
      mergedText({
        body: '{"count":2}',
        fields: { "/name": Option.some("n") },
        schema: Person,
      }),
    );

    expect(JSON.parse(text)).toEqual({ count: 2, name: "n" });
  });

  test("the merged value is asserted, never decoded: unknown properties are sent", async () => {
    const text = await run(mergedText({ body: '{"name":"n","extra":1}', schema: Person }));

    expect(text).toBe('{"name":"n","extra":1}');
  });

  test("an assertion failure names the flag and never the value", async () => {
    const error = await run(
      failure({ body: '{"name":"s3cret-value","count":"x"}', schema: Person }),
    );

    expect(error._tag).toBe("UsageError");
    expect(JSON.stringify(error)).not.toContain("s3cret-value");
  });

  test("a body that is not JSON is a UsageError", async () => {
    const error = await run(failure({ body: "{nope" }));

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body");
  });

  test("body bytes with no field override are sent verbatim", async () => {
    const source = '{ "id" : 9007199254740993 ,  "name":"n", "f" : 1.50 }';
    const text = await run(mergedText({ body: source, schema: Person }));

    expect(text).toBe(source);
  });

  test("9007199254740993 in the body arrives as the same digits through a merge", async () => {
    const text = await run(
      mergedText({
        body: '{"id":9007199254740993,"big":-9007199254740995,"f":1.5,"name":"a"}',
        fields: { "/name": Option.some("b") },
      }),
    );

    expect(text).toBe('{"id":9007199254740993,"big":-9007199254740995,"f":1.5,"name":"b"}');
  });

  test("an int64 field flag arrives as the same digits and is asserted as a number", async () => {
    const text = await run(
      mergedText({
        fields: {
          "/count": Option.some(new Input.JsonNumber("9007199254740993")),
          "/name": Option.some("n"),
        },
        schema: Person,
      }),
    );

    expect(text).toBe('{"count":9007199254740993,"name":"n"}');
  });

  test("a repeatable field flag is an array and an empty one is unset", async () => {
    const text = await run(
      Input.mergeBody({
        body: none,
        bodyFile: none,
        fields: { "/none": [], "/tags": ["a", "b"] },
        required: true,
        schema: Schema.Unknown,
      }).pipe(
        Effect.flatMap(readBody),
        Effect.map((read) => decoder.decode(read)),
        Effect.provide(inputLayer()),
      ),
    );

    expect(text).toBe('{"tags":["a","b"]}');
  });

  test("an int64 field flag that is not digits is a UsageError that omits the value", async () => {
    const error = await run(
      failure({ fields: { "/count": Option.some(new Input.JsonNumber("12x-secret")) } }),
    );

    expect(error._tag).toBe("UsageError");
    expect(JSON.stringify(error)).not.toContain("12x-secret");
  });

  test("a required body with no input is {} and fails on required properties", async () => {
    expect(await run(mergedText({}))).toBe("{}");

    const error = await run(failure({ schema: Person }));

    expect(error._tag).toBe("UsageError");
  });

  test("an optional body with no input is empty", async () => {
    const body = await run(merge({ required: false }).pipe(Effect.provide(inputLayer())));

    expect(body._tag).toBe("Empty");
  });

  test("--body-file merges, and - claims stdin once", async () => {
    const text = await run(
      withTempFile(new TextEncoder().encode('{"name":"file"}'), (path) =>
        merge({ bodyFile: path, fields: { "/count": Option.some(1) } }).pipe(
          Effect.flatMap(readBody),
          Effect.map((read) => decoder.decode(read)),
        ),
      ).pipe(Effect.provide(inputLayer())),
    );

    expect(JSON.parse(text)).toEqual({ count: 1, name: "file" });

    const error = await run(
      Effect.gen(function* twice() {
        yield* merge({ bodyFile: "-" });

        return yield* Effect.flip(merge({ bodyFile: "-" }));
      }).pipe(Effect.provide(inputLayer(new TextEncoder().encode("{}")))),
    );

    expect(error._tag).toBe("UsageError");
  });

  test("a JSON-valued field with a nested __proto__ key and an array of objects merges at its pointer", async () => {
    const meta: unknown = JSON.parse(
      '{"__proto__":{"polluted":true},"inner":{"k":[1,{"z":null}]}}',
    );
    const text = await run(
      mergedText({
        body: '{"name":"n"}',
        fields: {
          "/items": Option.some([{ id: 1 }, { id: 2, tags: ["a"] }]),
          "/meta": Option.some(Schema.decodeUnknownSync(Schema.Json)(meta)),
          "/plain": Option.some({ a: 1 }),
          "/plain/__proto__/x": Option.some("1"),
        },
      }),
    );

    expect(text).toBe(
      '{"name":"n","items":[{"id":1},{"id":2,"tags":["a"]}],' +
        '"meta":{"__proto__":{"polluted":true},"inner":{"k":[1,{"z":null}]}},' +
        '"plain":{"a":1,"__proto__":{"x":"1"}}}',
    );
    expect("polluted" in {}).toBe(false);
    expect("x" in {}).toBe(false);
  });

  test("an unreadable --body-file names the flag, not the path", async () => {
    const error = await run(failure({ bodyFile: "/nonexistent/secret-path" }));

    expect(error.flag).toBe("body-file");
    expect(JSON.stringify(error)).not.toContain("secret-path");
  });
});

const counting = (body: HttpBody.HttpBody) => {
  const counter = { runs: 0 };
  const effect = Effect.sync(() => {
    counter.runs += 1;

    return body;
  });

  return { counter, effect };
};

describe("Input.selectBody", () => {
  const media = { request: ["application/json", "image/png"], responses: {} };
  const marker = HttpBody.text("marker");

  test("no --content-type selects the declared JSON alternative", async () => {
    const json = counting(HttpBody.text("json"));
    const png = counting(marker);
    const selected = await run(
      Input.selectBody({
        alternatives: { "application/json": json.effect, "image/png": png.effect },
        chosen: none,
        media,
      }),
    );

    expect(selected.contentType).toBe("application/json");
    expect([json.counter.runs, png.counter.runs]).toEqual([1, 0]);
  });

  test("only the chosen alternative is evaluated", async () => {
    const json = counting(HttpBody.text("json"));
    const png = counting(HttpBody.uint8Array(bytes));
    const selected = await run(
      Input.selectBody({
        alternatives: { "application/json": json.effect, "image/png": png.effect },
        chosen: Option.some("image/png"),
        media,
      }),
    );

    expect(selected.contentType).toBe("image/png");
    expect([...(await run(readBody(selected.body)))]).toEqual([...bytes]);
    expect([json.counter.runs, png.counter.runs]).toEqual([0, 1]);
  });

  test("the unchosen binary alternative's refusals never fire and stdin is read once", async () => {
    const selected = await run(
      Input.selectBody({
        alternatives: {
          "application/json": Input.mergeBody({
            body: none,
            bodyFile: Option.some("-"),
            fields: {},
            required: true,
            schema: Schema.Json,
          }),
          "image/png": Input.binaryBody({
            body: Option.some("x"),
            bodyFile: none,
            required: true,
          }),
        },
        chosen: none,
        media,
      }).pipe(Effect.provide(inputLayer(new TextEncoder().encode('{"a":1}')))),
    );

    expect(selected.contentType).toBe("application/json");
    expect(new TextDecoder().decode(await run(readBody(selected.body)))).toBe('{"a":1}');
  });

  test("an undeclared --content-type is a UsageError that never echoes the value", async () => {
    const png = counting(marker);
    const error = await run(
      Input.selectBody({
        alternatives: { "application/json": png.effect, "image/png": png.effect },
        chosen: Option.some("text/secret-value"),
        media,
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(JSON.stringify(error)).toContain("--content-type");
    expect(JSON.stringify(error)).not.toContain("secret-value");
    expect(png.counter.runs).toBe(0);
  });

  test("a range key sends the operator's concrete type", async () => {
    const image = counting(HttpBody.uint8Array(bytes));
    const selected = await run(
      Input.selectBody({
        alternatives: { "image/*": image.effect },
        chosen: Option.some("image/webp"),
        media: { request: ["image/*"], responses: {} },
      }),
    );

    expect(selected.contentType).toBe("image/webp");
    expect(image.counter.runs).toBe(1);
  });
});

describe("Input.jsonNumber", () => {
  test("a digit string round-trips through a merge with its exact digits", async () => {
    const number = await run(Input.jsonNumber("9007199254740993", "count"));

    expect(number).toBeInstanceOf(Input.JsonNumber);
    expect(number.text).toBe("9007199254740993");

    const text = await run(
      mergedText({
        fields: { "/count": Option.some(number) },
        schema: Schema.Struct({ count: Schema.Number }),
      }),
    );

    expect(text).toBe('{"count":9007199254740993}');
  });

  test("a non-digit string is a UsageError naming the flag only, never the value", async () => {
    const error = await run(Input.jsonNumber("12x-secret", "count").pipe(Effect.flip));

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("count");
    expect(JSON.stringify(error)).not.toContain("12x-secret");
  });
});
