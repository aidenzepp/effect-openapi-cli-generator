/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Layer, Option, Path, Sink, Stdio, Stream } from "effect";
import type { GlobalFlag } from "effect/cli";
import { systemError } from "effect/PlatformError";
import { ResponseStreamError, UsageError } from "../../src/runtime-src/domain/errors.ts";
import {
  Force,
  MaxRecordBytes,
  OutputPath,
  Raw,
  writeResponse,
} from "../../src/runtime-src/runtime/output.ts";
import type { ResponseBody } from "../../src/runtime-src/runtime/output.ts";

type Env =
  | FileSystem.FileSystem
  | Path.Path
  | Stdio.Stdio
  | GlobalFlag.Setting.Identifier<"force">
  | GlobalFlag.Setting.Identifier<"output">;

interface Settings {
  readonly isTerminal?: boolean;
  readonly maxRecordBytes?: number;
  readonly output?: string;
  readonly raw?: boolean;
  readonly stdout?: Stdio.Stdio["stdout"];
}

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const brokenPipe = systemError({
  _tag: "Unknown",
  cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
  method: "stdout",
  module: "Stdio",
});

/**
 * Run `program` with captured stdout. `--raw` and `--max-record-bytes` are provided only when the
 * case sets them, so an unset one exercises the default a root without the setting gets.
 */
const run = <A, E>(settings: Settings, program: Effect.Effect<A, E, Env>) => {
  const captured: Buffer[] = [];
  const optional = [
    ...(settings.raw === undefined ? [] : [Layer.succeed(Raw, settings.raw)]),
    ...(settings.maxRecordBytes === undefined
      ? []
      : [Layer.succeed(MaxRecordBytes, settings.maxRecordBytes)]),
  ];
  const layer = Layer.mergeAll(
    BunFileSystem.layer,
    BunPath.layer,
    Stdio.layerTest({
      stdout:
        settings.stdout ??
        (() =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.sync(() => {
              captured.push(Buffer.from(chunk));
            }),
          )),
      stdoutIsTerminal: Effect.succeed(settings.isTerminal ?? false),
    }),
    Layer.succeed(OutputPath, Option.fromNullishOr(settings.output)),
    Layer.succeed(Force, false),
    ...optional,
  );

  return Effect.runPromise(Effect.exit(program).pipe(Effect.provide(layer))).then((exit) => ({
    exit,
    stdout: () => decoder.decode(Buffer.concat(captured)),
  }));
};

const bodyOf = (mediaType: string | undefined, ...chunks: string[]): ResponseBody<never> => ({
  bytes: Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk))),
  mediaType,
});

const failure = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Option.getOrUndefined(Exit.findErrorOption(exit));

const ndjson = '{"a": 1}\n\n{"b": [1, 2]}\n';

const jsonSeq = '\u001E{"a": 1}\n\u001E{"b": [1, 2]}\n';

const sse = "event: tick\ndata: one\nid: 7\n\ndata: two\n\n";

const sseLines = '{"data":"one","event":"tick","id":"7"}\n{"data":"two","id":"7"}\n';

describe("sequential output dispatch", () => {
  test("an NDJSON line reaches stdout before the next chunk is released", async () => {
    const captured: Buffer[] = [];
    const seenAtRelease: string[] = [];
    const body: ResponseBody<never> = {
      bytes: Stream.concat(
        Stream.make(encoder.encode('{"a": 1}\n{"b"')),
        Stream.fromEffect(
          Effect.sync(() => {
            seenAtRelease.push(decoder.decode(Buffer.concat(captured)));

            return encoder.encode(": 2}\n");
          }),
        ),
      ),
      mediaType: "application/x-ndjson",
    };
    const result = await run(
      {
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.sync(() => {
              captured.push(Buffer.from(chunk));
            }),
          ),
      },
      writeResponse(body),
    );

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(seenAtRelease).toEqual(['{"a":1}\n']);
    expect(decoder.decode(Buffer.concat(captured))).toBe('{"a":1}\n{"b":2}\n');
  });

  test("each sequential media type routes to its framer", async () => {
    const cases = [
      ["application/x-ndjson", ndjson, '{"a":1}\n{"b":[1,2]}\n'],
      ["application/jsonl", ndjson, '{"a":1}\n{"b":[1,2]}\n'],
      ["application/json-seq", jsonSeq, '{"a":1}\n{"b":[1,2]}\n'],
      ["application/geo+json-seq", jsonSeq, '{"a":1}\n{"b":[1,2]}\n'],
      ["text/event-stream", sse, sseLines],
    ] as const;
    const outputs = await Promise.all(
      cases.map(async ([mediaType, text]) => {
        const result = await run({}, writeResponse(bodyOf(mediaType, text)));

        return [mediaType, Exit.isSuccess(result.exit), result.stdout()] as const;
      }),
    );

    expect(outputs).toEqual(cases.map(([mediaType, , lines]) => [mediaType, true, lines] as const));
  });

  test("a type with no known framing stays raw byte for byte", async () => {
    const mediaTypes = ["application/json", "text/plain", "application/x-ndjson-v2", undefined];
    const outputs = await Promise.all(
      mediaTypes.map(async (mediaType) => {
        const result = await run(
          {},
          writeResponse(bodyOf(mediaType, ndjson.slice(0, 5), ndjson.slice(5))),
        );

        return result.stdout();
      }),
    );

    expect(outputs).toEqual(mediaTypes.map(() => ndjson));
  });

  test("--raw returns a sequential body as the bytes received", async () => {
    const outputs = await Promise.all(
      (
        [
          ["application/x-ndjson", ndjson],
          ["application/json-seq", jsonSeq],
          ["text/event-stream", sse],
        ] as const
      ).map(async ([mediaType, text]) => {
        const result = await run({ raw: true }, writeResponse(bodyOf(mediaType, text)));

        return [Exit.isSuccess(result.exit), result.stdout()] as const;
      }),
    );

    expect(outputs).toEqual([
      [true, ndjson],
      [true, jsonSeq],
      [true, sse],
    ]);
  });

  test("--max-record-bytes 10 fails a longer record with recordTooLarge after the records before it", async () => {
    const result = await run(
      { maxRecordBytes: 10 },
      writeResponse(bodyOf("application/x-ndjson", '{"a":1}\n{"long":"0123456789"}\n')),
    );
    const error = failure(result.exit);

    expect(error).toBeInstanceOf(ResponseStreamError);
    expect(error instanceof ResponseStreamError ? [error.reason, error.itemIndex] : []).toEqual([
      "recordTooLarge",
      1,
    ]);
    expect(result.stdout()).toBe('{"a":1}\n');
  });

  test("EPIPE mid-stream stops the stream and succeeds", async () => {
    let pulled = 0;
    let writes = 0;
    const body: ResponseBody<never> = {
      bytes: Stream.fromIterable(['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            pulled += 1;
          }),
        ),
        Stream.map((chunk) => encoder.encode(chunk)),
      ),
      mediaType: "application/x-ndjson",
    };
    const result = await run(
      {
        stdout: () =>
          Sink.forEach(() =>
            Effect.suspend(() => {
              writes += 1;

              return writes === 1 ? Effect.void : Effect.fail(brokenPipe);
            }),
          ),
      },
      writeResponse(body),
    );

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(pulled).toBeLessThan(3);
  });

  test("--raw writes a sequential type to a terminal; a binary type is still refused", async () => {
    const outcomes = await Promise.all(
      (["application/x-ndjson", "application/jsonl", "application/octet-stream"] as const).map(
        async (mediaType) => {
          const result = await run(
            { isTerminal: true, raw: true },
            writeResponse(bodyOf(mediaType, ndjson)),
          );
          const error = failure(result.exit);

          return [error instanceof UsageError ? error._tag : "written", result.stdout()] as const;
        },
      ),
    );

    expect(outcomes).toEqual([
      ["written", ndjson],
      ["written", ndjson],
      ["UsageError", ""],
    ]);
  });

  test("sequential lines reach a terminal: the binary guard does not apply", async () => {
    const result = await run(
      { isTerminal: true },
      writeResponse(bodyOf("application/x-ndjson", ndjson)),
    );

    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.stdout()).toBe('{"a":1}\n{"b":[1,2]}\n');
  });

  test("--output writes the framed lines to the file", async () => {
    const written = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* step1() {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "sq3-" });
          const target = path.join(dir, "out.jsonl");
          const result = yield* Effect.promise(() =>
            run({ output: target }, writeResponse(bodyOf("application/json-seq", jsonSeq))),
          );

          return [Exit.isSuccess(result.exit), result.stdout(), yield* fs.readFileString(target)];
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
    );

    expect(written).toEqual([true, "", '{"a":1}\n{"b":[1,2]}\n']);
  });
});
