import { Duration, Effect, Stream } from "effect";
import { Sse } from "effect/encoding";
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
 * One record's text with its insignificant whitespace removed, and its status: `complete`;
 * `truncated` when it ends inside a string or an open container; or `invalid` when removing the
 * whitespace would change the data, which the text is then not returned for.
 */
type Compacted =
  | { readonly status: "complete" | "truncated"; readonly text: string }
  | { readonly status: "invalid" };

/**
 * Characters that are JSON syntax or whitespace; every other character outside a string belongs
 * to a number or to `true`, `false` or `null`.
 */
const delimiters = new Set(["{", "}", "[", "]", ":", ",", '"', " ", "\t", "\n", "\r"]);

/**
 * Characters that open a value, besides a number or literal.
 */
const valueOpeners = new Set(["{", "[", '"']);

/**
 * The whitespace JSON allows between tokens, which the compactor removes.
 */
const whitespace = new Set([" ", "\t", "\n", "\r"]);

/**
 * The container depth each bracket adds.
 */
const depthChange = new Map([
  ["{", 1],
  ["[", 1],
  ["}", -1],
  ["]", -1],
]);

/**
 * The punctuation after which another value may follow.
 */
const separators = new Set([",", ":"]);

/**
 * The first code point JSON allows raw inside a string; every one below must be escaped.
 */
const firstStringCodePoint = 0x20;

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
 * The compactor's position in one record: container depth, whether it is inside a string (and
 * just after a backslash there) or inside a number or literal, and whether a value has just ended.
 */
interface Scan {
  afterValue: boolean;
  depth: number;
  escaped: boolean;
  inScalar: boolean;
  inString: boolean;
}

/**
 * Advance the scan over one character inside a string. Returns false for a raw character below
 * U+0020, which JSON requires to be escaped.
 */
const scanString = (scan: Scan, char: string): boolean => {
  if ((char.codePointAt(0) ?? 0) < firstStringCodePoint) {
    return false;
  }

  scan.inString = scan.escaped || char !== '"';
  scan.escaped = !scan.escaped && char === "\\";
  scan.afterValue = !scan.inString;

  return true;
};

/**
 * Advance the scan over one character outside strings. Returns false when a value starts right
 * after another value, so removing the whitespace between them would join them, or when a
 * container closes that was never opened.
 */
const scanToken = (scan: Scan, char: string): boolean => {
  if (!delimiters.has(char)) {
    const joins = scan.afterValue && !scan.inScalar;

    scan.inScalar = true;

    return !joins;
  }

  scan.afterValue ||= scan.inScalar;
  scan.inScalar = false;

  if (scan.afterValue && valueOpeners.has(char)) {
    return false;
  }

  const change = depthChange.get(char) ?? 0;

  scan.inString = char === '"';
  scan.depth += change;
  scan.afterValue = change < 0 || (scan.afterValue && !separators.has(char));

  return scan.depth >= 0;
};

/**
 * Remove the whitespace JSON allows between tokens from one record's text. Nothing is parsed:
 * strings, numbers and key order are copied as received, so a number past 2^53 and every escape
 * survive byte for byte, which `JSON.parse` followed by `JSON.stringify` would not keep (design
 * 4.6). Only ASCII code units are inspected, so indexing by UTF-16 code unit is exact.
 *
 * Removing whitespace is safe only where it separates a value from punctuation, so the record is
 * `invalid` when a value follows another value with no `,` or `:` between them (whitespace in
 * `1 2` would otherwise join two numbers into `12`), when a string holds a raw character below
 * U+0020, or when a container closes that was never opened. It is not a full JSON check: input
 * the compactor cannot alter passes unchanged.
 */
const compact = (record: string): Compacted => {
  const scan: Scan = {
    afterValue: false,
    depth: 0,
    escaped: false,
    inScalar: false,
    inString: false,
  };
  let text = "";
  let start = 0;

  for (let index = 0; index < record.length; index += 1) {
    const char = record.charAt(index);
    const { inString } = scan;

    if (!(inString ? scanString(scan, char) : scanToken(scan, char))) {
      return { status: "invalid" };
    }

    if (!inString && whitespace.has(char)) {
      text += record.slice(start, index);
      start = index + 1;
    }
  }

  return {
    status: scan.inString || scan.depth > 0 ? "truncated" : "complete",
    text: text + record.slice(start),
  };
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
 * `maxRecordBytes` UTF-8 bytes fails with `recordTooLarge`, a line that ends inside a string or
 * an open container fails with `truncated`, and a line the compactor would change (two values
 * apart only by whitespace, a raw control character in a string, an unopened close) fails with
 * `invalidFraming`. Each failure carries the zero-based `itemIndex` of the record among the
 * non-blank lines, after every record before it has been emitted.
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
          const compacted = compact(line);

          if (compacted.status !== "complete") {
            const reason = compacted.status === "invalid" ? "invalidFraming" : "truncated";

            return Effect.fail(new ResponseStreamError({ itemIndex, reason }));
          }

          return Effect.succeed(
            compacted.text === ""
              ? ([itemIndex, []] as const)
              : ([itemIndex + 1, [compacted.text]] as const),
          );
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
  const compacted = compact(record);

  state.bytes = 0;
  state.record = "";

  if (compacted.status === "complete" && compacted.text === "") {
    return undefined;
  }

  if (bytes - (record.endsWith("\n") ? 1 : 0) > maxRecordBytes) {
    return new ResponseStreamError({ itemIndex, reason: "recordTooLarge" });
  }

  if (compacted.status === "invalid") {
    return new ResponseStreamError({ itemIndex, reason: "invalidFraming" });
  }

  if (compacted.status === "truncated" || !closedByLineFeed.test(record)) {
    return new ResponseStreamError({ itemIndex, reason: "truncated" });
  }

  state.itemIndex += 1;

  return compacted.text;
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
 * container, fails with `truncated`; a record the compactor would change fails with
 * `invalidFraming`. Each failure carries the zero-based `itemIndex` of the record being read,
 * after every record before it has been emitted.
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

/**
 * The longest prefix a `data` line carries before its value. `Sse.makeParser` counts the line it
 * is reading with its prefix, so its buffer bound is the record bound plus this prefix.
 */
const dataPrefix = "data: ";

/**
 * Render one dispatched SSE event as a compact JSON line with alphabetical keys: `data` as a
 * string, `event` unless it is the default type `message`, `id` when the stream has set one, and
 * `retry` in milliseconds when a `retry` field arrived since the previous event.
 */
const eventLine = (event: Sse.Event, retry: number | undefined): string =>
  JSON.stringify({
    data: event.data,
    event: event.event === "message" ? undefined : event.event,
    id: event.id,
    retry,
  });

/**
 * Build the SSE framer for one response body: a step that feeds a chunk of decoded text to
 * `Sse.makeParser` and returns the lines of the events it dispatched, then the first failure,
 * after which the step takes no more input. The parser is created per body, so a stream run twice
 * starts clean.
 */
const sseFramer = (maxRecordBytes: number) => {
  const out: Framed[] = [];
  let failed = false;
  let itemIndex = 0;
  let retry: number | undefined;

  const fail = (): void => {
    failed = true;
    out.push(new ResponseStreamError({ itemIndex, reason: "recordTooLarge" }));
  };

  const parser = Sse.makeParser(
    (parsed) => {
      if (failed) {
        return;
      }

      if (parsed._tag === "Retry") {
        retry = Duration.toMillis(parsed.duration);

        return;
      }

      if (utf8Length(parsed.data) > maxRecordBytes) {
        fail();

        return;
      }

      out.push(eventLine(parsed, retry));
      retry = undefined;
      itemIndex += 1;
    },
    { maxEventSize: maxRecordBytes + dataPrefix.length },
  );

  return (chunk: string): Framed[] => {
    if (!failed && parser.feed(chunk) !== undefined && !failed) {
      fail();
    }

    return out.splice(0);
  };
};

/**
 * Frame a Server-Sent Events response body (`text/event-stream`) as one compact JSON line per
 * dispatched event, `{"data":…,"event":…,"id":…,"retry":…}` with absent fields omitted, emitted as
 * each event is dispatched (design 4.6, the OAS generic event schema).
 *
 * The body is parsed by `Sse.makeParser` per `text/event-stream`: comments and unknown fields are
 * ignored, multi-line `data` is joined by LF, `id` is the last event ID the stream set, and an
 * event the stream ends inside is not dispatched. `Sse.decode` is not used because it fails the
 * stream on a `retry` field (design 5, SSE row); here `retry` is an integer field of the next
 * event dispatched. `data` stays a string: `contentMediaType` and `contentSchema` are not applied
 * (MED-18). An event whose `data` is over `maxRecordBytes` UTF-8 bytes, or a line the parser is
 * reading that passes the bound plus a `data: ` prefix, fails with `recordTooLarge` carrying the
 * zero-based `itemIndex` of the event, after every event before it has been emitted.
 */
export const sseRecords =
  (maxRecordBytes: number) =>
  <E, R>(
    body: Stream.Stream<Uint8Array, E, R>,
  ): Stream.Stream<string, E | ResponseStreamError, R> =>
    body.pipe(
      Stream.decodeText(),
      Stream.mapAccum(
        () => sseFramer(maxRecordBytes),
        (frame, chunk: string) => [frame, frame(chunk)] as const,
      ),
      Stream.mapEffect(raise),
    );
