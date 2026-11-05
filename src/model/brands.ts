import { Array as Arr, Effect, Exit, Predicate, Schema } from "effect";
import { parsePointer } from "../resolve/pointer.ts";
import { methodTokens } from "./method-tokens.ts";

const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";

const concrete = "[!#$%&'+.^_`|~0-9A-Za-z-]+";

const quoted = '"(?:[\\t !#-\\[\\]-~]|\\\\[\\t -~])*"';

const parameters = `(?:[ \\t]*;[ \\t]*${token}=(?:${token}|${quoted}))*`;

const pathSegment =
  "(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2}|\\{[^{}/?#\\s\\p{Cc}\\p{Cs}]+\\})*";

const serverChar = "(?:[A-Za-z0-9\\-._~:/?#[\\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2}|\\{[^{}/?#\\s]+\\})";

const uriChar = "(?:[A-Za-z0-9\\-._~:/?#[\\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})";

const tokenPattern = new RegExp(`^${token}$`, "u");

const mediaTypePattern = new RegExp(`^${concrete}/${concrete}${parameters}$`, "u");

const mediaRangePattern = new RegExp(
  `^(?:\\*/\\*|${concrete}/\\*|${concrete}/${concrete})${parameters}$`,
  "u",
);

const pathPattern = new RegExp(`^(?:/${pathSegment})+$`, "u");

const encodedDot = /%2e/giu;

const isDotSegment = (segment: string) => {
  const decoded = segment.replaceAll(encodedDot, ".");

  return decoded === "." || decoded === "..";
};

const hasValidSegments = (value: string) => {
  const segments = value.split("/").slice(1);
  const last = segments.length - 1;

  return segments.every(
    (segment, index) => (segment !== "" || index === last) && !isDotSegment(segment),
  );
};

const serverPattern = new RegExp(`^${serverChar}+$`, "u");

const uriPattern = new RegExp(`^[A-Za-z][A-Za-z0-9+.-]*:${uriChar}*$`, "u");

const wireNamePattern = /^[^\p{Cc}\p{Cs}]+$/u;

const safeTextPattern = /^(?:[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]|[\n\t])*$/u;

const pattern = (regExp: RegExp) => Schema.String.pipe(Schema.check(Schema.isPattern(regExp)));

/**
 * A parameter, property or field name exactly as the specification spells it.
 */
export const WireName = pattern(wireNamePattern).pipe(Schema.brand("WireName"));

/**
 * An RFC 9110 header field name.
 */
export const HeaderName = pattern(tokenPattern).pipe(Schema.brand("HeaderName"));

/**
 * An RFC 6265 cookie name.
 */
export const CookieName = pattern(tokenPattern).pipe(Schema.brand("CookieName"));

/**
 * An RFC 9110 8.3.1 media type, parameters allowed, no wildcards.
 */
export const MediaType = pattern(mediaTypePattern).pipe(Schema.brand("MediaType"));

/**
 * An RFC 9110 8.3.1 media range, wildcards allowed.
 */
export const MediaRange = pattern(mediaRangePattern).pipe(Schema.brand("MediaRange"));

/**
 * An OpenAPI 3.2.1 path template: absolute, with balanced non-empty expressions, no dot segments
 * and no empty segment except the last.
 */
export const PathTemplate = pattern(pathPattern).pipe(
  Schema.check(Schema.makeFilter(hasValidSegments)),
  Schema.brand("PathTemplate"),
);

/**
 * A server URL template with balanced non-empty variables.
 */
export const ServerTemplate = pattern(serverPattern).pipe(Schema.brand("ServerTemplate"));

/**
 * An HTTP method token in the Bun allowlist.
 */
export const MethodToken = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value: string) => methodTokens.includes(value))),
  Schema.brand("MethodToken"),
);

/**
 * Help-safe plain text: no controls except LF and TAB, no format, separator or lone surrogate
 * characters.
 */
export const SafeText = pattern(safeTextPattern).pipe(Schema.brand("SafeText"));

/**
 * An absolute URI with ASCII characters only.
 */
export const DocumentUri = pattern(uriPattern).pipe(Schema.brand("DocumentUri"));

/**
 * An RFC 6901 JSON Pointer.
 */
export const JsonPointer = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => Exit.isSuccess(Effect.runSyncExit(parsePointer(value)))),
  ),
  Schema.brand("JsonPointer"),
);

const maxNodes = 65_536;

const maxStringLength = 2 ** 20;

const isJson = Schema.is(Schema.Json);

const childrenOf = (value: Schema.Json): readonly unknown[] => {
  if (Arr.isArray(value)) {
    return value;
  }

  return Predicate.isObject(value) ? Object.values(value) : [];
};

const withinBounds = (root: Schema.Json): boolean => {
  const pending: Schema.Json[] = [root];
  let nodes = 0;
  let next = pending.pop();
  while (next !== undefined) {
    nodes += 1;
    if (nodes > maxNodes) {
      return false;
    }

    if (Predicate.isNumber(next) && !Number.isFinite(next)) {
      return false;
    }

    if (Predicate.isString(next) && next.length > maxStringLength) {
      return false;
    }

    const children = childrenOf(next);
    for (const child of children) {
      if (isJson(child)) {
        pending.push(child);
      }
    }

    next = pending.pop();
  }

  return true;
};

/**
 * A finite JSON value of bounded size.
 */
export const JsonLiteral = Schema.Json.pipe(
  Schema.check(Schema.makeFilter(withinBounds)),
  Schema.brand("JsonLiteral"),
);
