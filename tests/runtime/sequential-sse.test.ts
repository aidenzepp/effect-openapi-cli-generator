import { describe, expect, test } from "bun:test";
import { Effect, Exit, Stream } from "effect";
import { ResponseStreamError } from "../../src/runtime-src/domain/errors.ts";
import { sseRecords } from "../../src/runtime-src/runtime/sequential.ts";

const encoder = new TextEncoder();

const bound = 64;

// The body arrives in the chunks given, so a line or an event can straddle two chunks.
const run = (chunks: readonly string[], maxRecordBytes = bound) =>
  Effect.runPromiseExit(
    Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk))).pipe(
      sseRecords(maxRecordBytes),
      Stream.runCollect,
    ),
  );

const lines = async (chunks: readonly string[], maxRecordBytes = bound) => {
  const exit = await run(chunks, maxRecordBytes);

  if (Exit.isFailure(exit)) {
    throw new Error(`stream failed: ${String(exit.cause)}`);
  }

  return [...exit.value];
};

// The lines emitted before the stream failed, and the failure's stable fields.
const failure = async (chunks: readonly string[], maxRecordBytes = bound) => {
  const emitted: string[] = [];
  const exit = await Effect.runPromiseExit(
    Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk))).pipe(
      sseRecords(maxRecordBytes),
      Stream.runForEach((line) => Effect.sync(() => emitted.push(line))),
    ),
  );

  if (Exit.isSuccess(exit)) {
    throw new Error(`stream succeeded: ${JSON.stringify(emitted)}`);
  }

  const error = exit.cause.reasons
    .map((reason) => (reason._tag === "Fail" ? reason.error : undefined))
    .find((candidate) => candidate instanceof ResponseStreamError);

  return { _tag: error?._tag, emitted, itemIndex: error?.itemIndex, reason: error?.reason };
};

describe("SSE records", () => {
  test("a stream that opens with retry yields its first event with an integer retry", async () => {
    expect(await lines(["retry: 3000\n\n", "id: 1\ndata: a\n\n", "id: 2\ndata: b\n\n"])).toEqual([
      '{"data":"a","id":"1","retry":3000}',
      '{"data":"b","id":"2"}',
    ]);
  });

  test("a retry inside an event's block belongs to that event", async () => {
    expect(await lines(["event: tick\ndata: x\nretry: 5\n\ndata: y\n\n"])).toEqual([
      '{"data":"x","event":"tick","retry":5}',
      '{"data":"y"}',
    ]);
  });

  test("multi-line data is joined by LF, across chunk boundaries and CRLF", async () => {
    expect(await lines(["data: first\r", "\ndata:second\r\nda", "ta: third\r\n\r\n"])).toEqual([
      String.raw`{"data":"first\nsecond\nthird"}`,
    ]);
  });

  test("event and id are kept and keys are alphabetical", async () => {
    expect(await lines(["id: 7\nevent: update\ndata: v\n\n"])).toEqual([
      '{"data":"v","event":"update","id":"7"}',
    ]);
  });

  test("a comment line and an unknown field are ignored", async () => {
    expect(await lines([": keep-alive\n\nunknownField: x\ndata: v\n: note\n\n"])).toEqual([
      '{"data":"v"}',
    ]);
  });

  test("data holding JSON stays a string", async () => {
    expect(await lines(['data: {"foo": 9007199254740993}\n\n'])).toEqual([
      String.raw`{"data":"{\"foo\": 9007199254740993}"}`,
    ]);
  });

  test("an empty body and an event the stream ends inside yield no records", async () => {
    expect(await lines([])).toEqual([]);
    expect(await lines(["data: a\n\ndata: cut"])).toEqual(['{"data":"a"}']);
  });

  test("an event of exactly the bound passes; one byte more is recordTooLarge with its index", async () => {
    const exact = "x".repeat(bound);

    expect(await lines([`data: ${exact}\n\n`])).toEqual([`{"data":"${exact}"}`]);
    expect(await failure(["data: a\n\n", `data: ${exact}`, "y\n\ndata: b\n\n"])).toEqual({
      _tag: "ResponseStreamError",
      emitted: ['{"data":"a"}'],
      itemIndex: 1,
      reason: "recordTooLarge",
    });
  });

  test("an event over the bound in UTF-8 bytes fails even inside one chunk", async () => {
    expect(await failure([`data: ok\n\ndata: ${"é".repeat(bound / 2 + 1)}\n\n`])).toEqual({
      _tag: "ResponseStreamError",
      emitted: ['{"data":"ok"}'],
      itemIndex: 1,
      reason: "recordTooLarge",
    });
  });

  test("an unterminated line far past the bound fails before the event ends", async () => {
    expect(await failure(["data: a\n\n", `: ${"c".repeat(bound * 4)}`])).toEqual({
      _tag: "ResponseStreamError",
      emitted: ['{"data":"a"}'],
      itemIndex: 1,
      reason: "recordTooLarge",
    });
  });
});
