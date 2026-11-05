import { Array as Arr, Data, Effect, Option, Order, Schema } from "effect";
import { MediaType, WireName } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import type { DiagnosticOperation } from "../model/diagnostic.ts";
import { Parameter } from "../model/entities.ts";
import { defsKey } from "../resolve/canonical.ts";
import { referenceAt } from "../resolve/index.ts";
import type { Resolution } from "../resolve/index.ts";
import { escapeToken, evaluatePointer } from "../model/pointer.ts";
import type { Line } from "../validate/index.ts";
import { specSectionUrl } from "../model/spec-section.ts";

/**
 * Where a parameter is read: its use site in the entry document, the operation it belongs to when
 * known, and the document's full `openapi` value.
 */
export interface ParameterSite {
  readonly openapi: string;
  readonly operation?: typeof DiagnosticOperation.Type;
  readonly pointer: string;
}

/**
 * What normalizing one Parameter Object produced. `Refused` keeps `required` so the operation
 * assembly can raise a refused required parameter to operation scope.
 */
export type ParameterOutcome =
  | {
      readonly _tag: "Implemented";
      readonly diagnostics: readonly Diagnostic[];
      readonly parameter: Parameter;
    }
  | { readonly _tag: "Ignored"; readonly diagnostics: readonly Diagnostic[] }
  | {
      readonly _tag: "Refused";
      readonly diagnostics: readonly Diagnostic[];
      readonly required: boolean;
    };

/**
 * The site is not a Parameter Object the earlier stages could have passed: validation, resolution
 * or the structure checks should have stopped it.
 */
export class ParameterNotReadable extends Data.TaggedError("ParameterNotReadable")<{
  readonly pointer: string;
  readonly reason:
    | "content-entry-count"
    | "line-mismatch"
    | "not-a-parameter"
    | "path-not-required"
    | "schema-xor-content";
}> {}

const styleNames = [
  "cookie",
  "deepObject",
  "form",
  "label",
  "matrix",
  "pipeDelimited",
  "simple",
  "spaceDelimited",
] as const;

type StyleName = (typeof styleNames)[number];

type Location = "cookie" | "header" | "path" | "query" | "querystring";

const ParameterObject = Schema.Struct({
  allowEmptyValue: Schema.optionalKey(Schema.Boolean),
  allowReserved: Schema.optionalKey(Schema.Boolean),
  content: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  deprecated: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  explode: Schema.optionalKey(Schema.Boolean),
  in: Schema.Literals(["cookie", "header", "path", "query", "querystring"]),
  name: Schema.String,
  required: Schema.optionalKey(Schema.Boolean),
  schema: Schema.optionalKey(Schema.Unknown),
  style: Schema.optionalKey(Schema.Literals(styleNames)),
});

type ParameterNode = typeof ParameterObject.Type;

const MediaTypeObject = Schema.Struct({ schema: Schema.optionalKey(Schema.Unknown) });

const rules: Record<Line, string> = { "3.0": "oas-3.0", "3.1": "oas-3.1", "3.2": "oas-3.2" };

const ignoredHeaders: ReadonlySet<string> = new Set(["accept", "authorization", "content-type"]);

const unsafeText = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

const formUrlencoded = /^application\/x-www-form-urlencoded[ \t]*(?:;|$)/iu;

// One row per legal (location, style, explode, allowReserved) of design 6.1; deepObject and the
// cookie rows are decided by `deepObjectRow` and `cookieFinding`.
const styleTable: readonly (readonly [string, StyleName, boolean, boolean, string])[] = [
  ["path", "matrix", false, false, "STY-01"],
  ["path", "matrix", true, false, "STY-02"],
  ["path", "label", false, false, "STY-03"],
  ["path", "label", true, false, "STY-04"],
  ["path", "simple", false, false, "STY-05"],
  ["path", "simple", true, false, "STY-06"],
  ["path", "matrix", false, true, "STY-07"],
  ["path", "matrix", true, true, "STY-08"],
  ["path", "label", false, true, "STY-09"],
  ["path", "label", true, true, "STY-10"],
  ["path", "simple", false, true, "STY-11"],
  ["path", "simple", true, true, "STY-12"],
  ["query", "form", true, false, "STY-13"],
  ["query", "form", false, false, "STY-14"],
  ["query", "form", true, true, "STY-15"],
  ["query", "form", false, true, "STY-16"],
  ["query", "spaceDelimited", false, false, "STY-17"],
  ["query", "spaceDelimited", true, false, "STY-18"],
  ["query", "spaceDelimited", false, true, "STY-19"],
  ["query", "spaceDelimited", true, true, "STY-20"],
  ["query", "pipeDelimited", false, false, "STY-21"],
  ["query", "pipeDelimited", true, false, "STY-22"],
  ["query", "pipeDelimited", false, true, "STY-23"],
  ["query", "pipeDelimited", true, true, "STY-24"],
  ["header", "simple", false, false, "STY-31"],
  ["header", "simple", true, false, "STY-32"],
];

const rowKey = (location: string, style: string, explode: boolean, allowReserved: boolean) =>
  `${location} ${style} ${explode} ${allowReserved}`;

const rowOf: ReadonlyMap<string, string> = new Map(
  styleTable.map(([location, style, explode, allowReserved, row]) => [
    rowKey(location, style, explode, allowReserved),
    row,
  ]),
);

// The rows whose style table says no value type fits (design 6.1; inventory "refused").
const explodeNotApplicable: ReadonlySet<string> = new Set(["STY-18", "STY-20", "STY-22", "STY-24"]);

const cookieStyles: Record<Line, readonly StyleName[]> = {
  "3.0": ["form"],
  "3.1": ["form"],
  "3.2": ["cookie", "form"],
};

const fixedStyles: Record<Exclude<Location, "cookie">, readonly StyleName[]> = {
  header: ["simple"],
  path: ["label", "matrix", "simple"],
  query: ["deepObject", "form", "pipeDelimited", "spaceDelimited"],
  querystring: [],
};

const stylesOf = (location: Location, line: Line): readonly StyleName[] =>
  location === "cookie" ? cookieStyles[line] : fixedStyles[location];

const defaultStyle = (location: Location): StyleName =>
  location === "path" || location === "header" ? "simple" : "form";

interface Finding {
  readonly anchor: string;
  readonly code: string;
  readonly element: string;
  readonly hint?: string;
  readonly message: string;
  readonly severity: "notice" | "refusal";
}

const refusal = (
  code: string,
  anchor: string,
  element: string,
  message: string,
  hint?: string,
): Finding => {
  const finding: Finding = { anchor, code, element, message, severity: "refusal" };

  return hint === undefined ? finding : { ...finding, hint };
};

const notice = (code: string, anchor: string, element: string, message: string): Finding => ({
  anchor,
  code,
  element,
  message,
  severity: "notice",
});

const notImplemented = (row: string, anchor: string, element: string): Finding =>
  refusal(
    `${row}/not-implemented`,
    anchor,
    element,
    "This construct is read but not implemented in Milestone 1.",
    "Milestone 2 implements this",
  );

const cookieNames = {
  "STY-33": "Parameter in cookie, style form",
  "STY-34": "Parameter in cookie, style form, explode false",
  "STY-35": "Parameter in cookie, style form, explode false",
  "STY-36": "Parameter in cookie, style form, allowReserved true",
  "STY-37": "Parameter in cookie, style form, explode false, allowReserved true",
  "STY-38": "Parameter in cookie, style cookie",
  "STY-39": "Parameter in cookie, style cookie, explode false",
} as const;

const permanentCookieRow = (style: StyleName, allowReserved: boolean) => {
  if (style === "cookie") {
    return "STY-39";
  }

  return allowReserved ? "STY-37" : "STY-35";
};

const stagedCookieRow = (style: StyleName, explode: boolean, allowReserved: boolean) => {
  if (!explode) {
    return "STY-34";
  }

  if (style === "cookie") {
    return "STY-38";
  }

  return allowReserved ? "STY-36" : "STY-33";
};

// STY-33, 34, 36 and 38 are what Milestone 2 implements; STY-35, 37 and 39 are refused for good.
const cookieFinding = (
  line: Line,
  style: StyleName,
  explode: boolean,
  allowReserved: boolean,
): Finding => {
  if (!explode && line === "3.2") {
    const row = permanentCookieRow(style, allowReserved);

    return refusal(
      `${row}/cookie-explode-false`,
      "style-values",
      cookieNames[row],
      "A cookie parameter cannot have explode false in 3.2.",
      "refused (permanent): explode: false is invalid with in: cookie",
    );
  }

  const row = stagedCookieRow(style, explode, allowReserved);

  return notImplemented(row, "style-values", cookieNames[row]);
};

const deepObjectRow = (line: Line, explode: boolean, allowReserved: boolean): string => {
  if (line === "3.2") {
    return allowReserved ? "STY-30" : "STY-27";
  }

  if (allowReserved) {
    return explode ? "STY-28" : "STY-29";
  }

  return explode ? "STY-25" : "STY-26";
};

interface StylePlan {
  readonly allowReserved: boolean;
  readonly explode: boolean;
  readonly kind: "style";
  readonly row: string;
  readonly style: StyleName;
}

interface ContentPlan {
  readonly kind: "content";
  readonly mediaType: string;
  readonly row: string;
  readonly schemaKey: string;
}

type Decision =
  | {
      readonly _tag: "Build";
      readonly findings: readonly Finding[];
      readonly plan: ContentPlan | StylePlan;
    }
  | { readonly _tag: "Ignore"; readonly findings: readonly Finding[] }
  | { readonly _tag: "Refuse"; readonly finding: Finding };

const refuse = (finding: Finding): Decision => ({ _tag: "Refuse", finding });

const styleLocation = refusal(
  "STY-40/style-location",
  "style-values",
  "Parameter style",
  "The style is not defined for the parameter's location in this OpenAPI line.",
  "Use a style that the parameter's location defines",
);

const allowEmptyValueIgnored = notice(
  "PRM-08/allow-empty-value-ignored",
  "parameter-allow-empty-value",
  "Parameter allowEmptyValue",
  "allowEmptyValue applies only to a query parameter with a style, so it is ignored here.",
);

const headerEncoding = notice(
  "PRM-32/header-percent-encoding",
  "appendix-d-serializing-headers-and-cookies",
  "Header parameter percent-encoding",
  "The 3.0 text implies percent-encoding of header values; 3.1 calls that a mistake, so none is applied.",
);

const allowReservedIgnored = notice(
  "PRM-35/allow-reserved-ignored",
  "parameter-allow-reserved",
  "Parameter allowReserved",
  "allowReserved does not apply to this parameter in this OpenAPI line, so it is ignored.",
);

const deepObjectExplode = (row: string): Finding =>
  notice(
    `${row}/explode-no-effect`,
    "parameter-explode",
    "Parameter deepObject explode",
    "The 3.2 text says explode has no effect for deepObject; it is applied to this line, so the value is exploded.",
  );

const explodeNotApplicableFinding = (row: string): Finding =>
  refusal(
    `${row}/explode-not-applicable`,
    "style-values",
    "Parameter style with explode true",
    "The style table defines no value type for this style with explode true.",
  );

const decideContent = (
  node: ParameterNode,
  mediaType: string,
  schemaKey: Option.Option<string>,
): Decision => {
  if (node.in === "cookie") {
    return refuse(
      notImplemented("PRM-24", "parameter-content", "Parameter in cookie with content"),
    );
  }

  if (Option.isNone(Schema.decodeUnknownOption(MediaType)(mediaType))) {
    return refuse(
      refusal(
        "PRM-15/invalid-media-type",
        "parameter-content",
        "Parameter content media type",
        "The content key is not a concrete media type.",
      ),
    );
  }

  if (Option.isNone(schemaKey)) {
    return refuse(
      refusal(
        "PRM-15/missing-schema",
        "parameter-content",
        "Parameter content media type",
        "The content entry has no schema, so the value has no type.",
      ),
    );
  }

  return {
    _tag: "Build",
    findings: node.allowEmptyValue === true ? [allowEmptyValueIgnored] : [],
    plan: {
      kind: "content",
      mediaType,
      row: node.in === "header" ? "PRM-24" : "PRM-23",
      schemaKey: schemaKey.value,
    },
  };
};

// Whether the line's text gives allowReserved a meaning for this location and style.
const honorsAllowReserved = (node: ParameterNode, style: StyleName, line: Line): boolean => {
  if (node.in === "query") {
    return true;
  }

  return line === "3.2" && (node.in === "path" || (node.in === "cookie" && style === "form"));
};

const styleNotices = (
  node: ParameterNode,
  line: Line,
  honored: boolean,
  deepRow: string | undefined,
): readonly Finding[] => {
  const findings: Finding[] = [];
  if (node.allowEmptyValue === true && node.in !== "query") {
    findings.push(allowEmptyValueIgnored);
  }

  if (line === "3.0" && node.in === "header") {
    findings.push(headerEncoding);
  }

  if (node.allowReserved === true && !honored) {
    findings.push(allowReservedIgnored);
  }

  if (deepRow !== undefined && line !== "3.2" && node.explode !== true) {
    findings.push(deepObjectExplode(deepRow));
  }

  return findings;
};

const decideStyle = (node: ParameterNode, line: Line): Decision => {
  const location = node.in;
  const style = node.style ?? defaultStyle(location);
  const explode = node.explode ?? (style === "form" || style === "cookie");
  if (!stylesOf(location, line).includes(style)) {
    return refuse(styleLocation);
  }

  const honored = honorsAllowReserved(node, style, line);
  const allowReserved = honored && node.allowReserved === true;
  if (location === "cookie") {
    return refuse(cookieFinding(line, style, explode, allowReserved));
  }

  const deepRow =
    style === "deepObject" ? deepObjectRow(line, node.explode === true, allowReserved) : undefined;
  const row = deepRow ?? rowOf.get(rowKey(location, style, explode, allowReserved));
  if (row === undefined) {
    return refuse(styleLocation);
  }

  if (explodeNotApplicable.has(row)) {
    return refuse(explodeNotApplicableFinding(row));
  }

  return {
    _tag: "Build",
    findings: styleNotices(node, line, honored, deepRow),
    plan: {
      allowReserved,
      explode: explode || deepRow !== undefined,
      kind: "style",
      row,
      style,
    },
  };
};

const decideName = (node: ParameterNode): Decision | undefined => {
  const name = node.name.toLowerCase();
  if (node.in === "header" && ignoredHeaders.has(name)) {
    return {
      _tag: "Ignore",
      findings: [
        notice(
          "PRM-19/ignored-header",
          "parameter-name",
          "Header parameter Accept, Content-Type or Authorization",
          "The specification says this header parameter SHALL be ignored; the generated CLI sets the header itself.",
        ),
      ],
    };
  }

  if (node.in === "header" && name === "cookie") {
    return refuse(
      refusal(
        "PRM-21/cookie-header",
        "parameter-name",
        "Header parameter Cookie",
        "A header parameter named Cookie has no defined effect.",
        "Describe cookies with a parameter in: cookie",
      ),
    );
  }

  if (Option.isNone(Schema.decodeUnknownOption(WireName)(node.name))) {
    return refuse(
      refusal(
        "PRM-02/invalid-name",
        "parameter-name",
        "Parameter name",
        "The parameter name contains control characters or lone surrogates.",
      ),
    );
  }

  return undefined;
};

type Media = Option.Option<readonly [string, Option.Option<string>]>;

const decide = (node: ParameterNode, line: Line, media: Media): Decision => {
  const named = decideName(node);
  if (named !== undefined) {
    return named;
  }

  if (node.in === "querystring") {
    return refuse(
      Option.exists(media, ([mediaType]) => formUrlencoded.test(mediaType))
        ? notImplemented(
            "STY-43",
            "parameter-object-examples",
            "Parameter in querystring with form-urlencoded content",
          )
        : notImplemented("STY-42", "parameter-locations", "Parameter in querystring"),
    );
  }

  return Option.match(media, {
    onNone: () => decideStyle(node, line),
    onSome: ([mediaType, schemaKey]) => decideContent(node, mediaType, schemaKey),
  });
};

// What the earlier stages guarantee; a violation means one of them let something through.
const contractReason = (
  node: ParameterNode,
  line: Line,
): ParameterNotReadable["reason"] | undefined => {
  if (node.in === "querystring" && line !== "3.2") {
    return "line-mismatch";
  }

  if ((node.schema === undefined) === (node.content === undefined)) {
    return "schema-xor-content";
  }

  if (node.content === undefined && node.in === "querystring") {
    return "schema-xor-content";
  }

  if (node.content !== undefined && Object.keys(node.content).length !== 1) {
    return "content-entry-count";
  }

  return node.in === "path" && node.required !== true ? "path-not-required" : undefined;
};

const sanitize = (text: string): string => text.replaceAll(unsafeText, "");

const schemaKeyAt = (resolution: Resolution, pointer: string): string =>
  referenceAt(resolution, pointer)?.defsKey ??
  defsKey(resolution.document, { document: resolution.document, pointer });

// The schema key of a content entry's media type object, which 3.2 lets be a reference.
const mediaSchemaKey = (
  resolution: Resolution,
  mediaPointer: string,
): Effect.Effect<Option.Option<string>> => {
  const home = referenceAt(resolution, mediaPointer)?.target.pointer ?? mediaPointer;

  return evaluatePointer(resolution.value, home).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(MediaTypeObject)),
    Effect.map((media) =>
      media.schema === undefined
        ? Option.none()
        : Option.some(schemaKeyAt(resolution, `${home}/schema`)),
    ),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
};

interface Related {
  readonly document: string;
  readonly pointer: string;
}

interface DiagnosticFields {
  code: string;
  document: string;
  element: string;
  hint?: string;
  message: string;
  openapi: string;
  operation?: typeof DiagnosticOperation.Type;
  pointer: string;
  related?: readonly Related[];
  row: string;
  scope: "element";
  severity: "notice" | "refusal";
  specSection: string;
  wire?: string;
}

const toDiagnostics = (
  resolution: Resolution,
  site: ParameterSite,
  related: readonly Related[],
  wireName: string,
  findings: readonly Finding[],
): Effect.Effect<readonly Diagnostic[]> => {
  const wire = sanitize(wireName);

  return Effect.all(
    findings.map((finding) => {
      const fields: DiagnosticFields = {
        code: finding.code,
        document: resolution.document,
        element: finding.element,
        message: finding.message,
        openapi: site.openapi,
        pointer: site.pointer,
        row: finding.code.slice(0, finding.code.indexOf("/")),
        scope: "element",
        severity: finding.severity,
        specSection: specSectionUrl(resolution.line, finding.anchor),
      };
      if (finding.hint !== undefined) {
        fields.hint = finding.hint;
      }

      if (site.operation !== undefined) {
        fields.operation = site.operation;
      }

      if (related.length > 0) {
        fields.related = related;
      }

      if (wire !== "") {
        fields.wire = wire;
      }

      return Schema.decodeUnknownEffect(Diagnostic)(fields);
    }),
  ).pipe(Effect.orDie);
};

const sorted = (rows: readonly string[]): readonly string[] =>
  Arr.sort(Arr.dedupe(rows), Order.String);

interface Docs {
  description?: string;
  summary?: string;
}

const docsOf = (description: string | undefined, summary: string | undefined): Docs => {
  const docs: Docs = {};
  if (description !== undefined) {
    docs.description = sanitize(description);
  }

  if (summary !== undefined) {
    docs.summary = sanitize(summary);
  }

  return docs;
};

interface Source {
  readonly node: ParameterNode;
  readonly reference: ReturnType<typeof referenceAt>;
  readonly related: readonly Related[];
  readonly target: Related;
}

const read = (
  resolution: Resolution,
  site: ParameterSite,
): Effect.Effect<Source, ParameterNotReadable> => {
  const unreadable = new ParameterNotReadable({ pointer: site.pointer, reason: "not-a-parameter" });
  const reference = referenceAt(resolution, site.pointer);
  const target = reference?.target ?? { document: resolution.document, pointer: site.pointer };
  if (target.document !== resolution.document) {
    return Effect.fail(unreadable);
  }

  return evaluatePointer(resolution.value, target.pointer).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ParameterObject)),
    Effect.mapError(() => unreadable),
    Effect.map((node) => ({
      node,
      reference,
      related: reference === undefined ? [] : [target],
      target,
    })),
  );
};

const mediaOf = (resolution: Resolution, source: Source): Effect.Effect<Media> => {
  const [mediaType] = Object.keys(source.node.content ?? {});
  if (mediaType === undefined) {
    return Effect.succeed(Option.none());
  }

  const pointer = `${source.target.pointer}/content/${escapeToken(mediaType)}`;

  return mediaSchemaKey(resolution, pointer).pipe(
    Effect.map((key) => Option.some([mediaType, key] as const)),
  );
};

const serializationOf = (
  node: ParameterNode,
  plan: ContentPlan | StylePlan,
  line: Line,
  origin: Related,
) => {
  if (plan.kind === "content") {
    return {
      kind: plan.kind,
      mediaType: plan.mediaType,
      origin,
      rows: sorted(["PRM-15", plan.row]),
      rules: rules[line],
      schema: { key: plan.schemaKey },
    };
  }

  const honored = node.in === "query" && node.allowEmptyValue === true;

  return {
    allowReserved: plan.allowReserved,
    explode: plan.explode,
    kind: plan.kind,
    origin,
    rows: sorted(honored ? [plan.row, "PRM-08"] : [plan.row]),
    rules: rules[line],
    style: plan.style,
  };
};

const parameterRows = (node: ParameterNode, plan: ContentPlan | StylePlan): readonly string[] => {
  if (plan.kind === "content") {
    return ["PRM-01", "PRM-15"];
  }

  return node.in === "query" && node.allowEmptyValue === true ? ["PRM-01", "PRM-08"] : ["PRM-01"];
};

const build = (
  resolution: Resolution,
  site: ParameterSite,
  source: Source,
  plan: ContentPlan | StylePlan,
) => {
  const { node, reference, target } = source;
  const origin = { document: resolution.document, pointer: site.pointer };
  const schemaKey =
    plan.kind === "content" ? plan.schemaKey : schemaKeyAt(resolution, `${target.pointer}/schema`);

  return Schema.decodeUnknownEffect(Parameter)({
    deprecated: node.deprecated ?? false,
    docs: docsOf(reference?.description ?? node.description, reference?.summary),
    location: node.in,
    origin,
    required: node.required ?? false,
    rows: sorted(parameterRows(node, plan)),
    schema: { key: schemaKey },
    serialization: serializationOf(node, plan, resolution.line, origin),
    wireName: node.name,
  }).pipe(Effect.orDie);
};

/**
 * Normalizes one Parameter Object into a `Parameter`, a notice-only ignore, or an element-scope
 * refusal (design 2.2, 6.1, 6.2). Defaults come from the line's text, never from a schema
 * `default`. A site the earlier stages should have stopped fails with `ParameterNotReadable`.
 */
export const normalizeParameter = (
  resolution: Resolution,
  site: ParameterSite,
): Effect.Effect<ParameterOutcome, ParameterNotReadable> =>
  Effect.gen(function* normalize() {
    const source = yield* read(resolution, site);
    const reason = contractReason(source.node, resolution.line);
    if (reason !== undefined) {
      return yield* new ParameterNotReadable({ pointer: site.pointer, reason });
    }

    const decision = decide(source.node, resolution.line, yield* mediaOf(resolution, source));
    const diagnostics = (findings: readonly Finding[]) =>
      toDiagnostics(resolution, site, source.related, source.node.name, findings);
    if (decision._tag === "Ignore") {
      return { _tag: "Ignored", diagnostics: yield* diagnostics(decision.findings) };
    }

    if (decision._tag === "Refuse") {
      return {
        _tag: "Refused",
        diagnostics: yield* diagnostics([decision.finding]),
        required: source.node.required ?? false,
      };
    }

    return {
      _tag: "Implemented",
      diagnostics: yield* diagnostics(decision.findings),
      parameter: yield* build(resolution, site, source, decision.plan),
    };
  });
