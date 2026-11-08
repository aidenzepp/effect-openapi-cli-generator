import { describe, expect, test } from "bun:test";
import { Effect, Exit, Stream } from "effect";
import { ResponseStreamError } from "../../src/runtime-src/domain/errors.ts";
import { jsonSeqRecords, ndjsonRecords } from "../../src/runtime-src/runtime/sequential.ts";

type Framing = typeof ndjsonRecords;

const encoder = new TextEncoder();

const rs = "\u001E";

const bound = 64;

// The body arrives in the chunks given, so a record or a terminator can straddle two chunks.
const run = (framing: Framing, chunks: readonly string[], maxRecordBytes = bound) =>
  Effect.runPromiseExit(
    Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk))).pipe(
      framing(maxRecordBytes),
      Stream.runCollect,
    ),
  );

const lines = async (framing: Framing, chunks: readonly string[], maxRecordBytes = bound) => {
  const exit = await run(framing, chunks, maxRecordBytes);

  if (Exit.isFailure(exit)) {
    throw new Error(`stream failed: ${String(exit.cause)}`);
  }

  return [...exit.value];
};

const failure = async (framing: Framing, chunks: readonly string[], maxRecordBytes = bound) => {
  const exit = await run(framing, chunks, maxRecordBytes);

  if (Exit.isSuccess(exit)) {
    throw new Error(`stream succeeded: ${JSON.stringify([...exit.value])}`);
  }

  const error = exit.cause.reasons
    .map((reason) => (reason._tag === "Fail" ? reason.error : undefined))
    .find((candidate) => candidate instanceof ResponseStreamError);

  return { _tag: error?._tag, itemIndex: error?.itemIndex, reason: error?.reason };
};

const lineSeparator = "\u2028";

// Every escape the compactor must keep byte for byte: an escaped quote, an escaped backslash
// before a closing quote, a raw U+2028 and a lone surrogate escape, with whitespace inside strings.
const tricky = String.raw`{ "q" : "a \" b" , "s" : "x\\" , "u" : "  ${lineSeparator}" , "l" : "\ud800" }`;

const trickyCompact = String.raw`{"q":"a \" b","s":"x\\","u":"  ${lineSeparator}","l":"\ud800"}`;

describe("NDJSON and JSONL records", () => {
  test("a number past 2^53 and the key order survive byte for byte", async () => {
    expect(
      await lines(ndjsonRecords, ['{ "b" : 1, "a" : 9007199254740993 }\n', "[ 1.50, 2e10 ]\n"]),
    ).toEqual(['{"b":1,"a":9007199254740993}', "[1.50,2e10]"]);
  });

  test("string contents keep escaped quotes, U+2028 and a lone surrogate escape", async () => {
    expect(await lines(ndjsonRecords, [`${tricky}\n`], 256)).toEqual([trickyCompact]);
  });

  test("CRLF is tolerated and blank lines are skipped, across chunk boundaries", async () => {
    expect(await lines(ndjsonRecords, ['{"a":1}\r', '\n\r\n  \t\n{"a"', ":2}\r\n", "\n3"])).toEqual(
      ['{"a":1}', '{"a":2}', "3"],
    );
  });

  test("an empty body yields no records", async () => {
    expect(await lines(ndjsonRecords, [])).toEqual([]);
  });

  test("a record of exactly the bound passes; one byte more is recordTooLarge with its index", async () => {
    const exact = `"${"x".repeat(bound - 2)}"`;

    expect(await lines(ndjsonRecords, [`1\n${exact}\r\n`])).toEqual(["1", exact]);
    expect(await failure(ndjsonRecords, [`1\n\n"${"x".repeat(bound - 1)}"\n`])).toEqual({
      _tag: "ResponseStreamError",
      itemIndex: 1,
      reason: "recordTooLarge",
    });
  });

  test("the bound counts UTF-8 bytes, not UTF-16 code units", async () => {
    expect(await failure(ndjsonRecords, [`"${"é".repeat(bound / 2)}"\n`])).toEqual({
      _tag: "ResponseStreamError",
      itemIndex: 0,
      reason: "recordTooLarge",
    });
  });

  test("an over-long line fails before its terminator arrives", async () => {
    const endless = Stream.fromIterable(["[", "1,".repeat(bound)]).pipe(
      Stream.map((chunk) => encoder.encode(chunk)),
      Stream.concat(Stream.never),
    );
    const exit = await Effect.runPromiseExit(endless.pipe(ndjsonRecords(bound), Stream.runCollect));

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("a stream ending inside a record is truncated", async () => {
    expect(await failure(ndjsonRecords, ['{"a":1}\n{"a":"b', "c"])).toEqual({
      _tag: "ResponseStreamError",
      itemIndex: 1,
      reason: "truncated",
    });
    expect(await failure(ndjsonRecords, ['{"a":[1,2'])).toEqual({
      _tag: "ResponseStreamError",
      itemIndex: 0,
      reason: "truncated",
    });
  });
});

// Removing whitespace must never change the data: a record whose whitespace separates two values,
// whose string holds a raw control character, or that closes more containers than it opens fails.
describe("records the compactor would change", () => {
  const malformed = {
    "a container closed that was never opened": "]",
    "a raw tab inside a string": '{"a":"x\ty"}',
    "two numbers separated by whitespace": "1 2",
    "two objects on one line": '{"a":1} {"b":2}',
  };

  for (const [name, record] of Object.entries(malformed)) {
    test(`NDJSON: ${name} is invalidFraming`, async () => {
      expect(await failure(ndjsonRecords, [`[0]\n${record}\n`])).toEqual({
        _tag: "ResponseStreamError",
        itemIndex: 1,
        reason: "invalidFraming",
      });
    });

    test(`JSON-seq: ${name} is invalidFraming`, async () => {
      expect(await failure(jsonSeqRecords, [`${rs}[0]\n${rs}${record}\n`])).toEqual({
        _tag: "ResponseStreamError",
        itemIndex: 1,
        reason: "invalidFraming",
      });
    });
  }

  test("valid records keep their bytes, numbers and escapes", async () => {
    expect(
      await lines(ndjsonRecords, [
        '[ -1.5e+3 , true , null , "a b" , { } , [ ] ]\n',
        '{ "k" : [ 1 , "\\u0009" ] }\n',
      ]),
    ).toEqual(['[-1.5e+3,true,null,"a b",{},[]]', '{"k":[1,"\\u0009"]}']);
  });
});

describe("JSON-seq records (RFC 7464)", () => {
  test("records containing LF are compacted and keep numbers and key order", async () => {
    expect(
      await lines(jsonSeqRecords, [
        `${rs}{\n  "b": 1,\n  "a": 9007199254740993\n}\n${rs}[1,`,
        "\n2]\n",
      ]),
    ).toEqual(['{"b":1,"a":9007199254740993}', "[1,2]"]);
  });

  test("string contents keep escaped quotes, U+2028 and a lone surrogate escape", async () => {
    expect(await lines(jsonSeqRecords, [`${rs}${tricky}\n`], 256)).toEqual([trickyCompact]);
  });

  test("leading whitespace, empty records and CRLF are tolerated", async () => {
    expect(await lines(jsonSeqRecords, [` \r\n${rs}${rs}\n${rs}1\r\n${rs}`, '"a"\n'])).toEqual([
      "1",
      '"a"',
    ]);
  });

  test("an empty body yields no records", async () => {
    expect(await lines(jsonSeqRecords, [])).toEqual([]);
  });

  test("a body not starting at U+001E is invalidFraming", async () => {
    expect(await failure(jsonSeqRecords, [' {"a":1}\n'])).toEqual({
      _tag: "ResponseStreamError",
      itemIndex: 0,
      reason: "invalidFraming",
    });
  });

  test("a record of exactly the bound passes; one byte more is recordTooLarge with its index", async () => {
    const exact = `"${"x".repeat(bound - 2)}"`;

    expect(await lines(jsonSeqRecords, [`${rs}1\n${rs}${exact}\n`])).toEqual(["1", exact]);
    expect(
      await failure(jsonSeqRecords, [`${rs}1\n${rs}\n${rs}"${"x".repeat(bound - 1)}"\n`]),
    ).toEqual({
      _tag: "ResponseStreamError",
      itemIndex: 1,
      reason: "recordTooLarge",
    });
  });

  test("a record without its closing LF, or ended inside, is truncated", async () => {
    expect(await failure(jsonSeqRecords, [`${rs}1\n${rs}23`])).toEqual({
      _tag: "ResponseStreamError",
      itemIndex: 1,
      reason: "truncated",
    });
    expect(await failure(jsonSeqRecords, [`${rs}{"a":[1,2]\n`])).toEqual({
      _tag: "ResponseStreamError",
      itemIndex: 0,
      reason: "truncated",
    });
  });
});
