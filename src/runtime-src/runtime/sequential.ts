import { Effect, Option, Schema, Stream } from "effect";
import { ResponseStreamError } from "../domain/errors.ts";

/**
 * A sequential body's framing: NDJSON or JSONL lines, RFC 7464 JSON-seq records, or Server-Sent
 * Events.
 */
export type SequentialCodec = "jsonseq" | "ndjson" | "sse";

/**
 * The sequential codec each media type essence selects. With the `+json-seq` suffix rule in
 * `sequentialCodecOf`, the one owner of these facts: the generator assigns a response alternative
 * its codec through it (`src/normalize/responses.ts`) and the runtime frames a body by it
 * (`framerFor` in `output.ts`), so the two cannot disagree.
 */
export const sequentialMediaTypes: ReadonlyMap<string, SequentialCodec> = new Map([
  ["application/json-seq", "jsonseq"],
  ["application/jsonl", "ndjson"],
  ["application/ndjson", "ndjson"],
  ["application/x-ndjson", "ndjson"],
  ["text/event-stream", "sse"],
]);

/**
 * A structured syntax suffix essence for JSON text sequences (RFC 8091), such as
 * `application/geo+json-seq`.
 */
const jsonSeqSuffix = /^[^/;]+\/[^/;]+\+json-seq$/u;

/**
 * A media type's essence: parameters dropped, trimmed, lowercased. The one place the runtime
 * splits a media type at `;`.
 */
export const mediaEssence = (mediaType: string): string => {
  const [head = ""] = mediaType.split(";", 1);

  return head.trim().toLowerCase();
};

/**
 * Whether `mediaType` is JSON media: `application/json` or a `+json` suffix, parameters and case
 * ignored.
 */
export const isJsonFamily = (mediaType: string): boolean => {
  const essence = mediaEssence(mediaType);

  return essence === "application/json" || essence.endsWith("+json");
};

/**
 * The sequential codec a media type selects, or `undefined` for a non-sequential type: its essence
 * (lowercased, parameters dropped) is looked up in `sequentialMediaTypes`, and any other
 * `+json-seq` essence is JSON-seq.
 */
export const sequentialCodecOf = (mediaType: string): SequentialCodec | undefined => {
  const essence = mediaEssence(mediaType);

  return sequentialMediaTypes.get(essence) ?? (jsonSeqSuffix.test(essence) ? "jsonseq" : undefined);
};

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
 * The JSON-seq framer's state between body chunks: the open record's text, UTF-8 size and scan,
 * the index the next record takes, whether a record is open (a separator has arrived and no LF
 * has closed its record since), whether the open record can no longer close at an LF, and whether
 * the stream failed.
 */
interface SeqState {
  bytes: number;
  failed: boolean;
  itemIndex: number;
  open: boolean;
  record: string;
  scan: Scan;
  settled: boolean;
}

/**
 * Compute the UTF-8 byte length of one code point.
 */
export const utf8Bytes = (char: string): number => {
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
 * Construct the scan at the start of a record.
 */
const freshScan = (): Scan => ({
  afterValue: false,
  depth: 0,
  escaped: false,
  inScalar: false,
  inString: false,
});

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
  const scan = freshScan();
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
 * Frame an NDJSON or JSONL response body (`application/x-ndjson`, `application/ndjson`,
 * `application/jsonl`) as one
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
  open: false,
  record: "",
  scan: freshScan(),
  settled: false,
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
  state.scan = freshScan();
  state.settled = false;

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
 * Advance the open record's scan over text added to it, until the scan finds text the compactor
 * would change; the record then closes only at the next separator or the end of the body.
 */
const scanRecord = (state: SeqState, text: string): void => {
  const { scan } = state;

  for (const char of state.settled ? "" : text) {
    if (!(scan.inString ? scanString(scan, char) : scanToken(scan, char))) {
      state.settled = true;

      return;
    }
  }
};

/**
 * Decode text as one JSON text; `None` when it is not one.
 */
const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * Whether the open record's text, which ends at an LF, is a complete JSON text, so the record
 * closes at that LF (RFC 7464 ends each record with LF) instead of at the next separator. The
 * scan rules out text inside a string or a container without parsing; decoding decides the rest.
 * Past a top-level value only whitespace may follow, so text that does not decode here never will,
 * and the record settles: it closes at the next separator or the end of the body.
 */
const completeAtLineFeed = (state: SeqState): boolean => {
  const { scan } = state;

  if (state.settled || scan.inString || scan.depth > 0 || !scan.afterValue) {
    return false;
  }

  const decodes = Option.isSome(decodeJsonText(state.record));

  state.settled = !decodes;

  return decodes;
};

/**
 * Add text between separators to the open JSON-seq record, closing it into `out` at the LF that
 * completes its JSON text, or check text outside a record: before the first separator, or after a
 * record closed at its LF, where only whitespace may appear. Fails as soon as the record passes
 * the bound with one byte left for its closing LF.
 */
const appendRecord = (
  state: SeqState,
  part: string,
  maxRecordBytes: number,
  out: Framed[],
): ResponseStreamError | undefined => {
  let start = 0;

  while (start < part.length) {
    const { itemIndex } = state;

    if (!state.open) {
      return nonWhitespace.test(part.slice(start))
        ? new ResponseStreamError({ itemIndex, reason: "invalidFraming" })
        : undefined;
    }

    const lineFeed = part.indexOf("\n", start);
    const end = lineFeed === -1 ? part.length : lineFeed + 1;
    const text = part.slice(start, end);
    const bytes = state.bytes + utf8Length(text);

    if (bytes > maxRecordBytes + 1) {
      return new ResponseStreamError({ itemIndex, reason: "recordTooLarge" });
    }

    state.bytes = bytes;
    state.record += text;
    scanRecord(state, text);
    start = end;

    if (lineFeed !== -1 && completeAtLineFeed(state)) {
      const closed = closeRecord(state, maxRecordBytes);

      state.open = false;

      if (closed instanceof ResponseStreamError) {
        return closed;
      }

      if (closed !== undefined) {
        out.push(closed);
      }
    }
  }

  return undefined;
};

/**
 * Frame one chunk of decoded JSON-seq text: every record a separator or an LF in the chunk closes,
 * then the first failure, after which the framer takes no more input.
 */
const frameChunk = (state: SeqState, chunk: string, maxRecordBytes: number): Framed[] => {
  const out: Framed[] = [];

  for (const [position, part] of (state.failed ? [] : chunk.split(recordSeparator)).entries()) {
    const closed = position > 0 && state.open ? closeRecord(state, maxRecordBytes) : undefined;

    state.open ||= position > 0;

    if (closed !== undefined && !(closed instanceof ResponseStreamError)) {
      out.push(closed);
    }

    const failure =
      closed instanceof ResponseStreamError
        ? closed
        : appendRecord(state, part, maxRecordBytes, out);

    if (failure !== undefined) {
      state.failed = true;
      out.push(failure);

      return out;
    }
  }

  return out;
};

/**
 * Frame a JSON-seq response body (RFC 7464, `application/json-seq` and `+json-seq`) as one
 * compacted JSON text per record, without a line terminator, emitted as each record closes.
 *
 * A record opens at U+001E and closes at the first LF after which its text decodes as JSON, so it
 * is emitted as it arrives; an LF inside the text is whitespace and keeps the record open. A
 * record that never decodes at an LF closes at the next separator or the end of the body. The body
 * may open with whitespace; any other text before the first separator, or after a record's closing
 * LF and before the next separator, fails with `invalidFraming`. An empty
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
              state.failed || !state.open ? undefined : closeRecord(state, maxRecordBytes);

            return last === undefined ? [] : [last];
          },
        },
      ),
      Stream.mapEffect(raise),
    );

// The SSE line handling is owned here rather than taken from `Sse.makeParser`, whose `Parser` is
// `feed` and `reset` only (effect 4.1.2, `effect/src/encoding/Sse.ts`): it reports a `retry` field
// through `parseInt`, which loses digits past 2^53, and does not expose whether an event block is
// open, which `truncated` needs. `Sse.decode` fails the stream on a `retry` field. One reader keeps
// the line splitting, the fields and the bound in step.

/**
 * The longest prefix a `data` line carries before its value. The buffer bound, the line being
 * read plus the data of the open event block in UTF-16 code units, is the record bound plus this
 * prefix, the bound `Sse.makeParser` applies with `maxEventSize`.
 */
const dataPrefix = "data: ";

/**
 * The byte order mark skipped at the start of the stream.
 */
const byteOrderMark = "﻿";

/**
 * The digits of a `retry` field value the stream acts on: digits only.
 */
const retryDigits = /^\d+$/u;

/**
 * The fields of one dispatched SSE event: `event` is the type, `message` by default, and `id` the
 * last event ID the stream set.
 */
interface SseEvent {
  readonly data: string;
  readonly event: string;
  readonly id: string | undefined;
}

/**
 * The SSE reader's state between body chunks (`text/event-stream`): the line being read
 * (`pending`), whether the previous chunk ended with CR so a leading LF completes that CRLF, the
 * event block being built (`data`, each line followed by LF, and `eventName`), the last event ID,
 * whether an event block is open (a field line has arrived since the last blank line), and the
 * digits of the last `retry` field since the previous dispatched event.
 */
interface SseScan {
  afterCarriageReturn: boolean;
  data: string;
  eventName: string | undefined;
  lastEventId: string | undefined;
  open: boolean;
  pending: string;
  retry: string | undefined;
  started: boolean;
}

/**
 * Render one dispatched SSE event as a compact JSON line with alphabetical keys: `data` as a
 * string, `event` unless it is the default type `message`, `id` when the stream has set one, and
 * `retry` as the digits received when a `retry` field arrived since the previous event. The digits
 * are written as they are, not through a JS number, so a value past 2^53 keeps them.
 */
const eventLine = (event: SseEvent, retry: string | undefined): string => {
  const fields = JSON.stringify({
    data: event.data,
    event: event.event === "message" ? undefined : event.event,
    id: event.id,
  });

  return retry === undefined ? fields : `${fields.slice(0, -1)},"retry":${retry}}`;
};

/**
 * The SSE framer for one response body: `step` reads a chunk of decoded text and returns the lines
 * of the events it dispatched, then the first failure, after which it takes no more input; `halt`
 * returns `truncated` when the body ends inside an event block.
 */
interface SseFramer {
  readonly halt: () => Framed[];
  readonly step: (chunk: string) => Framed[];
}

/**
 * Build the SSE framer for one response body. The state is created per body, so a stream run
 * twice starts clean.
 */
const sseFramer = (maxRecordBytes: number): SseFramer => {
  const out: Framed[] = [];
  const scan: SseScan = {
    afterCarriageReturn: false,
    data: "",
    eventName: undefined,
    lastEventId: undefined,
    open: false,
    pending: "",
    retry: undefined,
    started: false,
  };
  let failed = false;
  let itemIndex = 0;

  const fail = (reason: "recordTooLarge" | "truncated"): void => {
    failed = true;
    out.push(new ResponseStreamError({ itemIndex, reason }));
  };

  // A blank line dispatches the event block when it holds data, without its last LF.
  const dispatch = (): void => {
    const { data, eventName } = scan;

    scan.data = "";
    scan.eventName = undefined;
    if (data.length === 0) {
      return;
    }

    const event: SseEvent = {
      data: data.slice(0, -1),
      event: eventName === undefined || eventName === "" ? "message" : eventName,
      id: scan.lastEventId,
    };
    if (utf8Length(event.data) > maxRecordBytes) {
      fail("recordTooLarge");

      return;
    }

    out.push(eventLine(event, scan.retry));
    scan.retry = undefined;
    itemIndex += 1;
  };

  // One line: the field before the first colon, the value after it less one leading space.
  // Comments and unknown fields are ignored; any line but a comment opens an event block.
  const readLine = (line: string): void => {
    if (line.length === 0) {
      scan.open = false;
      dispatch();

      return;
    }

    scan.open ||= !line.startsWith(":");

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value =
      colon === -1 ? "" : line.slice(line.startsWith(" ", colon + 1) ? colon + 2 : colon + 1);

    if (field === "data") {
      scan.data += `${value}\n`;
    } else if (field === "event") {
      scan.eventName = value;
    } else if (field === "id" && !value.includes("\u0000")) {
      scan.lastEventId = value;
    } else if (field === "retry" && retryDigits.test(value)) {
      // Without leading zeros, so the digits form a JSON number.
      scan.retry = value.replace(/^0+(?=\d)/u, "");
    }
  };

  return {
    halt: () => {
      const open = scan.open || (scan.pending.length > 0 && !scan.pending.startsWith(":"));

      if (!failed && open) {
        fail("truncated");
      }

      return out.splice(0);
    },
    step: (chunk) => {
      if (failed || chunk.length === 0) {
        return out.splice(0);
      }

      const text = !scan.started && chunk.startsWith(byteOrderMark) ? chunk.slice(1) : chunk;
      scan.started = true;

      // Lines end at LF, CR or CRLF; the LF of a CRLF may arrive in the next chunk.
      let position = 0;
      while (position < text.length) {
        if (scan.afterCarriageReturn) {
          scan.afterCarriageReturn = false;
          if (text.charAt(position) === "\n") {
            position += 1;
            continue;
          }
        }

        let end = position;
        while (end < text.length && text.charAt(end) !== "\r" && text.charAt(end) !== "\n") {
          end += 1;
        }

        if (end === text.length) {
          scan.pending += text.slice(position);
          break;
        }

        scan.afterCarriageReturn = text.charAt(end) === "\r";
        const line = scan.pending + text.slice(position, end);
        scan.pending = "";
        readLine(line);
        if (failed) {
          return out.splice(0);
        }

        position = end + 1;
      }

      if (scan.pending.length + scan.data.length > maxRecordBytes + dataPrefix.length) {
        fail("recordTooLarge");
      }

      return out.splice(0);
    },
  };
};

/**
 * Frame a Server-Sent Events response body (`text/event-stream`) as one compact JSON line per
 * dispatched event, `{"data":…,"event":…,"id":…,"retry":…}` with absent fields omitted, emitted as
 * each event is dispatched (design 4.6, the OAS generic event schema).
 *
 * The body is read per `text/event-stream`: comments and unknown fields are ignored, multi-line
 * `data` is joined by LF, and `id` is the last event ID the stream set. `Sse.decode` is not used
 * because it fails the stream on a `retry` field (design 5, SSE row); here `retry` is an integer
 * field of the next event dispatched, written with the digits received.
 * `data` stays a string: `contentMediaType` and `contentSchema` are not applied (MED-18).
 *
 * An event whose `data` is over `maxRecordBytes` UTF-8 bytes, or a line being read that, with the
 * open block's data, passes the bound plus a `data: ` prefix, fails with `recordTooLarge`. A body
 * that ends inside an event block, after a field line with no blank line to dispatch it, fails with
 * `truncated` and the block is not dispatched. Each failure carries the zero-based `itemIndex` of
 * the event, after every event before it has been emitted.
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
        (framer, chunk: string) => [framer, framer.step(chunk)] as const,
        { onHalt: (framer) => framer.halt() },
      ),
      Stream.mapEffect(raise),
    );
