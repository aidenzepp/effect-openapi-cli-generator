import { describe, expect, test } from "bun:test";
import { Effect, Exit, Stream } from "effect";
import { ResponseStreamError } from "../../src/runtime-src/domain/errors.ts";
import { jsonSeqRecords } from "../../src/runtime-src/runtime/sequential.ts";

const encoder = new TextEncoder();

const rs = "\u001E";

const bound = 64;

// Pull the body one chunk at a time and log each pull and each record in the order they happen,
// so a record emitted before the next chunk is pulled shows up ahead of that pull in the log.
const timeline = async (chunks: readonly string[]) => {
  const log: string[] = [];
  const body = Stream.unfold(0, (index: number) =>
    Effect.sync(() => {
      const chunk = chunks[index];

      if (chunk !== undefined) {
        log.push(`pull ${index}`);
      }

      return chunk === undefined ? undefined : ([encoder.encode(chunk), index + 1] as const);
    }),
  );
  const exit = await Effect.runPromiseExit(
    body.pipe(
      jsonSeqRecords(bound),
      Stream.runForEach((record) => Effect.sync(() => log.push(record))),
    ),
  );

  if (Exit.isFailure(exit)) {
    const error = exit.cause.reasons
      .map((reason) => (reason._tag === "Fail" ? reason.error : undefined))
      .find((candidate) => candidate instanceof ResponseStreamError);

    log.push(`fail ${error?.reason} ${error?.itemIndex}`);
  }

  return log;
};

describe("JSON-seq records close at their LF", () => {
  test("each record is emitted before the next chunk is pulled", async () => {
    expect(await timeline([1, 2, 3].map((n) => `${rs}{"n":${n}}\n`))).toEqual([
      "pull 0",
      '{"n":1}',
      "pull 1",
      '{"n":2}',
      "pull 2",
      '{"n":3}',
    ]);
  });

  test("an LF inside a record keeps buffering until the LF that completes it", async () => {
    expect(await timeline([`${rs}{\n  "a":`, " 9007199254740993\n", "}\n", `${rs}[1]\n`])).toEqual([
      "pull 0",
      "pull 1",
      "pull 2",
      '{"a":9007199254740993}',
      "pull 3",
      "[1]",
    ]);
  });

  test("a record that ends at an LF but does not decode closes at the next separator, as before", async () => {
    expect(await timeline([`${rs}{"a"}\n`, `${rs}1\n`])).toEqual([
      "pull 0",
      "pull 1",
      '{"a"}',
      "1",
    ]);
    expect(await timeline([`${rs}1.\n`, "5\n"])).toEqual([
      "pull 0",
      "pull 1",
      "fail invalidFraming 0",
    ]);
  });

  test("whitespace after the LF is skipped; other text before the next separator is invalidFraming", async () => {
    expect(await timeline([`${rs}1\n \r\n`, `${rs}2\n`])).toEqual(["pull 0", "1", "pull 1", "2"]);
    expect(await timeline([`${rs}1\n2\n`])).toEqual(["pull 0", "1", "fail invalidFraming 1"]);
  });

  test("a record without its LF is still truncated at the next separator or the end", async () => {
    expect(await timeline([`${rs}1`, `${rs}2\n`])).toEqual([
      "pull 0",
      "pull 1",
      "fail truncated 0",
    ]);
    expect(await timeline([`${rs}1\n`, `${rs}2`])).toEqual([
      "pull 0",
      "1",
      "pull 1",
      "fail truncated 1",
    ]);
  });

  test("the bound still counts the record up to its closing LF", async () => {
    const exact = `"${"x".repeat(bound - 2)}"`;

    expect(await timeline([`${rs}${exact}\n`])).toEqual(["pull 0", exact]);
    expect(await timeline([`${rs}"${"x".repeat(bound - 1)}"`, "\n"])).toEqual([
      "pull 0",
      "pull 1",
      "fail recordTooLarge 0",
    ]);
  });
});
