/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option, Schema, Sink, Stdio, Stream } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Json } from "../../src/model/pointer.ts";
import { normalizeResponses } from "../../src/normalize/responses.ts";
import { resolve } from "../../src/resolve/index.ts";
import { Force, OutputPath, writeResponse } from "../../src/runtime-src/runtime/output.ts";
import type { SequentialCodec } from "../../src/runtime-src/runtime/sequential.ts";
import { sequentialMediaTypes } from "../../src/runtime-src/runtime/sequential.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const encoder = new TextEncoder();

const decoder = new TextDecoder();

/**
 * Media types a document may declare for a sequential body: every entry of the shared table, the
 * `+json-seq` suffix forms (RFC 8091), and the variants (case, parameters) both sides accept.
 */
const sequentialCandidates = [
  ...sequentialMediaTypes.keys(),
  "Application/NDJSON",
  "application/ndjson; charset=utf-8",
  "text/event-stream;charset=utf-8",
  "application/geo+json-seq",
  "Application/Geo+JSON-Seq",
  "application/vnd.example+json-seq; charset=utf-8",
];

/**
 * Media types neither side treats as sequential, including near misses of the suffix rule.
 */
const plainCandidates = [
  "application/json",
  "application/geo+json",
  "application/octet-stream",
  "text/plain",
  "application/json-seq+xml",
];

const candidates = [...sequentialCandidates, ...plainCandidates];

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

  return new Map(
    (responses[0]?.alternatives ?? []).map(
      (alternative) => [String(alternative.mediaType), alternative.codec] as const,
    ),
  );
};

/**
 * A two-record body in each sequential codec's framing, and the lines the runtime prints for it.
 */
const samples = {
  jsonseq: ['\u001E{"a": 1}\n\u001E{"b": [1, 2]}\n', '{"a":1}\n{"b":[1,2]}\n'],
  ndjson: ['{"a": 1}\n\n{"b": [1, 2]}\n', '{"a":1}\n{"b":[1,2]}\n'],
  sse: ["data: one\n\ndata: two\n\n", '{"data":"one"}\n{"data":"two"}\n'],
} as const satisfies Record<Sequential, readonly [string, string]>;

type Sequential = SequentialCodec;

const sequentialCodecs: readonly Sequential[] = ["jsonseq", "ndjson", "sse"];

const isSequential = (codec: string | undefined): codec is Sequential =>
  sequentialCodecs.some((known) => known === codec);

/**
 * What the runtime prints for `text` served under the matched response key `mediaType`, or
 * `undefined` when the write fails.
 */
const printed = async (mediaType: string, text: string): Promise<string | undefined> => {
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

  return Exit.isSuccess(exit) ? decoder.decode(Buffer.concat(captured)) : undefined;
};

/**
 * The codec the runtime frames a `mediaType` body by: the one whose sample it prints as that
 * codec's record lines, or `undefined` when it frames none of them.
 */
const runtimeCodec = async (mediaType: string): Promise<Sequential | undefined> => {
  const outputs = await Promise.all(
    sequentialCodecs.map(
      async (codec) => [codec, await printed(mediaType, samples[codec][0])] as const,
    ),
  );

  return outputs.find(([codec, output]) => output === samples[codec][1])?.[0];
};

describe("sequential media parity", () => {
  test("every media type the generator gives a sequential codec is framed by the runtime with it", async () => {
    const generated = generatorCodecs(candidates);
    const sequential = candidates.flatMap((mediaType) => {
      const codec = generated.get(mediaType);

      return isSequential(codec) ? [[mediaType, codec] as const] : [];
    });
    const framed = await Promise.all(
      sequential.map(async ([mediaType]) => [mediaType, await runtimeCodec(mediaType)] as const),
    );

    expect(sequential.map(([mediaType]) => mediaType)).toEqual(sequentialCandidates);
    expect(framed).toEqual(sequential);
  });

  test("every media type the runtime frames is given that sequential codec by the generator", async () => {
    const generated = generatorCodecs(candidates);
    const framed = await Promise.all(
      candidates.map(async (mediaType) => [mediaType, await runtimeCodec(mediaType)] as const),
    );
    const assigned = framed.flatMap(([mediaType, codec]) =>
      codec === undefined ? [] : [[mediaType, generated.get(mediaType)] as const],
    );

    expect(assigned.map(([mediaType]) => mediaType)).toEqual(sequentialCandidates);
    expect(assigned).toEqual(framed.filter(([, codec]) => codec !== undefined));
  });
});
