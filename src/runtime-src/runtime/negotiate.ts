import { Effect, Option } from "effect";
import { Flag } from "effect/cli";
import { UsageError } from "../domain/errors.ts";

/**
 * An operation's declared media: request keys, and response keys per response key, in document
 * order. `refused` lists, per request key, the body properties refused at `field` scope (design
 * 8.5); absent, none is. It is the one list the form serializer's `--body` guard reads.
 */
export interface MediaDeclaration {
  readonly refused?: { readonly [requestKey: string]: readonly string[] };
  readonly request: readonly string[];
  readonly responses: { readonly [responseKey: string]: readonly string[] };
}

/**
 * The declared request key, and the type sent in `Content-Type` (the operator's concrete type for a
 * range key).
 */
export interface RequestMedia {
  readonly contentType: string;
  readonly key: string;
}

const contentTypeFlagName = "--content-type";

const acceptFlagName = "--accept";

/**
 * A concrete media type, as an RFC 9110 token pair. No `*`, no parameters, nothing a header could
 * not carry.
 */
const concreteType = /^[!#$%&'+.^_`|~0-9a-z-]+\/[!#$%&'+.^_`|~0-9a-z-]+$/u;

/**
 * Plain optional strings: the declared choices are listed in help, and a refused value is never
 * echoed.
 */
export const contentTypeFlag = Flag.String("content-type").pipe(Flag.optional);

export const acceptFlag = Flag.String("accept").pipe(Flag.optional);

const essence = (mediaType: string): string => {
  const [head = ""] = mediaType.split(";", 1);

  return head.trim().toLowerCase();
};

const isJsonFamily = (key: string): boolean => {
  const type = essence(key);

  return type === "application/json" || type.endsWith("+json");
};

const isRange = (key: string): boolean => essence(key).endsWith("/*");

const rangeMatches = (range: string, type: string): boolean =>
  range === "*/*" || range === `${type.slice(0, type.indexOf("/"))}/*`;

/**
 * The declared key a concrete type falls under: exact, then `type/*`, then `*` over `*`.
 */
const matchDeclared = (declared: readonly string[], type: string): string | undefined =>
  declared.find((key) => essence(key) === type) ??
  declared.find(
    (key) => essence(key) !== "*/*" && isRange(key) && rangeMatches(essence(key), type),
  ) ??
  declared.find((key) => essence(key) === "*/*");

const refuse = (flag: string, reason: string) =>
  Effect.fail(new UsageError({ flag, message: `${flag} ${reason}` }));

/**
 * `--content-type` chooses among the declared request keys; the default is the first JSON-family
 * key, else the first key. A range key needs a concrete `--content-type` inside it. A refused value
 * is never echoed.
 */
export const selectRequestMedia = (
  media: MediaDeclaration,
  chosen: Option.Option<string>,
): Effect.Effect<RequestMedia, UsageError> => {
  const [first] = media.request;

  if (first === undefined) {
    return refuse(contentTypeFlagName, "does not apply: the operation declares no request media");
  }

  return Option.match(chosen, {
    onNone: () => {
      const key = media.request.length === 1 ? first : (media.request.find(isJsonFamily) ?? first);

      return isRange(key)
        ? refuse(contentTypeFlagName, "must name a concrete media type for this operation")
        : Effect.succeed({ contentType: key, key });
    },
    onSome: (value) => {
      const named = value.trim().toLowerCase();
      const key = concreteType.test(named) ? matchDeclared(media.request, named) : undefined;

      return key === undefined
        ? refuse(contentTypeFlagName, "names a media type this operation does not declare")
        : Effect.succeed({ contentType: isRange(key) ? named : key, key });
    },
  });
};

/**
 * The `Accept` value: the declared response media in document order, once each, narrowed to the
 * JSON family where JSON and other alternatives coexist, or the one `--accept` names. `None` when
 * no response declares content.
 */
export const accept = (
  media: MediaDeclaration,
  chosen: Option.Option<string>,
): Effect.Effect<Option.Option<string>, UsageError> => {
  const declared = [...new Set(Object.values(media.responses).flat())];

  return Option.match(chosen, {
    onNone: () => {
      const json = declared.filter(isJsonFamily);
      const listed = json.length > 0 && json.length < declared.length ? json : declared;

      return Effect.succeed(listed.length === 0 ? Option.none() : Option.some(listed.join(", ")));
    },
    onSome: (value) => {
      const named = value.trim().toLowerCase();

      return concreteType.test(named) && matchDeclared(declared, named) !== undefined
        ? Effect.succeed(Option.some(named))
        : refuse(acceptFlagName, "names a media type this operation does not declare");
    },
  });
};

/**
 * The most specific declared response key for a response `Content-Type`, or `undefined` when none
 * is declared (the body is then output as raw bytes).
 */
export const dispatchResponse = (
  declared: readonly string[],
  actual?: string,
): string | undefined => {
  const type = actual === undefined ? "" : essence(actual);

  return concreteType.test(type) ? matchDeclared(declared, type) : undefined;
};
