import { Array as Arr, Data, Effect, Option, Order, Schema } from "effect";
import { HeaderName, MediaRange } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import type { DiagnosticOperation } from "../model/diagnostic.ts";
import { Body } from "../model/entities.ts";
import { defsKey } from "../resolve/canonical.ts";
import { defaultLimits, referenceAt } from "../resolve/index.ts";
import type { ResolveLimits, Resolution, ResolvedReference } from "../resolve/index.ts";
import { escapeToken, evaluatePointer } from "../model/pointer.ts";
import type { Line } from "../validate/index.ts";

/**
 * Where a request body is read: its use site in the entry document, the operation it belongs to
 * when known, and the document's full `openapi` value.
 */
export interface BodySite {
  readonly openapi: string;
  readonly operation?: typeof DiagnosticOperation.Type;
  readonly pointer: string;
}

/**
 * What normalizing one Request Body Object produced. `Implemented` keeps every alternative that
 * survived; `Refused` means none did, and keeps `required` so the operation assembly can raise the
 * refusal to operation scope.
 */
export type BodyOutcome =
  | {
      readonly _tag: "Implemented";
      readonly body: Body;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly _tag: "Refused";
      readonly diagnostics: readonly Diagnostic[];
      readonly required: boolean;
    };

/**
 * The site is not a Request Body Object the earlier stages could have passed: validation or
 * resolution should have stopped it.
 */
export class BodyNotReadable extends Data.TaggedError("BodyNotReadable")<{
  readonly pointer: string;
  readonly reason: "media-type-not-an-object" | "not-a-request-body";
}> {}

/**
 * Schema inspection visited more nodes than the node budget allows.
 */
export class BodyNodeBudget extends Data.TaggedError("BodyNodeBudget")<{
  readonly diagnostic: Diagnostic;
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

const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);

const HeaderObject = Schema.Struct({ required: Schema.optionalKey(Schema.Boolean) });

interface EncodingNode {
  readonly allowReserved?: boolean;
  readonly contentType?: string;
  readonly encoding?: Readonly<Record<string, EncodingNode>>;
  readonly explode?: boolean;
  readonly headers?: Readonly<Record<string, typeof HeaderObject.Type>>;
  readonly itemEncoding?: EncodingNode;
  readonly prefixEncoding?: readonly EncodingNode[];
  readonly style?: StyleName;
}

// Encoding Objects nest, so the codec is recursive; the rules cap the depth at one level.
const EncodingObject: Schema.Codec<EncodingNode> = Schema.Struct({
  allowReserved: Schema.optionalKey(Schema.Boolean),
  contentType: Schema.optionalKey(Schema.String),
  encoding: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.suspend((): Schema.Codec<EncodingNode> => EncodingObject),
    ),
  ),
  explode: Schema.optionalKey(Schema.Boolean),
  headers: Schema.optionalKey(Schema.Record(Schema.String, HeaderObject)),
  itemEncoding: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<EncodingNode> => EncodingObject),
  ),
  prefixEncoding: Schema.optionalKey(
    Schema.Array(Schema.suspend((): Schema.Codec<EncodingNode> => EncodingObject)),
  ),
  style: Schema.optionalKey(Schema.Literals(styleNames)),
});

const RequestBodyObject = Schema.Struct({
  content: ObjectValue,
  description: Schema.optionalKey(Schema.String),
  required: Schema.optionalKey(Schema.Boolean),
});

const MediaTypeObject = Schema.Struct({
  encoding: Schema.optionalKey(Schema.Record(Schema.String, EncodingObject)),
  itemEncoding: Schema.optionalKey(EncodingObject),
  itemSchema: Schema.optionalKey(Schema.Unknown),
  prefixEncoding: Schema.optionalKey(Schema.Array(EncodingObject)),
  schema: Schema.optionalKey(Schema.Unknown),
});

type MediaNode = typeof MediaTypeObject.Type;

// Only what the multipart rules read of a schema; a boolean schema decodes to nothing.
const SchemaNode = Schema.Struct({
  additionalProperties: Schema.optionalKey(Schema.Unknown),
  allOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  contentEncoding: Schema.optionalKey(Schema.String),
  format: Schema.optionalKey(Schema.String),
  items: Schema.optionalKey(Schema.Unknown),
  prefixItems: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  properties: Schema.optionalKey(ObjectValue),
  type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});

type SchemaNodeValue = typeof SchemaNode.Type;

const specVersion: Record<Line, string> = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.1" };

const unsafeText = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

const formUrlencoded = "application/x-www-form-urlencoded";

const octetStream = "application/octet-stream";

const maxHops = 16;

type Codec =
  | "binary"
  | "form"
  | "json"
  | "jsonseq"
  | "multipart"
  | "ndjson"
  | "sse"
  | "text"
  | "xml";

const ndjsonTypes: ReadonlySet<string> = new Set([
  "application/jsonl",
  "application/ndjson",
  "application/x-ndjson",
]);

const baseType = (mediaType: string): string => {
  const [base = ""] = mediaType.split(";");

  return base.trim().toLowerCase();
};

// The codec follows the media type alone (design 2.2); a range such as `*/*` is raw bytes until the
// operator names a concrete type.
const codecOf = (base: string): Codec => {
  if (base === formUrlencoded) {
    return "form";
  }

  if (base.startsWith("multipart/")) {
    return "multipart";
  }

  if (base === "text/event-stream") {
    return "sse";
  }

  if (base === "application/json-seq" || base.endsWith("+json-seq")) {
    return "jsonseq";
  }

  if (ndjsonTypes.has(base)) {
    return "ndjson";
  }

  if (base === "application/json" || base.endsWith("+json")) {
    return "json";
  }

  if (base === "application/xml" || base === "text/xml" || base.endsWith("+xml")) {
    return "xml";
  }

  return base.startsWith("text/") ? "text" : "binary";
};

interface Finding {
  readonly anchor: string;
  readonly code: string;
  readonly element: string;
  readonly hint?: string;
  readonly message: string;
  readonly pointer: string;
  readonly severity: "notice" | "refusal";
}

const refusal = (
  code: string,
  anchor: string,
  element: string,
  message: string,
  pointer: string,
  hint?: string,
): Finding => {
  const base: Finding = { anchor, code, element, message, pointer, severity: "refusal" };

  return hint === undefined ? base : { ...base, hint };
};

const notice = (
  code: string,
  anchor: string,
  element: string,
  message: string,
  pointer: string,
): Finding => ({ anchor, code, element, message, pointer, severity: "notice" });

const sanitize = (text: string): string => text.replaceAll(unsafeText, "");

const sorted = (rows: readonly string[]): readonly string[] =>
  Arr.sort(Arr.dedupe(rows), Order.String);

// --- Schema inspection (design 6.3, MED-27: only `$ref` and `allOf` are followed) ---

interface Located {
  readonly node: SchemaNodeValue;
  readonly pointer: string;
}

const settle = (resolution: Resolution, start: string): string => {
  let current = start;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const reference = referenceAt(resolution, current);
    if (
      reference === undefined ||
      reference.kind !== "schema" ||
      reference.target.document !== resolution.document
    ) {
      return current;
    }

    current = reference.target.pointer;
  }

  return current;
};

const nodeAt = (resolution: Resolution, pointer: string): Effect.Effect<SchemaNodeValue> =>
  evaluatePointer(resolution.value, pointer).pipe(
    Effect.map((json) => Schema.decodeUnknownOption(SchemaNode)(json)),
    Effect.map(Option.getOrElse((): SchemaNodeValue => ({}))),
    Effect.orElseSucceed((): SchemaNodeValue => ({})),
  );

// What one body spends on schema inspection: every visit of an `allOf` member is charged to
// `spent`, against the resolution limits' node budget (design 9 I5).
interface Walk {
  readonly maxNodes: number;
  readonly resolution: Resolution;
  readonly site: BodySite;
  spent: number;
}

const budgetFailure = (walk: Walk): Effect.Effect<never, BodyNodeBudget> =>
  Schema.decodeUnknownEffect(Diagnostic)({
    code: "REF-18/node-budget",
    document: walk.resolution.document,
    element: "Schema inspection",
    message: "Inspecting the request body schemas visits more nodes than the node budget allows.",
    openapi: walk.site.openapi,
    pointer: walk.site.pointer,
    row: "REF-18",
    scope: "document",
    severity: "refusal",
    specSection: `https://spec.openapis.org/oas/v${specVersion[walk.resolution.line]}.html#reference-object`,
  }).pipe(
    Effect.orDie,
    Effect.flatMap((diagnostic) => Effect.fail(new BodyNodeBudget({ diagnostic }))),
  );

// The schema and its `allOf` members in document order, each distinct schema once, so a graph
// that reuses members costs its size and a cycle ends at the first repeat.
const flatten = (walk: Walk, start: string): Effect.Effect<readonly Located[], BodyNodeBudget> =>
  Effect.gen(function* walkMembers() {
    const seen = new Set<string>();
    const found: Located[] = [];
    const pending = [start];
    let next = pending.pop();
    while (next !== undefined) {
      const pointer = settle(walk.resolution, next);
      walk.spent += 1;
      if (walk.spent > walk.maxNodes) {
        return yield* budgetFailure(walk);
      }

      if (!seen.has(pointer)) {
        seen.add(pointer);

        const node = yield* nodeAt(walk.resolution, pointer);
        found.push({ node, pointer });

        const members = (node.allOf ?? []).map((_, index) => `${pointer}/allOf/${index}`);
        pending.push(...Arr.reverse(members));
      }

      next = pending.pop();
    }

    return found;
  });

const firstLocated = <T>(
  nodes: readonly Located[],
  read: (node: SchemaNodeValue) => T | undefined,
): { readonly pointer: string; readonly value: T } | undefined => {
  for (const located of nodes) {
    const value = read(located.node);
    if (value !== undefined) {
      return { pointer: located.pointer, value };
    }
  }

  return undefined;
};

interface Members {
  readonly items: string | undefined;
  readonly prefixItems: readonly string[];
  readonly properties: readonly (readonly [string, string])[];
}

const noMembers: Members = { items: undefined, prefixItems: [], properties: [] };

// The declared properties (document order, first definition wins) and item schemas of a schema.
const membersOf = (walk: Walk, pointer: string): Effect.Effect<Members, BodyNodeBudget> =>
  Effect.gen(function* members() {
    const nodes = yield* flatten(walk, pointer);
    const seen = new Set<string>();
    const properties: (readonly [string, string])[] = [];
    for (const located of nodes) {
      for (const name of Object.keys(located.node.properties ?? {})) {
        if (!seen.has(name)) {
          seen.add(name);
          properties.push([name, `${located.pointer}/properties/${escapeToken(name)}`]);
        }
      }
    }

    const prefix = firstLocated(nodes, (node) => node.prefixItems);
    const items = firstLocated(nodes, (node) => node.items);

    return {
      items: items === undefined ? undefined : `${items.pointer}/items`,
      prefixItems:
        prefix === undefined
          ? []
          : prefix.value.map((_, index) => `${prefix.pointer}/prefixItems/${index}`),
      properties,
    };
  });

const memberSchema = (members: Members, target: Target): string | undefined =>
  target.kind === "property"
    ? members.properties.find(([name]) => name === target.name)?.[1]
    : members.prefixItems[target.index];

interface Facts {
  readonly contentEncoding: string | undefined;
  readonly format: string | undefined;
  readonly items: Facts | undefined;
  readonly type: readonly string[];
}

const noFacts: Facts = {
  contentEncoding: undefined,
  format: undefined,
  items: undefined,
  type: [],
};

const factsOf = (
  walk: Walk,
  pointer: string | undefined,
  depth = 0,
): Effect.Effect<Facts, BodyNodeBudget> =>
  Effect.gen(function* facts() {
    if (pointer === undefined) {
      return noFacts;
    }

    const nodes = yield* flatten(walk, pointer);
    const items = firstLocated(nodes, (node) => node.items);
    const itemFacts =
      items === undefined || depth > 0
        ? undefined
        : yield* factsOf(walk, `${items.pointer}/items`, depth + 1);
    const type = firstLocated(nodes, (node) => node.type)?.value;

    return {
      contentEncoding: firstLocated(nodes, (node) => node.contentEncoding)?.value,
      format: firstLocated(nodes, (node) => node.format)?.value,
      items: itemFacts,
      type: type === undefined ? [] : Arr.ensure(type),
    };
  });

interface Default {
  readonly row: string;
  readonly type: string;
}

const absentDefault = (line: Line): Default => ({
  row: line === "3.0" ? "ENC-26" : "ENC-17",
  type: octetStream,
});

const stringDefault = (line: Line, facts: Facts): Default => {
  if (line === "3.0" && (facts.format === "binary" || facts.format === "byte")) {
    return { row: "ENC-18", type: octetStream };
  }

  if (line !== "3.0" && facts.contentEncoding !== undefined) {
    return { row: "ENC-19", type: octetStream };
  }

  return { row: "ENC-20", type: "text/plain" };
};

const scalarDefault = (line: Line, name: string, facts: Facts): Default => {
  switch (name) {
    case "string": {
      return stringDefault(line, facts);
    }
    case "number":
    case "integer":
    case "boolean": {
      return { row: "ENC-21", type: "text/plain" };
    }
    case "object": {
      return { row: "ENC-22", type: "application/json" };
    }
    case "null": {
      return { row: "ENC-25", type: "text/plain" };
    }
    default: {
      return absentDefault(line);
    }
  }
};

type ArrayDefault = (line: Line, facts: Facts) => Default;

// A type list ignores `null` unless it is the only member, and a list whose members disagree is
// treated as untyped.
const defaultOfTypes = (line: Line, facts: Facts, arrayDefault: ArrayDefault): Default => {
  const named = facts.type.filter((name) => name !== "null");
  const names = named.length === 0 ? facts.type : named;
  const decided = Arr.dedupeWith(
    names.map((name) =>
      name === "array" ? arrayDefault(line, facts) : scalarDefault(line, name, facts),
    ),
    (left, right) => left.type === right.type,
  );
  const [only] = decided;

  return decided.length === 1 && only !== undefined ? only : absentDefault(line);
};

const nestedArrayDefault: ArrayDefault = () => ({ row: "ENC-23", type: "application/json" });

const arrayDefault: ArrayDefault = (line, facts) =>
  line === "3.2"
    ? { row: "ENC-24", type: "application/json" }
    : {
        row: "ENC-23",
        type: defaultOfTypes(line, facts.items ?? noFacts, nestedArrayDefault).type,
      };

// ENC-17 to ENC-26: the default contentType of a part from the schema of its value.
const defaultFor = (line: Line, facts: Facts): Default => defaultOfTypes(line, facts, arrayDefault);

// --- Encoding rules ---

type Target =
  | { readonly kind: "position"; readonly index: number }
  | { readonly kind: "property"; readonly name: string };

interface PlainSerialization {
  allowReserved?: boolean;
  explode?: boolean;
  style?: StyleName;
}

interface PlainHeader {
  readonly name: string;
  readonly required: boolean;
}

interface PlainNested {
  readonly contentType: readonly string[];
  readonly headers: readonly PlainHeader[];
  serialization?: PlainSerialization;
  readonly target: Target;
}

interface PlainRule extends PlainNested {
  nested?: readonly PlainNested[];
  readonly origin: { readonly document: string; readonly pointer: string };
  readonly rows: readonly string[];
}

interface RuleResult {
  readonly findings: readonly Finding[];
  readonly rule: PlainRule | undefined;
}

interface RuleInput {
  readonly actual: string;
  readonly depth: 0 | 1;
  readonly honorsStyle: boolean;
  readonly node: EncodingNode | undefined;
  readonly schemaPointer: string | undefined;
  readonly target: Target;
}

interface Context {
  readonly line: Line;
  readonly reference: ResolvedReference | undefined;
  readonly resolution: Resolution;
  readonly site: BodySite;
  readonly walk: Walk;
}

const targetLabel = (target: Target): string =>
  target.kind === "property" ? target.name : `position ${target.index}`;

const contentTypes = (text: string): Option.Option<readonly string[]> => {
  const parts = text.split(",").map((part) => part.trim());
  const decoded = parts.map((part) => Schema.decodeUnknownOption(MediaRange)(part));

  return decoded.every((part) => Option.isSome(part)) ? Option.some(parts) : Option.none();
};

const explicitStyle = (node: EncodingNode): PlainSerialization => {
  const given: PlainSerialization = {};
  if (node.allowReserved !== undefined) {
    given.allowReserved = node.allowReserved;
  }

  if (node.explode !== undefined) {
    given.explode = node.explode;
  }

  if (node.style !== undefined) {
    given.style = node.style;
  }

  return given;
};

const styleRows = (style: PlainSerialization): readonly string[] => [
  ...(style.style === undefined ? [] : ["ENC-04"]),
  ...(style.explode === undefined ? [] : ["ENC-05"]),
  ...(style.allowReserved === undefined ? [] : ["ENC-06"]),
  "ENC-13",
];

const styleIgnored = (actual: string): Finding =>
  notice(
    "ENC-12/style-ignored",
    "encoding-style",
    "Encoding style, explode or allowReserved",
    "The specification applies these fields to form-urlencoded and multipart/form-data values only, so they are ignored here.",
    actual,
  );

const contentTypeIgnored = (actual: string): Finding =>
  notice(
    "ENC-13/content-type-ignored",
    "fixed-fields-for-rfc6570-style-serialization",
    "Encoding contentType beside style fields",
    "An explicit style, explode or allowReserved makes contentType SHALL be ignored.",
    actual,
  );

const invalidContentType = (input: RuleInput): Finding =>
  refusal(
    "ENC-02/invalid-content-type",
    "encoding-content-type",
    "Encoding contentType",
    `The contentType of ${JSON.stringify(sanitize(targetLabel(input.target)))} is not a list of media ranges.`,
    `${input.actual}/contentType`,
  );

interface Typing {
  readonly contentType: readonly string[];
  readonly findings: readonly Finding[];
  readonly refused: boolean;
  readonly rows: readonly string[];
  readonly serialization: PlainSerialization | undefined;
}

// ENC-02, ENC-12, ENC-13 and the ENC-17 to ENC-26 table: how the part's type is decided.
const typingOf = (
  ctx: Context,
  input: RuleInput,
  node: EncodingNode,
): Effect.Effect<Typing, BodyNodeBudget> =>
  Effect.gen(function* typing() {
    const given = explicitStyle(node);
    const hasStyle = Object.keys(given).length > 0;
    const findings: Finding[] = [];
    if (hasStyle && input.honorsStyle) {
      if (node.contentType !== undefined) {
        findings.push(contentTypeIgnored(input.actual));
      }

      return {
        contentType: [],
        findings,
        refused: false,
        rows: ["ENC-01", ...styleRows(given)],
        serialization: given,
      };
    }

    if (hasStyle) {
      findings.push(styleIgnored(input.actual));
    }

    if (node.contentType === undefined) {
      const fallback = defaultFor(ctx.line, yield* factsOf(ctx.walk, input.schemaPointer));

      return {
        contentType: [fallback.type],
        findings,
        refused: false,
        rows: ["ENC-01", fallback.row],
        serialization: undefined,
      };
    }

    const parsed = contentTypes(node.contentType);
    if (Option.isNone(parsed)) {
      return {
        contentType: [],
        findings: [...findings, invalidContentType(input)],
        refused: true,
        rows: [],
        serialization: undefined,
      };
    }

    return {
      contentType: parsed.value,
      findings,
      refused: false,
      rows: ["ENC-01", "ENC-02"],
      serialization: undefined,
    };
  });

const headerRequired = (
  resolution: Resolution,
  actual: string,
  name: string,
): Effect.Effect<boolean> => {
  const pointer = `${actual}/headers/${escapeToken(name)}`;
  const home = referenceAt(resolution, pointer)?.target.pointer ?? pointer;

  return evaluatePointer(resolution.value, home).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(HeaderObject)),
    Effect.map((header) => header.required ?? false),
    Effect.orElseSucceed(() => false),
  );
};

interface Headers {
  readonly findings: readonly Finding[];
  readonly headers: readonly PlainHeader[] | undefined;
}

// ENC-03, ENC-11: part headers; a `Content-Type` entry is ignored, a bad name refuses the part.
const headersOf = (
  resolution: Resolution,
  actual: string,
  node: EncodingNode,
): Effect.Effect<Headers> =>
  Effect.gen(function* headers() {
    const findings: Finding[] = [];
    const kept: PlainHeader[] = [];
    for (const name of Object.keys(node.headers ?? {})) {
      const pointer = `${actual}/headers/${escapeToken(name)}`;
      if (name.toLowerCase() === "content-type") {
        findings.push(
          notice(
            "ENC-11/content-type-header-ignored",
            "encoding-headers",
            "Encoding header Content-Type",
            "The specification says a Content-Type entry in headers SHALL be ignored; the part type comes from contentType.",
            pointer,
          ),
        );
      } else if (Option.isNone(Schema.decodeUnknownOption(HeaderName)(name))) {
        findings.push(
          refusal(
            "ENC-03/invalid-header-name",
            "encoding-headers",
            "Encoding header name",
            `The header name ${JSON.stringify(sanitize(name))} is not an HTTP field name.`,
            pointer,
          ),
        );

        return { findings, headers: undefined };
      } else {
        kept.push({ name, required: yield* headerRequired(resolution, actual, name) });
      }
    }

    return { findings, headers: kept };
  });

interface NestedEntry {
  readonly actual: string;
  readonly node: EncodingNode;
  readonly target: Target;
}

const nestedEntries = (node: EncodingNode, actual: string): readonly NestedEntry[] => [
  ...Object.entries(node.encoding ?? {}).map(([name, child]): NestedEntry => ({
    actual: `${actual}/encoding/${escapeToken(name)}`,
    node: child,
    target: { kind: "property", name },
  })),
  ...(node.prefixEncoding ?? []).map((child, index): NestedEntry => ({
    actual: `${actual}/prefixEncoding/${index}`,
    node: child,
    target: { index, kind: "position" },
  })),
];

const toNested = (rule: PlainRule): PlainNested => {
  const nested: PlainNested = {
    contentType: rule.contentType,
    headers: rule.headers,
    target: rule.target,
  };
  if (rule.serialization !== undefined) {
    nested.serialization = rule.serialization;
  }

  return nested;
};

const nestingRefusal = (code: string, element: string, message: string, actual: string): Finding =>
  refusal(code, "nested-encoding", element, message, actual);

interface Nesting {
  readonly findings: readonly Finding[];
  readonly nested: readonly PlainNested[];
  readonly refused: boolean;
  readonly rows: readonly string[];
}

const refuseNesting = (finding: Finding): Nesting => ({
  findings: [finding],
  nested: [],
  refused: true,
  rows: [],
});

interface Batch {
  readonly findings: readonly Finding[];
  readonly refused: boolean;
  readonly rules: readonly PlainRule[];
}

type BuildAll = (
  ctx: Context,
  inputs: readonly RuleInput[],
) => Effect.Effect<Batch, BodyNodeBudget>;

const nestedRows = (node: EncodingNode): readonly string[] => [
  ...(node.encoding === undefined ? [] : ["ENC-07"]),
  ...(node.prefixEncoding === undefined ? [] : ["ENC-08"]),
];

// ENC-07 to ENC-09, ENC-16: one nested level by name and by position; a deeper level, and a nested
// itemEncoding (which `EncodingRule.nested` cannot hold), are refused.
const nestingOf = (
  ctx: Context,
  input: RuleInput,
  node: EncodingNode,
  buildAll: BuildAll,
): Effect.Effect<Nesting, BodyNodeBudget> =>
  Effect.gen(function* nesting() {
    const entries = nestedEntries(node, input.actual);
    if (input.depth === 1 && (entries.length > 0 || node.itemEncoding !== undefined)) {
      return refuseNesting(
        nestingRefusal(
          "ENC-16/nesting-too-deep",
          "Encoding nested more than one level",
          "Nested encoding is supported for one level only.",
          input.actual,
        ),
      );
    }

    if (node.itemEncoding !== undefined) {
      return refuseNesting(
        nestingRefusal(
          "ENC-09/nested-item-encoding",
          "Nested itemEncoding",
          "A nested itemEncoding has no place in the model.",
          `${input.actual}/itemEncoding`,
        ),
      );
    }

    const children =
      entries.length === 0 || input.schemaPointer === undefined
        ? noMembers
        : yield* membersOf(ctx.walk, input.schemaPointer);
    const built = yield* buildAll(
      ctx,
      entries.map((entry): RuleInput => ({
        actual: entry.actual,
        depth: 1,
        honorsStyle: false,
        node: entry.node,
        schemaPointer: memberSchema(children, entry.target),
        target: entry.target,
      })),
    );

    return {
      findings: built.findings,
      nested: built.rules.map((rule) => toNested(rule)),
      refused: built.refused,
      rows: nestedRows(node),
    };
  });

// One Encoding Object, or the table default of a part that has none, as a rule (design 2.2).
const buildRule = (
  ctx: Context,
  input: RuleInput,
  buildAll: BuildAll,
): Effect.Effect<RuleResult, BodyNodeBudget> =>
  Effect.gen(function* build() {
    const node: EncodingNode = input.node ?? {};
    const typing = yield* typingOf(ctx, input, node);
    if (typing.refused) {
      return { findings: typing.findings, rule: undefined };
    }

    const headers = yield* headersOf(ctx.resolution, input.actual, node);
    const nesting = yield* nestingOf(ctx, input, node, buildAll);
    const findings = [...typing.findings, ...headers.findings, ...nesting.findings];
    if (headers.headers === undefined || nesting.refused) {
      return { findings, rule: undefined };
    }

    const rule: PlainRule = {
      contentType: typing.contentType,
      headers: headers.headers,
      origin: { document: ctx.resolution.document, pointer: input.actual },
      rows: sorted([
        ...typing.rows,
        ...nesting.rows,
        ...(headers.headers.length === 0 ? [] : ["ENC-03"]),
      ]),
      target: input.target,
    };
    if (nesting.nested.length > 0) {
      rule.nested = nesting.nested;
    }

    if (typing.serialization !== undefined) {
      rule.serialization = typing.serialization;
    }

    return { findings, rule };
  });

// Builds the rules in order and stops at the first refusal.
const buildAll: BuildAll = (ctx, inputs) =>
  Effect.gen(function* all() {
    const findings: Finding[] = [];
    const rules: PlainRule[] = [];
    for (const input of inputs) {
      const result = yield* buildRule(ctx, input, buildAll);
      findings.push(...result.findings);
      if (result.rule === undefined) {
        return { findings, refused: true, rules: [] };
      }

      rules.push(result.rule);
    }

    return { findings, refused: false, rules };
  });

// --- Media alternatives ---

interface PlainAlternative {
  readonly codec: Codec;
  readonly encoding: readonly PlainRule[];
  itemEncoding?: PlainRule;
  itemSchema?: { readonly key: string };
  readonly mediaType: string;
  readonly origin: { readonly document: string; readonly pointer: string };
  readonly prefixEncoding: readonly PlainRule[];
  readonly rows: readonly string[];
  schema?: { readonly key: string };
}

interface AlternativeResult {
  readonly alternative: PlainAlternative | undefined;
  readonly findings: readonly Finding[];
}

const stopAlternative = (...findings: readonly Finding[]): AlternativeResult => ({
  alternative: undefined,
  findings,
});

const schemaKeyAt = (resolution: Resolution, pointer: string): string =>
  referenceAt(resolution, pointer)?.defsKey ??
  defsKey(resolution.document, { document: resolution.document, pointer });

const formRefusal = (line: Line, pointer: string): Finding =>
  refusal(
    line === "3.2" ? "ENC-28/not-implemented" : "ENC-27/not-implemented",
    "encoding-the-x-www-form-urlencoded-media-type",
    "Request body application/x-www-form-urlencoded",
    "This construct is read but not implemented in Milestone 1.",
    pointer,
    "Milestone 2 implements this",
  );

// The slice names `S30-24/multipart-extra-fields` for 3.0, but the Diagnostic codec's row pattern
// (`^[A-Z]+-[0-9]+$`, src/model/diagnostic.ts) rejects the digits in `S30`, so 3.0 reports SCH-13
// too until that pattern admits them; then restore the 3.0 code here and in the test.
const extraFieldsRefusal = (pointer: string): Finding =>
  refusal(
    "SCH-13/multipart-extra-fields",
    "json-schema-keywords",
    "Multipart schema additionalProperties",
    "A schema-valued additionalProperties on a multipart body root would add parts the declared properties do not name.",
    pointer,
    "D-ENC1 decides extra multipart fields; until then this map is refused and the declared parts stay",
  );

const encodingIgnored = (line: Line, pointer: string): Finding =>
  line === "3.2"
    ? notice(
        "MED-14/encoding-ignored",
        "encoding-usage-and-restrictions",
        "Media type encoding fields",
        "Encoding fields SHALL be ignored for media types other than multipart and form-urlencoded.",
        pointer,
      )
    : notice(
        "MED-10/encoding-ignored",
        "media-type-encoding",
        "Media type encoding",
        "The encoding field applies to multipart and form-urlencoded request bodies only, so it is ignored here.",
        pointer,
      );

interface Media {
  readonly home: string;
  readonly node: MediaNode;
}

const readMedia = (
  resolution: Resolution,
  mediaPointer: string,
): Effect.Effect<Media, BodyNotReadable> => {
  const unreadable = new BodyNotReadable({
    pointer: mediaPointer,
    reason: "media-type-not-an-object",
  });
  const reference = referenceAt(resolution, mediaPointer);
  const home = reference?.target.pointer ?? mediaPointer;
  if (reference !== undefined && reference.target.document !== resolution.document) {
    return Effect.fail(unreadable);
  }

  return evaluatePointer(resolution.value, home).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(MediaTypeObject)),
    Effect.mapError(() => unreadable),
    Effect.map((node) => ({ home, node })),
  );
};

const alternativeRows = (
  line: Line,
  node: MediaNode,
  schema: boolean,
  itemSchema: boolean,
): readonly string[] =>
  sorted([
    "MED-01",
    ...(schema ? ["MED-02"] : []),
    ...(itemSchema ? ["MED-03"] : []),
    ...(node.encoding === undefined ? [] : ["MED-06"]),
    ...(node.prefixEncoding === undefined ? [] : ["MED-07"]),
    ...(node.itemEncoding === undefined ? [] : ["MED-08"]),
    ...(schema || itemSchema ? [] : [line === "3.0" ? "RQB-10" : "RQB-09"]),
  ]);

interface Parts {
  readonly encoding: readonly PlainRule[];
  readonly findings: readonly Finding[];
  readonly itemEncoding: PlainRule | undefined;
  readonly prefixEncoding: readonly PlainRule[];
  readonly refused: boolean;
}

const noParts: Parts = {
  encoding: [],
  findings: [],
  itemEncoding: undefined,
  prefixEncoding: [],
  refused: false,
};

const refusedParts = (findings: readonly Finding[]): Parts => ({
  ...noParts,
  findings,
  refused: true,
});

// The schema-valued additionalProperties of a multipart root, found through `$ref` and `allOf`.
const extraFields = (
  ctx: Context,
  schemaPointer: string,
): Effect.Effect<readonly Finding[], BodyNodeBudget> =>
  flatten(ctx.walk, schemaPointer).pipe(
    Effect.map((nodes) => {
      const found = firstLocated(nodes, (node) =>
        Schema.is(ObjectValue)(node.additionalProperties) ? true : undefined,
      );

      return found === undefined
        ? []
        : [extraFieldsRefusal(`${found.pointer}/additionalProperties`)];
    }),
  );

// ENC-33 and MED-13: a multipart body this line cannot read at all.
const partsBlocker = (line: Line, media: Media): Finding | undefined => {
  const { home, node } = media;
  const positional = node.prefixEncoding !== undefined || node.itemEncoding !== undefined;
  if (node.schema === undefined && line !== "3.2") {
    return refusal(
      "ENC-33/missing-schema",
      "encoding-multipart-media-types",
      "Multipart media type without a schema",
      "A multipart body REQUIRES a schema in this OpenAPI line.",
      home,
    );
  }

  return line === "3.2" && node.encoding !== undefined && positional
    ? refusal(
        "MED-13/encoding-with-positional",
        "media-type-encoding",
        "Media type encoding with prefixEncoding or itemEncoding",
        "encoding MUST NOT appear with prefixEncoding or itemEncoding.",
        home,
      )
    : undefined;
};

interface Keys {
  readonly findings: readonly Finding[];
  readonly refused: boolean;
}

// MED-11 refuses an encoding key that names no property; MED-12 (3.2) ignores it with a notice.
const unknownKeys = (line: Line, media: Media, members: Members): Keys => {
  const declared = new Set(members.properties.map(([name]) => name));
  const findings: Finding[] = [];
  for (const name of Object.keys(media.node.encoding ?? {})) {
    const actual = `${media.home}/encoding/${escapeToken(name)}`;
    if (!declared.has(name) && line !== "3.2") {
      return {
        findings: [
          refusal(
            "MED-11/unknown-property",
            "media-type-encoding",
            "Media type encoding key",
            `The encoding key ${JSON.stringify(sanitize(name))} is not a property of the schema.`,
            actual,
          ),
        ],
        refused: true,
      };
    }

    if (!declared.has(name)) {
      findings.push(
        notice(
          "MED-12/absent-property-ignored",
          "encoding-by-name",
          "Media type encoding key",
          `The encoding key ${JSON.stringify(sanitize(name))} names no schema property, so it is ignored.`,
          actual,
        ),
      );
    }
  }

  return { findings, refused: false };
};

// One input per declared property, then per prefixEncoding entry, then the itemEncoding rule.
const partInputs = (
  line: Line,
  media: Media,
  members: Members,
  honorsStyle: boolean,
): readonly RuleInput[] => {
  const { home, node } = media;
  const byName = node.encoding ?? {};
  const prefix = line === "3.2" ? (node.prefixEncoding ?? []) : [];
  const item = line === "3.2" ? node.itemEncoding : undefined;
  const properties = members.properties.map(([name, schemaPointer]): RuleInput => {
    const explicit = Object.hasOwn(byName, name) ? byName[name] : undefined;

    return {
      actual: explicit === undefined ? schemaPointer : `${home}/encoding/${escapeToken(name)}`,
      depth: 0,
      honorsStyle,
      node: explicit,
      schemaPointer,
      target: { kind: "property", name },
    };
  });
  const positions = prefix.map((entry, index): RuleInput => ({
    actual: `${home}/prefixEncoding/${index}`,
    depth: 0,
    honorsStyle,
    node: entry,
    schemaPointer: members.prefixItems[index],
    target: { index, kind: "position" },
  }));
  const remaining: RuleInput[] =
    item === undefined
      ? []
      : [
          {
            actual: `${home}/itemEncoding`,
            depth: 0,
            honorsStyle,
            node: item,
            schemaPointer: node.itemSchema === undefined ? members.items : `${home}/itemSchema`,
            target: { index: prefix.length, kind: "position" },
          },
        ];

  return [...properties, ...positions, ...remaining];
};

// Multipart part rules: the declared properties by name, then 3.2 positions (design 6.3).
const multipartParts = (
  ctx: Context,
  media: Media,
  base: string,
): Effect.Effect<Parts, BodyNodeBudget> =>
  Effect.gen(function* parts() {
    const { line } = ctx;
    const blocker = partsBlocker(line, media);
    if (blocker !== undefined) {
      return refusedParts([blocker]);
    }

    const schemaPointer = media.node.schema === undefined ? undefined : `${media.home}/schema`;
    const members =
      schemaPointer === undefined ? noMembers : yield* membersOf(ctx.walk, schemaPointer);
    const extra = schemaPointer === undefined ? [] : yield* extraFields(ctx, schemaPointer);
    const keys = unknownKeys(line, media, members);
    if (keys.refused) {
      return refusedParts([...extra, ...keys.findings]);
    }

    const honorsStyle = base === "multipart/form-data" && line !== "3.0";
    const inputs = partInputs(line, media, members, honorsStyle);
    const built = yield* buildAll(ctx, inputs);
    const findings = [...extra, ...keys.findings, ...built.findings];
    if (built.refused) {
      return refusedParts(findings);
    }

    const prefixCount = line === "3.2" ? (media.node.prefixEncoding ?? []).length : 0;
    const propertyCount = members.properties.length;
    const positioned = built.rules.slice(propertyCount);

    return {
      encoding: built.rules.slice(0, propertyCount),
      findings,
      itemEncoding: positioned[prefixCount],
      prefixEncoding: positioned.slice(0, prefixCount),
      refused: false,
    };
  });

const ignoredParts = (line: Line, media: Media): Parts => {
  const { home, node } = media;
  const present = [node.encoding, node.prefixEncoding, node.itemEncoding].some(
    (member) => member !== undefined,
  );

  return present ? { ...noParts, findings: [encodingIgnored(line, home)] } : noParts;
};

const normalizeAlternative = (
  ctx: Context,
  bodyPointer: string,
  key: string,
): Effect.Effect<AlternativeResult, BodyNodeBudget | BodyNotReadable> =>
  Effect.gen(function* alternative() {
    const { line, resolution } = ctx;
    const mediaPointer = `${bodyPointer}/content/${escapeToken(key)}`;
    if (Option.isNone(Schema.decodeUnknownOption(MediaRange)(key))) {
      return stopAlternative(
        refusal(
          "MED-24/invalid-media-type",
          "media-types",
          "Request body content key",
          `The content key ${JSON.stringify(sanitize(key))} is not a media type or range.`,
          mediaPointer,
        ),
      );
    }

    const base = baseType(key);
    const codec = codecOf(base);
    if (codec === "form") {
      return stopAlternative(formRefusal(line, mediaPointer));
    }

    const media = yield* readMedia(resolution, mediaPointer);
    const { home, node } = media;
    const parts =
      codec === "multipart" ? yield* multipartParts(ctx, media, base) : ignoredParts(line, media);
    if (parts.refused) {
      return stopAlternative(...parts.findings);
    }

    // An XML body is opaque, so its schema is never consulted (design 6.3, D-SCH3).
    const opaque = codec === "xml";
    const result: PlainAlternative = {
      codec,
      encoding: parts.encoding,
      mediaType: key,
      origin: { document: resolution.document, pointer: home },
      prefixEncoding: parts.prefixEncoding,
      rows: alternativeRows(
        line,
        node,
        node.schema !== undefined && !opaque,
        node.itemSchema !== undefined && !opaque,
      ),
    };
    if (node.schema !== undefined && !opaque) {
      result.schema = { key: schemaKeyAt(resolution, `${home}/schema`) };
    }

    if (node.itemSchema !== undefined && !opaque) {
      result.itemSchema = { key: schemaKeyAt(resolution, `${home}/itemSchema`) };
    }

    if (parts.itemEncoding !== undefined) {
      result.itemEncoding = parts.itemEncoding;
    }

    return { alternative: result, findings: parts.findings };
  });

// --- Diagnostics and the body ---

interface DiagnosticFields {
  code: string;
  document: string;
  element: string;
  hint?: string;
  message: string;
  openapi: string;
  operation?: typeof DiagnosticOperation.Type;
  pointer: string;
  related?: readonly { readonly document: string; readonly pointer: string }[];
  row: string;
  scope: "element";
  severity: "notice" | "refusal";
  specSection: string;
}

// The use site is the operation's request body; when it is a reference, the element's own
// location in the target is `related[0]` (design 8.1).
const toDiagnostics = (
  ctx: Context,
  findings: readonly Finding[],
): Effect.Effect<readonly Diagnostic[]> =>
  Effect.all(
    findings.map((item) => {
      const fields: DiagnosticFields = {
        code: item.code,
        document: ctx.resolution.document,
        element: item.element,
        message: item.message,
        openapi: ctx.site.openapi,
        pointer: ctx.reference === undefined ? item.pointer : ctx.site.pointer,
        row: item.code.slice(0, item.code.indexOf("/")),
        scope: "element",
        severity: item.severity,
        specSection: `https://spec.openapis.org/oas/v${specVersion[ctx.line]}.html#${item.anchor}`,
      };
      if (item.hint !== undefined) {
        fields.hint = item.hint;
      }

      if (ctx.site.operation !== undefined) {
        fields.operation = ctx.site.operation;
      }

      if (ctx.reference !== undefined) {
        fields.related = [{ document: ctx.resolution.document, pointer: item.pointer }];
      }

      return Schema.decodeUnknownEffect(Diagnostic)(fields);
    }),
  ).pipe(Effect.orDie);

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

const emptyContent = (line: Line, pointer: string): Finding =>
  refusal(
    "RQB-07/empty-content",
    line === "3.0" ? "request-body-object" : "request-body-content",
    "Request body content",
    "The request body declares no media type, so nothing can be sent.",
    pointer,
  );

/**
 * Normalizes one Request Body Object into a `Body` whose alternatives are the media types that
 * survive, with element-scope refusals and notices for the rest (design 2.2, 6.3, 6.6). Codecs
 * follow the media type; encoding defaults follow the line's table; XML stays opaque; staged and
 * undecided constructs are refused rather than dropped. A site the earlier stages should have
 * stopped fails with `BodyNotReadable`.
 */
export const normalizeBody = (
  resolution: Resolution,
  site: BodySite,
  limits: ResolveLimits = defaultLimits,
): Effect.Effect<BodyOutcome, BodyNodeBudget | BodyNotReadable> =>
  Effect.gen(function* normalize() {
    const unreadable = new BodyNotReadable({ pointer: site.pointer, reason: "not-a-request-body" });
    const reference = referenceAt(resolution, site.pointer);
    const target = reference?.target ?? { document: resolution.document, pointer: site.pointer };
    if (target.document !== resolution.document) {
      return yield* unreadable;
    }

    const node = yield* evaluatePointer(resolution.value, target.pointer).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RequestBodyObject)),
      Effect.mapError(() => unreadable),
    );
    const walk: Walk = { maxNodes: limits.maxNodes, resolution, site, spent: 0 };
    const ctx: Context = { line: resolution.line, reference, resolution, site, walk };
    const required = node.required ?? false;
    const keys = Object.keys(node.content);
    if (keys.length === 0) {
      const empty = emptyContent(resolution.line, `${target.pointer}/content`);

      return { _tag: "Refused", diagnostics: yield* toDiagnostics(ctx, [empty]), required };
    }

    const results = yield* Effect.all(
      keys.map((key) => normalizeAlternative(ctx, target.pointer, key)),
    );
    const diagnostics = yield* toDiagnostics(
      ctx,
      results.flatMap((result) => result.findings),
    );
    const alternatives = results.flatMap((result) =>
      result.alternative === undefined ? [] : [result.alternative],
    );
    if (alternatives.length === 0) {
      return { _tag: "Refused", diagnostics, required };
    }

    const body = yield* Schema.decodeUnknownEffect(Body)({
      alternatives,
      docs: docsOf(reference?.description ?? node.description, reference?.summary),
      origin: { document: resolution.document, pointer: site.pointer },
      required,
      rows: ["RQB-01", "RQB-03", "RQB-04"],
    }).pipe(Effect.orDie);

    return { _tag: "Implemented", body, diagnostics };
  });
