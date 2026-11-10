import { Array as Arr, Effect, HashMap, Option, Order, Record, Schema } from "effect";
import type { AuthorConfig } from "../model/author-config.ts";
import { MediaType, WireName } from "../model/brands.ts";
import { diagnosticOf } from "../model/diagnostic.ts";
import type { Diagnostic, DiagnosticOperation } from "../model/diagnostic.ts";
import { Parameter } from "../model/entities.ts";
import { keyOf } from "../resolve/canonical.ts";
import type { CanonicalKey } from "../resolve/canonical.ts";
import type { Resolution, ResolvedReference } from "../resolve/index.ts";
import type { Line } from "../validate/index.ts";
import { specSectionUrl } from "../model/spec-section.ts";
import { docsOf, sanitize } from "./docs.ts";
import { childKey, follow, nodeIn, referenceIn } from "./document-set.ts";
import { appliesDynamicKeyword, budgetOf, charge, schemaKeyAt } from "./schemas.ts";
import type { Budget, SchemaLimits } from "./schemas.ts";

/**
 * Where a parameter is read: its use site in the entry document, the operation it belongs to when
 * known, and the document's full `openapi` value. `nonStandard` carries the author config's opt-in
 * switches of the same name; absent is strict (design 6.1, D-OQ1).
 */
export interface ParameterSite {
  readonly nonStandard?: AuthorConfig["nonStandard"];
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
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError<Self>()(tag, fields) declares a class; nothing is thrown
export class ParameterNotReadable extends Schema.TaggedError<ParameterNotReadable>()(
  "ParameterNotReadable",
  {
    pointer: Schema.String,
    reason: Schema.Literals([
      "content-entry-count",
      "line-mismatch",
      "not-a-parameter",
      "path-not-required",
      "schema-xor-content",
    ]),
  },
) {}

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
  // Any value decodes; only `true` marks the value sensitive, so a malformed mark never refuses.
  "x-sensitive": Schema.optionalKey(Schema.Unknown),
});

type ParameterNode = typeof ParameterObject.Type;

const MediaTypeObject = Schema.Struct({ schema: Schema.optionalKey(Schema.Unknown) });

const rules: Record<Line, string> = { "3.0": "oas-3.0", "3.1": "oas-3.1", "3.2": "oas-3.2" };

const ignoredHeaders: ReadonlySet<string> = new Set(["accept", "authorization", "content-type"]);

// One row per legal (location, style, explode, allowReserved) of design 6.1; deepObject and the
// cookie rows are decided by `deepObjectRow` and `decideCookie`.
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

// The style table's row by its `[location, style, explode, allowReserved]` key; a lookup builds a
// fresh key, compared structurally.
const rowOf = HashMap.fromIterable<
  readonly [location: string, style: string, explode: boolean, allowReserved: boolean],
  string
>(
  styleTable.map(([location, style, explode, allowReserved, row]) => [
    [location, style, explode, allowReserved],
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

/**
 * One diagnostic a parameter rule produces, before it is placed at a site. Form Encoding entries
 * reuse the style table's refusals through `formStyleRefusal` (design 6.3).
 */
export interface Finding {
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
  readonly nonStandard?: "deepObjectBrackets";
  readonly nonStandardScalars?: "deepObjectScalars";
  readonly row: string;
  readonly style: StyleName;
}

interface ContentPlan {
  readonly kind: "content";
  readonly mediaType: string;
  readonly rows: readonly string[];
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

const cookieExplodeFalse = (style: StyleName, allowReserved: boolean): Finding => {
  const row = permanentCookieRow(style, allowReserved);

  return refusal(
    `${row}/cookie-explode-false`,
    "style-values",
    cookieNames[row],
    "A cookie parameter cannot have explode false in 3.2.",
    "refused (permanent): explode: false is invalid with in: cookie",
  );
};

const cookieFormMultiple = refusal(
  "PRM-34/cookie-form-multiple",
  "appendix-d-serializing-headers-and-cookies",
  "Parameter in cookie, style form, array or object",
  "A form cookie cannot carry an array or object, exploded or not; the specification calls it always incorrect.",
  "Use a primitive schema, or style: cookie in 3.2",
);

// STY-33, 34, 36 and 38 build; STY-35, 37 and 39 are refused for good, and so is any form cookie
// over an array or object, whatever explode is (PRM-34, Appendix D). A 3.2 explode false form
// cookie reports its STY row alone.
const decideCookie = (
  line: Line,
  plan: Omit<StylePlan, "kind" | "row">,
  multiple: boolean,
  findings: readonly Finding[],
): Decision => {
  const { allowReserved, explode, style } = plan;
  if (!explode && line === "3.2") {
    return refuse(cookieExplodeFalse(style, allowReserved));
  }

  if (style === "form" && multiple) {
    return refuse(cookieFormMultiple);
  }

  return {
    _tag: "Build",
    findings,
    plan: { ...plan, kind: "style", row: stagedCookieRow(style, explode, allowReserved) },
  };
};

// In the entry document, official-schema validation (VAL-02 to VAL-04) refuses a style its
// location does not define before this runs; a parameter in another document-set member, which is
// not schema-validated, reaches this refusal.
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

/**
 * What a 3.0 header notice says: `PRM-32` for a header parameter, `HDR-15` for a schema-serialized
 * response header (design D-OC9).
 */
export const headerPercentEncoding =
  "The 3.0 text implies percent-encoding of header values; 3.1 calls that a mistake, so none is applied.";

const headerEncoding = notice(
  "PRM-32/header-percent-encoding",
  "appendix-d-serializing-headers-and-cookies",
  "Header parameter percent-encoding",
  headerPercentEncoding,
);

const allowReservedIgnored = notice(
  "PRM-35/allow-reserved-ignored",
  "parameter-allow-reserved",
  "Parameter allowReserved",
  "allowReserved does not apply to this parameter in this OpenAPI line, so it is ignored.",
);

/**
 * The STY-26 notice text for a 3.0 or 3.1 `deepObject` whose `explode` is false or omitted; form
 * Encoding rules share it (ENC-12).
 */
export const deepObjectExplodeText =
  "The 3.2 text says explode has no effect for deepObject; it is applied to this line, so the value is exploded.";

const deepObjectExplode = (row: string): Finding =>
  notice(
    `${row}/explode-no-effect`,
    "parameter-explode",
    "Parameter deepObject explode",
    deepObjectExplodeText,
  );

const compoundNested = refusal(
  "PRM-27/compound-nested",
  "style-values",
  "Parameter style deepObject",
  "deepObject is defined only for an object with scalar members; this schema is an array or has an object or array member.",
  "Flatten the parameter, or set nonStandard.deepObjectBrackets in the author config to send the bracket convention",
);

// PRM-27 (style-values): deepObject is defined only for an object; a schema that also admits a
// value that is not an object would generate a flag the runtime refuses for every value.
const nonObjectSchema = refusal(
  "PRM-27/non-object-schema",
  "style-values",
  "Parameter style deepObject",
  "deepObject is defined only for an object; this schema also admits a value that is not an object.",
  "Give the parameter an object schema, or use style: form",
);

/**
 * The code of the bracket switch's notice (design 6.1 Bracket switch), on parameters and bodies.
 */
export const bracketChoiceCode = "PRM-27/bracket-author-choice";

/**
 * The code of the scalar switch's notice (design 6.1 Scalar switch), on parameters and bodies.
 */
export const scalarChoiceCode = "PRM-27/scalar-author-choice";

/**
 * The notices of the author config's deepObject switches, which go with an element that is not
 * sent (design 8.5 rule 7).
 */
export const authorChoiceCodes: ReadonlySet<string> = new Set([
  bracketChoiceCode,
  scalarChoiceCode,
]);

const bracketAuthorChoice = notice(
  bracketChoiceCode,
  "style-values",
  "Parameter style deepObject",
  "The author config's nonStandard.deepObjectBrackets sends this nested deepObject value in the bracket convention, which the specification does not define.",
);

const scalarAuthorChoice = notice(
  scalarChoiceCode,
  "style-values",
  "Parameter style deepObject",
  "The author config's nonStandard.deepObjectScalars sends a scalar value of this deepObject parameter as name=value, which the specification does not define.",
);

const cookieName = refusal(
  "PRM-02/invalid-cookie-name",
  "parameter-name",
  "Parameter in cookie name",
  "The cookie parameter name is not an RFC 6265 token.",
  "Use a name made of RFC 9110 token characters",
);

// In the entry document, official-schema validation (VAL-04) refuses these fields on a querystring
// parameter before this runs; a parameter in another document-set member, which is not
// schema-validated, reaches this refusal.
const querystringSchemaFields = refusal(
  "STY-45/querystring-schema-fields",
  "fixed-fields-for-use-with-schema",
  "Parameter in querystring with schema fields",
  "A querystring parameter cannot use schema, style, explode or allowReserved.",
  "Describe the query string with exactly one content entry",
);

// An RFC 6265 cookie-name is an RFC 9110 token.
const cookieNameToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

// The rows a content-based parameter's serialization rests on, by location.
const contentRows = (location: Location): readonly string[] => {
  if (location === "querystring") {
    return ["STY-42", "STY-43"];
  }

  return location === "header" || location === "cookie" ? ["PRM-24"] : ["PRM-23"];
};

// The style table defines spaceDelimited and pipeDelimited for an array or object only.
const delimitedStyles: ReadonlySet<StyleName> = new Set(["pipeDelimited", "spaceDelimited"]);

const primitiveNotApplicableFinding = (row: string): Finding =>
  refusal(
    `${row}/primitive-not-applicable`,
    "style-values",
    "Parameter style spaceDelimited or pipeDelimited over a primitive",
    "The style table defines this style only for an array or object; this schema is a primitive.",
    "Use an array or object schema, or style: form",
  );

const explodeNotApplicableFinding = (row: string): Finding =>
  refusal(
    `${row}/explode-not-applicable`,
    "style-values",
    "Parameter style with explode true",
    "The style table defines no value type for this style with explode true.",
  );

const decideContent = (node: ParameterNode, content: Content): Decision => {
  const { mediaType, schemaKey } = content;
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
      rows: contentRows(node.in),
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
  deepRow?: string,
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

/**
 * What the author config's scalar switch makes of a `deepObject` schema (design 6.1 Scalar
 * switch). `Strict`: the switch is off, or the schema has no scalar branch or has a branch no
 * switch covers (`null`, untyped, unresolved), so the strict rules decide (`PRM-27/non-object-
 * schema` when it admits a non-object). `Uncovered`: a nested branch the bracket switch is off for,
 * or a member union neither switch defines (`PRM-27/compound-nested`). `Covered`: every branch is
 * covered and a scalar one by the scalar switch; `nested` when the bracket switch covers one.
 */
export type ScalarCover =
  | { readonly _tag: "Covered"; readonly nested: boolean }
  | { readonly _tag: "Strict" }
  | { readonly _tag: "Uncovered" };

const strictCover: ScalarCover = { _tag: "Strict" };

/**
 * What the schema shape and the author config add to a parameter's decision: `multiple` for a
 * cookie over an array or object (PRM-34), `nested` for a `deepObject` value beyond one level
 * (PRM-27), `nonObject` for a `deepObject` schema that admits a value that is not an object
 * (PRM-27), `primitive` for a schema that declares only primitive types (STY-17, STY-21),
 * `brackets` for the author config's bracket switch and `scalars` for what its scalar switch makes
 * of a `deepObject` schema (design 6.1 Scalar switch).
 */
interface Traits {
  readonly brackets: boolean;
  readonly multiple: boolean;
  readonly nested: boolean;
  readonly nonObject: boolean;
  readonly primitive: boolean;
  readonly scalars: ScalarCover;
}

// The style table's applicability checks (design 6.1): explode true where no value type fits,
// a delimited style over a primitive, and deepObject over a schema that admits non-objects
// (PRM-27). Query parameters and form Encoding entries (design 6.3) share them.
const inapplicable = (
  row: string,
  style: StyleName,
  traits: Pick<Traits, "nonObject" | "primitive">,
): Finding | undefined => {
  if (explodeNotApplicable.has(row)) {
    return explodeNotApplicableFinding(row);
  }

  if (delimitedStyles.has(style) && traits.primitive) {
    return primitiveNotApplicableFinding(row);
  }

  return style === "deepObject" && traits.nonObject ? nonObjectSchema : undefined;
};

// Which deepObject switches send a value, or none when an uncovered nested branch refuses it
// (PRM-27/compound-nested): under the scalar switch the branch walk decides; otherwise the strict
// nested test, which the bracket switch marks instead of refusing.
interface Marks {
  readonly nested: boolean;
  readonly scalars: boolean;
}

const deepObjectMarks = (
  cover: ScalarCover,
  strictNested: boolean,
  brackets: boolean,
): Marks | undefined => {
  if (cover._tag === "Uncovered") {
    return undefined;
  }

  const nested = cover._tag === "Covered" ? cover.nested : strictNested;

  return nested && !brackets ? undefined : { nested, scalars: cover._tag === "Covered" };
};

const markedPlan = (plan: StylePlan, marks: Marks): StylePlan => {
  const bracketed: StylePlan = marks.nested ? { ...plan, nonStandard: "deepObjectBrackets" } : plan;

  return marks.scalars ? { ...bracketed, nonStandardScalars: "deepObjectScalars" } : bracketed;
};

const decideStyle = (node: ParameterNode, line: Line, traits: Traits): Decision => {
  const location = node.in;
  const style = node.style ?? defaultStyle(location);
  const explode = node.explode ?? (style === "form" || style === "cookie");
  if (!stylesOf(location, line).includes(style)) {
    return refuse(styleLocation);
  }

  const honored = honorsAllowReserved(node, style, line);
  const allowReserved = honored && node.allowReserved === true;
  if (location === "cookie") {
    const findings = styleNotices(node, line, honored);

    return decideCookie(line, { allowReserved, explode, style }, traits.multiple, findings);
  }

  const deepRow =
    style === "deepObject" ? deepObjectRow(line, node.explode === true, allowReserved) : undefined;
  const row =
    deepRow ?? Option.getOrUndefined(HashMap.get(rowOf, [location, style, explode, allowReserved]));
  if (row === undefined) {
    return refuse(styleLocation);
  }

  // PRM-27: a deepObject over a schema that admits non-objects is refused, bracket switch or not,
  // unless the scalar switch's branch walk decides it (design 6.1 Scalar switch).
  const cover = deepRow === undefined ? strictCover : traits.scalars;
  const blocked = inapplicable(
    row,
    style,
    cover._tag === "Strict" ? traits : { ...traits, nonObject: false },
  );
  if (blocked !== undefined) {
    return refuse(blocked);
  }

  const marks = deepObjectMarks(cover, deepRow !== undefined && traits.nested, traits.brackets);
  if (marks === undefined) {
    return refuse(compoundNested);
  }

  const plan: StylePlan = {
    allowReserved,
    explode: explode || deepRow !== undefined,
    kind: "style",
    row,
    style,
  };

  return {
    _tag: "Build",
    findings: [
      ...styleNotices(node, line, honored, deepRow),
      ...(marks.nested ? [bracketAuthorChoice] : []),
      ...(marks.scalars ? [scalarAuthorChoice] : []),
    ],
    plan: markedPlan(plan, marks),
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

  return node.in === "cookie" && !cookieNameToken.test(node.name) ? refuse(cookieName) : undefined;
};

// A parameter's one content entry: its media type and the schema key of its media type object.
// A `querystring` form entry's Encoding Objects are decided by the body form rules (design 6.1), in
// the operation assembly.
interface Content {
  readonly mediaType: string;
  readonly schemaKey: Option.Option<string>;
}

type Media = Option.Option<Content>;

// STY-45: a querystring is content only.
const usesSchemaFields = (node: ParameterNode): boolean =>
  node.schema !== undefined ||
  node.style !== undefined ||
  node.explode !== undefined ||
  node.allowReserved !== undefined;

const decide = (node: ParameterNode, line: Line, media: Media, traits: Traits): Decision => {
  const named = decideName(node);
  if (named !== undefined) {
    return named;
  }

  if (node.in === "querystring" && usesSchemaFields(node)) {
    return refuse(querystringSchemaFields);
  }

  return Option.match(media, {
    onNone: () => decideStyle(node, line, traits),
    onSome: (content) => decideContent(node, content),
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

  // A querystring with schema is refused as STY-45, not stopped here.
  const both = node.schema !== undefined && node.content !== undefined;
  if (
    (node.schema === undefined && node.content === undefined) ||
    (both && node.in !== "querystring")
  ) {
    return "schema-xor-content";
  }

  if (node.content !== undefined && Object.keys(node.content).length !== 1) {
    return "content-entry-count";
  }

  return node.in === "path" && node.required !== true ? "path-not-required" : undefined;
};

// A content entry's media type object, which 3.2 lets be a reference: its schema key.
const mediaContent = (
  resolution: Resolution,
  mediaType: string,
  mediaSite: CanonicalKey,
): Effect.Effect<Content> => {
  const home = follow(resolution, mediaSite);

  return nodeIn(resolution, home).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(MediaTypeObject)),
    Effect.map((media): Content => ({
      mediaType,
      schemaKey:
        media.schema === undefined
          ? Option.none()
          : Option.some(schemaKeyAt(resolution, childKey(home, "schema"))),
    })),
    Effect.orElseSucceed((): Content => ({ mediaType, schemaKey: Option.none() })),
  );
};

interface Related {
  readonly document: string;
  readonly pointer: string;
}

const toDiagnostics = (
  resolution: Resolution,
  site: ParameterSite,
  related: readonly Related[],
  wireName: string,
  findings: readonly Finding[],
): Effect.Effect<readonly Diagnostic[]> => {
  const wire = sanitize(wireName);

  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach(items, f), not an array method
  return Effect.forEach(findings, (finding) =>
    diagnosticOf({
      code: finding.code,
      document: resolution.document,
      element: finding.element,
      hint: finding.hint,
      message: finding.message,
      openapi: site.openapi,
      operation: site.operation,
      pointer: site.pointer,
      related: related.length > 0 ? related : undefined,
      scope: "element",
      severity: finding.severity,
      specSection: specSectionUrl(resolution.line, finding.anchor),
      wire: wire === "" ? undefined : wire,
    }),
  ).pipe(Effect.orDie);
};

const sorted = (rows: readonly string[]): readonly string[] =>
  Arr.sort(Arr.dedupe(rows), Order.String);

interface Source {
  readonly node: ParameterNode;
  readonly reference: ResolvedReference | undefined;
  readonly related: readonly Related[];
  readonly target: CanonicalKey;
}

const read = (
  resolution: Resolution,
  site: ParameterSite,
): Effect.Effect<Source, ParameterNotReadable> => {
  const unreadable = new ParameterNotReadable({ pointer: site.pointer, reason: "not-a-parameter" });
  const use = { document: resolution.document, pointer: site.pointer };
  const reference = referenceIn(resolution, use);
  const target = follow(resolution, use);

  return nodeIn(resolution, target).pipe(
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

const TypedSchema = Schema.Struct({
  type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});

const MemberSchemas = Schema.Struct({
  additionalProperties: Schema.optionalKey(Schema.Unknown),
  properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

// The type names the schema at `key` declares, through `$ref`; none when it declares no type.
const typesAt = (resolution: Resolution, key: CanonicalKey): Effect.Effect<readonly string[]> =>
  nodeIn(resolution, follow(resolution, key)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TypedSchema)),
    Effect.map(({ type }) => [type ?? []].flat()),
    Effect.orElseSucceed(() => []),
  );

const compound = (types: readonly string[]): boolean =>
  types.some((name) => name === "array" || name === "object");

// Whether a cookie's schema, through `$ref`, declares an array or object type (PRM-34).
const carriesMultiple = (resolution: Resolution, source: Source): Effect.Effect<boolean> => {
  if (source.node.in !== "cookie" || source.node.schema === undefined) {
    return Effect.succeed(false);
  }

  return typesAt(resolution, childKey(source.target, "schema")).pipe(Effect.map(compound));
};

// Whether a deepObject query parameter's schema, through `$ref`, is an array or declares a
// property or `additionalProperties` schema of an object or array type (PRM-27). An untyped
// member is not nested.
const nestsDeeply = Effect.fnUntraced(function* nestsDeeply(
  resolution: Resolution,
  source: Source,
): Effect.fn.Return<boolean> {
  const { node, target } = source;
  if (node.in !== "query" || node.style !== "deepObject" || node.schema === undefined) {
    return false;
  }

  const home = follow(resolution, childKey(target, "schema"));
  if ((yield* typesAt(resolution, home)).includes("array")) {
    return true;
  }

  const declared = yield* nodeIn(resolution, home).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(MemberSchemas)),
    Effect.orElseSucceed((): typeof MemberSchemas.Type => ({})),
  );
  const members = Object.keys(declared.properties ?? {}).map((name) =>
    childKey(home, "properties", name),
  );
  if (declared.additionalProperties !== undefined) {
    members.push(childKey(home, "additionalProperties"));
  }

  for (const member of members) {
    if (compound(yield* typesAt(resolution, member))) {
      return true;
    }
  }

  return false;
});

const CompositionSchema = Schema.Struct({
  anyOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  oneOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  properties: Schema.optionalKey(Schema.Unknown),
});

// One `objectOnly` walk: each resolved schema is decided once (`memo`), a schema already on the
// current path is a cycle, and every schema decided is charged to the call's node budget. `arrays`
// says whether an array counts with the objects, as it does for PRM-27, whose nested test refuses it.
interface ObjectWalk {
  readonly arrays: boolean;
  readonly budget: Budget;
  readonly memo: Map<string, boolean>;
  readonly path: Set<string>;
}

const walkOf = (limits: SchemaLimits, arrays: boolean): ObjectWalk => ({
  arrays,
  budget: budgetOf(limits),
  memo: new Map(),
  path: new Set(),
});

// What one resolved schema says on its own about admitting only objects (and arrays, when the walk
// counts them): a declared type list must name nothing else; an untyped schema is an object when it
// declares `properties`, except that its anyOf and oneOf members, when it has any, decide with it.
interface OwnVerdict {
  readonly members: readonly CanonicalKey[];
  readonly only: boolean;
}

const ownVerdict = Effect.fnUntraced(function* ownVerdict(
  resolution: Resolution,
  home: CanonicalKey,
  walk: ObjectWalk,
): Effect.fn.Return<OwnVerdict> {
  const types = yield* typesAt(resolution, home);
  if (types.length > 0) {
    const counted = (name: string) => name === "object" || (walk.arrays && name === "array");

    return { members: [], only: types.every(counted) };
  }

  const declared = yield* nodeIn(resolution, home).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CompositionSchema)),
    Effect.orElseSucceed((): typeof CompositionSchema.Type => ({})),
  );
  const members = (["anyOf", "oneOf"] as const).flatMap((keyword) =>
    (declared[keyword] ?? []).map((_, index) => childKey(home, keyword, String(index))),
  );

  return { members, only: members.length > 0 || declared.properties !== undefined };
});

// Whether the schema at `key`, through `$ref`, admits only objects: its own verdict, or every
// anyOf and oneOf member's. A cycle or a spent budget fails closed (not object-only); a result
// reached through either is false, so memoizing it is sound.
const objectOnly = Effect.fnUntraced(function* admitsOnlyObjects(
  resolution: Resolution,
  key: CanonicalKey,
  walk: ObjectWalk,
): Effect.fn.Return<boolean> {
  const home = follow(resolution, key);
  const id = keyOf(home);
  const known = walk.memo.get(id);
  if (known !== undefined) {
    return known;
  }

  if (walk.path.has(id) || !charge(walk.budget)) {
    return false;
  }

  walk.path.add(id);

  const verdict = yield* ownVerdict(resolution, home, walk);
  let { only } = verdict;
  for (const member of verdict.members) {
    if (only) {
      only = yield* objectOnly(resolution, member, walk);
    }
  }

  walk.path.delete(id);
  walk.memo.set(id, only);

  return only;
});

// The value traits of one schema site, through `$ref`, that the style table's applicability checks
// read (`inapplicable`): `primitive` when it declares types and none of them is an array or object
// (an untyped schema is not primitive), and, for a `deepObject` value only, `nonObject` when it
// admits a value that is not an object (PRM-27). `limits` bounds that walk, which fails closed. No
// schema has neither trait. Parameters and form Encoding entries share it.
const valueTraits = Effect.fnUntraced(function* valueTraits(
  resolution: Resolution,
  schema: CanonicalKey | undefined,
  deepObject: boolean,
  limits: SchemaLimits,
): Effect.fn.Return<Pick<Traits, "nonObject" | "primitive">> {
  if (schema === undefined) {
    return { nonObject: false, primitive: false };
  }

  const types = yield* typesAt(resolution, schema);
  const nonObject = deepObject && !(yield* objectOnly(resolution, schema, walkOf(limits, true)));

  return { nonObject, primitive: types.length > 0 && !compound(types) };
});

// A parameter's own schema site, or `undefined` for a `content` parameter.
const schemaOf = (source: Source): CanonicalKey | undefined =>
  source.node.schema === undefined ? undefined : childKey(source.target, "schema");

// Whether a styled parameter's value is an object (design 6.1): its schema, through `$ref`, admits
// only objects, by `type: object`, by `properties` with no type, or by anyOf and oneOf members that
// all do. Emit reads it to take the value as JSON.
const objectValued = (
  resolution: Resolution,
  source: Source,
  limits: SchemaLimits,
): Effect.Effect<boolean> => {
  const { node, target } = source;
  if (node.schema === undefined) {
    return Effect.succeed(false);
  }

  return objectOnly(resolution, childKey(target, "schema"), walkOf(limits, false));
};

// One branch of a `deepObject` schema (design 6.1 Scalar switch): an object with scalar members
// (`flat`, the standard rule), an object with nested members or an array (`nested`, the bracket
// switch's), a scalar (`scalar`, the scalar switch's), an object with a member whose union mixes
// objects with other values (`mixed`, which neither switch defines), or anything else (`other`:
// `null`, untyped, unresolved, a cycle or a spent budget).
type Branch = "flat" | "mixed" | "nested" | "other" | "scalar";

// One branch walk: each resolved schema is classified once (`memo`), a schema already on the
// current path is a cycle, and every schema classified is charged to the call's node budget.
interface BranchWalk {
  readonly budget: Budget;
  readonly memo: Map<string, ReadonlySet<Branch>>;
  readonly path: Set<string>;
}

const BranchSchema = Schema.Struct({
  anyOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  const: Schema.optionalKey(Schema.Unknown),
  enum: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  nullable: Schema.optionalKey(Schema.Unknown),
  oneOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  properties: Schema.optionalKey(Schema.Unknown),
  type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});

// The `enum` or `const` values of a scalar branch: strings, numbers and booleans.
const ScalarValues = Schema.NonEmptyArray(
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
);

const scalarTypes: ReadonlySet<string> = new Set(["boolean", "integer", "number", "string"]);

// What one resolved schema declares on its own, before any member is walked: the branches it
// settles (`kinds`), the anyOf and oneOf members whose branches it is the union of (`union`), and
// the members of its object branch (`object`), when it has one.
interface OwnBranches {
  readonly kinds: readonly Branch[];
  readonly object?: readonly CanonicalKey[];
  readonly union: readonly CanonicalKey[];
}

const settled = (kinds: readonly Branch[]): OwnBranches => ({ kinds, union: [] });

// The property and additionalProperties member sites of an object branch at `home`.
const memberSites = (resolution: Resolution, home: CanonicalKey) =>
  nodeIn(resolution, home).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(MemberSchemas)),
    Effect.orElseSucceed((): typeof MemberSchemas.Type => ({})),
    Effect.map((declared) => [
      ...Object.keys(declared.properties ?? {}).map((name) => childKey(home, "properties", name)),
      ...(declared.additionalProperties === undefined
        ? []
        : [childKey(home, "additionalProperties")]),
    ]),
  );

// The branches of a `type` list, the object branch's members read once for `object`.
const typedBranches = Effect.fnUntraced(function* typedBranches(
  resolution: Resolution,
  home: CanonicalKey,
  declared: typeof BranchSchema.Type,
): Effect.fn.Return<OwnBranches> {
  const types = [declared.type ?? []].flat();
  const kinds: Branch[] = [];
  if (types.length === 0 && declared.properties === undefined) {
    return settled(["other"]);
  }

  for (const name of types) {
    if (name === "array") {
      kinds.push("nested");
    } else if (name !== "object") {
      kinds.push(scalarTypes.has(name) ? "scalar" : "other");
    }
  }

  const objects = types.length === 0 || types.includes("object");

  return objects
    ? { kinds, object: yield* memberSites(resolution, home), union: [] }
    : settled(kinds);
});

// One resolved schema's own branches: an anyOf or oneOf beside no constraint of its own is the union
// of its members' branches (beside `type`, `enum`, `const` or `properties` it fails closed); an
// `enum` or `const` of strings, numbers and booleans is a scalar branch; then the `type` list, or
// an untyped schema with `properties` (an object).
const ownBranches = Effect.fnUntraced(function* ownBranches(
  resolution: Resolution,
  home: CanonicalKey,
): Effect.fn.Return<OwnBranches> {
  const decoded = yield* nodeIn(resolution, home).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(BranchSchema)),
    Effect.option,
  );
  if (Option.isNone(decoded)) {
    return settled(["other"]);
  }

  // The index signature lets `Record.has` test a key the struct declares optional.
  const declared: Record.ReadonlyRecord<string, unknown> & typeof BranchSchema.Type = decoded.value;
  // A 3.0 `nullable: true` admits `null`, which neither switch sends.
  if (resolution.line === "3.0" && declared.nullable === true) {
    return settled(["other"]);
  }

  const constant = Record.has(declared, "const");
  const union = (["anyOf", "oneOf"] as const).flatMap((keyword) =>
    (declared[keyword] ?? []).map((_, index) => childKey(home, keyword, String(index))),
  );
  if (union.length > 0) {
    const constrained =
      declared.type !== undefined ||
      declared.enum !== undefined ||
      constant ||
      declared.properties !== undefined;

    return constrained ? settled(["other"]) : { kinds: [], union };
  }

  if (constant || declared.enum !== undefined) {
    const values = constant ? [declared.const] : declared.enum;
    const scalar = Option.isSome(Schema.decodeUnknownOption(ScalarValues)(values));

    return settled([scalar ? "scalar" : "other"]);
  }

  return yield* typedBranches(resolution, home, declared);
});

// How a member of an object branch nests: its declared type is an object or array (`nested`, as
// the strict nested test reads it), it is an anyOf or oneOf union (`union`, walked), or neither
// (`flat`: an untyped member is scalar, as it is today).
const memberNesting = Effect.fnUntraced(function* memberNesting(
  resolution: Resolution,
  member: CanonicalKey,
): Effect.fn.Return<"flat" | "nested" | "union"> {
  if (compound(yield* typesAt(resolution, member))) {
    return "nested";
  }

  const composed = yield* nodeIn(resolution, follow(resolution, member)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CompositionSchema)),
    Effect.orElseSucceed((): typeof CompositionSchema.Type => ({})),
  );

  return composed.anyOf === undefined && composed.oneOf === undefined ? "flat" : "union";
});

// A member union holding objects nests (`nested`); objects beside other values is `mixed`; a
// union with no object is a scalar member (`flat`).
const unionMember = (kinds: ReadonlySet<Branch>): Branch => {
  const objects = kinds.has("flat") || kinds.has("mixed") || kinds.has("nested");
  if (kinds.has("mixed") || (objects && (kinds.has("scalar") || kinds.has("other")))) {
    return "mixed";
  }

  return objects ? "nested" : "flat";
};

// An object branch from its members' kinds: `mixed` over `nested` over `flat`.
const objectBranch = (members: readonly Branch[]): Branch => {
  if (members.includes("mixed")) {
    return "mixed";
  }

  return members.includes("nested") ? "nested" : "flat";
};

// The branches the schema at `key` admits, through `$ref`. A cycle or a spent budget is `other`,
// which refuses the entry, so memoizing a result reached through either is sound.
const branchesOf = Effect.fnUntraced(function* branches(
  resolution: Resolution,
  key: CanonicalKey,
  walk: BranchWalk,
): Effect.fn.Return<ReadonlySet<Branch>> {
  const home = follow(resolution, key);
  const id = keyOf(home);
  const known = walk.memo.get(id);
  if (known !== undefined) {
    return known;
  }

  if (walk.path.has(id) || !charge(walk.budget)) {
    return new Set<Branch>(["other"]);
  }

  walk.path.add(id);

  const own = yield* ownBranches(resolution, home);
  const kinds = new Set<Branch>(own.kinds);
  for (const member of own.union) {
    for (const kind of yield* branchesOf(resolution, member, walk)) {
      kinds.add(kind);
    }
  }

  if (own.object !== undefined) {
    const members: Branch[] = [];
    for (const member of own.object) {
      const nesting = yield* memberNesting(resolution, member);
      members.push(
        nesting === "union" ? unionMember(yield* branchesOf(resolution, member, walk)) : nesting,
      );
    }

    kinds.add(objectBranch(members));
  }

  walk.path.delete(id);
  walk.memo.set(id, kinds);

  return kinds;
});

/**
 * Classifies the `deepObject` schema at `schema` branch by branch, through `$ref`, `anyOf`,
 * `oneOf`, a `type` list, `enum` and `const`, memoized and bounded by `limits` (failing closed),
 * and decides it under the author config's `switches`. Query parameters and form Encoding entries
 * share it (design 6.1, 6.3).
 */
export const scalarCover = Effect.fnUntraced(function* scalarCover(
  resolution: Resolution,
  schema: CanonicalKey,
  switches: AuthorConfig["nonStandard"],
  limits: SchemaLimits = {},
): Effect.fn.Return<ScalarCover> {
  if (switches?.deepObjectScalars !== true) {
    return strictCover;
  }

  const walk: BranchWalk = { budget: budgetOf(limits), memo: new Map(), path: new Set() };
  const kinds = yield* branchesOf(resolution, schema, walk);
  if (!kinds.has("scalar") || kinds.has("other")) {
    return strictCover;
  }

  const nested = kinds.has("nested");
  if (kinds.has("mixed") || (nested && switches.deepObjectBrackets !== true)) {
    return { _tag: "Uncovered" };
  }

  return { _tag: "Covered", nested };
});

// The scalar switch's decision for a deepObject query parameter; `Strict` for any other.
const scalarsOf = (
  resolution: Resolution,
  site: ParameterSite,
  source: Source,
  limits: SchemaLimits,
): Effect.Effect<ScalarCover> => {
  const { node, target } = source;
  if (node.in !== "query" || node.style !== "deepObject" || node.schema === undefined) {
    return Effect.succeed(strictCover);
  }

  return scalarCover(resolution, childKey(target, "schema"), site.nonStandard, limits);
};

/**
 * The query style table's refusal for one form-urlencoded Encoding entry (design 6.3: `style`,
 * `explode` and `allowReserved` apply as for query parameters), by the checks query parameters use:
 * STY-18/20/22/24 explode not applicable, STY-17/21 a delimited style over a primitive, and PRM-27
 * a deepObject over a schema that admits non-objects. `given` holds the entry's explicit fields;
 * the query defaults fill the rest. `schema` is the property's schema site, through `$ref`;
 * `limits` bounds the PRM-27 walk, which fails closed. `None` means the table does not refuse
 * the entry, or its style is outside the query table and is not decided here.
 */
export const formStyleRefusal = Effect.fnUntraced(function* formStyleRefusal(
  resolution: Resolution,
  schema: CanonicalKey | undefined,
  given: {
    readonly allowReserved?: boolean;
    readonly explode?: boolean;
    readonly style?: StyleName;
  },
  limits: SchemaLimits = {},
): Effect.fn.Return<Option.Option<Finding>> {
  const style = given.style ?? "form";
  const allowReserved = given.allowReserved === true;
  const row =
    style === "deepObject"
      ? deepObjectRow(resolution.line, given.explode === true, allowReserved)
      : Option.getOrUndefined(
          HashMap.get(rowOf, ["query", style, given.explode ?? style === "form", allowReserved]),
        );
  if (row === undefined) {
    return Option.none();
  }

  const traits = yield* valueTraits(resolution, schema, style === "deepObject", limits);

  return Option.fromUndefinedOr(inapplicable(row, style, traits));
});

const mediaOf = (resolution: Resolution, source: Source): Effect.Effect<Media> => {
  const [mediaType] = Object.keys(source.node.content ?? {});
  if (mediaType === undefined) {
    return Effect.succeed(Option.none());
  }

  return mediaContent(resolution, mediaType, childKey(source.target, "content", mediaType)).pipe(
    Effect.map(Option.some),
  );
};

const serializationOf = (
  node: ParameterNode,
  plan: ContentPlan | StylePlan,
  line: Line,
  origin: Related,
  objectValue: boolean,
) => {
  if (plan.kind === "content") {
    // The operation assembly fills a `querystring` form entry's rules (design 6.1).
    return {
      encoding: [],
      kind: plan.kind,
      mediaType: plan.mediaType,
      origin,
      rows: sorted(["PRM-15", ...plan.rows]),
      rules: rules[line],
      schema: { key: plan.schemaKey },
    };
  }

  const honored = node.in === "query" && node.allowEmptyValue === true;

  const serialization = {
    allowReserved: plan.allowReserved,
    explode: plan.explode,
    kind: plan.kind,
    objectValued: objectValue,
    origin,
    rows: sorted(honored ? [plan.row, "PRM-08"] : [plan.row]),
    rules: rules[line],
    style: plan.style,
  };

  const bracketed =
    plan.nonStandard === undefined
      ? serialization
      : { ...serialization, nonStandard: plan.nonStandard };

  return plan.nonStandardScalars === undefined
    ? bracketed
    : { ...bracketed, nonStandardScalars: plan.nonStandardScalars };
};

const parameterRows = (node: ParameterNode, plan: ContentPlan | StylePlan): readonly string[] => {
  if (plan.kind === "content") {
    return ["PRM-01", "PRM-15"];
  }

  return node.in === "query" && node.allowEmptyValue === true ? ["PRM-01", "PRM-08"] : ["PRM-01"];
};

const build = Effect.fnUntraced(function* build(
  resolution: Resolution,
  site: ParameterSite,
  source: Source,
  plan: ContentPlan | StylePlan,
  limits: SchemaLimits,
  mark: SensitiveMark,
) {
  const { node, reference, target } = source;
  const origin = { document: resolution.document, pointer: site.pointer };
  const schemaKey =
    plan.kind === "content" ? plan.schemaKey : schemaKeyAt(resolution, childKey(target, "schema"));
  const objectValue = plan.kind === "style" && (yield* objectValued(resolution, source, limits));

  return yield* Schema.decodeUnknownEffect(Parameter)({
    deprecated: node.deprecated ?? false,
    docs: docsOf(reference?.description ?? node.description, reference?.summary),
    location: node.in,
    origin,
    required: node.required ?? false,
    rows: sorted(parameterRows(node, plan)),
    schema: { key: schemaKey },
    ...mark,
    serialization: serializationOf(node, plan, resolution.line, origin, objectValue),
    wireName: node.name,
  }).pipe(Effect.orDie);
});

// The schema sites a parameter carries: its `schema`, or its one content entry's `schema`.
const schemaSitesOf = (resolution: Resolution, source: Source): readonly CanonicalKey[] => {
  const { node, target } = source;
  if (node.schema !== undefined) {
    return [childKey(target, "schema")];
  }

  const [mediaType] = Object.keys(node.content ?? {});

  return mediaType === undefined
    ? []
    : [childKey(follow(resolution, childKey(target, "content", mediaType)), "schema")];
};

const MarkedSchema = Schema.Struct({
  allOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  anyOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  oneOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  "x-sensitive": Schema.optionalKey(Schema.Unknown),
});

const branchKeys = ["allOf", "anyOf", "oneOf"] as const;

// Whether the schema at `key` carries `x-sensitive: true` on any node the password reading walks
// (names `isPassword`): each node of its `$ref` chain with its sibling keywords, each `allOf`
// member and each `anyOf` or `oneOf` branch. A node already on the walk is not read twice, so a
// cycle ends; past the node budget the answer is yes, so a secret never prints by exhaustion. An
// unreadable node is not marked.
const schemaMarked = Effect.fnUntraced(function* schemaMarked(
  resolution: Resolution,
  key: CanonicalKey,
  budget: Budget,
  seen: Set<string>,
): Effect.fn.Return<boolean> {
  const id = keyOf(key);
  if (seen.has(id)) {
    return false;
  }

  seen.add(id);
  if (!charge(budget)) {
    return true;
  }

  const decoded = yield* nodeIn(resolution, key).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(MarkedSchema)),
    Effect.option,
  );
  if (Option.isNone(decoded)) {
    return false;
  }

  const node = decoded.value;
  if (node["x-sensitive"] === true) {
    return true;
  }

  const next = [
    follow(resolution, key),
    ...branchKeys.flatMap((branch) =>
      (node[branch] ?? []).map((_, index) => childKey(key, branch, String(index))),
    ),
  ];
  for (const at of next) {
    if (yield* schemaMarked(resolution, at, budget, seen)) {
      return true;
    }
  }

  return false;
});

interface SensitiveMark {
  readonly sensitive?: true;
}

// The `sensitive` mark of a Parameter or Header Object: present when `x-sensitive: true` sits on
// the object itself or anywhere `schemaMarked` walks its schema. `limits.maxNodes` bounds the walk.
const sensitiveOf = Effect.fnUntraced(function* sensitiveOf(
  resolution: Resolution,
  source: Source,
  limits: SchemaLimits,
): Effect.fn.Return<SensitiveMark> {
  if (source.node["x-sensitive"] === true) {
    return { sensitive: true };
  }

  const budget = budgetOf(limits);
  const seen = new Set<string>();
  for (const at of schemaSitesOf(resolution, source)) {
    if (yield* schemaMarked(resolution, at, budget, seen)) {
      return { sensitive: true };
    }
  }

  return {};
});

/**
 * Normalizes one Parameter Object into a `Parameter`, a notice-only ignore, or an element-scope
 * refusal (design 2.2, 6.1, 6.2). Defaults come from the line's text, never from a schema
 * `default`. A site the earlier stages should have stopped fails with `ParameterNotReadable`.
 * `limits.maxNodes` bounds each schema walk behind the PRM-27 object test and the `objectValued`
 * fact, which fail closed when it is spent.
 */
export const normalizeParameter = Effect.fnUntraced(function* normalizeParameter(
  resolution: Resolution,
  site: ParameterSite,
  limits: SchemaLimits = {},
): Effect.fn.Return<ParameterOutcome, ParameterNotReadable> {
  const source = yield* read(resolution, site);
  const reason = contractReason(source.node, resolution.line);
  if (reason !== undefined) {
    return yield* new ParameterNotReadable({ pointer: site.pointer, reason });
  }

  const deepObject = source.node.in === "query" && source.node.style === "deepObject";
  const values = yield* valueTraits(resolution, schemaOf(source), deepObject, limits);
  const decision = decide(source.node, resolution.line, yield* mediaOf(resolution, source), {
    brackets: site.nonStandard?.deepObjectBrackets === true,
    multiple: yield* carriesMultiple(resolution, source),
    nested: yield* nestsDeeply(resolution, source),
    nonObject: values.nonObject,
    primitive: values.primitive,
    scalars: yield* scalarsOf(resolution, site, source, limits),
  });
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

  if (schemaSitesOf(resolution, source).some((at) => appliesDynamicKeyword(resolution, at))) {
    // The schema store refuses the keyword at element scope where it sits (SCH-05, 06, 65, 66);
    // the value cannot be checked without it, so the parameter is refused with no second
    // diagnostic, as a body is, and a required one raises its operation.
    return { _tag: "Refused", diagnostics: [], required: source.node.required ?? false };
  }

  return {
    _tag: "Implemented",
    diagnostics: yield* diagnostics(decision.findings),
    parameter: yield* build(
      resolution,
      site,
      source,
      decision.plan,
      limits,
      yield* sensitiveOf(resolution, source, limits),
    ),
  };
});

const { in: _in, name: _name, ...headerFields } = ParameterObject.fields;

// A Header Object is a Parameter Object without `name` and `in` (HDR-01).
const HeaderObject = Schema.Struct(headerFields);

/**
 * How one encoding part header is typed and sent: as a header parameter of its name would be, or
 * `Unsupported` with the reason the header parameter path cannot carry it.
 */
export type PartHeaderOutcome =
  | {
      readonly _tag: "Typed";
      readonly schema: { readonly key: string };
      readonly sensitive?: true;
      readonly serialization: ReturnType<typeof serializationOf>;
    }
  | { readonly _tag: "Unsupported"; readonly reason: string };

const unsupported = (reason: string): PartHeaderOutcome => ({ _tag: "Unsupported", reason });

/**
 * Decides an encoding part header (ENC-03, HDR-01) by the header parameter rules: the Header
 * Object at use site `site`, read where its `$ref` leads, as `in: header` under `name`. The name
 * rules of header parameters (PRM-19, PRM-21) govern the operation's own headers and do not apply
 * to a part's. A style or content the header parameter path refuses, a dynamic keyword in its
 * schema, or a Header Object with neither or both of `schema` and `content` is `Unsupported`. The
 * notices a header parameter would carry are not repeated here. `origin` is the header's pointer.
 */
export const partHeader = Effect.fnUntraced(function* partHeader(
  resolution: Resolution,
  site: CanonicalKey,
  name: string,
  origin: Related,
  limits: SchemaLimits = {},
): Effect.fn.Return<PartHeaderOutcome> {
  const target = follow(resolution, site);
  const decoded = yield* nodeIn(resolution, target).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(HeaderObject)),
    Effect.option,
  );
  if (Option.isNone(decoded)) {
    return unsupported("The header is not a Header Object.");
  }

  const node: ParameterNode = { ...decoded.value, in: "header", name };
  if ((node.schema === undefined) === (node.content === undefined)) {
    return unsupported("The header needs exactly one of schema and content.");
  }

  if (node.content !== undefined && Object.keys(node.content).length !== 1) {
    return unsupported("The header's content needs exactly one media type.");
  }

  const source: Source = { node, reference: referenceIn(resolution, site), related: [], target };
  const traits: Traits = {
    brackets: false,
    multiple: false,
    nested: yield* nestsDeeply(resolution, source),
    nonObject: false,
    primitive: (yield* valueTraits(resolution, schemaOf(source), false, {})).primitive,
    scalars: strictCover,
  };
  const decision = Option.match(yield* mediaOf(resolution, source), {
    onNone: () => decideStyle(node, resolution.line, traits),
    onSome: (content) => decideContent(node, content),
  });
  if (decision._tag === "Refuse") {
    return unsupported(decision.finding.message);
  }

  if (decision._tag === "Ignore") {
    return unsupported("The header parameter rules ignore this header.");
  }

  if (schemaSitesOf(resolution, source).some((at) => appliesDynamicKeyword(resolution, at))) {
    return unsupported("The header's schema applies a dynamic keyword.");
  }

  const { plan } = decision;
  const objectValue = plan.kind === "style" && (yield* objectValued(resolution, source, limits));

  return {
    _tag: "Typed",
    schema: {
      key:
        plan.kind === "content"
          ? plan.schemaKey
          : schemaKeyAt(resolution, childKey(target, "schema")),
    },
    ...(yield* sensitiveOf(resolution, source, limits)),
    serialization: serializationOf(node, plan, resolution.line, origin, objectValue),
  };
});
