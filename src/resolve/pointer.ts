import { Data, Effect } from "effect";

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
export const escapeToken = (token: string): string =>
  token.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * Unescapes one reference token; a `~` not followed by `0` or `1` fails.
 */
export const unescapeToken = (token: string): Effect.Effect<string, PointerSyntaxError> =>
  /~(?![01])/u.test(token)
    ? Effect.fail(new PointerSyntaxError({ pointer: token, reason: "invalid-escape" }))
    : Effect.succeed(token.replaceAll("~1", "/").replaceAll("~0", "~"));

/**
 * Parses a pointer string into unescaped tokens.
 */
export const parsePointer = (
  pointer: string,
): Effect.Effect<readonly string[], PointerSyntaxError> => {
  if (pointer === "") {
    return Effect.succeed([]);
  }

  if (!pointer.startsWith("/")) {
    return Effect.fail(new PointerSyntaxError({ pointer, reason: "missing-leading-slash" }));
  }

  return Effect.forEach(pointer.slice(1).split("/"), unescapeToken).pipe(
    Effect.mapError(() => new PointerSyntaxError({ pointer, reason: "invalid-escape" })),
  );
};

/**
 * Formats tokens as a pointer string.
 */
export const formatPointer = (tokens: readonly string[]): string =>
  tokens.map((token) => `/${escapeToken(token)}`).join("");

/**
 * Parses a URI-fragment pointer (`#/a%25b`) into unescaped tokens.
 */
export const parseFragment = (
  fragment: string,
): Effect.Effect<readonly string[], PointerSyntaxError> => {
  if (!fragment.startsWith("#")) {
    return Effect.fail(new PointerSyntaxError({ pointer: fragment, reason: "missing-hash" }));
  }

  return Effect.try({
    catch: () => new PointerSyntaxError({ pointer: fragment, reason: "invalid-percent-escape" }),
    try: () => decodeURIComponent(fragment.slice(1)),
  }).pipe(
    Effect.flatMap(parsePointer),
    Effect.mapError(
      (failure) => new PointerSyntaxError({ pointer: fragment, reason: failure.reason }),
    ),
  );
};

const arrayIndex = /^(?:0|[1-9][0-9]*)$/u;

const isArray = (value: Json): value is readonly Json[] => Array.isArray(value);

const isObject = (value: Json): value is { readonly [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Evaluates tokens against a JSON value through own members only.
 */
export const evaluateTokens = (
  value: Json,
  tokens: readonly string[],
): Effect.Effect<Json, PointerEvalError> =>
  Effect.gen(function* evaluate() {
    let current = value;
    for (const [index, token] of tokens.entries()) {
      const pointer = formatPointer(tokens.slice(0, index + 1));
      if (isArray(current)) {
        const item = arrayIndex.test(token) ? current[Number(token)] : undefined;
        if (item === undefined) {
          return yield* new PointerIndexOutOfRange({ pointer, token });
        }

        current = item;
      } else if (isObject(current)) {
        const member = Object.hasOwn(current, token) ? current[token] : undefined;
        if (member === undefined) {
          return yield* new PointerMemberNotFound({ pointer, token });
        }

        current = member;
      } else {
        return yield* new PointerNotContainer({ pointer, token });
      }
    }

    return current;
  });

/**
 * Evaluates a pointer string against a JSON value.
 */
export const evaluatePointer = (
  value: Json,
  pointer: string,
): Effect.Effect<Json, PointerSyntaxError | PointerEvalError> =>
  parsePointer(pointer).pipe(Effect.flatMap((tokens) => evaluateTokens(value, tokens)));

/**
 * Evaluates a URI-fragment pointer against a JSON value.
 */
export const evaluateFragment = (
  value: Json,
  fragment: string,
): Effect.Effect<Json, PointerSyntaxError | PointerEvalError> =>
  parseFragment(fragment).pipe(Effect.flatMap((tokens) => evaluateTokens(value, tokens)));
