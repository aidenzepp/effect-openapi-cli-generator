import { Effect, Stream } from "effect";
import { ResponseStreamError } from "../domain/errors.ts";

/**
 * The RFC 7464 record separator that opens every JSON-seq record.
 */
const recordSeparator = "\u001E";

/**
 * A record's tail after its last LF; RFC 7464 ends every record with LF, so a record that does not
 * match was cut short.
 */
const closedByLineFeed = /\n[\t\n\r ]*$/u;

/**
 * Text that holds something other than JSON whitespace.
 */
const nonWhitespace = /[^\t\n\r ]/u;

/**
 * One output of a framing step: a record line to emit, or the failure that ends the stream after
 * the records before it have been emitted.
 */
type Framed = string | ResponseStreamError;

/**
 * One record's text with its insignificant whitespace removed, and whether the text ended outside
 * every string and container.
 */
interface Compacted {
  readonly complete: boolean;
  readonly text: string;
}

/**
 * The JSON-seq framer's state between body chunks: the open record's text and UTF-8 size, the index
 * the next record takes, whether the first separator has arrived, and whether the stream failed.
 */
interface SeqState {
  bytes: number;
  failed: boolean;
  itemIndex: number;
  record: string;
  started: boolean;
}

/**
 * Compute the UTF-8 byte length of one code point.
 */
const utf8Bytes = (char: string): number => {
  const point = char.codePointAt(0) ?? 0;

  if (point < 0x80) {
    return 1;
  }

  if (point < 0x8_00) {
    return 2;
  }

  return point < 0x1_00_00 ? 3 : 4;
};

/**
 * Compute the UTF-8 byte length of a string without encoding it.
 */
const utf8Length = (text: string): number => {
  let length = 0;

  for (const char of text) {
    length += utf8Bytes(char);
  }

  return length;
};

/**
 * Remove the whitespace JSON allows between tokens from one record's text. Nothing is parsed:
 * strings, numbers and key order are copied as received, so a number past 2^53 and every escape
 * survive byte for byte, which `JSON.parse` followed by `JSON.stringify` would not keep (design
 * 4.6). Only ASCII code units are inspected, so indexing by UTF-16 code unit is exact.
 */
const compact = (record: string): Compacted => {
  let text = "";
  let start = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < record.length; index += 1) {
    const char = record[index];

    if (inString) {
      inString = escaped || char !== '"';
      escaped = !escaped && char === "\\";
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    } else if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      text += record.slice(start, index);
      start = index + 1;
    }
  }

  return { complete: !inString && depth <= 0, text: text + record.slice(start) };
};

/**
 * Fail the stream on a framing failure and pass every record line through.
 */
const raise = (item: Framed): Effect.Effect<string, ResponseStreamError> =>
  item instanceof ResponseStreamError ? Effect.fail(item) : Effect.succeed(item);

/**
 * Bound each line of decoded NDJSON text to `maxRecordBytes` UTF-8 bytes, not counting its
 * terminator, before `Stream.splitLines` buffers it. An over-long line yields the text before it
 * and then `recordTooLarge` at the index of the record being read, without waiting for the line to
 * end. Line breaks are LF, CR and CRLF, as `Stream.splitLines` splits them; a line holding only
 * spaces and tabs is blank and takes no record index.
 */
const boundLines = (maxRecordBytes: number) =>
  Stream.mapAccum(
    () => ({ bytes: 0, content: false, failed: false, itemIndex: 0 }),
    (state, chunk: string) => {
      const out: Framed[] = [];
      let offset = 0;

      for (const char of state.failed ? "" : chunk) {
        if (char === "\n" || char === "\r") {
          state.itemIndex += state.content ? 1 : 0;
          state.bytes = 0;
          state.content = false;
        } else {
          state.bytes += utf8Bytes(char);
          state.content ||= char !== " " && char !== "\t";
        }

        if (state.bytes > maxRecordBytes) {
          state.failed = true;
          out.push(
            chunk.slice(0, offset),
            new ResponseStreamError({ itemIndex: state.itemIndex, reason: "recordTooLarge" }),
          );

          return [state, out] as const;
        }

        offset += char.length;
      }

      return [state, state.failed ? out : [chunk]] as const;
    },
  );

/**
 * Frame an NDJSON or JSONL response body (`application/x-ndjson`, `application/jsonl`) as one
 * compacted JSON text per record, without a line terminator, emitted as each line arrives.
 *
 * The body is decoded as UTF-8 and split by `Stream.splitLines`, so LF, CRLF and CR end a line and
 * a final line needs no terminator; blank lines are skipped. `Ndjson.decode` is not used because
 * it yields `JSON.parse` values, which lose number precision (design 5, NDJSON row). A line over
 * `maxRecordBytes` UTF-8 bytes fails with `recordTooLarge`, and a line that ends inside a string
 * or an open container fails with `truncated`; both carry the zero-based `itemIndex` of the record
 * among the non-blank lines, after every record before it has been emitted.
 */
export const ndjsonRecords =
  (maxRecordBytes: number) =>
  <E, R>(
    body: Stream.Stream<Uint8Array, E, R>,
  ): Stream.Stream<string, E | ResponseStreamError, R> =>
    body.pipe(
      Stream.decodeText(),
      boundLines(maxRecordBytes),
      Stream.mapEffect(raise),
      Stream.splitLines,
      Stream.mapAccumEffect(
        () => 0,
        (itemIndex, line: string) => {
          const { complete, text } = compact(line);

          if (text === "") {
            return Effect.succeed([itemIndex, []] as const);
          }

          return complete
            ? Effect.succeed([itemIndex + 1, [text]] as const)
            : Effect.fail(new ResponseStreamError({ itemIndex, reason: "truncated" }));
        },
      ),
    );

/**
 * Construct the JSON-seq framer's state before the first body chunk.
 */
const seqState = (): SeqState => ({
  bytes: 0,
  failed: false,
  itemIndex: 0,
  record: "",
  started: false,
});

/**
 * Close the open JSON-seq record: its compacted text, `undefined` for an empty record, or the
 * failure that ends the stream. The size excludes the closing LF.
 */
const closeRecord = (state: SeqState, maxRecordBytes: number): Framed | undefined => {
  const { bytes, itemIndex, record } = state;
  const { complete, text } = compact(record);

  state.bytes = 0;
  state.record = "";

  if (text === "") {
    return undefined;
  }

  if (bytes - (record.endsWith("\n") ? 1 : 0) > maxRecordBytes) {
    return new ResponseStreamError({ itemIndex, reason: "recordTooLarge" });
  }

  if (!complete || !closedByLineFeed.test(record)) {
    return new ResponseStreamError({ itemIndex, reason: "truncated" });
  }

  state.itemIndex += 1;

  return text;
};

/**
 * Add text between separators to the open JSON-seq record, or check the text before the first
 * separator. Fails as soon as the record passes the bound with one byte left for its closing LF.
 */
const appendRecord = (
  state: SeqState,
  part: string,
  maxRecordBytes: number,
): ResponseStreamError | undefined => {
  const { itemIndex } = state;

  if (!state.started) {
    return nonWhitespace.test(part)
      ? new ResponseStreamError({ itemIndex, reason: "invalidFraming" })
      : undefined;
  }

  const bytes = state.bytes + utf8Length(part);

  if (bytes > maxRecordBytes + 1) {
    return new ResponseStreamError({ itemIndex, reason: "recordTooLarge" });
  }

  state.bytes = bytes;
  state.record += part;

  return undefined;
};

/**
 * Frame one chunk of decoded JSON-seq text: every record a separator in the chunk closes, then the
 * first failure, after which the framer takes no more input.
 */
const frameChunk = (state: SeqState, chunk: string, maxRecordBytes: number): Framed[] => {
  const out: Framed[] = [];

  for (const [position, part] of (state.failed ? [] : chunk.split(recordSeparator)).entries()) {
    const closed = position > 0 && state.started ? closeRecord(state, maxRecordBytes) : undefined;

    state.started ||= position > 0;

    const failure =
      closed instanceof ResponseStreamError ? closed : appendRecord(state, part, maxRecordBytes);

    if (failure !== undefined) {
      state.failed = true;
      out.push(failure);

      return out;
    }

    if (closed !== undefined) {
      out.push(closed);
    }
  }

  return out;
};

/**
 * Frame a JSON-seq response body (RFC 7464, `application/json-seq` and `+json-seq`) as one
 * compacted JSON text per record, without a line terminator, emitted as each record closes.
 *
 * Records are split on U+001E, not on lines, because a record may contain LF. The body may open
 * with whitespace; any other text before the first separator fails with `invalidFraming`. An empty
 * record (separators in a row, or only whitespace) is skipped and takes no index. A record over
 * `maxRecordBytes` UTF-8 bytes, not counting its closing LF, fails with `recordTooLarge` as soon as
 * the bound is passed; a record that does not end with LF, or ends inside a string or an open
 * container, fails with `truncated`. Each failure carries the zero-based `itemIndex` of the record
 * being read, after every record before it has been emitted.
 */
export const jsonSeqRecords =
  (maxRecordBytes: number) =>
  <E, R>(
    body: Stream.Stream<Uint8Array, E, R>,
  ): Stream.Stream<string, E | ResponseStreamError, R> =>
    body.pipe(
      Stream.decodeText(),
      Stream.mapAccum(
        seqState,
        (state, chunk: string) => [state, frameChunk(state, chunk, maxRecordBytes)] as const,
        {
          onHalt: (state) => {
            const last =
              state.failed || !state.started ? undefined : closeRecord(state, maxRecordBytes);

            return last === undefined ? [] : [last];
          },
        },
      ),
      Stream.mapEffect(raise),
    );
