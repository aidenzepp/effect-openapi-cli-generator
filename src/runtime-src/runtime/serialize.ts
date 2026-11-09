import { Effect, Option, Predicate, Result, Schema, SchemaIssue, SchemaParser } from "effect";
import type { Stream } from "effect";
import { Headers, HttpBody, HttpClientRequest, UrlParams } from "effect/http";
import { UsageError } from "../domain/errors.ts";
import { JsonNumber, isJsonNumberText, rawJson } from "./input.ts";
import type { Chosen, RawJson, SentType } from "./input.ts";
import * as Multipart from "./multipart.ts";
import type { MediaDeclaration } from "./negotiate.ts";

/**
 * A value with a text form. Integers outside the safe range arrive as digit strings and are sent
 * as given; a `JsonNumber` is a number sent as its digit text, never through a JS number.
 */
export type Scalar = string | number | boolean | null | undefined | JsonNumber;

/**
 * A parameter value: a scalar, an array of scalars, or an object with scalar members. Deeper
 * nesting has no style: a style constructor takes any `Nested` value, such as an object-schema
 * parameter's JSON, and refuses a member that is itself an object or array.
 */
export type Value = Scalar | readonly Scalar[] | { readonly [member: string]: Scalar };

/**
 * A value at any depth: what a `deepObject` parameter or Encoding entry may receive. Only the
 * bracket convention sends one deeper than `Value`; every other path refuses it.
 */
export type Nested = Scalar | readonly Nested[] | { readonly [member: string]: Nested };

/**
 * The text form of a defined value: array items and object members in document order.
 */
export type Text =
  | { readonly kind: "primitive"; readonly text: string }
  | { readonly kind: "array"; readonly items: readonly string[] }
  | {
      readonly kind: "object";
      readonly members: readonly (readonly [key: string, text: string])[];
    };

export interface PathOptions {
  readonly allowReserved: boolean;
  readonly explode: boolean;
}

/**
 * A path parameter: plain data plus its expansion, which fails with `UsageError` instead of
 * throwing.
 */
export interface PathParameter {
  readonly expand: Effect.Effect<string, UsageError>;
  readonly name: string;
  readonly style: "label" | "matrix" | "simple";
}

/**
 * An expanded path template: the path only, with no origin and no query.
 */
export interface Path {
  readonly expand: Effect.Effect<string, UsageError>;
  readonly template: string;
}

type Refusal = Effect.Effect<never, UsageError>;

/**
 * Messages name the parameter and the rule, never the value.
 */
const refuse = (message: string): Refusal => Effect.fail(new UsageError({ message }));

const unpairedSurrogate = /\p{Surrogate}/u;

const scalarText = (name: string, value: Scalar): Effect.Effect<string | undefined, UsageError> => {
  if (value instanceof JsonNumber) {
    return isJsonNumberText(value.text)
      ? Effect.succeed(value.text)
      : refuse(`parameter ${name} holds a number with no JSON text form`);
  }

  if (Predicate.isString(value)) {
    return unpairedSurrogate.test(value)
      ? refuse(`parameter ${name} holds an unpaired surrogate, which has no UTF-8 form`)
      : Effect.succeed(value);
  }

  if (Predicate.isNumber(value)) {
    return Number.isFinite(value)
      ? Effect.succeed(JSON.stringify(value))
      : refuse(`parameter ${name} holds a number with no JSON text form`);
  }

  if (Predicate.isBoolean(value)) {
    return Effect.succeed(String(value));
  }

  if (Predicate.isNullish(value)) {
    return Effect.undefined;
  }

  return refuse(`parameter ${name} holds a value nested deeper than one level`);
};

/**
 * An array item or an object member that is itself undefined has no place in a list.
 */
const itemText = (name: string, value: Scalar) =>
  Effect.flatMap(scalarText(name, value), (text) =>
    text === undefined
      ? refuse(`parameter ${name} holds an item with no text form`)
      : Effect.succeed(text),
  );

const memberTexts = (name: string, value: { readonly [member: string]: Scalar }) =>
  Effect.forEach(
    Object.entries(value).filter(([, member]) => member !== undefined),
    ([key, member]) => Effect.zip(itemText(name, key), itemText(name, member)),
  );

const isList = (value: Value): value is readonly Scalar[] => Array.isArray(value);

const isNestedList = (value: Nested): value is readonly Nested[] => Array.isArray(value);

const isScalar = (value: Nested): value is Scalar =>
  value instanceof JsonNumber || !Predicate.isObjectOrArray(value);

/**
 * A value an RFC 6570 style can expand: a scalar, or an array or object of scalars.
 */
const isFlat = (value: Nested): value is Value =>
  isScalar(value) ||
  (isNestedList(value) ? value : Object.values(value)).every((member) => isScalar(member));

// A value an RFC 6570 style expands, or the refusal of a member that is an object or array.
const flatOf = (name: string, value: Nested): Effect.Effect<Value, UsageError> =>
  isFlat(value)
    ? Effect.succeed(value)
    : refuse(`parameter ${name} holds a value nested deeper than one level`);

const describe = (name: string, value: Value): Effect.Effect<Text | undefined, UsageError> => {
  if (isList(value)) {
    return value.length === 0
      ? Effect.undefined
      : Effect.map(Effect.all(value.map((item) => itemText(name, item))), (items): Text => ({
          items,
          kind: "array",
        }));
  }

  if (!isScalar(value)) {
    return Effect.map(memberTexts(name, value), (members): Text | undefined =>
      members.length === 0 ? undefined : { kind: "object", members },
    );
  }

  return Effect.map(scalarText(name, value), (text): Text | undefined =>
    text === undefined ? undefined : { kind: "primitive", text },
  );
};

/**
 * Type to text (design 6.1): numbers as shortest JSON text, booleans as `true` and `false`.
 * `null`, undefined, an empty array and an empty object are RFC 6570 undefined, which a required
 * parameter refuses. A member that is undefined is omitted, a `null` member and a `null` or
 * undefined item are refused. A lone surrogate is refused everywhere, so no later encoding path
 * sees one.
 */
export const toText = (
  name: string,
  value: Value,
  required: boolean,
): Effect.Effect<Text | undefined, UsageError> =>
  Effect.gen(function* conversion() {
    const text = yield* describe(name, value);

    if (text === undefined && required) {
      return yield* refuse(`parameter ${name} is required and has no value`);
    }

    return text;
  });

const percentTriplet = /%[0-9A-Fa-f]{2}/u;

/**
 * Everything outside RFC 3986 unreserved. `encodeURIComponent` leaves `!'()*` alone.
 */
const encodeUnreserved = (text: string) =>
  encodeURIComponent(text).replaceAll(
    /[!'()*]/gu,
    (character) => `%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
  );

/**
 * Reserved characters a path expansion may pass under `allowReserved`: `/`, `?` and `#` are always
 * encoded (3.2.1 path templating).
 */
const pathReserved = ":[]@!$&'()*+,;=";

/**
 * Reserved characters a form-urlencoded value may pass under `allowReserved`: RFC 3986 reserved
 * less the form delimiters `&`, `=` and `+` and the fragment start `#`, which stay encoded.
 */
const formReserved = ":/?[]@!$'()*,;";

/**
 * Reserved characters a query value may pass under `allowReserved`: `formReserved` less `'`, which
 * `fetch` always sends as `%27` in an http(s) query (a platform limit, D-OC7). Effect's
 * `HttpClient` parses every request URL with `new URL`, so encoding it here keeps this output equal
 * to the wire, as `queryWireForm` does. A form body is not parsed as a URL, so it keeps `'`.
 */
const queryReserved = formReserved.replace("'", "");

const encoder =
  (allowReserved: boolean, passed = pathReserved) =>
  (text: string) =>
    allowReserved
      ? text.replaceAll(/%[0-9A-Fa-f]{2}|[\S\s]/gu, (token) =>
          percentTriplet.test(token) || passed.includes(token) ? token : encodeUnreserved(token),
        )
      : encodeUnreserved(text);

type PathStyle = PathParameter["style"];

/**
 * Delimiters the style emits unencoded: an item or member containing one cannot be told apart from
 * the delimiter after expansion (design 6.1 runtime refusals).
 */
const ambiguousDelimiters = (
  style: PathStyle,
  text: Text,
  options: PathOptions,
): readonly string[] => {
  const exploded = options.explode;
  const reserved = options.allowReserved;

  if (style === "simple") {
    return reserved ? [",", ...(exploded && text.kind === "object" ? ["="] : [])] : [];
  }

  if (style === "label") {
    return [...(exploded ? ["."] : []), ...(reserved ? [",", "="] : [])];
  }

  return reserved ? [";", ",", "="] : [];
};

const parts = (text: Text): readonly string[] => {
  if (text.kind === "primitive") {
    return [];
  }

  return text.kind === "array" ? text.items : text.members.flat();
};

const checkDelimiters = (name: string, style: PathStyle, text: Text, options: PathOptions) => {
  const banned = ambiguousDelimiters(style, text, options);
  const clash = parts(text).some((part) => banned.some((delimiter) => part.includes(delimiter)));

  return clash
    ? refuse(`parameter ${name} holds a character its ${style} expansion would leave ambiguous`)
    : Effect.void;
};

const assignment = (key: string, text: string) => (text === "" ? `;${key}` : `;${key}=${text}`);

const encodeText = (text: Text, encode: (text: string) => string): Text => {
  if (text.kind === "primitive") {
    return { kind: "primitive", text: encode(text.text) };
  }

  if (text.kind === "array") {
    return { items: text.items.map((item) => encode(item)), kind: "array" };
  }

  return {
    kind: "object",
    members: text.members.map(([key, member]) => [encode(key), encode(member)] as const),
  };
};

/**
 * The comma-joined form of every non-exploded expansion.
 */
const flat = (text: Text, separator = ",") => {
  if (text.kind === "primitive") {
    return text.text;
  }

  return text.kind === "array" ? text.items.join(separator) : text.members.flat().join(separator);
};

const expandMatrix = (name: string, text: Text, explode: boolean) => {
  if (explode && text.kind === "array") {
    return text.items.map((item) => assignment(name, item)).join("");
  }

  if (explode && text.kind === "object") {
    return text.members.map(([key, member]) => assignment(key, member)).join("");
  }

  return assignment(name, flat(text));
};

const expandLabel = (text: Text, explode: boolean) => {
  if (explode && text.kind === "array") {
    return `.${text.items.join(".")}`;
  }

  if (explode && text.kind === "object") {
    return `.${text.members.map(([key, member]) => `${key}=${member}`).join(".")}`;
  }

  return `.${flat(text)}`;
};

const compose = (
  style: PathStyle,
  name: string,
  raw: Text,
  explode: boolean,
  encode: (text: string) => string,
) => {
  const text = encodeText(raw, encode);

  if (style === "label") {
    return expandLabel(text, explode);
  }

  if (style === "matrix") {
    return expandMatrix(encodeUnreserved(name), text, explode);
  }

  return explode && text.kind === "object"
    ? text.members.map(([key, member]) => `${key}=${member}`).join(",")
    : flat(text);
};

const styled =
  (style: PathStyle) =>
  (name: string, value: Nested, options: PathOptions): PathParameter => ({
    expand: Effect.gen(function* styleExpansion() {
      // Only a matrix expansion emits the name.
      if (style === "matrix" && unpairedSurrogate.test(name)) {
        return yield* refuse("a matrix parameter has a name with no UTF-8 form");
      }

      const text = yield* toText(name, yield* flatOf(name, value), true);

      if (text === undefined) {
        return yield* refuse(`parameter ${name} is required and has no value`);
      }

      yield* checkDelimiters(name, style, text, options);

      return compose(style, name, text, options.explode, encoder(options.allowReserved));
    }),
    name,
    style,
  });

/**
 * RFC 6570 `{name}`.
 */
export const simple = styled("simple");

/**
 * RFC 6570 `{.name}`.
 */
export const label = styled("label");

/**
 * RFC 6570 `{;name}`.
 */
export const matrix = styled("matrix");

const placeholder = /\{(?<name>[^{}]*)\}/u;

const dotSegment = (segment: string) => {
  const decoded = segment.replaceAll(/%2e/giu, ".");

  return decoded === "." || decoded === "..";
};

/**
 * A path template with its parameters. Expansion fails with `UsageError` for a placeholder with no
 * parameter, a parameter with no placeholder, a repeated parameter name, any parameter refusal,
 * and a `.` or `..` segment in the result (percent-encoded forms included, since servers and the
 * WHATWG parser normalize them away).
 */
export const path = (template: string, parameters: readonly PathParameter[]): Path => ({
  expand: Effect.gen(function* pathExpansion() {
    const names = parameters.map((parameter) => parameter.name);

    if (new Set(names).size !== names.length) {
      return yield* refuse(`path ${template} has two parameters with one name`);
    }

    const expansions = new Map<string, string>();

    for (const parameter of parameters) {
      const expansion = yield* parameter.expand;

      // An empty simple expansion would collapse its segment; matrix and label never expand to "".
      if (expansion === "") {
        return yield* refuse(`path parameter ${parameter.name} expands to nothing`);
      }

      expansions.set(parameter.name, expansion);
    }

    const used = new Set<string>();
    const pieces = template.split(placeholder);
    let expanded = "";

    for (const [index, piece] of pieces.entries()) {
      if (index % 2 === 0) {
        expanded += piece;
      } else {
        const value = expansions.get(piece);

        if (value === undefined) {
          return yield* refuse(`path ${template} has a placeholder with no parameter`);
        }

        used.add(piece);
        expanded += value;
      }
    }

    if (used.size !== names.length) {
      return yield* refuse(`path ${template} has a parameter with no placeholder`);
    }

    if (expanded.split("/").some(dotSegment)) {
      return yield* refuse(`path ${template} expands to a dot segment`);
    }

    return expanded;
  }),
  template,
});

type QueryStyle = "deepObject" | "form" | "pipeDelimited" | "spaceDelimited";

export interface QueryOptions {
  readonly allowEmptyValue?: boolean;
  readonly allowReserved: boolean;
  /**
   * `deepObject` only: send nested values in the bracket convention (design 6.1, D-OQ1 (b)). Set
   * only by the author config's `nonStandard.deepObjectBrackets`; absent is strict.
   */
  readonly brackets?: boolean;
  readonly explode: boolean;
  readonly required: boolean;
  /**
   * `deepObject` only: send a scalar value as one `name=value` pair by the type-to-text rule
   * (design 6.1 Scalar switch). Set only by the author config's `nonStandard.deepObjectScalars`;
   * absent is strict, and a scalar is refused.
   */
  readonly scalars?: boolean;
}

/**
 * A query parameter: plain data plus its expansion, which fails with `UsageError` instead of
 * throwing. The expansion is the encoded pairs joined by `&`, or `undefined` when the parameter
 * sends nothing.
 */
export interface QueryParameter {
  readonly expand: Effect.Effect<string | undefined, UsageError>;
  readonly name: string;
  readonly style: QueryStyle | "content" | "querystring";
}

/**
 * Delimiters the style emits as `%20` or `%7C` or leaves unencoded: an item containing one cannot
 * be told apart from the delimiter after expansion. Exploded values repeat the name, so they have
 * none.
 */
const queryDelimiter = (
  style: QueryStyle,
  text: Text,
  options: QueryOptions,
): string | undefined => {
  if (options.explode || text.kind === "primitive") {
    return undefined;
  }

  if (style === "spaceDelimited") {
    return " ";
  }

  if (style === "pipeDelimited") {
    return "|";
  }

  return style === "form" && options.allowReserved ? "," : undefined;
};

/**
 * Under `allowReserved` a percent triplet passes unchanged, so one that spells the joiner is
 * byte-identical to it.
 */
const encodedDelimiters: Partial<Record<QueryStyle, string>> = {
  pipeDelimited: "%7C",
  spaceDelimited: "%20",
};

const bracketInKey = /[[\]]/u;

/**
 * A deepObject member key holding `[` or `]` writes a name whose encoded bracket equals the
 * encoded delimiter, so a single decoding pass cannot tell the key from the path.
 */
const refuseBracketKey = (name: string) =>
  refuse(`parameter ${name} has a member name with [ or ], which deepObject would leave ambiguous`);

const checkQueryDelimiter = (
  name: string,
  style: QueryStyle,
  text: Text,
  options: QueryOptions,
) => {
  if (style === "deepObject" && text.kind === "object") {
    return text.members.some(([member]) => bracketInKey.test(member))
      ? refuseBracketKey(name)
      : Effect.void;
  }

  const banned = queryDelimiter(style, text, options);
  const encoded = options.allowReserved ? encodedDelimiters[style] : undefined;
  const clash =
    banned !== undefined &&
    parts(text).some(
      (part) =>
        part.includes(banned) || (encoded !== undefined && part.toUpperCase().includes(encoded)),
    );

  return clash
    ? refuse(`parameter ${name} holds a character its ${style} expansion would leave ambiguous`)
    : Effect.void;
};

/**
 * How a query string or a form body writes pairs: names, values, and the joiner of each style's
 * non-exploded value. Names are always strictly encoded; `allowReserved` is for values only.
 */
interface PairCodec {
  readonly joiners: Readonly<Record<QueryStyle, string>>;
  readonly name: (text: string) => string;
  readonly value: (text: string) => string;
}

const queryCodec = (allowReserved: boolean): PairCodec => ({
  joiners: { deepObject: ",", form: ",", pipeDelimited: "%7C", spaceDelimited: "%20" },
  name: encodeUnreserved,
  value: encoder(allowReserved, queryReserved),
});

const composePairs = (
  style: QueryStyle,
  name: string,
  raw: Text,
  explode: boolean,
  codec: PairCodec,
): readonly string[] => {
  const key = codec.name(name);
  const text = encodeText(raw, codec.value);

  if (raw.kind === "object" && style === "deepObject") {
    return raw.members.map(
      ([member, memberText]) => `${codec.name(`${name}[${member}]`)}=${codec.value(memberText)}`,
    );
  }

  if (explode && text.kind === "array") {
    return text.items.map((item) => `${key}=${item}`);
  }

  if (explode && raw.kind === "object") {
    return raw.members.map(
      ([member, memberText]) => `${codec.name(member)}=${codec.value(memberText)}`,
    );
  }

  return [`${key}=${flat(text, codec.joiners[style])}`];
};

const isEmptyCompound = (value: Nested) =>
  isNestedList(value) ? value.length === 0 : !isScalar(value) && Object.keys(value).length === 0;

/**
 * Bracket paths stop here (design 6.1): deeper is refused, so the walk is bounded.
 */
const maxBracketDepth = 32;

type Leaf = readonly [keys: readonly string[], text: string];

/**
 * Every leaf below `value` with its path of member names and indexes, in document order. An
 * undefined member is omitted, as in the one-level form; a `null` member, an undefined or `null`
 * item and a lone surrogate are refused. Depth is checked before descending.
 */
const bracketLeaves = (
  name: string,
  value: Nested,
  keys: readonly string[],
): Effect.Effect<readonly Leaf[], UsageError> =>
  Effect.gen(function* bracketWalk() {
    if (keys.length > maxBracketDepth) {
      return yield* refuse(`parameter ${name} nests deeper than ${maxBracketDepth} levels`);
    }

    if (isScalar(value)) {
      return [[keys, yield* itemText(name, value)]];
    }

    const children: readonly (readonly [string, Nested])[] = isNestedList(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value).filter(([, member]) => member !== undefined);
    const leaves: Leaf[] = [];

    for (const [key, child] of children) {
      if (bracketInKey.test(key) && !isNestedList(value)) {
        return yield* refuseBracketKey(name);
      }

      leaves.push(...(yield* bracketLeaves(name, child, [...keys, yield* itemText(name, key)])));
    }

    return leaves;
  });

/**
 * The bracket convention (design 6.1, D-OQ1 (b)): each leaf at path `k1 … kn` becomes
 * `name[k1]…[kn]=v`, the whole name encoded as the one-level form encodes it. `undefined` when the
 * value sends no pair. Two leaves whose names encode alike are refused: a server cannot tell them
 * apart.
 */
const bracketPairs = (
  name: string,
  value: Nested,
  codec: PairCodec,
): Effect.Effect<readonly string[] | undefined, UsageError> =>
  Effect.gen(function* bracketExpansion() {
    if (isScalar(value)) {
      return Predicate.isNullish(value)
        ? undefined
        : yield* refuse(`parameter ${name} is not an object or array, which brackets require`);
    }

    const leaves = yield* bracketLeaves(name, value, []);
    const names = leaves.map(([keys]) =>
      codec.name(`${name}${keys.map((key) => `[${key}]`).join("")}`),
    );

    if (new Set(names).size !== names.length) {
      return yield* refuse(`parameter ${name} sends two leaves with one bracketed name`);
    }

    return leaves.length === 0
      ? undefined
      : leaves.map(([, text], index) => `${names[index]}=${codec.value(text)}`);
  });

/**
 * Whether `deepObject` takes this value through the bracket convention: an object or array under
 * `brackets`, but not a scalar the scalar switch sends as one pair.
 */
const bracketed = (style: QueryStyle, value: Nested, brackets?: boolean, scalars?: boolean) =>
  style === "deepObject" && brackets === true && !(scalars === true && isScalar(value));

/**
 * `deepObject` sends an object, or a scalar when the scalar switch is set.
 */
const deepObjectTakes = (text: Text, scalars?: boolean) =>
  text.kind === "object" || (scalars === true && text.kind === "primitive");

const nothingSent = (
  name: string,
  value: Nested,
  options: QueryOptions,
): Effect.Effect<string | undefined, UsageError> => {
  if (options.allowEmptyValue === true && isEmptyCompound(value)) {
    return Effect.succeed(`${encodeUnreserved(name)}=`);
  }

  return options.required
    ? refuse(`parameter ${name} is required and has no value`)
    : Effect.undefined;
};

const queryStyled =
  (style: QueryStyle) =>
  (name: string, value: Nested, options: QueryOptions): QueryParameter => ({
    expand: Effect.gen(function* queryExpansion() {
      if (unpairedSurrogate.test(name)) {
        return yield* refuse(`parameter ${name} has a name with no UTF-8 form`);
      }

      if (bracketed(style, value, options.brackets, options.scalars)) {
        const pairs = yield* bracketPairs(name, value, queryCodec(options.allowReserved));

        return pairs === undefined ? yield* nothingSent(name, value, options) : pairs.join("&");
      }

      if (!isFlat(value)) {
        return yield* refuse(`parameter ${name} holds a value nested deeper than one level`);
      }

      const text = yield* toText(name, value, false);

      if (text === undefined) {
        return yield* nothingSent(name, value, options);
      }

      if (style === "deepObject" && !deepObjectTakes(text, options.scalars)) {
        return yield* refuse(`parameter ${name} is not an object, which deepObject requires`);
      }

      yield* checkQueryDelimiter(name, style, text, options);

      return composePairs(
        style,
        name,
        text,
        options.explode,
        queryCodec(options.allowReserved),
      ).join("&");
    }),
    name,
    style,
  });

type QueryExpansion = (name: string, value: Nested, options: QueryOptions) => QueryParameter;

/**
 * Query `form`: RFC 6570 `{?name}` and `{?name*}`.
 */
export const form: QueryExpansion = queryStyled("form");

/**
 * Query `spaceDelimited`: a non-exploded list joined by an encoded space.
 */
export const spaceDelimited: QueryExpansion = queryStyled("spaceDelimited");

/**
 * Query `pipeDelimited`: a non-exploded list joined by an encoded pipe.
 */
export const pipeDelimited: QueryExpansion = queryStyled("pipeDelimited");

/**
 * Query `deepObject`: an object with scalar members as `name[key]=value`, brackets encoded.
 * `explode` has no effect. A deeper value is refused unless `brackets` is set; then any object or
 * array is sent in the bracket convention. A scalar is refused unless `scalars` is set; then it is
 * one `name=value` pair.
 */
export const deepObject = queryStyled("deepObject");

export interface HeaderOptions {
  readonly explode: boolean;
  readonly required: boolean;
}

/**
 * A header parameter: plain data plus its expansion, which fails with `UsageError` instead of
 * throwing. The expansion is the value text, or `undefined` when the header sends nothing.
 */
export interface HeaderParameter {
  readonly expand: Effect.Effect<string | undefined, UsageError>;
  readonly name: string;
  readonly style: "content" | "simple";
}

/**
 * RFC 9110 `token`.
 */
const headerToken = /^[\w!#$%&'*+.^`|~-]+$/u;

const headerLineBreak = /[\n\r]/u;

const edgeSpace = /^[\t ]|[\t ]$/u;

/**
 * Any code point above U+00FF: a header field carries one byte per character, so it has no form.
 */
const wideCodePoint = /[\u{100}-\u{10FFFF}]/u;

/**
 * A header value, or a media type that becomes one, that no header can carry unchanged (RFC 9110
 * 5.5): CR, LF, NUL, leading or trailing whitespace and a code point above U+00FF.
 */
const unsafeHeaderText = (text: string) =>
  headerLineBreak.test(text) ||
  text.includes("\u0000") ||
  edgeSpace.test(text) ||
  wideCodePoint.test(text);

const headerTexts = (text: Text): readonly string[] =>
  text.kind === "primitive" ? [text.text] : parts(text);

/**
 * `,` inside an item or member cannot be told from the separator, and `=` inside an exploded
 * object key cannot be told from the pair delimiter, because header text is never percent-encoded.
 */
const headerAmbiguity = (text: Text, explode: boolean): readonly string[] => {
  if (text.kind === "primitive") {
    return [];
  }

  const keys = explode && text.kind === "object" ? text.members.map(([key]) => key) : [];

  return [
    ...parts(text).filter((part) => part.includes(",")),
    ...keys.filter((key) => key.includes("=")),
  ];
};

/**
 * Header `simple` (RFC 6570 `{name}`, `{name*}`) with no percent-encoding in any line.
 */
export const header = (name: string, value: Nested, options: HeaderOptions): HeaderParameter => ({
  expand: Effect.gen(function* headerExpansion() {
    if (!headerToken.test(name)) {
      return yield* refuse("a header parameter has a name that is not an RFC 9110 token");
    }

    const text = yield* toText(name, yield* flatOf(name, value), options.required);

    if (text === undefined) {
      return text;
    }

    if (headerTexts(text).some(unsafeHeaderText)) {
      return yield* refuse(`header ${name} holds a value no header line can carry unchanged`);
    }

    if (headerAmbiguity(text, options.explode).length > 0) {
      return yield* refuse(
        `header ${name} holds a character its simple expansion leaves ambiguous`,
      );
    }

    return compose("simple", name, text, options.explode, (raw) => raw);
  }),
  name,
  style: "simple",
});

export interface CookieOptions {
  readonly allowReserved: boolean;
  readonly explode: boolean;
  /**
   * The OpenAPI line the parameter comes from.
   */
  readonly line: "3.0" | "3.1" | "3.2";
  readonly required: boolean;
  readonly style: "cookie" | "form";
}

/**
 * A cookie parameter: plain data plus its expansion, which fails with `UsageError` instead of
 * throwing. The expansion is the pairs for one `Cookie` header joined by `; `, or `undefined` when
 * the parameter sends nothing.
 */
export interface CookieParameter {
  readonly expand: Effect.Effect<string | undefined, UsageError>;
  readonly name: string;
  readonly style: "content" | "cookie" | "form";
}

/**
 * RFC 6265 `cookie-octet`: `%x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E`.
 */
const cookieOctets = /^[\u0021\u0023-\u002B\u002D-\u003A\u003C-\u005B\u005D-\u007E]*$/u;

/**
 * Reserved characters a 3.2 `form` cookie value may pass under `allowReserved`: RFC 3986 reserved
 * less `,` and `;`, the two reserved characters outside `cookie-octet` (Appendix D.1).
 */
const cookieReserved = ":/?#[]@!$&'()*+=";

const cookieAssignment = (key: string, text: string) => `${key}=${text}`;

const composeCookie = (name: string, text: Text, explode: boolean): string => {
  if (explode && text.kind === "array") {
    return text.items.map((item) => cookieAssignment(name, item)).join("; ");
  }

  if (explode && text.kind === "object") {
    return text.members.map(([key, member]) => cookieAssignment(key, member)).join("; ");
  }

  return cookieAssignment(name, flat(text));
};

/**
 * A cookie parameter. 3.0 and 3.1 `form` and 3.2 `form` encode as RFC 6570 does (only 3.2 honors
 * `allowReserved`), and any array or object is refused, exploded or not (PRM-34, "always
 * incorrect"). 3.2 `cookie` sends the text as given and refuses a value outside `cookie-octet`. 3.2
 * refuses `explode: false`, and `cookie` exists only on 3.2.
 */
export const cookie = (name: string, value: Nested, options: CookieOptions): CookieParameter => ({
  expand: Effect.gen(function* cookieExpansion() {
    if (!headerToken.test(name)) {
      return yield* refuse("a cookie parameter has a name that is not an RFC 6265 token");
    }

    if (options.style === "cookie" && options.line !== "3.2") {
      return yield* refuse(`parameter ${name} uses style cookie, which only 3.2 has`);
    }

    if (options.line === "3.2" && !options.explode) {
      return yield* refuse(`parameter ${name} sets explode false, which 3.2 forbids for a cookie`);
    }

    const text = yield* toText(name, yield* flatOf(name, value), options.required);

    if (text === undefined) {
      return text;
    }

    if (options.style === "cookie") {
      const keys = text.kind === "object" ? text.members.map(([key]) => key) : [];

      if (keys.some((key) => !headerToken.test(key))) {
        return yield* refuse(`parameter ${name} holds a member name that is not an RFC 6265 token`);
      }

      if (headerTexts(text).some((part) => !cookieOctets.test(part))) {
        return yield* refuse(`parameter ${name} holds a character outside RFC 6265 cookie-octet`);
      }

      return composeCookie(name, text, options.explode);
    }

    if (text.kind !== "primitive") {
      return yield* refuse(
        `parameter ${name} is an array or object, which a form cookie cannot carry (OAS Appendix D)`,
      );
    }

    return composeCookie(
      name,
      encodeText(text, encoder(options.line === "3.2" && options.allowReserved, cookieReserved)),
      options.explode,
    );
  }),
  name,
  style: options.style,
});

/**
 * A JSON value. A `JsonNumber` is a number kept as its digit text, which every encoder writes
 * unchanged.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | JsonNumber
  | readonly Json[]
  | { readonly [member: string]: Json };

/**
 * A request body: a JSON or text value, or a binary stream that is already an `HttpBody` (a
 * `FileBody` file or stdin).
 */
export type Body = Json | HttpBody.HttpBody;

/**
 * A request body and its media type: plain data plus its evaluation, which fails with `UsageError`
 * instead of throwing. `ownsContentType` marks a body whose own `Content-Type` is sent instead of
 * `mediaType`: a multipart body's carries the boundary its writer chose.
 */
export interface RequestBody {
  readonly expand: Effect.Effect<HttpBody.HttpBody, UsageError>;
  readonly mediaType: string;
  readonly ownsContentType?: true;
}

/**
 * Whether `mediaType` is JSON media: `application/json` or a `+json` suffix, parameters and case
 * ignored. A body or `content` value under it is written as JSON text.
 */
export const isJsonMedia = (mediaType: string): boolean => {
  const essence = (mediaType.split(";")[0] ?? "").trim().toLowerCase();

  return essence === "application/json" || essence.endsWith("+json");
};

/**
 * Whether `value` holds a number `JSON.stringify` cannot write as given: a non-finite number, which
 * it turns into `null`, or a `JsonNumber` whose text is not a JSON number.
 */
const hasUnwritableNumber = (value: Json): boolean => {
  if (value instanceof JsonNumber) {
    return !isJsonNumberText(value.text);
  }

  if (Predicate.isNumber(value)) {
    return !Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.some((item: Json) => hasUnwritableNumber(item));
  }

  return (
    Predicate.isObject(value) && Object.values(value).some((member) => hasUnwritableNumber(member))
  );
};

const rawNumbers = (_key: string, value: Json): Json | RawJson =>
  value instanceof JsonNumber ? rawJson(value.text) : value;

/**
 * Compact JSON text from `JSON.stringify`, with a `JsonNumber` written as its digit text through
 * `JSON.rawJSON`. `subject` names the body, parameter or property in a refusal.
 */
const jsonText = (subject: string, value: Json) => {
  const unwritable = `${subject} holds a number with no JSON text form`;

  // The walk leaves `JSON.rawJSON` no text to refuse; a SyntaxError from it is a refusal all the same.
  return hasUnwritableNumber(value)
    ? refuse(unwritable)
    : Effect.sync(() => JSON.stringify(value, rawNumbers)).pipe(
        Effect.catchDefect((defect) =>
          defect instanceof SyntaxError ? refuse(unwritable) : Effect.die(defect),
        ),
      );
};

const bodyOf = (mediaType: string, value: Body) =>
  Effect.gen(function* bodyEvaluation() {
    if (mediaType === "" || unsafeHeaderText(mediaType)) {
      return yield* refuse("the request media type is not a valid header value");
    }

    if (HttpBody.isHttpBody(value)) {
      return value;
    }

    if (isJsonMedia(mediaType)) {
      return HttpBody.text(yield* jsonText("the body", value), mediaType);
    }

    if (!Predicate.isString(value)) {
      return yield* refuse("a body for a non-JSON media type must be text or a binary stream");
    }

    if (unpairedSurrogate.test(value)) {
      return yield* refuse("the body holds an unpaired surrogate, which has no UTF-8 form");
    }

    return HttpBody.text(value, mediaType);
  });

/**
 * The body for `mediaType`. `Content-Type` is set from `mediaType` by `request` and nowhere else.
 */
export const body = (mediaType: string, value: Body): RequestBody => ({
  expand: bodyOf(mediaType, value),
  mediaType,
});

export type { Chosen, SentType } from "./input.ts";

/**
 * The encoders of a body with several media alternatives, one per declared key: each takes the
 * key's body value and the `Content-Type` it sends, and returns that key's `RequestBody` (`body`,
 * `urlEncoded` or `formData`).
 */
export type Alternatives<V> = {
  readonly [P in keyof V & string]: (body: V[P], contentType: SentType<P>) => RequestBody;
};

/**
 * The `RequestBody` of the alternative `Input.selectBody` already chose: the table's encoder for
 * `chosen.key`. It selects nothing and has no default of its own. A multipart entry keeps
 * `formData`'s `ownsContentType`, so `request` sends the writer's boundary.
 */
export const alternatives = <V>(chosen: Chosen<V>, table: Alternatives<V>): RequestBody =>
  table[chosen.key](chosen.body, chosen.contentType);

/**
 * A file part's bytes and the filename its `Content-Disposition` carries.
 */
export interface FormFile {
  readonly filename: string;
  readonly stream: Stream.Stream<Uint8Array, unknown>;
}

/**
 * An object part's value (ENC-22): one decoded JSON value, written as compact JSON under the
 * part's `contentType`.
 */
export interface FormJson {
  readonly json: Json;
}

/**
 * A JSON flag's value as an object part's value.
 */
export const jsonPart = (json: Json): FormJson => ({ json });

/**
 * A by-name nested part's value (design 6.3, HT:B16): its nested parts' values by nested part name.
 */
export interface FormNested {
  readonly nested: FormFields;
}

/**
 * One `multipart/form-data` part value: a scalar sent as its text (an `int64` field as its digit
 * text), a JSON value, a file, or a by-name nested part's values.
 */
export type FormValue =
  | string
  | number
  | boolean
  | { readonly text: string }
  | FormJson
  | FormFile
  | FormNested;

/**
 * A part value the writer sends as one leaf part.
 */
type LeafValue = Exclude<FormValue, FormNested>;

/**
 * The part values of a `multipart/form-data` body by part name, each name sent once per value.
 */
export type FormFields = Readonly<Record<string, readonly FormValue[]>>;

/**
 * A part that travels whole beside the form's fields: its `Content-Type`, chosen among the types
 * its Encoding `contentType` lists (design 6.3, ENC-10) or the one it lists, its values, and its
 * declared headers (ENC-03, HDR-01), each a header parameter, sent together or not at all. Every
 * value of the part carries the same header lines; a header whose expansion is `undefined` is not
 * written.
 */
export interface ChosenPart<T extends string = string> {
  readonly contentType: T;
  readonly headers?: readonly HeaderParameter[];
  readonly values: readonly FormValue[];
}

/**
 * The one nested level of a part by name (design 6.3, HT:B16, ENC-07): the nested body's kind,
 * from the part's Encoding `contentType`, and each nested part's name and `Content-Type` in nested
 * property order. Under `mixed` the nested names are not written.
 */
export interface NestedForm {
  readonly kind: "form-data" | "mixed";
  readonly parts: readonly (readonly [name: string, contentType: string])[];
}

/**
 * The one nested level of a part by position (design 6.3, HT:B16, ENC-08, ENC-09): one
 * `multipart/mixed` nested part from the files of the part's repeated file flag `flag`, in order,
 * file `i` under `positions[i]` and every later file under `item`. With no `item` a file beyond
 * the positions has no rule.
 */
export interface PositionalForm {
  readonly flag: string;
  readonly item?: string;
  readonly kind: "mixed";
  readonly positions: readonly string[];
}

/**
 * One declared part: its name, its `Content-Type` and, when the part is sent base64 encoded, its
 * transfer encoding (design 6.3 Multipart transfer encoding). The writer then encodes the part's
 * bytes and writes the one `Content-Transfer-Encoding` header. A string is the one type the
 * Encoding `contentType` lists, and the part's values are the fields under its name. A `NestedForm`
 * sends the part as one nested part from the `FormNested` values under its name, and a
 * `PositionalForm` as one nested part from the files under its name. A `ChosenPart` brings its own
 * type, values and headers, and `undefined` is a keyed part not sent; the fields hold neither name.
 */
export type FormPartEntry = readonly [
  name: string,
  contentType: string | ChosenPart | NestedForm | PositionalForm | undefined,
  contentEncoding?: "base64",
];

/**
 * A by-name nested part's values as its part's values: one `FormNested`, or none when no nested
 * part has a value, so the part is not sent.
 */
export const nestedValues = (fields: FormFields): readonly FormValue[] =>
  Object.values(fields).some((values) => values.length > 0) ? [{ nested: fields }] : [];

/**
 * The declared parts in wire order.
 */
export interface FormDataOptions {
  readonly parts: readonly FormPartEntry[];
  readonly required: boolean;
}

const isFormFile = (value: FormValue): value is FormFile =>
  Predicate.isObject(value) && "stream" in value;

const isFormJson = (value: FormValue): value is FormJson =>
  Predicate.isObject(value) && "json" in value;

const isFormNested = (value: FormValue): value is FormNested =>
  Predicate.isObject(value) && "nested" in value;

const isNestedForm = (sent: FormPartEntry[1]): sent is NestedForm =>
  Predicate.isObject(sent) && "parts" in sent;

const isPositionalForm = (sent: FormPartEntry[1]): sent is PositionalForm =>
  Predicate.isObject(sent) && "positions" in sent;

const formText = (value: Exclude<LeafValue, FormFile>) => {
  if (isFormJson(value)) {
    return jsonText("a multipart part", value.json);
  }

  if (Predicate.isObject(value)) {
    return Effect.succeed(value.text);
  }

  if (Predicate.isNumber(value) && !Number.isFinite(value)) {
    return refuse("a multipart part holds a number with no text form");
  }

  if (Predicate.isString(value) && unpairedSurrogate.test(value)) {
    return refuse("a multipart part holds an unpaired surrogate, which has no UTF-8 form");
  }

  return Effect.succeed(String(value));
};

const utf8 = new TextEncoder();

// What one part entry sends: a declared type with the fields' values under the part's name, a
// chosen part as given, or nothing for a chosen part not sent.
const sentPart = (
  fields: FormFields,
  name: string,
  sent: Exclude<FormPartEntry[1], NestedForm | PositionalForm>,
): ChosenPart | undefined =>
  Predicate.isString(sent)
    ? { contentType: sent, values: Object.hasOwn(fields, name) ? (fields[name] ?? []) : [] }
    : sent;

type HeaderLine = readonly [name: string, value: string];

// The header lines of a sent part: each header parameter's expansion, in order, left out when it
// sends nothing.
const headerLines = (headers: readonly HeaderParameter[] | undefined) =>
  Effect.gen(function* lines() {
    const written: HeaderLine[] = [];
    for (const parameter of headers ?? []) {
      const text = yield* parameter.expand;
      if (text !== undefined) {
        written.push([parameter.name, text]);
      }
    }

    return written;
  });

// One value's part. A part entry's `contentEncoding` reaches the writer, which encodes the bytes,
// and the part's header lines reach the writer's part head.
const formPart = (
  [name, , contentEncoding]: FormPartEntry,
  contentType: string,
  headers: readonly HeaderLine[],
  value: LeafValue,
) => {
  const encoded = (part: Multipart.LeafPart): Multipart.LeafPart => {
    const withHeaders = headers.length === 0 ? part : { ...part, headers };

    return contentEncoding === undefined ? withHeaders : { ...withHeaders, contentEncoding };
  };

  return isFormFile(value)
    ? Effect.succeed(encoded({ body: value.stream, contentType, filename: value.filename, name }))
    : Effect.map(formText(value), (text) =>
        encoded({ body: utf8.encode(text), contentType, name }),
      );
};

// A by-name nested part (design 6.3, HT:B16): each nested part's values in nested property order,
// each under its own rule. The writer's one nesting level holds leaf parts only.
const nestedPart = (name: string, nesting: NestedForm, fields: FormFields) =>
  Effect.gen(function* nested() {
    const declared = new Set(nesting.parts.map(([member]) => member));
    if (Object.keys(fields).some((member) => !declared.has(member))) {
      return yield* Effect.die(new Error("formData: a nested field has no declared part"));
    }

    const leaves: Multipart.LeafPart[] = [];
    for (const entry of nesting.parts) {
      const [member, contentType] = entry;
      for (const value of Object.hasOwn(fields, member) ? (fields[member] ?? []) : []) {
        if (isFormNested(value)) {
          return yield* Effect.die(new Error("formData: a nested part nests again"));
        }

        leaves.push(yield* formPart(entry, contentType, [], value));
      }
    }

    return { kind: nesting.kind, name, parts: leaves } satisfies Multipart.NestedPart;
  });

// A part nested by position (design 6.3, HT:B16): the part's files in order, file `i` under
// `positions[i]` and later files under `item`, as one `multipart/mixed` nested part with no
// nested names, or nothing when no file is given. A file beyond the positions with no item rule is
// a `UsageError` naming the flag.
const positionalParts = (fields: FormFields, name: string, nesting: PositionalForm) =>
  Effect.gen(function* positional() {
    const values = Object.hasOwn(fields, name) ? (fields[name] ?? []) : [];
    if (values.length === 0) {
      return [];
    }

    const ruled = nesting.item === undefined ? nesting.positions.length : Infinity;
    if (values.length > ruled) {
      return yield* Effect.fail(
        new UsageError({
          flag: nesting.flag,
          message: `--${nesting.flag}: this part takes at most ${String(ruled)} file${ruled === 1 ? "" : "s"}`,
        }),
      );
    }

    const leaves: Multipart.LeafPart[] = [];
    for (const [index, value] of values.entries()) {
      const contentType = nesting.positions[index] ?? nesting.item;
      if (!isFormFile(value) || contentType === undefined) {
        return yield* Effect.die(new Error("formData: a positional nested part holds a non-file"));
      }

      leaves.push({ body: value.stream, contentType });
    }

    return [{ kind: nesting.kind, name, parts: leaves } satisfies Multipart.NestedPart];
  });

const formDataOf = (fields: FormFields, options: FormDataOptions) =>
  Effect.gen(function* formDataEvaluation() {
    const declared = new Set(options.parts.map(([name]) => name));
    if (Object.keys(fields).some((name) => !declared.has(name))) {
      return yield* Effect.die(new Error("formData: a field has no declared part"));
    }

    const sent: Multipart.Part[] = [];
    for (const entry of options.parts) {
      const [name, rule] = entry;
      if (isPositionalForm(rule)) {
        sent.push(...(yield* positionalParts(fields, name, rule)));
        continue;
      }

      if (isNestedForm(rule)) {
        const values = Object.hasOwn(fields, name) ? (fields[name] ?? []) : [];
        for (const value of values) {
          if (!isFormNested(value)) {
            return yield* Effect.die(new Error("formData: a nested part has a plain value"));
          }

          const nested = yield* nestedPart(name, rule, value.nested);
          if (nested.parts.length > 0) {
            sent.push(nested);
          }
        }

        continue;
      }

      if (!Predicate.isString(rule) && Object.hasOwn(fields, name)) {
        return yield* Effect.die(new Error("formData: a chosen part is also a field"));
      }

      const part = sentPart(fields, name, rule);
      if (part === undefined) {
        continue;
      }

      const headers = part.values.length === 0 ? [] : yield* headerLines(part.headers);
      for (const value of part.values) {
        if (isFormNested(value)) {
          return yield* Effect.die(new Error("formData: a nested value under a plain part"));
        }

        sent.push(yield* formPart(entry, part.contentType, headers, value));
      }
    }

    if (sent.length === 0 && !options.required) {
      return HttpBody.empty;
    }

    return yield* Multipart.formData(sent);
  });

/**
 * Each declared part's flag by part name, and the parts that repeat (an array property, one value
 * per item).
 */
export interface FormPartFlags {
  readonly flags: Readonly<Record<string, string>>;
  readonly repeated: readonly string[];
}

/**
 * What `assertFormData` reads beside the part values: the parts' flags, each by-name nested part's
 * own part flags (design 6.3, HT:B16), whose entry in `flags` is its first nested flag, whether the
 * body is required, and its schema.
 */
export interface FormSchemaOptions extends FormPartFlags {
  readonly nested?: Readonly<Record<string, FormPartFlags>>;
  readonly required: boolean;
  readonly schema: Schema.Top;
}

// A JSON value as `JSON.parse` reads its text back: a `JsonNumber` as its number.
const parsedJson = (value: Json): Schema.Json => {
  if (value instanceof JsonNumber) {
    return Number(value.text);
  }

  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item: Json) => parsedJson(item));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [key, parsedJson(member)]),
  );
};

// A part value as the body schema reads it: a scalar as itself, an `int64` digit text as its
// number and a JSON part as its parsed value, as a merged JSON body is asserted. A file is a
// stand-in whose issues are never reported.
const assertedValue = (value: LeafValue): Schema.Json => {
  if (isFormFile(value)) {
    return "";
  }

  if (isFormJson(value)) {
    return parsedJson(value.json);
  }

  return Predicate.isObject(value) ? Number(value.text) : value;
};

const standardIssues = SchemaIssue.makeFormatterStandardSchemaV1();

// A part's path: its name, and a nested part's nested name after it, as one key.
const partPath = (...names: readonly string[]): string => JSON.stringify(names);

interface Asserted {
  readonly files: Set<string>;
  readonly sent: Set<string>;
}

// The values of one form level as the body schema reads them: each part's first value, every value
// of a repeated part, and a by-name nested part's values as its object. The paths of the parts
// given and of the file parts are gathered into `seen`.
const assertedObject = (
  fields: FormFields,
  options: FormPartFlags & { readonly nested?: FormSchemaOptions["nested"] },
  seen: Asserted,
  ...at: readonly string[]
): { readonly [name: string]: Schema.Json } => {
  const repeated = new Set(options.repeated);
  const entries: (readonly [string, Schema.Json])[] = [];
  for (const [name, values] of Object.entries(fields)) {
    const [first] = values;
    if (first === undefined) {
      continue;
    }

    const slot = partPath(...at, name);
    seen.sent.add(slot);
    if (isFormNested(first)) {
      const members = options.nested?.[name] ?? { flags: {}, repeated: [] };
      entries.push([name, assertedObject(first.nested, members, seen, ...at, name)]);
      continue;
    }

    const leaves = values.filter((value): value is LeafValue => !isFormNested(value));
    if (leaves.some(isFormFile)) {
      seen.files.add(slot);
    }

    entries.push([name, repeated.has(name) ? leaves.map(assertedValue) : assertedValue(first)]);
  }

  return Object.fromEntries(entries);
};

type PathSegment = PropertyKey | { readonly key: PropertyKey };

// An issue path segment's name, if it is a string key.
const segmentName = (segment: PathSegment | undefined): string | undefined => {
  const key = Predicate.isObject(segment) ? segment.key : segment;

  return Predicate.isString(key) ? key : undefined;
};

// The path of the part an issue is under: its first segment, if that is a part name, and for a
// by-name nested part the nested name after it.
const issuePath = (
  issue: { readonly path?: readonly PathSegment[] | undefined },
  nested: ReadonlySet<string>,
): string | undefined => {
  const [head, inner] = issue.path ?? [];
  const name = segmentName(head);
  const member = segmentName(inner);
  if (name === undefined) {
    return undefined;
  }

  return nested.has(name) && member !== undefined ? partPath(name, member) : partPath(name);
};

// The first failing part's flag and path in declared order, a nested part's nested flags before
// its own.
const failingFlag = (options: FormSchemaOptions, failing: ReadonlySet<string | undefined>) =>
  Object.entries(options.flags)
    .flatMap(([name, flag]) => [
      ...Object.entries(options.nested?.[name]?.flags ?? {}).map(([member, memberFlag]) => ({
        flag: memberFlag,
        slot: partPath(name, member),
      })),
      { flag, slot: partPath(name) },
    ])
    .find(({ slot }) => failing.has(slot));

/**
 * The part values asserted against the body's schema before any request (design 4.5, C2): text
 * parts as their typed values, each supplied file part for presence only, never its content (the
 * files of a part nested by position among them), and a by-name nested part as its object (HT:B16).
 * A failure is a `UsageError` naming the first failing part's flag in declared order, a nested
 * part's dotted flag for its nested parts, never a value. An optional body with no value is not
 * asserted; a required one is asserted as `{}`, so a missing required part fails. The values pass
 * through unchanged.
 */
export const assertFormData =
  (options: FormSchemaOptions) =>
  (fields: FormFields): Effect.Effect<FormFields, UsageError> =>
    Effect.gen(function* assertion() {
      const seen: Asserted = { files: new Set(), sent: new Set() };
      const value = assertedObject(fields, options, seen);
      if (seen.sent.size === 0 && !options.required) {
        return fields;
      }

      const checked = SchemaParser.decodeUnknownResult(Schema.toType(options.schema))(value, {
        errors: "all",
      });
      if (Result.isSuccess(checked)) {
        return fields;
      }

      const nested = new Set(Object.keys(options.nested ?? {}));
      const failing = new Set(
        standardIssues(checked.failure)
          .issues.map((issue) => issuePath(issue, nested))
          .filter((slot) => slot === undefined || !seen.files.has(slot)),
      );
      if (failing.size === 0) {
        return fields;
      }

      const named = failingFlag(options, failing);
      if (named === undefined) {
        return yield* refuse("the multipart parts do not match the request body schema");
      }

      return yield* Effect.fail(
        new UsageError({
          flag: named.flag,
          message: seen.sent.has(named.slot)
            ? `--${named.flag}: does not match the request body schema`
            : `--${named.flag}: this request needs it`,
        }),
      );
    });

/**
 * The keyed parts of a form, by their key in the `api/` builder's form (ENC-10, ENC-03): each
 * part's name, its `Content-Type` (the operator's choice, if any, or the one type it lists) and its
 * header parameters.
 */
export type PartChoices = Readonly<
  Record<
    string,
    readonly [
      part: string,
      contentType: Option.Option<string> | string,
      headers?: readonly HeaderParameter[],
    ]
  >
>;

/**
 * The content type a keyed part entry gives: the chosen type, or the one type listed.
 */
export type PartChoiceType<X> =
  X extends Option.Option<infer T> ? Extract<T, string> : Extract<X, string>;

/**
 * A form as the `api/` builder takes it: the declared parts' values under `fields`, and each keyed
 * part under its key, absent when it is not sent.
 */
export type ChosenForm<C extends PartChoices> = { readonly fields: FormFields } & {
  readonly [K in keyof C]?: ChosenPart<PartChoiceType<C[K][1]>> | undefined;
};

/**
 * Splits asserted part values for the `api/` builder (ENC-10, ENC-03): each keyed part's values
 * leave the fields and travel with its type and header parameters, and a part with no value is left
 * out with its headers. `Input.partOptions` has already refused a sent part with no type and a
 * header flag without its part, so meeting a sent part with no type here is a defect.
 */
export const chooseParts =
  <const C extends PartChoices>(choices: C) =>
  (fields: FormFields): Effect.Effect<ChosenForm<C>> =>
    Effect.gen(function* choose() {
      const named = new Set(Object.values(choices).map(([part]) => part));
      const chosen: (readonly [string, ChosenPart])[] = [];
      for (const [key, [part, contentType, headers]] of Object.entries(choices)) {
        const values = Object.hasOwn(fields, part) ? (fields[part] ?? []) : [];
        if (values.length === 0) {
          continue;
        }

        const type = Predicate.isString(contentType)
          ? contentType
          : Option.getOrUndefined(contentType);
        if (type === undefined) {
          return yield* Effect.die(new Error("chooseParts: a sent part has no content type"));
        }

        chosen.push([
          key,
          headers === undefined || headers.length === 0
            ? { contentType: type, values }
            : { contentType: type, headers, values },
        ]);
      }

      const split = {
        ...Object.fromEntries(chosen),
        fields: Object.fromEntries(Object.entries(fields).filter(([name]) => !named.has(name))),
      };

      // SAFETY: each keyed key is a key of `choices` whose type is the one it gave, and the
      // generated keys are never `fields`, so `split` holds `fields` and optional keyed parts only.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `fields` and one optional keyed part per key of `choices`, as `ChosenForm` reads them
      return split as ChosenForm<C>;
    });

/**
 * A `multipart/form-data` body streamed through the multipart writer (design 6.3): one part per
 * value, in the declared part order, each with its declared or chosen `Content-Type` and a keyed
 * part's header lines, and a part entry's `contentEncoding` base64-encodes each of its values. With
 * no value a required body is the close delimiter alone and an optional one is empty. `request`
 * sends the writer's `Content-Type`, which carries its boundary.
 */
export const formData = (fields: FormFields, options: FormDataOptions): RequestBody => ({
  expand: formDataOf(fields, options),
  mediaType: "multipart/form-data",
  ownsContentType: true,
});

/**
 * The part bodies of a 3.2 positional `multipart/mixed` body, in the order the operator gave them.
 */
export type MixedParts = readonly Multipart.LeafPart["body"][];

/**
 * The rules of a positional body (design 6.3, HT:B15): part `i` takes `prefixEncoding[i]` and every
 * later part `itemEncoding`. `maxParts` and `minParts` are the schema's bounds on the part count.
 */
export interface MixedOptions {
  readonly itemEncoding?: Multipart.PartEncoding;
  readonly maxParts?: number;
  readonly minParts?: number;
  readonly prefixEncoding: readonly Multipart.PartEncoding[];
  readonly required: boolean;
}

// The one flag a positional body's parts come from (the names plan never renames it).
const partFlag = "part";

const partCount = (count: number) => `${count} part${count === 1 ? "" : "s"}`;

const partCountError = (bound: string) =>
  new UsageError({ flag: partFlag, message: `--${partFlag}: this body takes ${bound}` });

const mixedOf = (bodies: MixedParts, options: MixedOptions) =>
  Effect.gen(function* mixedEvaluation() {
    if (bodies.length === 0 && !options.required) {
      return HttpBody.empty;
    }

    // With no item rule a part beyond the position rules has no rule to be sent under.
    const ruled = options.itemEncoding === undefined ? options.prefixEncoding.length : Infinity;
    const most = Math.min(ruled, options.maxParts ?? Infinity);
    if (bodies.length > most) {
      return yield* Effect.fail(partCountError(`at most ${partCount(most)}`));
    }

    const least = options.minParts ?? 0;
    if (bodies.length < least) {
      return yield* Effect.fail(partCountError(`at least ${partCount(least)}`));
    }

    return yield* Multipart.mixed(Multipart.positionalParts(bodies, options));
  });

/**
 * A 3.2 positional `multipart/mixed` body streamed through the multipart writer (design 6.3,
 * HT:B15): each part's raw bytes in the given order, part `i` under `prefixEncoding[i]` and later
 * parts under `itemEncoding`, with no `Content-Disposition`; `prefixEncoding` entries beyond the
 * parts are unused (MED-15). More parts than rules, or a count outside `minParts` and `maxParts`,
 * is a `UsageError` naming `--part` before any request. With no part a required body is the close
 * delimiter alone and an optional one is empty. `request` sends the writer's `Content-Type`.
 */
export const mixed = (bodies: MixedParts, options: MixedOptions): RequestBody => ({
  expand: mixedOf(bodies, options),
  mediaType: "multipart/mixed",
  ownsContentType: true,
});

/**
 * An Encoding Object's RFC 6570 fields for one form-urlencoded property. With none of the three the
 * property is encoded by its default `contentType` (design 6.3).
 */
export interface FormEncoding {
  readonly allowReserved?: boolean;
  /**
   * With `style: deepObject` only: the bracket convention, as `QueryOptions.brackets`.
   */
  readonly brackets?: boolean;
  readonly explode?: boolean;
  /**
   * With `style: deepObject` only: a scalar as one pair, as `QueryOptions.scalars`.
   */
  readonly scalars?: boolean;
  readonly style?: QueryStyle;
}

/**
 * The declared properties of a form-urlencoded body in document order, each with its Encoding
 * Object fields.
 */
export interface UrlEncodedOptions {
  readonly properties: readonly (readonly [name: string, encoding: FormEncoding])[];
}

interface JsonObject {
  readonly [member: string]: Json;
}

const isJsonObject = (value: Json): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value) && !(value instanceof JsonNumber);

const isJsonScalar = (value: Json): value is Exclude<Json, object> | JsonNumber =>
  value instanceof JsonNumber || (!Predicate.isObject(value) && !Array.isArray(value));

/**
 * Whether a string, member name or item anywhere in `value` holds a lone surrogate.
 */
const hasLoneSurrogate = (value: Json): boolean => {
  if (Predicate.isString(value)) {
    return unpairedSurrogate.test(value);
  }

  if (Array.isArray(value)) {
    return value.some((item: Json) => hasLoneSurrogate(item));
  }

  return (
    isJsonObject(value) &&
    Object.entries(value).some(
      ([member, text]) => unpairedSurrogate.test(member) || hasLoneSurrogate(text),
    )
  );
};

const formSafe = /^[\w*.-]$/u;

/**
 * The WHATWG `application/x-www-form-urlencoded` serializer for one name or value: ASCII
 * alphanumerics and `*-._` pass, a space becomes `+`, every other UTF-8 byte is percent-encoded.
 * Under `allowReserved` the form's reserved set and percent triplets also pass, so `&`, `=`, `+`
 * and `#` stay encoded.
 */
const formEncoder = (allowReserved: boolean) => (text: string) =>
  text.replaceAll(/%[0-9A-Fa-f]{2}|[\S\s]/gu, (token) => {
    if (token === " ") {
      return "+";
    }

    if (formSafe.test(token)) {
      return token;
    }

    if (allowReserved && (percentTriplet.test(token) || formReserved.includes(token))) {
      return token;
    }

    return token === "~" ? "%7E" : encodeUnreserved(token);
  });

const formCodec = (allowReserved: boolean): PairCodec => ({
  joiners: { deepObject: ",", form: ",", pipeDelimited: "%7C", spaceDelimited: "+" },
  name: formEncoder(false),
  value: formEncoder(allowReserved),
});

const hasStyle = (encoding: FormEncoding) =>
  encoding.style !== undefined ||
  encoding.explode !== undefined ||
  encoding.allowReserved !== undefined;

/**
 * The pairs one property sends. `members` marks pairs named by the value's members (an exploded
 * object or `deepObject`) rather than by the property itself.
 */
interface PropertyPairs {
  readonly members: boolean;
  readonly pairs: readonly string[];
}

const noPairs: PropertyPairs = { members: false, pairs: [] };

/**
 * RFC 6570 expansion with percent-encoding disabled decides delimiters, explode and value text; the
 * form encoder then encodes each name and value once. Missing fields take the query defaults.
 */
const styledPairs = (
  name: string,
  value: Json,
  encoding: FormEncoding,
): Effect.Effect<PropertyPairs, UsageError> =>
  Effect.gen(function* styledExpansion() {
    const style = encoding.style ?? "form";
    const options = {
      allowReserved: encoding.allowReserved ?? false,
      explode: encoding.explode ?? style === "form",
    };

    if (bracketed(style, value, encoding.brackets, encoding.scalars)) {
      const pairs = yield* bracketPairs(name, value, formCodec(options.allowReserved));

      return pairs === undefined ? noPairs : { members: true, pairs };
    }

    if (!isFlat(value)) {
      return yield* refuse(`property ${name} holds a value nested deeper than one level`);
    }

    const text = yield* toText(name, value, false);

    if (text === undefined) {
      return noPairs;
    }

    if (style === "deepObject" && !deepObjectTakes(text, encoding.scalars)) {
      return yield* refuse(`property ${name} is not an object, which deepObject requires`);
    }

    yield* checkQueryDelimiter(name, style, text, { ...options, required: false });

    return {
      members: text.kind === "object" && (style === "deepObject" || options.explode),
      pairs: composePairs(style, name, text, options.explode, formCodec(options.allowReserved)),
    };
  });

/**
 * The default `contentType` table: an object or an array item that is an array as compact JSON, a
 * scalar as its text. An array repeats the name, one pair per item; `null` is omitted. A lone
 * surrogate anywhere in the value is refused, not sent as a JSON escape.
 */
const contentPairs = (name: string, value: Json): Effect.Effect<PropertyPairs, UsageError> =>
  Effect.gen(function* contentExpansion() {
    if (value === null) {
      return noPairs;
    }

    if (hasLoneSurrogate(value)) {
      return yield* refuse(`property ${name} holds an unpaired surrogate, which has no UTF-8 form`);
    }

    const items: readonly Json[] = Array.isArray(value) ? value : [value];
    const encode = formEncoder(false);
    const pairs: string[] = [];

    for (const item of items) {
      const text = isJsonScalar(item)
        ? yield* itemText(name, item)
        : yield* jsonText(`property ${name}`, item);

      pairs.push(`${encode(name)}=${encode(text)}`);
    }

    return { members: false, pairs };
  });

/**
 * The `application/x-www-form-urlencoded` text of an object (design 6.3): the pairs of each
 * declared property in document order, joined by `&`. A property with Encoding `style`, `explode`
 * or `allowReserved` is expanded as a query parameter is; one with none of them by its default
 * `contentType`. Binary reaches a form only as text already encoded by its `contentEncoding`. A
 * key the form does not declare follows the declared ones in input order, by the default
 * `contentType` rules (design 4.5).
 *
 * A server cannot tell two sources of one pair name apart, so a pair name sent by two properties,
 * or a member-named pair (an exploded object or `deepObject`) named like any declared property, is
 * refused, naming the property that sent it last (design 4.5, SM-9). One property repeating its own
 * name, as an array does, is sent.
 */
export const urlEncode = (
  value: JsonObject,
  options: UrlEncodedOptions,
): Effect.Effect<string, UsageError> =>
  Effect.gen(function* formExpansion() {
    const declared = new Set(options.properties.map(([name]) => name));
    const undeclared = Object.keys(value)
      .filter((name) => !declared.has(name))
      .map((name) => [name, {}] as const);
    const encodeName = formEncoder(false);
    const declaredNames = new Set([...declared].map(encodeName));
    const senders = new Map<string, string>();
    const pairs: string[] = [];

    for (const [name, encoding] of [...options.properties, ...undeclared]) {
      const property = Object.hasOwn(value, name) ? value[name] : undefined;

      if (property === undefined) {
        continue;
      }

      if (unpairedSurrogate.test(name)) {
        return yield* refuse("a form property has a name with no UTF-8 form");
      }

      const sent = hasStyle(encoding)
        ? yield* styledPairs(name, property, encoding)
        : yield* contentPairs(name, property);

      for (const pair of sent.pairs) {
        // An encoded name holds no `=`, so the first one ends it.
        const pairName = pair.slice(0, pair.indexOf("="));
        const sender = senders.get(pairName);

        if (
          (sender !== undefined && sender !== name) ||
          (sent.members && declaredNames.has(pairName))
        ) {
          return yield* refuse(
            `property ${name} sends a pair named like another property's, which a server cannot tell apart`,
          );
        }

        senders.set(pairName, name);
      }

      pairs.push(...sent.pairs);
    }

    return pairs.join("&");
  });

/**
 * A form body's options: its declared properties, whether it is required, and the operation's
 * refused fields keyed by request media type, the `refused` list of its `MediaDeclaration`.
 */
export interface UrlEncodedBodyOptions extends UrlEncodedOptions {
  readonly refused?: MediaDeclaration["refused"];
  readonly required: boolean;
}

/**
 * The properties refused at `field` scope under `mediaType`, from the operation's `refused` list.
 */
const refusedNamesOf = (
  mediaType: string,
  refused: MediaDeclaration["refused"],
): readonly string[] => {
  const listed = refused !== undefined && Object.hasOwn(refused, mediaType);

  return (listed ? refused[mediaType] : undefined) ?? [];
};

/**
 * Whether a sent pair name carries `field`: the name itself, or a bracketed or dotted name under
 * it, as a server reading brackets or dots would nest it.
 */
const carries = (field: string, pairName: string): boolean =>
  pairName === field || pairName.startsWith(`${field}[`) || pairName.startsWith(`${field}.`);

// A refused field has no flag, so only the whole body can carry it; the name is the field's,
// never its value.
const refuseField = (field: string, mediaType: string): Refusal =>
  Effect.fail(
    new UsageError({
      flag: "--body",
      message: `property ${field} is refused for ${mediaType} and cannot be set through --body or --body-file`,
    }),
  );

/**
 * The form text of `value`, refusing a refused field however it would be sent (design 4.5
 * Refused body fields, 8.5): an own key of the merged body named like one, even one that sends no
 * pair, and any pair the text carries, decoded as a server decodes it, whose name carries one. A
 * pair named exactly like a declared property that is not refused is that property's own.
 */
const guardedText = (value: JsonObject, mediaType: string, options: UrlEncodedBodyOptions) =>
  Effect.gen(function* refusedFieldGuard() {
    const names = refusedNamesOf(mediaType, options.refused);
    const ownKey = Object.keys(value).find((key) => names.includes(key));
    if (ownKey !== undefined) {
      return yield* refuseField(ownKey, mediaType);
    }

    const text = yield* urlEncode(value, options);
    if (names.length === 0) {
      return text;
    }

    const own = new Set(
      options.properties.map(([name]) => name).filter((name) => !names.includes(name)),
    );
    for (const pairName of new URLSearchParams(text).keys()) {
      const field = own.has(pairName) ? undefined : names.find((name) => carries(name, pairName));
      if (field !== undefined) {
        return yield* refuseField(field, mediaType);
      }
    }

    return text;
  });

const urlEncodedOf = (mediaType: string, value: Json | undefined, options: UrlEncodedBodyOptions) =>
  Effect.gen(function* urlEncodedEvaluation() {
    if (mediaType === "" || unsafeHeaderText(mediaType)) {
      return yield* refuse("the request media type is not a valid header value");
    }

    if (value === undefined) {
      return options.required ? HttpBody.text("", mediaType) : HttpBody.empty;
    }

    if (!isJsonObject(value)) {
      return yield* refuse("a form-urlencoded body must be an object");
    }

    return HttpBody.text(yield* guardedText(value, mediaType, options), mediaType);
  });

/**
 * A form-urlencoded body for `mediaType`, encoded by `urlEncode` (design 4.5 body presence).
 * `value` is `undefined` when the caller has no body input at all: then a required body is empty
 * text under `mediaType` and an optional one is no body. Present input is always sent under
 * `mediaType`, even when it yields no pair (`--body '{}'` sends empty text, as the JSON path sends
 * `{}`). An emitter (m2-em7) passes `undefined` for absent input, never `{}`.
 */
export const urlEncoded = (
  mediaType: string,
  value: Json | undefined,
  options: UrlEncodedBodyOptions,
): RequestBody => ({
  expand: urlEncodedOf(mediaType, value, options),
  mediaType,
});

/**
 * A content-based parameter's options (design 6.1, `content` rows).
 */
export interface ContentOptions {
  readonly required: boolean;
}

/**
 * A `querystring` parameter's content: `required`, and for form-urlencoded content the declared
 * properties as for a body (none declared means every key takes the default rules).
 */
export interface QuerystringOptions extends ContentOptions, Partial<UrlEncodedOptions> {}

const isFormMedia = (mediaType: string) =>
  (mediaType.split(";")[0] ?? "").trim().toLowerCase() === "application/x-www-form-urlencoded";

/**
 * A content-based parameter with no value: an optional one sends nothing and a required one is
 * refused.
 */
const absentContent = (name: string, options: ContentOptions) =>
  options.required ? refuse(`parameter ${name} is required and has no value`) : Effect.undefined;

/**
 * The text a content-based parameter's value has before any location encoding: its codec's text,
 * JSON compact and text as is. The one codec for `querystring` and every `content` parameter.
 */
const contentText = (name: string, mediaType: string, value: Json) =>
  Effect.gen(function* contentCodec() {
    if (isJsonMedia(mediaType)) {
      return yield* jsonText(`parameter ${name}`, value);
    }

    if (!Predicate.isString(value)) {
      return yield* refuse(`parameter ${name} must be text under a non-JSON media type`);
    }

    return unpairedSurrogate.test(value)
      ? yield* refuse(`parameter ${name} holds an unpaired surrogate, which has no UTF-8 form`)
      : value;
  });

/**
 * A `querystring` parameter (3.2): its value is the whole query string after `?`, so `request`
 * appends it as the only query part. `application/x-www-form-urlencoded` content goes through
 * `urlEncode` and is not encoded again; any other media type is serialized by its codec and then
 * percent-encoded once. `value` is `undefined` when the caller gave none: an optional parameter
 * then sends nothing and a required one is refused. Present input that yields no text adds no `?`.
 */
export const querystring = (
  name: string,
  mediaType: string,
  value: Json | undefined,
  options: QuerystringOptions,
): QueryParameter => ({
  expand: Effect.gen(function* querystringExpansion() {
    if (value === undefined) {
      return yield* absentContent(name, options);
    }

    if (isFormMedia(mediaType)) {
      return isJsonObject(value)
        ? yield* urlEncode(value, { properties: options.properties ?? [] })
        : yield* refuse(`parameter ${name} must be an object under form-urlencoded content`);
    }

    return encodeUnreserved(yield* contentText(name, mediaType, value));
  }),
  name,
  style: "querystring",
});

/**
 * Query `content` (PRM-23): `name=` and the codec's text, both percent-encoded outside unreserved.
 * `value` is `undefined` when the caller gave none, as for `querystring`.
 */
export const queryContent = (
  name: string,
  mediaType: string,
  value: Json | undefined,
  options: ContentOptions,
): QueryParameter => ({
  expand: Effect.gen(function* queryContentExpansion() {
    if (unpairedSurrogate.test(name)) {
      return yield* refuse(`parameter ${name} has a name with no UTF-8 form`);
    }

    if (value === undefined) {
      return yield* absentContent(name, options);
    }

    return `${encodeUnreserved(name)}=${encodeUnreserved(yield* contentText(name, mediaType, value))}`;
  }),
  name,
  style: "content",
});

/**
 * Header `content` (PRM-24): the codec's text sent as is, one opaque value, so it has no delimiter
 * to check; text no header line can carry unchanged is refused. `value` is as for `queryContent`.
 */
export const headerContent = (
  name: string,
  mediaType: string,
  value: Json | undefined,
  options: ContentOptions,
): HeaderParameter => ({
  expand: Effect.gen(function* headerContentExpansion() {
    if (!headerToken.test(name)) {
      return yield* refuse("a header parameter has a name that is not an RFC 9110 token");
    }

    if (value === undefined) {
      return yield* absentContent(name, options);
    }

    const text = yield* contentText(name, mediaType, value);

    return unsafeHeaderText(text)
      ? yield* refuse(`header ${name} holds a value no header line can carry unchanged`)
      : text;
  }),
  name,
  style: "content",
});

/**
 * Cookie `content` (PRM-24): `name=` and the codec's text sent as is. Text outside RFC 6265
 * `cookie-octet` is refused, so JSON content, with its quotes and commas, is refused: quoting and
 * escaping are the caller's (OAS Appendix D). `value` is as for `queryContent`.
 */
export const cookieContent = (
  name: string,
  mediaType: string,
  value: Json | undefined,
  options: ContentOptions,
): CookieParameter => ({
  expand: Effect.gen(function* cookieContentExpansion() {
    if (!headerToken.test(name)) {
      return yield* refuse("a cookie parameter has a name that is not an RFC 6265 token");
    }

    if (value === undefined) {
      return yield* absentContent(name, options);
    }

    const text = yield* contentText(name, mediaType, value);

    return cookieOctets.test(text)
      ? cookieAssignment(name, text)
      : yield* refuse(`parameter ${name} holds a character outside RFC 6265 cookie-octet`);
  }),
  name,
  style: "content",
});

/**
 * A request built from descriptors: it fails with `UsageError` on any refusal, before a connection.
 */
export type Request = Effect.Effect<HttpClientRequest.HttpClientRequest, UsageError>;

export interface RequestParts {
  readonly body?: RequestBody | undefined;
  /**
   * The cookie parameters, in document order. `request` joins their pairs into one `Cookie` header.
   */
  readonly cookies?: readonly CookieParameter[] | undefined;
  readonly headers: readonly HeaderParameter[];
  readonly path: Path;
  readonly query: readonly QueryParameter[];
}

/**
 * Evaluate the descriptors into a request whose URL is the expanded path plus the query pairs
 * joined by `&`, with no origin (the caller prefixes the base) and no `urlParams`. The cookie
 * pairs, in the order given, form one `Cookie` header joined by `; `, sent only when some pair
 * exists; a header parameter named `Cookie` beside cookie parameters is refused.
 */
export const request = (method: string, descriptors: RequestParts): Request =>
  Effect.gen(function* requestEvaluation() {
    const expandedPath = yield* descriptors.path.expand;
    const pairs = yield* Effect.all(descriptors.query.map((parameter) => parameter.expand));
    const query = pairs.filter(Predicate.isNotUndefined).join("&");
    const names = descriptors.headers.map((parameter) => parameter.name.toLowerCase());

    if (new Set(names).size !== names.length) {
      return yield* refuse("two header parameters have one name");
    }

    const cookies = descriptors.cookies ?? [];

    if (cookies.length > 0 && names.includes("cookie")) {
      return yield* refuse("a header parameter named Cookie sits beside cookie parameters");
    }

    const values = yield* Effect.all(
      descriptors.headers.map((parameter) =>
        parameter.expand.pipe(Effect.map((text) => [parameter.name, text] as const)),
      ),
    );
    const cookiePairs = yield* Effect.all(cookies.map((parameter) => parameter.expand));
    const cookieHeader = cookiePairs.filter(Predicate.isNotUndefined).join("; ");
    const url = query === "" ? expandedPath : `${expandedPath}?${query}`;
    let built = HttpClientRequest.setUrl(
      HttpClientRequest.makeWith(
        method,
        "",
        UrlParams.empty,
        Option.none(),
        Headers.empty,
        HttpBody.empty,
      ),
      url,
    );

    for (const [name, text] of values) {
      if (text !== undefined) {
        built = HttpClientRequest.setHeader(built, name, text);
      }
    }

    if (cookieHeader !== "") {
      built = HttpClientRequest.setHeader(built, "Cookie", cookieHeader);
    }

    if (descriptors.body === undefined) {
      return built;
    }

    const requestBody = yield* descriptors.body.expand;

    const withBody = HttpClientRequest.setBody(built, requestBody);

    if (requestBody._tag === "Empty") {
      return withBody;
    }

    const contentType =
      descriptors.body.ownsContentType === true
        ? (requestBody.contentType ?? descriptors.body.mediaType)
        : descriptors.body.mediaType;

    return HttpClientRequest.setHeader(withBody, "Content-Type", contentType);
  });
