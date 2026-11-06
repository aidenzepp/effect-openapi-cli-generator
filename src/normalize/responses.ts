import { Array as Arr, Effect, Option, Order, Schema } from "effect";
import { sanitizeProse } from "../emit/help.ts";
import { HeaderName, MediaRange } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import { ResponseCase } from "../model/entities.ts";
import type { MediaAlternative } from "../model/entities.ts";
import { defsKey } from "../resolve/canonical.ts";
import type { CanonicalKey } from "../resolve/canonical.ts";
import type { Resolution, ResolvedReference } from "../resolve/index.ts";
import { specSectionUrl } from "../model/spec-section.ts";
import { childKey, follow, nodeIn, referenceIn } from "./document-set.ts";

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
  itemSchema: Schema.optionalKey(Schema.Unknown),
  schema: Schema.optionalKey(Schema.Unknown),
});

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

type Plain<T> = { -readonly [K in keyof T]: T[K] };

type PlainAlternative = Plain<typeof MediaAlternative.Encoded>;

type PlainCase = Plain<typeof ResponseCase.Encoded>;

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

const sequential: ReadonlyMap<string, Codec> = new Map([
  ["application/json-seq", "jsonseq"],
  ["application/jsonl", "ndjson"],
  ["application/ndjson", "ndjson"],
  ["application/x-ndjson", "ndjson"],
  ["text/event-stream", "sse"],
]);

// The codec follows the media type alone, never the schema (design 2.2). A range, or a type no
// other family claims, is bytes.
const codecOf = (mediaType: string): Codec => {
  const essence = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  const known = sequential.get(essence);
  if (known !== undefined) {
    return known;
  }

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

const alternativeOf = (
  resolution: Resolution,
  response: CanonicalKey,
  mediaType: string,
  findings: Finding[],
): Effect.Effect<Option.Option<PlainAlternative>> =>
  Effect.gen(function* alternative() {
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

const headersOf = (
  headers: readonly string[],
  response: CanonicalKey,
  findings: Finding[],
): PlainCase["headers"] => {
  const names: PlainCase["headers"][number][] = [];
  for (const name of headers) {
    const at = childKey(response, "headers", name);
    if (name.toLowerCase() === "content-type") {
      findings.push({ at, code: "RSP-09/ignored-content-type" });
    } else if (isHeaderName(name)) {
      names.push({ name });
    } else {
      findings.push({ at, code: "RSP-09/invalid-header-name" });
    }
  }

  return names;
};

const docsOf = (
  response: typeof ResponseObject.Type,
  site: ResolvedReference | undefined,
): PlainCase["docs"] => {
  const description = site?.description ?? response.description;
  const summary = site?.summary ?? response.summary;
  const docs: Plain<PlainCase["docs"]> = {};
  if (description !== undefined) {
    docs.description = sanitizeProse(description);
  }

  if (summary !== undefined) {
    docs.summary = sanitizeProse(summary);
  }

  return docs;
};

const caseOf = (
  resolution: Resolution,
  responses: CanonicalKey,
  text: string,
  key: ResponseCase["key"],
  findings: Finding[],
): Effect.Effect<PlainCase> =>
  Effect.gen(function* responseCase() {
    const site = childKey(responses, text);
    const home = follow(resolution, site);
    const response = yield* nodeIn(resolution, home).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ResponseObject)),
      Effect.orDie,
    );
    const alternatives = Arr.getSomes(
      yield* Effect.all(
        Object.keys(response.content ?? {}).map((mediaType) =>
          alternativeOf(resolution, home, mediaType, findings),
        ),
      ),
    );
    const headers = headersOf(Object.keys(response.headers ?? {}), home, findings);
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
  const [row = ""] = finding.code.split("/");
  const openapi = Schema.decodeUnknownOption(Schema.Struct({ openapi: Schema.String }))(
    resolution.value,
  ).pipe(
    Option.map((declared) => declared.openapi),
    Option.getOrElse(() => "unknown"),
  );
  const fields: Plain<typeof Diagnostic.Encoded> = {
    code: finding.code,
    document: finding.at.document,
    element: rule.element,
    message: rule.message,
    openapi,
    pointer: finding.at.pointer,
    row,
    scope: "element",
    severity: rule.severity,
    specSection: specSectionUrl(resolution.line, rule.anchor),
  };
  if (rule.hint !== undefined) {
    fields.hint = rule.hint;
  }

  return Schema.decodeUnknownEffect(Diagnostic)(fields).pipe(Effect.orDie);
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
 * (`RSP-09`). Headers are recorded by name only: they never change output. An absent Responses
 * Object has no cases, and `x-` keys are NZ-5's to account for. Schemas are referenced by `$defs`
 * key, an inline one by `defsKey` of its canonical pointer. A response or media type a reference
 * takes into another document of the set is read there, and its findings name that document.
 */
export const normalizeResponses = (
  resolution: Resolution,
  pointer: string,
): Effect.Effect<NormalizedResponses> =>
  Effect.gen(function* normalize() {
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
      diagnostics: yield* Effect.all(findings.map((finding) => toDiagnostic(resolution, finding))),
      responses: yield* Effect.all(
        cases.map((plain) => Schema.decodeUnknownEffect(ResponseCase)(plain).pipe(Effect.orDie)),
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
