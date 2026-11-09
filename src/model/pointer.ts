import { Data, Effect, JsonPointer, Predicate, Result } from "effect";

/**
 * A JSON value.
 */
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/**
 * The pointer or fragment text is not valid RFC 6901 syntax.
 */
export class PointerSyntaxError extends Data.TaggedError("PointerSyntaxError")<{
  readonly pointer: string;
  readonly reason:
    | "missing-leading-slash"
    | "invalid-escape"
    | "invalid-percent-escape"
    | "missing-hash";
}> {}

/**
 * An object has no own member for a pointer token.
 */
export class PointerMemberNotFound extends Data.TaggedError("PointerMemberNotFound")<{
  readonly pointer: string;
  readonly token: string;
}> {}

/**
 * An array index token is not a valid index into the array.
 */
export class PointerIndexOutOfRange extends Data.TaggedError("PointerIndexOutOfRange")<{
  readonly pointer: string;
  readonly token: string;
}> {}

/**
 * A token tried to descend into a scalar.
 */
export class PointerNotContainer extends Data.TaggedError("PointerNotContainer")<{
  readonly pointer: string;
  readonly token: string;
}> {}

export type PointerEvalError = PointerMemberNotFound | PointerIndexOutOfRange | PointerNotContainer;

/**
 * Escapes one reference token (`~` to `~0`, `/` to `~1`).
 */
export const escapeToken = (token: string): string => JsonPointer.escapeToken(token);

// One token grammar: any characters but `/` and `~`, or the escapes `~0` and `~1`.
const tokenGrammar = String.raw`(?:[^/~]|~[01])*`;

/**
 * What `parsePointer` accepts: the empty pointer or `/`-led reference tokens.
 */
export const pointerPattern = new RegExp(String.raw`^(?:\/${tokenGrammar})*$`, "u");

/**
 * What `parsePointer` accepts, less the empty pointer.
 */
export const nonEmptyPointerPattern = new RegExp(String.raw`^(?:\/${tokenGrammar})+$`, "u");

/**
 * Unescapes one reference token; a `~` not followed by `0` or `1` fails.
 */
export const unescapeTokenResult = (token: string): Result.Result<string, PointerSyntaxError> =>
  /~(?![01])/u.test(token)
    ? Result.fail(new PointerSyntaxError({ pointer: token, reason: "invalid-escape" }))
    : Result.succeed(JsonPointer.unescapeToken(token));

/**
 * Unescapes one reference token; a `~` not followed by `0` or `1` fails.
 */
export const unescapeToken = (token: string): Effect.Effect<string, PointerSyntaxError> =>
  Effect.suspend(() => Effect.fromResult(unescapeTokenResult(token)));

/**
 * Parses a pointer string into unescaped tokens.
 */
export const parsePointerResult = (
  pointer: string,
): Result.Result<readonly string[], PointerSyntaxError> => {
  if (pointer === "") {
    return Result.succeed([]);
  }

  if (!pointer.startsWith("/")) {
    return Result.fail(new PointerSyntaxError({ pointer, reason: "missing-leading-slash" }));
  }

  const tokens: string[] = [];
  for (const raw of pointer.slice(1).split("/")) {
    const token = unescapeTokenResult(raw);
    if (Result.isFailure(token)) {
      return Result.fail(new PointerSyntaxError({ pointer, reason: "invalid-escape" }));
    }

    tokens.push(token.success);
  }

  return Result.succeed(tokens);
};

/**
 * Parses a pointer string into unescaped tokens.
 */
export const parsePointer = (
  pointer: string,
): Effect.Effect<readonly string[], PointerSyntaxError> =>
  Effect.suspend(() => Effect.fromResult(parsePointerResult(pointer)));

/**
 * The pointer to member or index `token` of the node at `pointer`.
 */
export const childPointer = (pointer: string, token: string): string =>
  `${pointer}/${escapeToken(token)}`;

/**
 * Whether `pointer` is `ancestor` or lies below it, by string prefix at a `/` boundary.
 */
export const isPointerWithin = (ancestor: string, pointer: string): boolean =>
  pointer === ancestor || pointer.startsWith(`${ancestor}/`);

/**
 * Formats tokens as a pointer string.
 */
export const formatPointer = (tokens: readonly string[]): string =>
  tokens.map((token) => `/${escapeToken(token)}`).join("");

/**
 * Parses a URI-fragment pointer (`#/a%25b`) into unescaped tokens.
 */
export const parseFragmentResult = (
  fragment: string,
): Result.Result<readonly string[], PointerSyntaxError> => {
  if (!fragment.startsWith("#")) {
    return Result.fail(new PointerSyntaxError({ pointer: fragment, reason: "missing-hash" }));
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment.slice(1));
  } catch {
    return Result.fail(
      new PointerSyntaxError({ pointer: fragment, reason: "invalid-percent-escape" }),
    );
  }

  return Result.mapError(
    parsePointerResult(decoded),
    (failure) => new PointerSyntaxError({ pointer: fragment, reason: failure.reason }),
  );
};

/**
 * Parses a URI-fragment pointer (`#/a%25b`) into unescaped tokens.
 */
export const parseFragment = (
  fragment: string,
): Effect.Effect<readonly string[], PointerSyntaxError> =>
  Effect.suspend(() => Effect.fromResult(parseFragmentResult(fragment)));

const arrayIndex = /^(?:0|[1-9][0-9]*)$/u;

/**
 * Evaluates tokens against a JSON value through own members only.
 */
export const evaluateTokensResult = (
  value: Json,
  tokens: readonly string[],
): Result.Result<Json, PointerEvalError> => {
  let current = value;
  for (const [index, token] of tokens.entries()) {
    const pointer = formatPointer(tokens.slice(0, index + 1));
    if (Array.isArray(current)) {
      const item = arrayIndex.test(token) ? current[Number(token)] : undefined;
      if (item === undefined) {
        return Result.fail(new PointerIndexOutOfRange({ pointer, token }));
      }

      current = item;
    } else if (Predicate.isObject(current)) {
      const member = Object.hasOwn(current, token) ? current[token] : undefined;
      if (member === undefined) {
        return Result.fail(new PointerMemberNotFound({ pointer, token }));
      }

      current = member;
    } else {
      return Result.fail(new PointerNotContainer({ pointer, token }));
    }
  }

  return Result.succeed(current);
};

/**
 * Evaluates tokens against a JSON value through own members only.
 */
export const evaluateTokens = (
  value: Json,
  tokens: readonly string[],
): Effect.Effect<Json, PointerEvalError> =>
  Effect.suspend(() => Effect.fromResult(evaluateTokensResult(value, tokens)));

/**
 * Evaluates a pointer string against a JSON value.
 */
export const evaluatePointerResult = (
  value: Json,
  pointer: string,
): Result.Result<Json, PointerSyntaxError | PointerEvalError> =>
  Result.flatMap(parsePointerResult(pointer), (tokens) => evaluateTokensResult(value, tokens));

/**
 * Evaluates a pointer string against a JSON value.
 */
export const evaluatePointer = (
  value: Json,
  pointer: string,
): Effect.Effect<Json, PointerSyntaxError | PointerEvalError> =>
  Effect.suspend(() => Effect.fromResult(evaluatePointerResult(value, pointer)));

/**
 * Evaluates a URI-fragment pointer against a JSON value.
 */
export const evaluateFragmentResult = (
  value: Json,
  fragment: string,
): Result.Result<Json, PointerSyntaxError | PointerEvalError> =>
  Result.flatMap(parseFragmentResult(fragment), (tokens) => evaluateTokensResult(value, tokens));

/**
 * Evaluates a URI-fragment pointer against a JSON value.
 */
export const evaluateFragment = (
  value: Json,
  fragment: string,
): Effect.Effect<Json, PointerSyntaxError | PointerEvalError> =>
  Effect.suspend(() => Effect.fromResult(evaluateFragmentResult(value, fragment)));
