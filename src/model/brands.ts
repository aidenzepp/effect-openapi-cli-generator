import { Schema } from "effect";
import { pointerPattern } from "./pointer.ts";
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
export const MethodToken = Schema.Literals(methodTokens).pipe(Schema.brand("MethodToken"));

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
  Schema.check(Schema.isPattern(pointerPattern)),
  Schema.brand("JsonPointer"),
);

/**
 * A finite JSON value. Resource bounds belong to the stage budgets, not the brand.
 */
export const JsonLiteral = Schema.Json.pipe(Schema.brand("JsonLiteral"));

/**
 * A SHA-256 digest as 64 lowercase hexadecimal digits.
 */
export const Sha256Hex = pattern(/^[0-9a-f]{64}$/u);
