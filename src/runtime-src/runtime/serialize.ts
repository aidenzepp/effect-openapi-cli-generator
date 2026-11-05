import { Effect, Predicate } from "effect";
import { UsageError } from "../domain/errors.ts";

/**
 * A value with a text form. Integers outside the safe range arrive as digit strings and are sent
 * as given.
 */
export type Scalar = string | number | boolean | null | undefined;

/**
 * A parameter value: a scalar, an array of scalars, or an object with scalar members. Deeper
 * nesting has no style and is refused.
 */
export type Value = Scalar | readonly Scalar[] | { readonly [member: string]: Scalar };

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

const describe = (name: string, value: Value): Effect.Effect<Text | undefined, UsageError> => {
  if (isList(value)) {
    return value.length === 0
      ? Effect.undefined
      : Effect.map(Effect.all(value.map((item) => itemText(name, item))), (items): Text => ({
          items,
          kind: "array",
        }));
  }

  if (Predicate.isObject(value)) {
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

const encoder = (allowReserved: boolean) => (text: string) =>
  allowReserved
    ? text.replaceAll(/%[0-9A-Fa-f]{2}|[\S\s]/gu, (token) =>
        percentTriplet.test(token) || pathReserved.includes(token)
          ? token
          : encodeUnreserved(token),
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
const flat = (text: Text) => {
  if (text.kind === "primitive") {
    return text.text;
  }

  return text.kind === "array" ? text.items.join(",") : text.members.flat().join(",");
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
    return expandMatrix(encode(name), text, explode);
  }

  return explode && text.kind === "object"
    ? text.members.map(([key, member]) => `${key}=${member}`).join(",")
    : flat(text);
};

const styled =
  (style: PathStyle) =>
  (name: string, value: Value, options: PathOptions): PathParameter => ({
    expand: Effect.gen(function* styleExpansion() {
      const text = yield* toText(name, value, true);

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
      expansions.set(parameter.name, yield* parameter.expand);
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
