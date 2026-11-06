import { afterAll, describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option, Sink, Stdio, Stream } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { FileBody } from "../../src/runtime-src/runtime/file-body.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

const encoder = new TextEncoder();

const none = Option.none<string>();

const capture = startCaptureServer();

afterAll(() => {
  capture.stop();
});

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

// The layer `bin.ts` provides: a file over `Bun.file`, which fetch sends with its `Content-Length`.
const bunFileBody = Layer.succeed(FileBody, {
  open: (path) => Effect.succeed(HttpBody.raw(Bun.file(path))),
});

const fileLayer = Layer.mergeAll(bunFileBody, BunFileSystem.layer);

const inputLayer = (...chunks: readonly Uint8Array[]) =>
  Layer.mergeAll(fileLayer, stdinOf(...chunks), Input.stdinClaimLayer);

const header = (seen: RecordedRequest, name: string) =>
  seen.headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1];

// The input goes through the runtime's two seams, `Input.sequentialBody` and `Serialize.body`, and
// is sent to the capture server by a real client.
const send = (
  mediaType: string,
  source: { body?: string; bodyFile?: string },
  ...stdin: readonly Uint8Array[]
) =>
  Effect.gen(function* sendBody() {
    const body = yield* Input.sequentialBody({
      body: Option.fromUndefinedOr(source.body),
      bodyFile: Option.fromUndefinedOr(source.bodyFile),
      required: true,
    });
    const built = yield* Serialize.request("POST", {
      body: Serialize.body(mediaType, body),
      headers: [],
      path: Serialize.path("/upload", []),
      query: [],
    });
    const before = capture.requests().length;
    const response = yield* HttpClient.execute(
      HttpClientRequest.prependUrl(built, capture.origins["127.0.0.1"]),
    );

    yield* response.text;

    const seen = capture.requests().at(before);

    return seen ?? (yield* Effect.die(new Error("the capture server saw no request")));
  }).pipe(Effect.provide(Layer.mergeAll(inputLayer(...stdin), FetchHttpClient.layer)));

const withTempFile = <E>(
  content: Uint8Array,
  use: (path: string) => Effect.Effect<RecordedRequest, E>,
) =>
  Effect.gen(function* temp() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* fs.makeTempFileScoped();

    yield* fs.writeFile(path, content);

    return yield* use(path);
  }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer));

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

// An item that breaks any `itemSchema` and a line that is not JSON: sent as given.
const ndjson = encoder.encode('{"id":1}\n{"id":"not a number"}\nnot json at all\n{"id":3}\n');

// Records hold newlines, and 0x1E separates them (RFC 7464).
const jsonSeq = encoder.encode('\u001E{"a":\n  1}\n\u001E{"a":\n  2}\n\u001E[1,\n2]\n');

describe("sequential upload", () => {
  test("--body is sent as given with the declared media type", async () => {
    const seen = await run(
      send("application/x-ndjson", { body: new TextDecoder().decode(ndjson) }),
    );

    expect([...seen.body]).toEqual([...ndjson]);
    expect(header(seen, "content-type")).toBe("application/x-ndjson");
  });

  test("NDJSON from a file is sent byte for byte with Content-Length", async () => {
    const seen = await run(
      withTempFile(ndjson, (path) => send("application/x-ndjson", { bodyFile: path })),
    );

    expect([...seen.body]).toEqual([...ndjson]);
    expect(header(seen, "content-length")).toBe(String(ndjson.length));
    expect(header(seen, "transfer-encoding")).toBeUndefined();
    expect(header(seen, "content-type")).toBe("application/x-ndjson");
  });

  test("JSON-seq records with newlines and 0x1E separators are sent byte for byte", async () => {
    const seen = await run(
      withTempFile(jsonSeq, (path) => send("application/json-seq", { bodyFile: path })),
    );

    expect([...seen.body]).toEqual([...jsonSeq]);
    expect(header(seen, "content-type")).toBe("application/json-seq");
  });

  test("a stdin body is sent chunked and unchanged", async () => {
    const seen = await run(
      send(
        "application/json-seq",
        { bodyFile: "-" },
        jsonSeq.slice(0, 7),
        jsonSeq.slice(7, 20),
        jsonSeq.slice(20),
      ),
    );

    expect([...seen.body]).toEqual([...jsonSeq]);
    expect(header(seen, "transfer-encoding")).toBe("chunked");
    expect(header(seen, "content-length")).toBeUndefined();
    expect(header(seen, "content-type")).toBe("application/json-seq");
  });

  test("a stdin body is not collected into memory before the send", async () => {
    const pulled: number[] = [];
    const source = Stream.fromIterable([ndjson, ndjson]).pipe(
      Stream.tap(() => Effect.sync(() => pulled.push(pulled.length))),
    );
    const layer = Layer.mergeAll(
      fileLayer,
      Input.stdinClaimLayer,
      Layer.succeed(
        Stdio.Stdio,
        Stdio.make({
          args: Effect.succeed([]),
          stderr: () => Sink.drain,
          stdin: source,
          stdout: () => Sink.drain,
        }),
      ),
    );
    const body = await run(
      Input.sequentialBody({ body: none, bodyFile: Option.some("-"), required: true }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(body._tag).toBe("Stream");
    expect(pulled).toEqual([]);
  });

  test("a file larger than the in-memory body limit is streamed with Content-Length", async () => {
    const size = Input.maxBodyBytes + 1;
    const seen = await run(
      Effect.gen(function* big() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* fs.makeTempFileScoped();

        yield* fs.truncate(path, size);

        return yield* send("application/x-ndjson", { bodyFile: path });
      }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)),
    );

    expect(seen.body.length).toBe(size);
    expect(header(seen, "content-length")).toBe(String(size));
  });

  test("--body with --body-file is a UsageError naming --body", async () => {
    const error = await run(
      Input.sequentialBody({
        body: Option.some("x"),
        bodyFile: Option.some("-"),
        required: true,
      }).pipe(Effect.flip, Effect.provide(inputLayer())),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("body");
  });

  test("a required body with neither flag is a UsageError naming --body-file", async () => {
    const error = await run(
      Input.sequentialBody({ body: none, bodyFile: none, required: true }).pipe(
        Effect.flip,
        Effect.provide(inputLayer()),
      ),
    );

    expect(error.flag).toBe("body-file");
  });

  test("an optional body with neither flag is empty", async () => {
    const body = await run(
      Input.sequentialBody({ body: none, bodyFile: none, required: false }).pipe(
        Effect.provide(inputLayer()),
      ),
    );

    expect(body._tag).toBe("Empty");
  });

  test("stdin is claimed once", async () => {
    const error = await run(
      Effect.gen(function* twice() {
        const options = { body: none, bodyFile: Option.some("-"), required: true };

        yield* Input.sequentialBody(options);

        return yield* Input.sequentialBody(options).pipe(Effect.flip);
      }).pipe(Effect.provide(inputLayer())),
    );

    expect(error._tag).toBe("UsageError");
  });

  test("a missing file is a UsageError naming --body-file, not the path", async () => {
    const error = await run(
      Input.sequentialBody({
        body: none,
        bodyFile: Option.some("/nonexistent/sequential-upload-test"),
        required: true,
      }).pipe(Effect.flip, Effect.provide(inputLayer())),
    );

    expect(error.flag).toBe("body-file");
    expect(error.message).not.toContain("nonexistent");
  });
});
