import { afterAll, describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, Option, Sink, Stdio, Stream } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import type { PlatformError } from "effect/PlatformError";
import { systemError } from "effect/PlatformError";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { FileBody } from "../../src/runtime-src/runtime/file-body.ts";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

const none = Option.none<string>();

const capture = startCaptureServer();

afterAll(() => {
  capture.stop();
});

// Binary bytes that are not valid UTF-8, split across several stdin chunks.
const bytes = Uint8Array.from({ length: 300 }, (_, index) => (index * 37 + 255) % 256);

const chunks = [bytes.slice(0, 1), bytes.slice(1, 128), bytes.slice(128, 129), bytes.slice(129)];

const stdinLayer = (source: Stream.Stream<Uint8Array, PlatformError>): Layer.Layer<Stdio.Stdio> =>
  Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stderr: () => Sink.drain,
      stdin: source,
      stdout: () => Sink.drain,
    }),
  );

const inputLayer = (source: Stream.Stream<Uint8Array, PlatformError>) =>
  Layer.mergeAll(
    Layer.succeed(FileBody, { open: (path) => Effect.succeed(HttpBody.raw(Bun.file(path))) }),
    BunFileSystem.layer,
    stdinLayer(source),
    Input.stdinClaimLayer,
  );

const header = (seen: RecordedRequest, name: string) =>
  seen.headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1];

const binaryStdin = (maxBytes: number = Input.maxBodyBytes) =>
  Input.binaryBody({ body: none, bodyFile: Option.some("-"), maxBytes, required: true });

// Drains a body as the send step does, so a failure inside the stream surfaces here.
const drain = (body: HttpBody.HttpBody) =>
  body._tag === "Stream" ? Stream.runDrain(body.stream) : Effect.void;

// The body goes through `Input.binaryBody` and `Serialize.body`, then to the capture server by a
// real client, as a generated command sends it.
const send = (body: HttpBody.HttpBody) =>
  Effect.gen(function* sendBody() {
    const built = yield* Serialize.request("POST", {
      body: Serialize.body("application/octet-stream", body),
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
  }).pipe(Effect.provide(FetchHttpClient.layer));

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("binary body from stdin", () => {
  test("stdin in several chunks is sent chunked, byte for byte, with no Content-Length", async () => {
    const seen = await run(
      binaryStdin().pipe(
        Effect.flatMap(send),
        Effect.provide(inputLayer(Stream.fromIterable(chunks))),
      ),
    );

    expect([...seen.body]).toEqual([...bytes]);
    expect(header(seen, "transfer-encoding")).toBe("chunked");
    expect(header(seen, "content-length")).toBeUndefined();
    expect(header(seen, "content-type")).toBe("application/octet-stream");
  });

  test("stdin is not collected into memory before the send", async () => {
    const pulled: number[] = [];
    const source = Stream.fromIterable(chunks).pipe(
      Stream.tap(() => Effect.sync(() => pulled.push(pulled.length))),
    );
    const body = await run(binaryStdin().pipe(Effect.provide(inputLayer(source))));

    expect(body._tag).toBe("Stream");
    expect(body._tag === "Stream" ? body.contentLength : 0).toBeUndefined();
    expect(pulled).toEqual([]);
  });

  test("stdin over maxBytes fails the stream with a UsageError naming --body-file", async () => {
    const error = await run(
      binaryStdin(bytes.length - 1).pipe(
        Effect.flatMap(drain),
        Effect.flip,
        Effect.provide(inputLayer(Stream.fromIterable(chunks))),
      ),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error).toMatchObject({ flag: "body-file" });
  });

  test("an unreadable stdin fails the stream with a UsageError naming --body-file", async () => {
    const error = await run(
      binaryStdin().pipe(
        Effect.flatMap(drain),
        Effect.flip,
        Effect.provide(
          inputLayer(
            Stream.fail(
              systemError({
                _tag: "Unknown",
                cause: new Error("EIO: secret device detail"),
                method: "stdin",
                module: "Stdio",
              }),
            ),
          ),
        ),
      ),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error).toMatchObject({ flag: "body-file" });
    expect(error instanceof UsageError ? error.message : "").not.toContain("secret");
  });
});
