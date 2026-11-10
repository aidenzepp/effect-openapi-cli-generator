import { Array as Arr, Effect, Option, Order, Schema } from "effect";
import type { Types } from "effect";
import { sanitizeProse } from "../emit/help.ts";
import { HeaderName, MediaRange } from "../model/brands.ts";
import { makeDiagnostic } from "../model/diagnostic.ts";
import type { Diagnostic } from "../model/diagnostic.ts";
import { ResponseCase } from "../model/entities.ts";
import type { MediaAlternative } from "../model/entities.ts";
import { defsKey } from "../resolve/canonical.ts";
import type { CanonicalKey } from "../resolve/canonical.ts";
import type { Resolution, ResolvedReference } from "../resolve/index.ts";
import { specSectionUrl } from "../model/spec-section.ts";
import { sequentialCodecOf } from "../runtime-src/runtime/sequential.ts";
import { childKey, follow, nodeIn, referenceIn } from "./document-set.ts";
import { headerMarks } from "./header-object.ts";
import { headerPercentEncoding } from "./parameters.ts";

/**
 * The response cases of one Responses Object and the diagnostics found while building them.
 */
export interface NormalizedResponses {
  readonly diagnostics: readonly Diagnostic[];
  readonly responses: readonly ResponseCase[];
}

const Members = Schema.Record(Schema.String, Schema.Unknown);

const ResponsesObject = Members;

const ResponseObject = Schema.Struct({
  content: Schema.optionalKey(Members),
  description: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Members),
  summary: Schema.optionalKey(Schema.String),
});

const MediaObject = Schema.Struct({
  description: Schema.optionalKey(Schema.Unknown),
  encoding: Schema.optionalKey(Schema.Unknown),
  itemSchema: Schema.optionalKey(Schema.Unknown),
  schema: Schema.optionalKey(Schema.Unknown),
});

const HeaderObject = Schema.Struct({ schema: Schema.optionalKey(Schema.Unknown) });

const isHeaderName = Schema.is(HeaderName);

const isMediaRange = Schema.is(MediaRange);

interface Rule {
  readonly anchor: string;
  readonly element: string;
  readonly hint?: string;
  readonly message: string;
  readonly severity: "notice" | "refusal";
}

const rules = {
  "HDR-15/header-percent-encoding": {
    anchor: "appendix-d-serializing-headers-and-cookies",
    element: "Response header percent-encoding",
    message: headerPercentEncoding,
    severity: "notice",
  },
  "MED-09/description-ignored": {
    anchor: "media-type-object",
    element: "Media type description",
    message: "The description of a media type is not used, so it is ignored here.",
    severity: "notice",
  },
  "MED-10/encoding-ignored": {
    anchor: "media-type-encoding",
    element: "Media type encoding",
    message:
      "The encoding field applies to multipart and form-urlencoded request bodies only, so it is ignored here.",
    severity: "notice",
  },
  "RSP-05/invalid-media-type": {
    anchor: "response-content",
    element: "Response content key",
    message: "A content key is not a media type or a media range; the alternative is refused.",
    severity: "refusal",
  },
  "RSP-09/ignored-content-type": {
    anchor: "response-headers",
    element: "Response header",
    message: "A response header named Content-Type is ignored.",
    severity: "notice",
  },
  "RSP-09/invalid-header-name": {
    anchor: "response-headers",
    element: "Response header",
    message: "A response header name is not an RFC 9110 token; the header is refused.",
    severity: "refusal",
  },
  "RSS-06/invalid-key": {
    anchor: "responses-code",
    element: "Response key",
    hint: "Use a status code, a range from 1XX to 5XX with an uppercase X, or default.",
    message:
      "A responses key is not a status code, a status range or default; the response is refused.",
    severity: "refusal",
  },
  "RSS-10/status-out-of-range": {
    anchor: "responses-code",
    element: "Response key",
    hint: "Status codes run from 100 to 599.",
    message: "A status code outside 100 to 599 is refused.",
    severity: "refusal",
  },
} as const satisfies Record<string, Rule>;

type Code = keyof typeof rules;

type PlainAlternative = Types.Mutable<typeof MediaAlternative.Encoded>;

type PlainCase = Types.Mutable<typeof ResponseCase.Encoded>;

// A finding at its own location, in whichever document of the set holds it.
interface Finding {
  readonly at: CanonicalKey;
  readonly code: Code;
}

const schemaRefAt = (resolution: Resolution, site: CanonicalKey) => {
  const reference = referenceIn(resolution, site);
  const key =
    reference === undefined
      ? defsKey(resolution.document, site)
      : (reference.defsKey ?? defsKey(resolution.document, reference.target));

  return { key };
};

type Key = ResponseCase["key"] | "extension" | "invalid" | "out-of-range";

const classifyKey = (text: string): Key => {
  const range = /^(?<digit>[1-5])XX$/u.exec(text)?.groups?.digit;
  if (range !== undefined) {
    return { range: Number(range) };
  }

  if (/^[0-9]{3}$/u.test(text)) {
    const code = Number(text);

    return code >= 100 && code <= 599 ? { code } : "out-of-range";
  }

  if (text === "default") {
    return "default";
  }

  return text.startsWith("x-") ? "extension" : "invalid";
};

type Codec = (typeof MediaAlternative.Type)["codec"];

// The codec follows the media type alone, never the schema (design 2.2). A range, or a type no
// other family claims, is bytes.
const codecOf = (mediaType: string): Codec => {
  const sequential = sequentialCodecOf(mediaType);
  if (sequential !== undefined) {
    return sequential;
  }

  const essence = (mediaType.split(";")[0] ?? "").trim().toLowerCase();

  if (essence === "application/json" || essence.endsWith("+json")) {
    return "json";
  }

  if (essence === "application/xml" || essence === "text/xml" || essence.endsWith("+xml")) {
    return "xml";
  }

  if (essence === "application/x-www-form-urlencoded") {
    return "form";
  }

  if (essence.startsWith("multipart/")) {
    return "multipart";
  }

  return essence.startsWith("text/") && !essence.endsWith("/*") ? "text" : "binary";
};

const keyRow = (key: ResponseCase["key"]): string => {
  if (key === "default") {
    return "RSS-02";
  }

  return "code" in key ? "RSS-03" : "RSS-06";
};

const alternativeOf = Effect.fnUntraced(function* alternativeOf(
  resolution: Resolution,
  response: CanonicalKey,
  mediaType: string,
  findings: Finding[],
): Effect.fn.Return<Option.Option<PlainAlternative>> {
  const site = childKey(response, "content", mediaType);
  if (!isMediaRange(mediaType)) {
    findings.push({ at: site, code: "RSP-05/invalid-media-type" });

    return Option.none();
  }

  const home = follow(resolution, site);
  const media = yield* nodeIn(resolution, home).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(MediaObject)),
    Effect.orDie,
  );
  // Encoding applies to request bodies only (MED-10, 3.0 and 3.1); a 3.2 Media Type description
  // is ignored (MED-09, D-OC5).
  if (media.encoding !== undefined && resolution.line !== "3.2") {
    findings.push({ at: home, code: "MED-10/encoding-ignored" });
  }

  if (media.description !== undefined && resolution.line === "3.2") {
    findings.push({ at: home, code: "MED-09/description-ignored" });
  }

  const plain: PlainAlternative = {
    codec: codecOf(mediaType),
    encoding: [],
    mediaType,
    origin: home,
    prefixEncoding: [],
    rows: ["RSP-05"],
  };
  if (media.itemSchema !== undefined) {
    plain.itemSchema = schemaRefAt(resolution, childKey(home, "itemSchema"));
  }

  if (media.schema !== undefined) {
    plain.schema = schemaRefAt(resolution, childKey(home, "schema"));
  }

  return Option.some(plain);
});

// A 3.0 schema-serialized header carries the D-OC9 notice; a content-based one never was
// percent-encoded.
const serializedBySchema = (resolution: Resolution, at: CanonicalKey): Effect.Effect<boolean> =>
  nodeIn(resolution, follow(resolution, at)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(HeaderObject)),
    Effect.map((header) => header.schema !== undefined),
    Effect.orDie,
  );

const headersOf = Effect.fnUntraced(function* headersOf(
  resolution: Resolution,
  headers: readonly string[],
  response: CanonicalKey,
  findings: Finding[],
): Effect.fn.Return<PlainCase["headers"]> {
  const kept: PlainCase["headers"][number][] = [];
  for (const name of headers) {
    const at = childKey(response, "headers", name);
    if (name.toLowerCase() === "content-type") {
      findings.push({ at, code: "RSP-09/ignored-content-type" });
    } else if (isHeaderName(name)) {
      kept.push({ name, ...(yield* headerMarks(resolution, at)) });
      if (resolution.line === "3.0" && (yield* serializedBySchema(resolution, at))) {
        findings.push({ at, code: "HDR-15/header-percent-encoding" });
      }
    } else {
      findings.push({ at, code: "RSP-09/invalid-header-name" });
    }
  }

  return kept;
});

const docsOf = (
  response: typeof ResponseObject.Type,
  site: ResolvedReference | undefined,
): PlainCase["docs"] => {
  const description = site?.description ?? response.description;
  const summary = site?.summary ?? response.summary;
  const docs: Types.Mutable<PlainCase["docs"]> = {};
  if (description !== undefined) {
    docs.description = sanitizeProse(description);
  }

  if (summary !== undefined) {
    docs.summary = sanitizeProse(summary);
  }

  return docs;
};

const caseOf = Effect.fnUntraced(function* caseOf(
  resolution: Resolution,
  responses: CanonicalKey,
  text: string,
  key: ResponseCase["key"],
  findings: Finding[],
): Effect.fn.Return<PlainCase> {
  const site = childKey(responses, text);
  const home = follow(resolution, site);
  const response = yield* nodeIn(resolution, home).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ResponseObject)),
    Effect.orDie,
  );
  const alternatives = Arr.getSomes(
    yield* Effect.forEach(Object.keys(response.content ?? {}), (mediaType) =>
      alternativeOf(resolution, home, mediaType, findings),
    ),
  );
  const headers = yield* headersOf(resolution, Object.keys(response.headers ?? {}), home, findings);
  const rows = [
    keyRow(key),
    "RSP-01",
    ...(headers.length === 0 ? [] : ["RSP-04"]),
    ...(response.content === undefined ? ["RSP-07"] : ["RSP-05"]),
  ];

  return {
    alternatives,
    docs: docsOf(response, referenceIn(resolution, site)),
    headers,
    key,
    origin: site,
    rows,
  };
});

const toDiagnostic = (resolution: Resolution, finding: Finding): Effect.Effect<Diagnostic> => {
  const rule: Rule = rules[finding.code];
  const openapi = Schema.decodeUnknownOption(Schema.Struct({ openapi: Schema.String }))(
    resolution.value,
  ).pipe(
    Option.map((declared) => declared.openapi),
    Option.getOrElse(() => "unknown"),
  );

  return makeDiagnostic({
    code: finding.code,
    document: finding.at.document,
    element: rule.element,
    hint: rule.hint,
    message: rule.message,
    openapi,
    pointer: finding.at.pointer,
    scope: "element",
    severity: rule.severity,
    specSection: specSectionUrl(resolution.line, rule.anchor),
  });
};

const responseKeys = (
  resolution: Resolution,
  responses: CanonicalKey,
): Effect.Effect<readonly string[]> =>
  nodeIn(resolution, responses).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ResponsesObject)),
    Effect.map(Object.keys),
    Effect.orElseSucceed((): readonly string[] => []),
  );

/**
 * Builds the `ResponseCase` list of the Responses Object at `pointer` in the entry document, in
 * member order (design 2.2, 6.6, 7.3; JavaScript lists integer-like keys such as `200` first,
 * ascending). A key is an explicit code, a range `1XX` to `5XX` or `default`; a key outside that
 * grammar, a code outside 100 to 599, a content key that is no media type and a header name that is
 * no token are refused at element scope, and a `Content-Type` header is ignored with a notice
 * (`RSP-09`). Headers are recorded by name with their `required` and `deprecated` marks, read
 * through a `$ref`; they never change stdout or the exit status. A 3.0 schema-serialized header
 * gets a notice that its value is not percent-decoded (`HDR-15`). An absent Responses Object has no
 * cases, and `x-` keys are NZ-5's to account for. Schemas are referenced by `$defs` key, an inline
 * one by `defsKey` of its canonical pointer. A response or media type a reference takes into
 * another document of the set is read there, and its findings name that document.
 */
export const normalizeResponses = Effect.fnUntraced(function* normalizeResponses(
  resolution: Resolution,
  pointer: string,
): Effect.fn.Return<NormalizedResponses> {
  const findings: Finding[] = [];
  const cases: PlainCase[] = [];
  const responses = { document: resolution.document, pointer };
  for (const text of yield* responseKeys(resolution, responses)) {
    const key = classifyKey(text);
    if (key === "invalid" || key === "out-of-range") {
      findings.push({
        at: childKey(responses, text),
        code: key === "invalid" ? "RSS-06/invalid-key" : "RSS-10/status-out-of-range",
      });
    } else if (key !== "extension") {
      cases.push(yield* caseOf(resolution, responses, text, key, findings));
    }
  }

  return {
    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach(items, f), not an array method
    diagnostics: yield* Effect.forEach(findings, (finding) => toDiagnostic(resolution, finding)),
    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach(items, f), not an array method
    responses: yield* Effect.forEach(cases, (plain) =>
      Schema.decodeUnknownEffect(ResponseCase)(plain).pipe(Effect.orDie),
    ),
  };
});

const keyRank = (key: ResponseCase["key"]): number => {
  if (key === "default") {
    return 2;
  }

  return "code" in key ? 0 : 1;
};

const keyValue = (key: ResponseCase["key"]): number => {
  if (key === "default") {
    return 0;
  }

  return "code" in key ? key.code : key.range;
};

const precedence = Order.combine(
  Order.mapInput(Order.Number, (response: ResponseCase) => keyRank(response.key)),
  Order.mapInput(Order.Number, (response: ResponseCase) => keyValue(response.key)),
);

/**
 * The matching order of the cases: explicit codes, then ranges, then `default` (design 7.3).
 */
export const precedenceOrder = (cases: readonly ResponseCase[]): readonly ResponseCase[] =>
  Arr.sort(cases, precedence);

const specificity = (alternative: MediaAlternative): number => {
  const essence = (alternative.mediaType.split(";")[0] ?? "").trim();
  if (essence === "*/*") {
    return 2;
  }

  return essence.endsWith("/*") ? 1 : 0;
};

/**
 * The order a response media type is looked up in: exact keys, then a type range, then the full
 * range, each in document order (design 6.6; `T30#response-content`).
 */
export const dispatchOrder = (
  alternatives: readonly MediaAlternative[],
): readonly MediaAlternative[] => Arr.sort(alternatives, Order.mapInput(Order.Number, specificity));
