import { Effect, Predicate } from "effect";
import { HttpBody, HttpClientRequest } from "effect/http";
import type { HttpMethod } from "effect/http";
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

/**
 * Reserved characters a query value may pass under `allowReserved`: RFC 3986 reserved less the form
 * delimiters `&`, `=` and `+` and the fragment start `#`, which stay encoded.
 */
const queryReserved = ":/?[]@!$'()*,;";

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
  (name: string, value: Value, options: PathOptions): PathParameter => ({
    expand: Effect.gen(function* styleExpansion() {
      // Only a matrix expansion emits the name.
      if (style === "matrix" && unpairedSurrogate.test(name)) {
        return yield* refuse("a matrix parameter has a name with no UTF-8 form");
      }

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

export interface QueryOptions {
  readonly allowEmptyValue?: boolean;
  readonly allowReserved: boolean;
  readonly explode: boolean;
  readonly required: boolean;
}

/**
 * A query parameter: plain data plus its expansion, which fails with `UsageError` instead of
 * throwing. The expansion is the encoded pairs joined by `&`, or `undefined` when the parameter
 * sends nothing.
 */
export interface QueryParameter {
  readonly expand: Effect.Effect<string | undefined, UsageError>;
  readonly name: string;
  readonly style: "deepObject" | "form" | "pipeDelimited" | "spaceDelimited";
}

type QueryStyle = QueryParameter["style"];

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

const checkQueryDelimiter = (
  name: string,
  style: QueryStyle,
  text: Text,
  options: QueryOptions,
) => {
  const banned = queryDelimiter(style, text, options);
  const clash = banned !== undefined && parts(text).some((part) => part.includes(banned));

  return clash
    ? refuse(`parameter ${name} holds a character its ${style} expansion would leave ambiguous`)
    : Effect.void;
};

const joiners = {
  deepObject: ",",
  form: ",",
  pipeDelimited: "%7C",
  spaceDelimited: "%20",
} as const;

const composeQuery = (
  style: QueryStyle,
  name: string,
  raw: Text,
  explode: boolean,
  encode: (text: string) => string,
) => {
  const key = encodeUnreserved(name);
  const text = encodeText(raw, encode);

  // Keys that become names are always strictly encoded; `allowReserved` is for values only.
  if (raw.kind === "object" && style === "deepObject") {
    return raw.members
      .map(
        ([member, memberText]) => `${key}%5B${encodeUnreserved(member)}%5D=${encode(memberText)}`,
      )
      .join("&");
  }

  if (explode && text.kind === "array") {
    return text.items.map((item) => `${key}=${item}`).join("&");
  }

  if (explode && raw.kind === "object") {
    return raw.members
      .map(([member, memberText]) => `${encodeUnreserved(member)}=${encode(memberText)}`)
      .join("&");
  }

  return `${key}=${flat(text, joiners[style])}`;
};

const isEmptyCompound = (value: Value) =>
  isList(value) ? value.length === 0 : Predicate.isObject(value) && Object.keys(value).length === 0;

const queryStyled =
  (style: QueryStyle) =>
  (name: string, value: Value, options: QueryOptions): QueryParameter => ({
    expand: Effect.gen(function* queryExpansion() {
      if (unpairedSurrogate.test(name)) {
        return yield* refuse(`parameter ${name} has a name with no UTF-8 form`);
      }

      const text = yield* toText(name, value, false);

      if (text === undefined) {
        if (options.allowEmptyValue === true && isEmptyCompound(value)) {
          return `${encodeUnreserved(name)}=`;
        }

        return options.required
          ? yield* refuse(`parameter ${name} is required and has no value`)
          : undefined;
      }

      if (style === "deepObject" && text.kind !== "object") {
        return yield* refuse(`parameter ${name} is not an object, which deepObject requires`);
      }

      yield* checkQueryDelimiter(name, style, text, options);

      return composeQuery(
        style,
        name,
        text,
        options.explode,
        encoder(options.allowReserved, queryReserved),
      );
    }),
    name,
    style,
  });

/**
 * Query `form`: RFC 6570 `{?name}` and `{?name*}`.
 */
export const form = queryStyled("form");

/**
 * Query `spaceDelimited`: a non-exploded list joined by an encoded space.
 */
export const spaceDelimited = queryStyled("spaceDelimited");

/**
 * Query `pipeDelimited`: a non-exploded list joined by an encoded pipe.
 */
export const pipeDelimited = queryStyled("pipeDelimited");

/**
 * Query `deepObject`: an object with scalar members as `name[key]=value`, brackets encoded.
 * `explode` has no effect.
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
  readonly style: "simple";
}

/**
 * RFC 9110 `token`.
 */
const headerToken = /^[\w!#$%&'*+.^`|~-]+$/u;

const headerLineBreak = /[\n\r]/u;

const edgeSpace = /^[\t ]|[\t ]$/u;

/**
 * A header value, or a media type that becomes one, that no header can carry unchanged (RFC 9110
 * 5.5): CR, LF, NUL and leading or trailing whitespace.
 */
const unsafeHeaderText = (text: string) =>
  headerLineBreak.test(text) || text.includes("\u0000") || edgeSpace.test(text);

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
export const header = (name: string, value: Value, options: HeaderOptions): HeaderParameter => ({
  expand: Effect.gen(function* headerExpansion() {
    if (!headerToken.test(name)) {
      return yield* refuse("a header parameter has a name that is not an RFC 9110 token");
    }

    const text = yield* toText(name, value, options.required);

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

/**
 * A JSON value.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [member: string]: Json };

/**
 * A request body: a JSON or text value, or a binary stream that is already an `HttpBody` (a
 * `FileBody` file or stdin).
 */
export type Body = Json | HttpBody.HttpBody;

/**
 * A request body and its media type: plain data plus its evaluation, which fails with `UsageError`
 * instead of throwing.
 */
export interface RequestBody {
  readonly expand: Effect.Effect<HttpBody.HttpBody, UsageError>;
  readonly mediaType: string;
}

const isJsonMedia = (mediaType: string) => {
  const essence = (mediaType.split(";")[0] ?? "").trim().toLowerCase();

  return essence === "application/json" || essence.endsWith("+json");
};

const hasNonFinite = (value: Json): boolean => {
  if (Predicate.isNumber(value)) {
    return !Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.some((item: Json) => hasNonFinite(item));
  }

  return Predicate.isObject(value) && Object.values(value).some((member) => hasNonFinite(member));
};

/**
 * Compact JSON text. `JSON.stringify` turns a non-finite number into `null`, which is a different
 * value, so one is refused.
 */
const jsonText = (value: Json) =>
  hasNonFinite(value)
    ? refuse("the body holds a number with no JSON text form")
    : Effect.succeed(JSON.stringify(value));

const bodyOf = (mediaType: string, value: Body) =>
  Effect.gen(function* bodyEvaluation() {
    if (mediaType === "" || unsafeHeaderText(mediaType)) {
      return yield* refuse("the request media type is not a valid header value");
    }

    if (HttpBody.isHttpBody(value)) {
      return value;
    }

    if (isJsonMedia(mediaType)) {
      return HttpBody.text(yield* jsonText(value), mediaType);
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

/**
 * A request built from descriptors: it fails with `UsageError` on any refusal, before a connection.
 */
export type Request = Effect.Effect<HttpClientRequest.HttpClientRequest, UsageError>;

export interface RequestParts {
  readonly body?: RequestBody | undefined;
  readonly headers: readonly HeaderParameter[];
  readonly path: Path;
  readonly query: readonly QueryParameter[];
}

/**
 * Evaluate the descriptors into a request whose URL is the expanded path plus the query pairs
 * joined by `&`, with no origin (the caller prefixes the base) and no `urlParams`.
 */
export const request = (method: HttpMethod.HttpMethod, descriptors: RequestParts): Request =>
  Effect.gen(function* requestEvaluation() {
    const expandedPath = yield* descriptors.path.expand;
    const pairs = yield* Effect.all(descriptors.query.map((parameter) => parameter.expand));
    const query = pairs.filter(Predicate.isNotUndefined).join("&");
    const names = descriptors.headers.map((parameter) => parameter.name.toLowerCase());

    if (new Set(names).size !== names.length) {
      return yield* refuse("two header parameters have one name");
    }

    const values = yield* Effect.all(
      descriptors.headers.map((parameter) =>
        parameter.expand.pipe(Effect.map((text) => [parameter.name, text] as const)),
      ),
    );
    const url = query === "" ? expandedPath : `${expandedPath}?${query}`;
    let built = HttpClientRequest.setUrl(HttpClientRequest.make(method)(""), url);

    for (const [name, text] of values) {
      if (text !== undefined) {
        built = HttpClientRequest.setHeader(built, name, text);
      }
    }

    if (descriptors.body === undefined) {
      return built;
    }

    const requestBody = yield* descriptors.body.expand;

    return HttpClientRequest.setHeader(
      HttpClientRequest.setBody(built, requestBody),
      "Content-Type",
      descriptors.body.mediaType,
    );
  });
