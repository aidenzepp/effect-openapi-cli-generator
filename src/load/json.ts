import { Effect, Option, Schema } from "effect";
import type { DocumentUri } from "../model/brands.ts";
import { formatPointer } from "../model/pointer.ts";
import type { Json } from "../model/pointer.ts";
import { refuse } from "./budget.ts";
import type { LoadLimits, LoadRefusal, Position } from "./budget.ts";
import { byteOffset } from "./offset.ts";

type Document = typeof DocumentUri.Type;

const nameMapKeys: ReadonlySet<string> = new Set([
  "$defs",
  "callbacks",
  "definitions",
  "dependentSchemas",
  "encoding",
  "headers",
  "links",
  "mediaTypes",
  "parameters",
  "patternProperties",
  "pathItems",
  "properties",
  "requestBodies",
  "responses",
  "schemas",
  "securitySchemes",
  "variables",
]);

const dataKeys: ReadonlySet<string> = new Set(["const", "default", "enum"]);

const opaqueKeys: ReadonlySet<string> = new Set(["example", "examples"]);

const largestSafeValue = 2 ** 53;

/**
 * Decodes the text of a JSON document.
 */
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

/**
 * Decodes one quoted JSON string literal.
 */
const decodeKey = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

/**
 * The key a raw (still escaped) member name denotes. A key's decoding matters only once
 * `JSON.parse` has accepted the text, so every raw key is then a valid JSON string body; on
 * malformed text the raw spelling stands in.
 */
const unescapeKey = (raw: string): string => Option.getOrElse(decodeKey(`"${raw}"`), () => raw);

const numberToken = /^-?(?<int>[0-9]+)(?:\.(?<frac>[0-9]+))?(?:[eE](?<exp>[+-]?[0-9]+))?$/u;

interface Decimal {
  readonly digits: string;
  readonly exponent: number;
}

/**
 * The value as `digits * 10^exponent` with no leading or trailing zeros in `digits`; sign ignored.
 */
const decimalOf = (token: string): Decimal | undefined => {
  const groups = numberToken.exec(token)?.groups;

  if (groups === undefined) {
    return undefined;
  }

  const fraction = groups.frac ?? "";
  const all = `${groups.int ?? ""}${fraction}`.replace(/^0+/u, "");
  const digits = all.replace(/0+$/u, "");
  const exponent = Number(groups.exp ?? "0") - fraction.length + (all.length - digits.length);

  return digits === "" ? { digits: "", exponent: 0 } : { digits, exponent };
};

const sameDecimal = (left: Decimal, right: Decimal): boolean =>
  left.digits === right.digits && left.exponent === right.exponent;

/**
 * A number literal that does not survive `JSON.parse`: not finite, an integer beyond 2^53,
 * or a decimal whose digits differ from the shortest decimal of the double it parses to.
 */
const isUnsafeNumber = (token: string): boolean => {
  const written = decimalOf(token);

  if (written === undefined) {
    return false;
  }

  const value = Math.abs(Number(token));
  const parsed = decimalOf(String(value));

  return (
    !Number.isFinite(value) ||
    value > largestSafeValue ||
    parsed === undefined ||
    !sameDecimal(written, parsed)
  );
};

interface Frame {
  readonly array: boolean;
  readonly data: boolean;
  readonly nameMap: boolean;
  readonly opaque: boolean;
  readonly keys: Set<string>;
  expectKey: boolean;
  index: number;
  key: string;
}

interface Context {
  readonly data: boolean;
  readonly nameMap: boolean;
  readonly opaque: boolean;
}

interface Finding {
  readonly code: "DOC-14/duplicate-key" | "DOC-14/unsafe-integer";
  readonly index: number;
  readonly pointer: string;
}

interface Scan {
  readonly limit?: "DOC-14/depth-limit" | "DOC-14/node-budget";
  readonly finding?: Finding;
}

const rootContext: Context = { data: false, nameMap: false, opaque: false };

const valueContext = (frame: Frame | undefined): Context => {
  if (frame === undefined) {
    return rootContext;
  }

  if (frame.array || frame.nameMap) {
    return { data: frame.data, nameMap: false, opaque: frame.opaque };
  }

  const data = frame.data || (!frame.opaque && dataKeys.has(frame.key));
  const opaque = !data && (frame.opaque || opaqueKeys.has(frame.key));

  return { data, nameMap: !data && !opaque && nameMapKeys.has(frame.key), opaque };
};

const pointerOf = (frames: readonly Frame[]): string =>
  formatPointer(frames.map((frame) => (frame.array ? String(frame.index) : frame.key)));

const stringEnd = (text: string, start: number): number => {
  let end = start + 1;

  while (end < text.length && text[end] !== '"') {
    end += text[end] === "\\" ? 2 : 1;
  }

  return end;
};

const tokenEnd = (text: string, start: number): number => {
  let end = start;

  while (end < text.length && !",:{}[] \t\n\r".includes(text[end] ?? "")) {
    end += 1;
  }

  return Math.max(end, start + 1);
};

interface State {
  readonly frames: Frame[];
  readonly limits: LoadLimits;
  readonly text: string;
  cursor: number;
  finding: Finding | undefined;
  limit: Scan["limit"];
  nodes: number;
}

const spend = (state: State): void => {
  state.nodes += 1;

  if (state.nodes > state.limits.maxNodes) {
    state.limit = "DOC-14/node-budget";
  }
};

const record = (state: State, code: Finding["code"], index: number): void => {
  state.finding ??= { code, index, pointer: pointerOf(state.frames) };
};

const open = (state: State, char: string): void => {
  spend(state);

  if (state.frames.length + 1 > state.limits.maxDepth) {
    state.limit = "DOC-14/depth-limit";

    return;
  }

  state.frames.push({
    ...valueContext(state.frames.at(-1)),
    array: char === "[",
    expectKey: char === "{",
    index: 0,
    key: "",
    keys: new Set(),
  });
  state.cursor += 1;
};

const separator = (state: State, char: string): void => {
  const top = state.frames.at(-1);

  if (top !== undefined && char === ":") {
    top.expectKey = false;
  } else if (top?.array === true) {
    top.index += 1;
  } else if (top !== undefined) {
    top.expectKey = true;
  }

  state.cursor += 1;
};

const string = (state: State): void => {
  const top = state.frames.at(-1);
  const end = stringEnd(state.text, state.cursor);

  if (top === undefined || top.array || !top.expectKey) {
    spend(state);
  } else {
    const raw = state.text.slice(state.cursor + 1, end);

    top.key = raw.includes("\\") ? unescapeKey(raw) : raw;

    if (top.keys.has(top.key)) {
      record(state, "DOC-14/duplicate-key", state.cursor);
    }

    top.keys.add(top.key);
  }

  state.cursor = end + 1;
};

const token = (state: State): void => {
  const end = tokenEnd(state.text, state.cursor);

  spend(state);

  if (
    valueContext(state.frames.at(-1)).data &&
    isUnsafeNumber(state.text.slice(state.cursor, end))
  ) {
    record(state, "DOC-14/unsafe-integer", state.cursor);
  }

  state.cursor = end;
};

/**
 * One iterative pass over the text: depth, node budget, duplicate keys, and unsafe integers at
 * `default`/`enum`/`const` sites. It tolerates malformed input; `JSON.parse` judges syntax.
 */
const scan = (text: string, limits: LoadLimits): Scan => {
  const state: State = {
    cursor: 0,
    finding: undefined,
    frames: [],
    limit: undefined,
    limits,
    nodes: 0,
    text,
  };

  while (state.cursor < text.length && state.limit === undefined) {
    const char = text[state.cursor] ?? "";

    if (char === "{" || char === "[") {
      open(state, char);
    } else if (char === "}" || char === "]") {
      state.frames.pop();
      state.cursor += 1;
    } else if (char === "," || char === ":") {
      separator(state, char);
    } else if (char === '"') {
      string(state);
    } else if (" \t\n\r".includes(char)) {
      state.cursor += 1;
    } else {
      token(state);
    }
  }

  if (state.limit !== undefined) {
    return { limit: state.limit };
  }

  return state.finding === undefined ? {} : { finding: state.finding };
};

const codePointCount = (text: string): number => {
  let count = 0;

  for (const _char of text) {
    count += 1;
  }

  return count;
};

const locate = (text: string, index: number, byteBase: number): Position => {
  const before = text.slice(0, index);
  const lines = before.split("\n");

  return {
    column: codePointCount(lines.at(-1) ?? "") + 1,
    line: lines.length,
    offset: byteOffset(text, index, byteBase),
  };
};

/**
 * `JSON.parse` plus a duplicate-key scan over the same text. `byteBase` is the number of bytes
 * before `text` in the input (a byte order mark), so reported offsets are input offsets.
 */
export const parseStrictJson: (
  text: string,
  limits: LoadLimits,
  document: Document,
  byteBase: number,
) => Effect.Effect<Json, LoadRefusal> = Effect.fnUntraced(function* strictJson(
  text: string,
  limits: LoadLimits,
  document: Document,
  byteBase: number,
) {
  const scanned = scan(text, limits);

  if (scanned.limit !== undefined) {
    return yield* refuse(document, scanned.limit);
  }

  const value = yield* decodeJson(text).pipe(
    Effect.catchTag("SchemaError", () => refuse(document, "DOC-14/invalid-json")),
  );
  const { finding } = scanned;

  if (finding !== undefined) {
    return yield* refuse(document, finding.code, {
      pointer: finding.pointer,
      position: locate(text, finding.index, byteBase),
    });
  }

  return value;
});
