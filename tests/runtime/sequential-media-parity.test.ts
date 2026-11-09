/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option, Schema, Sink, Stdio, Stream } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Json } from "../../src/model/pointer.ts";
import { normalizeResponses } from "../../src/normalize/responses.ts";
import { resolve } from "../../src/resolve/index.ts";
import { Force, OutputPath, writeResponse } from "../../src/runtime-src/runtime/output.ts";
import { sequentialMediaTypes } from "../../src/runtime-src/runtime/sequential.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const encoder = new TextEncoder();

const decoder = new TextDecoder();

/**
 * Media types a document may declare for a sequential body: every entry of the shared table, and
 * the variants (case, parameters) the generator's classification also accepts.
 */
const candidates = [
  ...sequentialMediaTypes.keys(),
  "Application/NDJSON",
  "application/ndjson; charset=utf-8",
  "text/event-stream;charset=utf-8",
];

/**
 * The codec the generator assigns each declared response media key.
 */
const generatorCodecs = (mediaTypes: readonly string[]) => {
  const value: Json = {
    info: { title: "t", version: "1" },
    openapi: "3.1.1",
    paths: {
      "/a": {
        get: {
          responses: {
            "200": {
              content: Object.fromEntries(mediaTypes.map((mediaType) => [mediaType, {}])),
              description: "ok",
            },
          },
        },
      },
    },
  };
  const resolution = Effect.runSync(resolve({ document: entry, line: "3.1", value }));
  const { responses } = Effect.runSync(normalizeResponses(resolution, "/paths/~1a/get/responses"));

  return (responses[0]?.alternatives ?? []).map(
    (alternative) => [String(alternative.mediaType), alternative.codec] as const,
  );
};

/**
 * A two-record body in each sequential codec's framing, and the lines the runtime prints for it.
 */
const samples = {
  jsonseq: ['\u001E{"a": 1}\n\u001E{"b": [1, 2]}\n', '{"a":1}\n{"b":[1,2]}\n'],
  ndjson: ['{"a": 1}\n\n{"b": [1, 2]}\n', '{"a":1}\n{"b":[1,2]}\n'],
  sse: ["data: one\n\ndata: two\n\n", '{"data":"one"}\n{"data":"two"}\n'],
} as const;

/**
 * What the runtime prints for `text` served under the matched response key `mediaType`.
 */
const printed = async (mediaType: string, text: string): Promise<string> => {
  const captured: Buffer[] = [];
  const layer = Layer.mergeAll(
    BunFileSystem.layer,
    BunPath.layer,
    Stdio.layerTest({
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.sync(() => {
            captured.push(Buffer.from(chunk));
          }),
        ),
      stdoutIsTerminal: Effect.succeed(false),
    }),
    Layer.succeed(OutputPath, Option.none()),
    Layer.succeed(Force, false),
  );
  const exit = await Effect.runPromise(
    Effect.exit(writeResponse({ bytes: Stream.make(encoder.encode(text)), mediaType })).pipe(
      Effect.provide(layer),
    ),
  );

  expect(Exit.isSuccess(exit)).toBe(true);

  return decoder.decode(Buffer.concat(captured));
};

describe("sequential media parity", () => {
  test("every media type the generator gives a sequential codec is framed by the runtime", async () => {
    const sequential = generatorCodecs(candidates).flatMap(([mediaType, codec]) =>
      codec === "jsonseq" || codec === "ndjson" || codec === "sse"
        ? [[mediaType, codec] as const]
        : [],
    );
    const outputs = await Promise.all(
      sequential.map(async ([mediaType, codec]) => [
        mediaType,
        await printed(mediaType, samples[codec][0]),
      ]),
    );

    expect(sequential.map(([mediaType]) => mediaType)).toEqual(candidates);
    expect(outputs).toEqual(sequential.map(([mediaType, codec]) => [mediaType, samples[codec][1]]));
  });
});
