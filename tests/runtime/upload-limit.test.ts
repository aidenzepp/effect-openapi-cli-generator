import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, Option, Sink, Stdio, Stream } from "effect";
import { HttpBody } from "effect/http";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import { FileBody } from "../../src/runtime-src/runtime/file-body.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";

// MED-21: a binary upload over its declared maxLength is refused with a UsageError naming the flag
// and the limit, never the content or the path. A file's size is known before the send; stdin is
// counted as it streams.

const root = nodePath.resolve(import.meta.dir, "../..");

nodeFs.mkdirSync(nodePath.join(root, "work"), { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(root, "work", "upload-limit-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

const ten = new TextEncoder().encode("secret-ten");

const tenFile = nodePath.join(work, "ten.bin");

nodeFs.writeFileSync(tenFile, ten);

const inputLayer = (stdin: Stream.Stream<Uint8Array>) =>
  Layer.mergeAll(
    Layer.succeed(FileBody, { open: (path) => Effect.succeed(HttpBody.raw(Bun.file(path))) }),
    BunFileSystem.layer,
    Layer.succeed(
      Stdio.Stdio,
      Stdio.make({
        args: Effect.succeed([]),
        stderr: () => Sink.drain,
        stdin,
        stdout: () => Sink.drain,
      }),
    ),
    Input.stdinClaimLayer,
  );

const upload = (bodyFile: string, maxBytes: number) =>
  Input.binaryBody({
    body: Option.none(),
    bodyFile: Option.some(bodyFile),
    maxBytes,
    required: true,
  });

const drain = (body: HttpBody.HttpBody) =>
  body._tag === "Stream" ? Stream.runDrain(body.stream) : Effect.void;

// The `UsageError` an upload fails with; a stream failure is typed `unknown` by `HttpBody`.
const failure = async (effect: Effect.Effect<unknown, unknown>): Promise<UsageError> => {
  const error = await Effect.runPromise(Effect.flip(effect));
  if (!(error instanceof UsageError)) {
    throw new TypeError("expected a UsageError");
  }

  return error;
};

const expectLimit = (error: UsageError) => {
  expect(error.flag).toBe("body-file");
  expect(error.message).toBe("--body-file: the body is over 4 bytes");
  expect(error.message).not.toContain("secret");
  expect(error.message).not.toContain(work);
};

describe("MED-21: an upload over its maxLength", () => {
  test("a 10-byte file against maxLength 4 is refused before any byte is read", async () => {
    const error = await failure(upload(tenFile, 4).pipe(Effect.provide(inputLayer(Stream.empty))));

    expectLimit(error);
  });

  test("10 bytes of stdin against maxLength 4 fail the stream before the send completes", async () => {
    const error = await failure(
      upload("-", 4).pipe(
        Effect.flatMap(drain),
        Effect.provide(inputLayer(Stream.make(ten.slice(0, 3), ten.slice(3)))),
      ),
    );

    expectLimit(error);
  });

  test("a file within maxLength streams with its size", async () => {
    const body = await Effect.runPromise(
      upload(tenFile, 10).pipe(Effect.provide(inputLayer(Stream.empty))),
    );

    expect(body._tag).toBe("Raw");
  });

  test("a maxLength above the runtime ceiling does not raise it", async () => {
    const error = await failure(
      upload("-", Input.maxBodyBytes * 2).pipe(
        Effect.flatMap(drain),
        Effect.provide(
          inputLayer(Stream.make(new Uint8Array(Input.maxBodyBytes), new Uint8Array(1))),
        ),
      ),
    );

    expect(error.message).toBe(`--body-file: the body is over ${Input.maxBodyBytes} bytes`);
  });
});
