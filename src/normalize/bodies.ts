import { Array as Arr, Data, Effect, Option, Order, Predicate, Schema } from "effect";
import { HeaderName, MediaRange } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import type { DiagnosticOperation } from "../model/diagnostic.ts";
import { Body, EncodingRule } from "../model/entities.ts";
import type { DiscriminatorHint } from "../model/entities.ts";
import { nodeAt as jsonAt } from "../model/json-tree.ts";
import { childPointer, formatPointer } from "../model/pointer.ts";
import type { Json } from "../model/pointer.ts";
import { keyOf } from "../resolve/canonical.ts";
import type { CanonicalKey } from "../resolve/canonical.ts";
import { allOfReferrers, defaultLimits, implicitComponent } from "../resolve/index.ts";
import type { ResolveLimits, Resolution, ResolvedReference } from "../resolve/index.ts";
import type { Line } from "../validate/index.ts";
import { specSectionUrl } from "../model/spec-section.ts";
import { docsOf, sanitize } from "./docs.ts";
import { childKey, follow, nodeIn, referenceIn } from "./document-set.ts";
import { headerMarks } from "./header-object.ts";
import { deepObjectExplodeText, formStyleRefusal, partHeader } from "./parameters.ts";
import type { PartHeaderOutcome } from "./parameters.ts";
import { appliesDynamicKeyword, schemaKeyAt } from "./schemas.ts";

/**
 * Where a request body is read: its use site in the entry document, the operation it belongs to
 * when known, and the document's full `openapi` value. `nonStandard` carries the author config's
 * opt-in switches of the same name; absent is strict (design 6.1, D-OQ1).
 */
export interface BodySite {
  readonly nonStandard?: { readonly deepObjectBrackets?: boolean };
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
  description: Schema.optionalKey(Schema.String),
  encoding: Schema.optionalKey(Schema.Record(Schema.String, EncodingObject)),
  itemEncoding: Schema.optionalKey(EncodingObject),
  itemSchema: Schema.optionalKey(Schema.Unknown),
  prefixEncoding: Schema.optionalKey(Schema.Array(EncodingObject)),
  schema: Schema.optionalKey(Schema.Unknown),
});

type MediaNode = typeof MediaTypeObject.Type;

// Only what the part rules read of a schema; a boolean schema decodes to nothing. `required` and
// the compositions are `Unknown` so a malformed value never hides the node's other members.
const SchemaNode = Schema.Struct({
  additionalProperties: Schema.optionalKey(Schema.Unknown),
  allOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  anyOf: Schema.optionalKey(Schema.Unknown),
  contentEncoding: Schema.optionalKey(Schema.String),
  dependentRequired: Schema.optionalKey(Schema.Unknown),
  dependentSchemas: Schema.optionalKey(Schema.Unknown),
  format: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.Unknown),
  items: Schema.optionalKey(Schema.Unknown),
  not: Schema.optionalKey(Schema.Unknown),
  oneOf: Schema.optionalKey(Schema.Unknown),
  prefixItems: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  properties: Schema.optionalKey(ObjectValue),
  required: Schema.optionalKey(Schema.Unknown),
  type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});

type SchemaNodeValue = typeof SchemaNode.Type;

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
  /**
   * The refusal drops its whole media alternative; `anchorDrops` moves it to the media type.
   */
  readonly drops?: true;
  readonly element: string;
  readonly hint?: string;
  readonly message: string;
  readonly at: CanonicalKey;
  readonly related?: readonly CanonicalKey[];
  /**
   * `field`: one property of a kept alternative is refused (design 8.5); absent, `element`.
   */
  readonly scope?: "field";
  readonly severity: "notice" | "refusal";
}

const refusal = (
  code: string,
  anchor: string,
  element: string,
  message: string,
  at: CanonicalKey,
  hint?: string,
): Finding => {
  const base: Finding = { anchor, at, code, element, message, severity: "refusal" };

  return hint === undefined ? base : { ...base, hint };
};

const notice = (
  code: string,
  anchor: string,
  element: string,
  message: string,
  at: CanonicalKey,
): Finding => ({ anchor, at, code, element, message, severity: "notice" });

// A refusal whose part, rule or key leaves its media alternative with nothing to send.
const dropping = (finding: Finding): Finding => ({ ...finding, drops: true });

// A refusal that drops a whole alternative is reported at that media type, its own keyword first
// in `related`, so the report names what was dropped and coverage credits it.
const anchorDrops = (home: CanonicalKey, findings: readonly Finding[]): readonly Finding[] =>
  findings.map((finding) =>
    finding.drops === true
      ? { ...finding, at: home, related: [finding.at, ...(finding.related ?? [])] }
      : finding,
  );

// A dropping refusal of an optional property whose alternative stays is refused at `field` scope,
// anchored at the property's Encoding entry, its own keyword first in `related` (design 8.5 rule 4).
const fieldRefusal = (entry: CanonicalKey, finding: Finding): Finding => {
  const { drops: _drops, ...kept } = finding;
  const field: Finding = { ...kept, at: entry, scope: "field" };

  return keyOf(finding.at) === keyOf(entry)
    ? field
    : { ...field, related: [finding.at, ...(finding.related ?? [])] };
};

const sorted = (rows: readonly string[]): readonly string[] =>
  Arr.sort(Arr.dedupe(rows), Order.String);

// --- Schema inspection (design 6.3, MED-27: only `$ref` and `allOf` are followed) ---

interface Located {
  readonly at: CanonicalKey;
  readonly node: SchemaNodeValue;
}

// Follows schema references to the schema they end at, in whichever document of the set holds it.
const settle = (resolution: Resolution, start: CanonicalKey): CanonicalKey => {
  let current = start;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const reference = referenceIn(resolution, current);
    if (reference === undefined || reference.kind !== "schema") {
      return current;
    }

    current = reference.target;
  }

  return current;
};

const nodeAt = (resolution: Resolution, at: CanonicalKey): Effect.Effect<SchemaNodeValue> =>
  nodeIn(resolution, at).pipe(
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
    specSection: specSectionUrl(walk.resolution.line, "reference-object"),
  }).pipe(
    Effect.orDie,
    Effect.flatMap((diagnostic) => Effect.fail(new BodyNodeBudget({ diagnostic }))),
  );

// The schema and its `allOf` members in document order, each distinct schema once, so a graph
// that reuses members costs its size and a cycle ends at the first repeat.
const flatten = (
  walk: Walk,
  start: CanonicalKey,
): Effect.Effect<readonly Located[], BodyNodeBudget> =>
  Effect.gen(function* walkMembers() {
    const seen = new Set<string>();
    const found: Located[] = [];
    const pending = [start];
    let next = pending.pop();
    while (next !== undefined) {
      const at = settle(walk.resolution, next);
      walk.spent += 1;
      if (walk.spent > walk.maxNodes) {
        return yield* budgetFailure(walk);
      }

      if (!seen.has(keyOf(at))) {
        seen.add(keyOf(at));

        const node = yield* nodeAt(walk.resolution, at);
        found.push({ at, node });

        const members = (node.allOf ?? []).map((_, index) => childKey(at, "allOf", String(index)));
        pending.push(...Arr.reverse(members));
      }

      next = pending.pop();
    }

    return found;
  });

const firstLocated = <T>(
  nodes: readonly Located[],
  read: (node: SchemaNodeValue) => T | undefined,
): { readonly at: CanonicalKey; readonly value: T } | undefined => {
  for (const located of nodes) {
    const value = read(located.node);
    if (value !== undefined) {
      return { at: located.at, value };
    }
  }

  return undefined;
};

interface Members {
  readonly items: CanonicalKey | undefined;
  readonly prefixItems: readonly CanonicalKey[];
  readonly properties: readonly (readonly [string, CanonicalKey])[];
}

const noMembers: Members = { items: undefined, prefixItems: [], properties: [] };

// The declared properties (document order, first definition wins) and item schemas of a schema.
const membersOf = (walk: Walk, schema: CanonicalKey): Effect.Effect<Members, BodyNodeBudget> =>
  Effect.gen(function* members() {
    const nodes = yield* flatten(walk, schema);
    const seen = new Set<string>();
    const properties: (readonly [string, CanonicalKey])[] = [];
    for (const located of nodes) {
      for (const name of Object.keys(located.node.properties ?? {})) {
        if (!seen.has(name)) {
          seen.add(name);
          properties.push([name, childKey(located.at, "properties", name)]);
        }
      }
    }

    const prefix = firstLocated(nodes, (node) => node.prefixItems);
    const items = firstLocated(nodes, (node) => node.items);

    return {
      items: items === undefined ? undefined : childKey(items.at, "items"),
      prefixItems:
        prefix === undefined
          ? []
          : prefix.value.map((_, index) => childKey(prefix.at, "prefixItems", String(index))),
      properties,
    };
  });

const memberSchema = (members: Members, target: Target): CanonicalKey | undefined =>
  target.kind === "property"
    ? members.properties.find(([name]) => name === target.name)?.[1]
    : members.prefixItems[target.index];

/**
 * Which properties of an alternative schema are required (design 8.5 rule 3): `names` gathers every
 * `required` array on the path `membersOf` walks, the root, `$ref` targets and `allOf` members.
 * `sure` is false when that walk cannot be complete: a cycle, a reference it cannot follow, or a
 * composition it does not resolve; then every property counts as required.
 */
interface Requirement {
  readonly names: ReadonlySet<string>;
  readonly sure: boolean;
}

// Keywords that can make a property required on a path `membersOf` does not follow; `then` and
// `else` apply only under `if`.
const unresolved = [
  "anyOf",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "not",
  "oneOf",
] as const;

const requiredStrings = Schema.decodeUnknownOption(Schema.Array(Schema.String));

const requirementOf = (
  walk: Walk,
  schema: CanonicalKey,
): Effect.Effect<Requirement, BodyNodeBudget> =>
  Effect.gen(function* requirement() {
    const names = new Set<string>();
    const done = new Set<string>();
    const path = new Set<string>();
    let sure = true;
    // A schema already on the path is a cycle, and a reference `settle` left unfollowed is not
    // resolved: either leaves the walk unsure. A schema reached twice otherwise is read once.
    const visit = (start: CanonicalKey): Effect.Effect<void, BodyNodeBudget> =>
      Effect.gen(function* member() {
        const at = settle(walk.resolution, start);
        walk.spent += 1;
        if (walk.spent > walk.maxNodes) {
          yield* budgetFailure(walk);
        }

        const key = keyOf(at);
        if (path.has(key) || referenceIn(walk.resolution, at)?.kind === "schema") {
          sure = false;
        } else if (!done.has(key)) {
          done.add(key);

          const node = yield* nodeAt(walk.resolution, at);
          for (const name of Option.getOrElse(requiredStrings(node.required), () => [])) {
            names.add(name);
          }

          if (unresolved.some((keyword) => node[keyword] !== undefined)) {
            sure = false;
          }

          path.add(key);
          for (const index of (node.allOf ?? []).keys()) {
            yield* visit(childKey(at, "allOf", String(index)));
          }

          path.delete(key);
        }
      });

    yield* visit(schema);

    return { names, sure };
  });

const isRequired = (requirement: Requirement, name: string): boolean =>
  !requirement.sure || requirement.names.has(name);

interface Facts {
  readonly contentEncoding: { readonly at: CanonicalKey; readonly value: string } | undefined;
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
  schema: CanonicalKey | undefined,
  depth = 0,
): Effect.Effect<Facts, BodyNodeBudget> =>
  Effect.gen(function* facts() {
    if (schema === undefined) {
      return noFacts;
    }

    const nodes = yield* flatten(walk, schema);
    const items = firstLocated(nodes, (node) => node.items);
    const itemFacts =
      items === undefined || depth > 0
        ? undefined
        : yield* factsOf(walk, childKey(items.at, "items"), depth + 1);
    const type = firstLocated(nodes, (node) => node.type)?.value;

    return {
      contentEncoding: firstLocated(nodes, (node) => node.contentEncoding),
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

// An array is typed by its items (ENC-23), except in 3.2, where an array is `application/json`
// unless it is a top-level property under encoding by name, which is encoded per item (ENC-24).
const arrayDefault =
  (byName: boolean): ArrayDefault =>
  (line, facts) => {
    const items = defaultOfTypes(line, facts.items ?? noFacts, nestedArrayDefault).type;
    if (line !== "3.2") {
      return { row: "ENC-23", type: items };
    }

    return { row: "ENC-24", type: byName ? items : "application/json" };
  };

// ENC-17 to ENC-26: the default contentType of a part from the schema of its value.
const defaultFor = (line: Line, facts: Facts, input: RuleInput): Default =>
  defaultOfTypes(line, facts, arrayDefault(input.target.kind === "property" && input.depth === 0));

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
  readonly deprecated: boolean;
  readonly name: string;
  readonly required: boolean;
  readonly schema: { readonly key: string };
  readonly serialization: Extract<PartHeaderOutcome, { readonly _tag: "Typed" }>["serialization"];
}

interface PlainNested {
  readonly contentType: readonly string[];
  readonly headers: readonly PlainHeader[];
  serialization?: PlainSerialization;
  readonly target: Target;
}

interface PlainRule extends PlainNested {
  contentEncoding?: Transfer;
  nested?: readonly PlainNested[];
  nonStandard?: "deepObjectBrackets";
  readonly origin: { readonly document: string; readonly pointer: string };
  readonly rows: readonly string[];
}

interface RuleResult {
  readonly findings: readonly Finding[];
  readonly rule: PlainRule | undefined;
}

interface RuleInput {
  readonly actual: CanonicalKey;
  readonly depth: 0 | 1;
  /**
   * The part is a top-level part of a `multipart/form-data` body, whose `Content-Disposition` the
   * writer writes.
   */
  readonly formData: boolean;
  readonly honorsStyle: boolean;
  readonly node: EncodingNode | undefined;
  readonly schema: CanonicalKey | undefined;
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

/**
 * Whether a style-based `multipart/form-data` part is sent the way the multipart writer sends it
 * (ENC-40, Appendix C): `form` with `explode` gives one name and raw value per value, which is one
 * part per value, under no contentType (RFC 7578: `text/plain`). `allowReserved` has no effect on
 * multipart. Other styles and an unexploded `form` join values into one part, which the writer has
 * no input for.
 */
export const sendsFormPairs = (serialization: {
  readonly explode?: boolean | undefined;
  readonly style?: string | undefined;
}): boolean =>
  (serialization.style === undefined || serialization.style === "form") &&
  serialization.explode !== false;

const formPairsType = "text/plain";

const unsupportedPartStyleCode = "ENC-40/unsupported-part-style";

const unsupportedPartStyle = (input: RuleInput): Finding =>
  refusal(
    unsupportedPartStyleCode,
    "appendix-c-using-rfc6570-based-serialization",
    "Encoding style, explode or allowReserved",
    `The multipart part ${JSON.stringify(sanitize(targetLabel(input.target)))} uses a style that joins its values into one part, which is not supported; the part has no flag.`,
    input.actual,
    "Use style form with explode true, or remove the style fields",
  );

const styleIgnored = (actual: CanonicalKey): Finding =>
  notice(
    "ENC-12/style-ignored",
    "encoding-style",
    "Encoding style, explode or allowReserved",
    "The specification applies these fields to form-urlencoded and multipart/form-data values only, so they are ignored here.",
    actual,
  );

const contentTypeIgnored = (actual: CanonicalKey): Finding =>
  notice(
    "ENC-13/content-type-ignored",
    "fixed-fields-for-rfc6570-style-serialization",
    "Encoding contentType beside style fields",
    "An explicit style, explode or allowReserved makes contentType SHALL be ignored.",
    actual,
  );

const invalidContentType = (input: RuleInput): Finding =>
  dropping(
    refusal(
      "ENC-02/invalid-content-type",
      "encoding-content-type",
      "Encoding contentType",
      `The contentType of ${JSON.stringify(sanitize(targetLabel(input.target)))} is not a list of media ranges.`,
      childKey(input.actual, "contentType"),
    ),
  );

// D-SCH3: an object part typed as XML would need serialization from its schema and XML Object,
// which is refused. A scalar part typed as XML is the operator's own text, sent as given.
const schemaDrivenXml = (input: RuleInput): Finding =>
  dropping(
    refusal(
      "XML-01/schema-driven",
      "xml-object",
      "Multipart part contentType",
      `The multipart part ${JSON.stringify(sanitize(targetLabel(input.target)))} is an object typed as XML, which needs serialization from its schema and the XML Object; schema-driven XML is not supported.`,
      childKey(input.actual, "contentType"),
      "Type the part application/json, or make the whole body an XML media type sent from --body-file",
    ),
  );

const isXmlType = (range: string): boolean => codecOf(baseType(range)) === "xml";

// Whether the part's schema is an object: typed `object`, or untyped with declared properties,
// found through `$ref` and `allOf`.
const isObjectPart = (
  walk: Walk,
  schema: CanonicalKey | undefined,
  facts: Facts,
): Effect.Effect<boolean, BodyNodeBudget> =>
  Effect.gen(function* objectPart() {
    if (schema === undefined) {
      return false;
    }

    if (facts.type.includes("object")) {
      return true;
    }

    return facts.type.length === 0 && (yield* membersOf(walk, schema)).properties.length > 0;
  });

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
  facts: Effect.Effect<Facts, BodyNodeBudget>,
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
      const fallback = defaultFor(ctx.line, yield* facts, input);

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

// A multipart part's typing: as `typingOf`, and an object part typed as XML is refused (XML-01).
const partTypingOf = (
  ctx: Context,
  input: RuleInput,
  node: EncodingNode,
  facts: Facts,
): Effect.Effect<Typing, BodyNodeBudget> =>
  Effect.gen(function* partTyping() {
    const typing = yield* typingOf(ctx, input, node, Effect.succeed(facts));
    const xml = typing.contentType.some(isXmlType);
    if (typing.refused || !xml || !(yield* isObjectPart(ctx.walk, input.schema, facts))) {
      return typing;
    }

    return {
      ...typing,
      contentType: [],
      findings: [...typing.findings, schemaDrivenXml(input)],
      refused: true,
      rows: [],
    };
  });

interface Headers {
  readonly findings: readonly Finding[];
  readonly headers: readonly PlainHeader[] | undefined;
  /**
   * Whether the rule declares a header besides an ignored `Content-Type` (row ENC-03).
   */
  readonly declares: boolean;
}

const writerOwnedCode = "ENC-03/writer-owned-header";

// Headers the multipart writer writes itself (design 6.3): `Content-Transfer-Encoding` always, and
// `Content-Disposition`, with the part name RFC 7578 requires, under `multipart/form-data`.
const writerOwned = (name: string, formData: boolean): boolean => {
  const folded = name.toLowerCase();

  return folded === "content-transfer-encoding" || (formData && folded === "content-disposition");
};

// ENC-03, ENC-11: part headers, each typed and serialized as a header parameter (HDR-01). A
// `Content-Type` entry is ignored, a header the writer owns gets no flag, and a bad name or a header
// the header parameter path cannot carry refuses the part.
const headersOf = (ctx: Context, input: RuleInput, node: EncodingNode): Effect.Effect<Headers> =>
  Effect.gen(function* headers() {
    const { resolution } = ctx;
    const findings: Finding[] = [];
    const kept: PlainHeader[] = [];
    let declares = false;
    for (const name of Object.keys(node.headers ?? {})) {
      const at = childKey(input.actual, "headers", name);
      if (name.toLowerCase() === "content-type") {
        findings.push(
          notice(
            "ENC-11/content-type-header-ignored",
            "encoding-headers",
            "Encoding header Content-Type",
            "The specification says a Content-Type entry in headers SHALL be ignored; the part type comes from contentType.",
            at,
          ),
        );
        continue;
      }

      declares = true;
      if (Option.isNone(Schema.decodeUnknownOption(HeaderName)(name))) {
        findings.push(
          dropping(
            refusal(
              "ENC-03/invalid-header-name",
              "encoding-headers",
              "Encoding header name",
              `The header name ${JSON.stringify(sanitize(name))} is not an HTTP field name.`,
              at,
            ),
          ),
        );

        return { declares, findings, headers: undefined };
      }

      if (writerOwned(name, input.formData)) {
        findings.push(
          notice(
            writerOwnedCode,
            "encoding-headers",
            `Encoding header ${name}`,
            `The multipart writer writes ${name} itself, so the declared header gets no flag and is not sent as declared.`,
            at,
          ),
        );
        continue;
      }

      const typed = yield* partHeader(resolution, at, name, at, { maxNodes: ctx.walk.maxNodes });
      if (typed._tag === "Unsupported") {
        findings.push(
          dropping(
            refusal(
              "ENC-03/unsupported-part-header",
              "encoding-headers",
              `Encoding header ${name}`,
              `The part header ${name} cannot be sent as a header parameter: ${typed.reason}`,
              at,
              "Describe the header with a schema the header parameter rules accept, or remove it",
            ),
          ),
        );

        return { declares, findings, headers: undefined };
      }

      const marks = yield* headerMarks(resolution, at);
      kept.push({
        deprecated: marks.deprecated,
        name,
        required: marks.required,
        schema: typed.schema,
        serialization: typed.serialization,
      });
    }

    return { declares, findings, headers: kept };
  });

interface NestedEntry {
  readonly actual: CanonicalKey;
  readonly node: EncodingNode;
  readonly target: Target;
}

const nestedEntries = (node: EncodingNode, actual: CanonicalKey): readonly NestedEntry[] => [
  ...Object.entries(node.encoding ?? {}).map(([name, child]): NestedEntry => ({
    actual: childKey(actual, "encoding", name),
    node: child,
    target: { kind: "property", name },
  })),
  ...(node.prefixEncoding ?? []).map((child, index): NestedEntry => ({
    actual: childKey(actual, "prefixEncoding", String(index)),
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

const nestingRefusal = (
  code: string,
  element: string,
  message: string,
  actual: CanonicalKey,
): Finding => dropping(refusal(code, "nested-encoding", element, message, actual));

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
          childKey(input.actual, "itemEncoding"),
        ),
      );
    }

    const children =
      entries.length === 0 || input.schema === undefined
        ? noMembers
        : yield* membersOf(ctx.walk, input.schema);
    const built = yield* buildAll(
      ctx,
      entries.map((entry): RuleInput => ({
        actual: entry.actual,
        depth: 1,
        formData: false,
        honorsStyle: false,
        node: entry.node,
        schema: memberSchema(children, entry.target),
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

// --- Transfer encoding (design 6.3: ENC-37 to ENC-39) ---

type Transfer = "base64";

interface TransferResult {
  readonly encoding: Transfer | undefined;
  readonly finding: Finding | undefined;
  readonly row: string | undefined;
}

const noTransfer: TransferResult = { encoding: undefined, finding: undefined, row: undefined };

const base64Transfer = (row: string): TransferResult => ({
  encoding: "base64",
  finding: undefined,
  row,
});

const transferAnchor = (line: Line): string =>
  line === "3.2"
    ? "content-transfer-encoding-and-contentencoding"
    : "encoding-multipart-media-types";

// Transfer encodings are case-insensitive tokens (RFC 2045 6.1).
const isBase64 = (value: string): boolean => value.toLowerCase() === "base64";

// The identity encodings of RFC 2045 6.2: the part is not transformed.
const identityEncodings: ReadonlySet<string> = new Set(["7bit", "8bit", "binary"]);

const isIdentity = (value: string): boolean => identityEncodings.has(value.toLowerCase());

// What one schema declares: 3.0 `format: byte` (ENC-38), 3.1+ `contentEncoding` (ENC-37). base64
// has a writer; an identity encoding sends the part raw, as a 3.0 `format: binary` part is, with no
// Content-Transfer-Encoding line of its own. Any other `contentEncoding` refuses the part.
const declaredTransfer = (line: Line, label: string, facts: Facts): TransferResult | undefined => {
  if (line === "3.0") {
    return facts.format === "byte" ? base64Transfer("ENC-38") : undefined;
  }

  const declared = facts.contentEncoding;
  if (declared === undefined) {
    return undefined;
  }

  if (isBase64(declared.value)) {
    return base64Transfer("ENC-37");
  }

  return isIdentity(declared.value)
    ? { ...noTransfer, row: "ENC-37" }
    : {
        ...noTransfer,
        finding: dropping(
          refusal(
            "ENC-37/unsupported-content-encoding",
            transferAnchor(line),
            "Multipart part contentEncoding",
            `The contentEncoding ${JSON.stringify(sanitize(declared.value))} of ${JSON.stringify(sanitize(label))} is neither base64 nor an identity encoding (binary, 7bit, 8bit), the transfer encodings a part is sent with.`,
            childKey(declared.at, "contentEncoding"),
            "Use contentEncoding base64 or binary, or remove it to send the part as is",
          ),
        ),
      };
};

// A part's transfer encoding, from its schema or, for a repeated part, its items. A nested part
// has no field to hold one, so it is refused rather than sent unencoded.
const transferOf = (ctx: Context, input: RuleInput, facts: Facts): TransferResult => {
  const label = targetLabel(input.target);
  const found =
    declaredTransfer(ctx.line, label, facts) ??
    (facts.items === undefined ? undefined : declaredTransfer(ctx.line, label, facts.items)) ??
    noTransfer;
  if (input.depth === 0 || found.encoding === undefined) {
    return found;
  }

  return {
    ...noTransfer,
    finding: dropping(
      refusal(
        `${found.row}/nested-transfer-encoding`,
        transferAnchor(ctx.line),
        "Transfer encoding of a nested part",
        `The nested part ${JSON.stringify(sanitize(label))} declares a base64 transfer encoding, which a nested part cannot carry.`,
        input.actual,
      ),
    ),
  };
};

const TransferHeaderSchema = Schema.Struct({
  const: Schema.optionalKey(Schema.Unknown),
  enum: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

const transferHeaderOf = (node: EncodingNode): string | undefined =>
  Object.keys(node.headers ?? {}).find(
    (name) => name.toLowerCase() === "content-transfer-encoding",
  );

// A header schema keyword admits base64 when it is absent or lists it among its string values.
const admitsBase64 = (values: readonly string[] | undefined): boolean =>
  values === undefined || values.some(isBase64);

// ENC-39: a declared Content-Transfer-Encoding header whose schema rules out the part's base64.
const transferConflict = (
  ctx: Context,
  input: RuleInput,
  name: string,
): Effect.Effect<Finding | undefined> =>
  Effect.gen(function* conflict() {
    const header = follow(ctx.resolution, childKey(input.actual, "headers", name));
    const at = follow(ctx.resolution, childKey(header, "schema"));
    const schema = yield* nodeIn(ctx.resolution, at).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(TransferHeaderSchema)),
      Effect.orElseSucceed((): typeof TransferHeaderSchema.Type => ({})),
    );
    const isString = Schema.is(Schema.String);
    const declared = {
      const: schema.const === undefined ? undefined : [schema.const].filter(isString),
      enum: schema.enum?.filter(isString),
    };
    const keyword = (["const", "enum"] as const).find((field) => !admitsBase64(declared[field]));

    return keyword === undefined
      ? undefined
      : dropping(
          refusal(
            "ENC-39/conflicting-transfer-encoding",
            transferAnchor(ctx.line),
            "Encoding header Content-Transfer-Encoding",
            `The Content-Transfer-Encoding schema of ${JSON.stringify(sanitize(targetLabel(input.target)))} does not admit base64, the transfer encoding its schema declares.`,
            childKey(at, keyword),
            "Remove the header, or let its schema admit base64",
          ),
        );
  });

// One Encoding Object, or the table default of a part that has none, as a rule (design 2.2).
const buildRule = (
  ctx: Context,
  input: RuleInput,
  buildAll: BuildAll,
): Effect.Effect<RuleResult, BodyNodeBudget> =>
  Effect.gen(function* build() {
    const node: EncodingNode = input.node ?? {};
    const facts = yield* factsOf(ctx.walk, input.schema);
    const typing = yield* partTypingOf(ctx, input, node, facts);
    if (typing.refused) {
      return { findings: typing.findings, rule: undefined };
    }

    const transfer = transferOf(ctx, input, facts);
    if (transfer.finding !== undefined) {
      return { findings: [...typing.findings, transfer.finding], rule: undefined };
    }

    const headers = yield* headersOf(ctx, input, node);
    const transferHeader = transferHeaderOf(node);
    const conflict =
      transfer.encoding === undefined ||
      headers.headers === undefined ||
      transferHeader === undefined
        ? undefined
        : yield* transferConflict(ctx, input, transferHeader);
    // A conflict refuses the part, so it sends no header and the writer-owned notices are moot.
    if (conflict !== undefined) {
      const kept = headers.findings.filter(({ code }) => code !== writerOwnedCode);

      return { findings: [...typing.findings, ...kept, conflict], rule: undefined };
    }

    const nesting = yield* nestingOf(ctx, input, node, buildAll);
    // ENC-40: a style the writer sends is name and raw value under `text/plain`; any other style
    // refuses the part alone, and the rule keeps its style so the names plan gives it no flag.
    const styled = typing.serialization;
    const pairs = styled !== undefined && sendsFormPairs(styled);
    const findings = [
      ...typing.findings,
      ...headers.findings,
      ...nesting.findings,
      ...(styled === undefined || pairs ? [] : [unsupportedPartStyle(input)]),
    ];
    if (headers.headers === undefined || nesting.refused) {
      return { findings, rule: undefined };
    }

    const rule: PlainRule = {
      contentType: pairs ? [formPairsType] : typing.contentType,
      headers: headers.headers,
      origin: input.actual,
      rows: sorted([
        ...typing.rows,
        ...nesting.rows,
        ...(headers.declares ? ["ENC-03"] : []),
        ...(transfer.row === undefined ? [] : [transfer.row]),
        ...(styled === undefined ? [] : ["ENC-40"]),
      ]),
      target: input.target,
    };
    if (transfer.encoding !== undefined) {
      rule.contentEncoding = transfer.encoding;
    }

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
  refusedFields?: readonly string[];
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

// Every line reports `SCH-13`. The slice named `S30-24/multipart-extra-fields` for 3.0; the
// Diagnostic row pattern (src/model/diagnostic.ts) now admits `S30-24`, but moving 3.0 to that code
// changes its diagnostics, so it is not done here.
const extraFieldsRefusal = (at: CanonicalKey): Finding =>
  refusal(
    "SCH-13/multipart-extra-fields",
    "json-schema-keywords",
    "Multipart schema additionalProperties",
    "A schema-valued additionalProperties on a multipart body root would add parts the declared properties do not name.",
    at,
    "D-ENC1 decides extra multipart fields; until then this map is refused and the declared parts stay",
  );

const encodingIgnored = (line: Line, at: CanonicalKey): Finding =>
  line === "3.2"
    ? notice(
        "MED-14/encoding-ignored",
        "encoding-usage-and-restrictions",
        "Media type encoding fields",
        "Encoding fields SHALL be ignored for media types other than multipart and form-urlencoded.",
        at,
      )
    : notice(
        "MED-10/encoding-ignored",
        "media-type-encoding",
        "Media type encoding",
        "The encoding field applies to multipart and form-urlencoded request bodies only, so it is ignored here.",
        at,
      );

// D-OC5: a Media Type description has no use in a generated CLI, so it is ignored.
const descriptionIgnored = (at: CanonicalKey): Finding =>
  notice(
    "MED-09/description-ignored",
    "media-type-object",
    "Media type description",
    "The description of a media type is not used, so it is ignored here.",
    at,
  );

// MED-26: a form-data body is a set of named parts, so an array of name/value objects has no part
// flags to fill and every run would fail.
const arrayFormData = (at: CanonicalKey): Finding =>
  refusal(
    "MED-26/array-form-data",
    "encoding-multipart-media-types",
    "Multipart form-data array body",
    "A multipart/form-data body whose schema is an array has no named parts to send, so the media type is refused.",
    at,
    "Describe the body as an object whose properties are the parts",
  );

// MED-25: a multipart type other than form-data sends unnamed ordered parts, and correlating them
// with an object's properties by a Content-Disposition name is a MAY this generator does not offer.
const unnamedParts = (line: Line, at: CanonicalKey): Finding =>
  refusal(
    "MED-25/unnamed-parts",
    line === "3.2" ? "additional-encoding-approaches" : "encoding-multipart-media-types",
    "Multipart object body other than form-data",
    "This multipart type sends unnamed parts in order, which the object schema's named properties do not map to, so the media type is refused.",
    at,
    line === "3.2"
      ? "Use multipart/form-data, or describe the parts in order with an array schema"
      : "Use multipart/form-data",
  );

interface Media {
  readonly home: CanonicalKey;
  readonly node: MediaNode;
}

const readMedia = (
  resolution: Resolution,
  mediaSite: CanonicalKey,
): Effect.Effect<Media, BodyNotReadable> => {
  const unreadable = new BodyNotReadable({
    pointer: mediaSite.pointer,
    reason: "media-type-not-an-object",
  });
  const home = follow(resolution, mediaSite);

  return nodeIn(resolution, home).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(MediaTypeObject)),
    Effect.mapError(() => unreadable),
    Effect.map((node) => ({ home, node })),
  );
};

const alternativeRows = (
  line: Line,
  codec: Codec,
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
    ...(codec === "form" ? [line === "3.2" ? "ENC-28" : "ENC-27", "ENC-29"] : []),
  ]);

interface Parts {
  readonly encoding: readonly PlainRule[];
  readonly findings: readonly Finding[];
  readonly itemEncoding: PlainRule | undefined;
  readonly prefixEncoding: readonly PlainRule[];
  readonly refused: boolean;
  /**
   * The properties refused at `field` scope, in property order (design 8.5).
   */
  readonly refusedFields: readonly string[];
}

const noParts: Parts = {
  encoding: [],
  findings: [],
  itemEncoding: undefined,
  prefixEncoding: [],
  refused: false,
  refusedFields: [],
};

const refusedParts = (findings: readonly Finding[]): Parts => ({
  ...noParts,
  findings,
  refused: true,
});

// The schema-valued additionalProperties of a multipart root, found through `$ref` and `allOf`.
const extraFields = (
  ctx: Context,
  schema: CanonicalKey,
): Effect.Effect<readonly Finding[], BodyNodeBudget> =>
  flatten(ctx.walk, schema).pipe(
    Effect.map((nodes) => {
      const found = firstLocated(nodes, (node) =>
        Schema.is(ObjectValue)(node.additionalProperties) ? true : undefined,
      );

      return found === undefined
        ? []
        : [extraFieldsRefusal(childKey(found.at, "additionalProperties"))];
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
    const actual = childKey(media.home, "encoding", name);
    if (!declared.has(name) && line !== "3.2") {
      return {
        findings: [
          dropping(
            refusal(
              "MED-11/unknown-property",
              "media-type-encoding",
              "Media type encoding key",
              `The encoding key ${JSON.stringify(sanitize(name))} is not a property of the schema.`,
              actual,
            ),
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

// One input per declared property in document order, with its Encoding Object when it has one.
const propertyInputs = (
  media: Media,
  members: Members,
  honorsStyle: boolean,
  formData: boolean,
): readonly RuleInput[] => {
  const byName = media.node.encoding ?? {};

  return members.properties.map(([name, schema]): RuleInput => {
    const explicit = Object.hasOwn(byName, name) ? byName[name] : undefined;

    return {
      actual: explicit === undefined ? schema : childKey(media.home, "encoding", name),
      depth: 0,
      formData,
      honorsStyle,
      node: explicit,
      schema,
      target: { kind: "property", name },
    };
  });
};

// One input per declared property, then per prefixEncoding entry, then the itemEncoding rule.
const partInputs = (
  line: Line,
  media: Media,
  members: Members,
  honorsStyle: boolean,
  formData: boolean,
): readonly RuleInput[] => {
  const { home, node } = media;
  const prefix = line === "3.2" ? (node.prefixEncoding ?? []) : [];
  const item = line === "3.2" ? node.itemEncoding : undefined;
  const properties = propertyInputs(media, members, honorsStyle, formData);
  const positions = prefix.map((entry, index): RuleInput => ({
    actual: childKey(home, "prefixEncoding", String(index)),
    depth: 0,
    formData,
    honorsStyle,
    node: entry,
    schema: members.prefixItems[index],
    target: { index, kind: "position" },
  }));
  const remaining: RuleInput[] =
    item === undefined
      ? []
      : [
          {
            actual: childKey(home, "itemEncoding"),
            depth: 0,
            formData,
            honorsStyle,
            node: item,
            schema: node.itemSchema === undefined ? members.items : childKey(home, "itemSchema"),
            target: { index: prefix.length, kind: "position" },
          },
        ];

  return [...properties, ...positions, ...remaining];
};

// Multipart part rules: the declared properties by name, then 3.2 positions (design 6.3).
const typesOf = (nodes: readonly Located[]): readonly string[] => {
  const type = firstLocated(nodes, (node) => node.type)?.value;

  return type === undefined ? [] : Arr.ensure(type);
};

// An array root: typed array, or item schemas with no declared properties.
const isArrayBody = (
  walk: Walk,
  schema: CanonicalKey,
  members: Members,
): Effect.Effect<boolean, BodyNodeBudget> =>
  Effect.gen(function* arrayBody() {
    if (
      members.properties.length === 0 &&
      (members.items !== undefined || members.prefixItems.length > 0)
    ) {
      return true;
    }

    return typesOf(yield* flatten(walk, schema)).includes("array");
  });

// An object root: not an array body, and typed object or with declared properties.
const isObjectBody = (
  walk: Walk,
  schema: CanonicalKey,
  members: Members,
): Effect.Effect<boolean, BodyNodeBudget> =>
  Effect.gen(function* objectBody() {
    if (yield* isArrayBody(walk, schema, members)) {
      return false;
    }

    return (
      members.properties.length > 0 || typesOf(yield* flatten(walk, schema)).includes("object")
    );
  });

interface PartStyles {
  readonly drops: boolean;
  readonly findings: readonly Finding[];
  readonly refusedFields: readonly string[];
}

// ENC-40 on a named part follows the form property rules (design 8.5 rules 2, 3 and 11): refused
// at `field` scope when every named part it refuses is optional, otherwise every one of them drops
// the alternative. A 3.2 positional entry has no name, so its refusal keeps `element` scope.
const partStyles = (
  ctx: Context,
  schema: CanonicalKey | undefined,
  inputs: readonly RuleInput[],
  findings: readonly Finding[],
): Effect.Effect<PartStyles, BodyNodeBudget> =>
  Effect.gen(function* styles() {
    const named = new Map(
      inputs.flatMap((input) =>
        input.target.kind === "property" ? [[keyOf(input.actual), input.target.name] as const] : [],
      ),
    );
    const nameOf = (finding: Finding): string | undefined =>
      finding.code === unsupportedPartStyleCode ? named.get(keyOf(finding.at)) : undefined;
    const refusedFields = findings.flatMap((finding) => nameOf(finding) ?? []);
    if (schema === undefined || refusedFields.length === 0) {
      return { drops: false, findings, refusedFields: [] };
    }

    const requirement = yield* requirementOf(ctx.walk, schema);
    const drops = refusedFields.some((name) => isRequired(requirement, name));
    const moved = (finding: Finding): Finding =>
      drops ? dropping(finding) : fieldRefusal(finding.at, finding);

    return {
      drops,
      findings: findings.map((finding) =>
        nameOf(finding) === undefined ? finding : moved(finding),
      ),
      refusedFields: drops ? [] : refusedFields,
    };
  });

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

    const schema = media.node.schema === undefined ? undefined : childKey(media.home, "schema");
    const members = schema === undefined ? noMembers : yield* membersOf(ctx.walk, schema);
    if (
      schema !== undefined &&
      base === "multipart/form-data" &&
      (yield* isArrayBody(ctx.walk, schema, members))
    ) {
      return refusedParts([arrayFormData(media.home)]);
    }

    // A range such as `multipart/*` is not a concrete type, so it is left to the emitter.
    if (
      schema !== undefined &&
      base !== "multipart/form-data" &&
      !base.endsWith("/*") &&
      (yield* isObjectBody(ctx.walk, schema, members))
    ) {
      return refusedParts([dropping(unnamedParts(line, schema))]);
    }

    const extra = schema === undefined ? [] : yield* extraFields(ctx, schema);
    const keys = unknownKeys(line, media, members);
    if (keys.refused) {
      return refusedParts([...extra, ...keys.findings]);
    }

    const honorsStyle = base === "multipart/form-data" && line !== "3.0";
    const inputs = partInputs(line, media, members, honorsStyle, base === "multipart/form-data");
    const built = yield* buildAll(ctx, inputs);
    if (built.refused) {
      return refusedParts([...extra, ...keys.findings, ...built.findings]);
    }

    const styled = yield* partStyles(ctx, schema, inputs, built.findings);
    const findings = [...extra, ...keys.findings, ...styled.findings];
    if (styled.drops) {
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
      refusedFields: styled.refusedFields,
    };
  });

// --- Form-urlencoded (design 6.3) ---

const multipartOnly = (code: string, anchor: string, field: string, at: CanonicalKey): Finding =>
  notice(
    code,
    anchor,
    `Encoding ${field} under form-urlencoded`,
    `The ${field} field applies to multipart media types only, so it is ignored for form-urlencoded.`,
    at,
  );

// Fields a form value has no use for, in pointer order: part headers (ENC-11) and nested encoding
// (ENC-07 to ENC-09).
const formIgnored = (node: EncodingNode, actual: CanonicalKey): readonly Finding[] => [
  ...(node.encoding === undefined
    ? []
    : [
        multipartOnly(
          "ENC-07/nested-encoding-ignored",
          "encoding-encoding",
          "encoding",
          childKey(actual, "encoding"),
        ),
      ]),
  ...(node.headers === undefined
    ? []
    : [
        multipartOnly(
          "ENC-11/headers-ignored",
          "encoding-headers",
          "headers",
          childKey(actual, "headers"),
        ),
      ]),
  ...(node.itemEncoding === undefined
    ? []
    : [
        multipartOnly(
          "ENC-09/item-encoding-ignored",
          "encoding-item-encoding",
          "itemEncoding",
          childKey(actual, "itemEncoding"),
        ),
      ]),
  ...(node.prefixEncoding === undefined
    ? []
    : [
        multipartOnly(
          "ENC-08/prefix-encoding-ignored",
          "encoding-prefix-encoding",
          "prefixEncoding",
          childKey(actual, "prefixEncoding"),
        ),
      ]),
];

const formContentTypeRefusal = (input: RuleInput, expected: string): Finding =>
  dropping(
    refusal(
      "ENC-02/form-content-type",
      "encoding-content-type",
      "Encoding contentType under form-urlencoded",
      `The contentType of ${JSON.stringify(sanitize(targetLabel(input.target)))} differs from ${expected}, the type a form value is sent as.`,
      childKey(input.actual, "contentType"),
      `Remove contentType, or set it to ${expected}`,
    ),
  );

const isCompound = (types: readonly string[]): boolean =>
  types.some((name) => name === "object" || name === "array");

// PRM-27 (design 6.1): a deepObject value is nested when its schema is an array, or declares a
// property or additionalProperties schema whose type is or includes object or array. An untyped
// member is not nested.
const isNested = (
  walk: Walk,
  schema: CanonicalKey | undefined,
): Effect.Effect<boolean, BodyNodeBudget> =>
  Effect.gen(function* nested() {
    if (schema === undefined) {
      return false;
    }

    const nodes = yield* flatten(walk, schema);
    if (typesOf(nodes).includes("array")) {
      return true;
    }

    const members = nodes.flatMap(({ at, node }) => [
      ...Object.keys(node.properties ?? {}).map((name) => childKey(at, "properties", name)),
      ...(Schema.is(ObjectValue)(node.additionalProperties)
        ? [childKey(at, "additionalProperties")]
        : []),
    ]);
    for (const member of members) {
      if (isCompound(typesOf(yield* flatten(walk, member)))) {
        return true;
      }
    }

    return false;
  });

const compoundNested = (input: RuleInput): Finding =>
  dropping(
    refusal(
      "PRM-27/compound-nested",
      "style-values",
      "Encoding style deepObject under form-urlencoded",
      `The deepObject value of ${JSON.stringify(sanitize(targetLabel(input.target)))} has nested objects or arrays, which the specification does not define.`,
      input.actual,
      "Set nonStandard.deepObjectBrackets in the author config to send it in the bracket convention",
    ),
  );

const bracketChoiceCode = "PRM-27/bracket-author-choice";

const bracketChoice = (input: RuleInput): Finding =>
  notice(
    bracketChoiceCode,
    "style-values",
    "Encoding style deepObject under form-urlencoded",
    `The author config sends the nested deepObject value of ${JSON.stringify(sanitize(targetLabel(input.target)))} in the bracket convention, which the specification does not define.`,
    input.actual,
  );

// The query style table's refusal for a form property's explicit style fields (design 6.3, through
// the parameter rule `formStyleRefusal`), placed at the Encoding entry; it drops the alternative.
const styleRefusalOf = (
  ctx: Context,
  input: RuleInput,
  serialization: PlainSerialization | undefined,
): Effect.Effect<Option.Option<Finding>> =>
  serialization === undefined
    ? Effect.succeedNone
    : formStyleRefusal(ctx.resolution, input.schema, serialization, {
        maxNodes: ctx.walk.maxNodes,
      }).pipe(
        Effect.map(
          Option.map((found) =>
            dropping(
              refusal(
                found.code,
                found.anchor,
                "Encoding style under form-urlencoded",
                found.message,
                input.actual,
                found.hint,
              ),
            ),
          ),
        ),
      );

// ENC-12 (design D-OC14): a 3.0 or 3.1 form deepObject with explode false or omitted is exploded,
// as STY-26 is for a parameter, with that row's notice text.
const deepObjectExplode = (
  line: Line,
  serialization: PlainSerialization | undefined,
  actual: CanonicalKey,
): readonly Finding[] =>
  line !== "3.2" && serialization?.style === "deepObject" && serialization.explode !== true
    ? [
        notice(
          "ENC-12/explode-no-effect",
          "encoding-explode",
          "Encoding deepObject explode",
          deepObjectExplodeText,
          actual,
        ),
      ]
    : [];

// What PRM-27 does to one form rule: nothing, refuse its alternative (strict), or mark it for the
// bracket convention (the author config's switch, never defaulted or inferred).
const deepObjectOf = (
  ctx: Context,
  input: RuleInput,
  serialization: PlainSerialization | undefined,
): Effect.Effect<"mark" | "none" | "refuse", BodyNodeBudget> =>
  Effect.gen(function* deepObject() {
    if (serialization?.style !== "deepObject" || !(yield* isNested(ctx.walk, input.schema))) {
      return "none";
    }

    return ctx.site.nonStandard?.deepObjectBrackets === true ? "mark" : "refuse";
  });

// One form property's rule. Style fields apply on every line (ENC-12; 3.0 per ENC-14); without
// them the value is sent by the default table, so an explicit contentType is kept only when it
// names the table's type, which changes nothing on the wire. Style fields the query style table
// marks not applicable refuse the alternative (STY-17 to STY-24, PRM-27), and a deepObject over a
// nested value refuses it unless the author config opts into brackets (PRM-27).
const formRule = (ctx: Context, input: RuleInput): Effect.Effect<RuleResult, BodyNodeBudget> =>
  Effect.gen(function* build() {
    const node: EncodingNode = input.node ?? {};
    const typing = yield* typingOf(ctx, input, node, factsOf(ctx.walk, input.schema));
    if (typing.refused) {
      return { findings: typing.findings, rule: undefined };
    }

    const inapplicable = yield* styleRefusalOf(ctx, input, typing.serialization);
    if (Option.isSome(inapplicable)) {
      return { findings: [...typing.findings, inapplicable.value], rule: undefined };
    }

    const deepObject = yield* deepObjectOf(ctx, input, typing.serialization);
    if (deepObject === "refuse") {
      return { findings: [...typing.findings, compoundNested(input)], rule: undefined };
    }

    const explicit = typing.serialization === undefined && node.contentType !== undefined;
    const fallback = explicit
      ? defaultFor(ctx.line, yield* factsOf(ctx.walk, input.schema), input)
      : undefined;
    const [given] = typing.contentType;
    if (
      fallback !== undefined &&
      (typing.contentType.length !== 1 || given?.toLowerCase() !== fallback.type)
    ) {
      return {
        findings: [...typing.findings, formContentTypeRefusal(input, fallback.type)],
        rule: undefined,
      };
    }

    const rule: PlainRule = {
      contentType: typing.contentType,
      headers: [],
      origin: input.actual,
      rows: sorted([
        ...typing.rows,
        ...(fallback === undefined ? [] : [fallback.row]),
        ...(typing.serialization === undefined ? [] : ["ENC-12"]),
        ...(ctx.line === "3.0" ? ["ENC-14"] : []),
      ]),
      target: input.target,
    };
    if (typing.serialization !== undefined) {
      rule.serialization = typing.serialization;
    }

    if (deepObject === "mark") {
      rule.nonStandard = "deepObjectBrackets";
    }

    return {
      findings: [
        ...typing.findings,
        ...(deepObject === "mark" ? [bracketChoice(input)] : []),
        ...deepObjectExplode(ctx.line, typing.serialization, input.actual),
        ...formIgnored(node, input.actual),
      ],
      rule,
    };
  });

// Positional encoding applies to multipart only (MED-07, MED-08), so a form alternative ignores it.
const formPositional = (media: Media): readonly Finding[] => [
  ...(media.node.itemEncoding === undefined
    ? []
    : [
        multipartOnly(
          "MED-08/item-encoding-ignored",
          "media-type-item-encoding",
          "itemEncoding",
          childKey(media.home, "itemEncoding"),
        ),
      ]),
  ...(media.node.prefixEncoding === undefined
    ? []
    : [
        multipartOnly(
          "MED-07/prefix-encoding-ignored",
          "media-type-prefix-encoding",
          "prefixEncoding",
          childKey(media.home, "prefixEncoding"),
        ),
      ]),
];

// A refused form alternative sends nothing, so no entry of it is sent in the bracket convention:
// its bracket notices go with it (design 8.4), whatever the order of its properties.
const refusedFormParts = (findings: readonly Finding[]): Parts =>
  refusedParts(findings.filter((finding) => finding.code !== bracketChoiceCode));

// Form-urlencoded rules: one per declared property, by name (MED-11, MED-12 as for multipart).
// With `fields` (a request body, design 8.5 rules 2, 3 and 11), a property whose rule refuses is
// refused at `field` scope when it is optional, and the alternative stays; a required one drops
// the alternative with every entry's dropping refusals, so no `field` record outlives it. Without
// (a `querystring` content entry, design 6.1), the first refusing rule refuses the entry.
const formParts = (
  ctx: Context,
  media: Media,
  fields: boolean,
): Effect.Effect<Parts, BodyNodeBudget> =>
  Effect.gen(function* parts() {
    const schema = media.node.schema === undefined ? undefined : childKey(media.home, "schema");
    const members = schema === undefined ? noMembers : yield* membersOf(ctx.walk, schema);
    const keys = unknownKeys(ctx.line, media, members);
    if (keys.refused) {
      return refusedParts(keys.findings);
    }

    const findings: Finding[] = [...keys.findings, ...formPositional(media)];
    const rules: PlainRule[] = [];
    const refusedFields: string[] = [];
    const entries = new Map<Finding, CanonicalKey>();
    let requirement: Requirement | undefined;
    for (const input of propertyInputs(media, members, true, false)) {
      const result = yield* formRule(ctx, input);
      findings.push(...result.findings);
      if (result.rule !== undefined) {
        rules.push(result.rule);
        continue;
      }

      if (!fields || schema === undefined || input.target.kind !== "property") {
        return refusedFormParts(findings);
      }

      requirement ??= yield* requirementOf(ctx.walk, schema);
      if (isRequired(requirement, input.target.name)) {
        return refusedFormParts(findings);
      }

      refusedFields.push(input.target.name);
      for (const finding of result.findings) {
        if (finding.drops === true) {
          entries.set(finding, input.actual);
        }
      }
    }

    return {
      ...noParts,
      encoding: rules,
      findings: findings.map((finding) => {
        const entry = entries.get(finding);

        return entry === undefined ? finding : fieldRefusal(entry, finding);
      }),
      refusedFields,
    };
  });

const ignoredParts = (line: Line, media: Media): Parts => {
  const { home, node } = media;
  const present = [node.encoding, node.prefixEncoding, node.itemEncoding].some(
    (member) => member !== undefined,
  );

  return present ? { ...noParts, findings: [encodingIgnored(line, home)] } : noParts;
};

// The part rules of an alternative: multipart and form-urlencoded read their encoding fields; any
// other codec ignores them.
const partsOf = (
  ctx: Context,
  media: Media,
  base: string,
  codec: Codec,
): Effect.Effect<Parts, BodyNodeBudget> => {
  if (codec === "multipart") {
    return multipartParts(ctx, media, base);
  }

  return codec === "form"
    ? formParts(ctx, media, true)
    : Effect.succeed(ignoredParts(ctx.line, media));
};

const normalizeAlternative = (
  ctx: Context,
  body: CanonicalKey,
  key: string,
): Effect.Effect<AlternativeResult, BodyNodeBudget | BodyNotReadable> =>
  Effect.gen(function* alternative() {
    const { line, resolution } = ctx;
    const mediaSite = childKey(body, "content", key);
    if (Option.isNone(Schema.decodeUnknownOption(MediaRange)(key))) {
      // The grammar check refuses the key (MED-24) before normalization, so it is not raised twice.
      return stopAlternative();
    }

    const base = baseType(key);
    const codec = codecOf(base);
    const media = yield* readMedia(resolution, mediaSite);
    const { home, node } = media;
    const parts = yield* partsOf(ctx, media, base, codec);
    if (parts.refused) {
      return stopAlternative(...anchorDrops(home, parts.findings));
    }

    // An XML body is opaque, so its schema is never consulted (design 6.3, D-SCH3).
    const opaque = codec === "xml";
    const schemaSites = opaque
      ? []
      : (["schema", "itemSchema"] as const).flatMap((field) =>
          node[field] === undefined ? [] : [childKey(home, field)],
        );
    const limits = { maxNodes: ctx.walk.maxNodes };
    if (schemaSites.some((site) => appliesDynamicKeyword(resolution, site, limits))) {
      // The schema store refuses the keyword at element scope where it sits (SCH-05, 06, 65, 66);
      // the body cannot be checked without it, so the alternative is refused with no second
      // diagnostic, and a required body left without one raises to operation scope.
      return stopAlternative();
    }

    const result: PlainAlternative = {
      codec,
      encoding: parts.encoding,
      mediaType: key,
      origin: home,
      prefixEncoding: parts.prefixEncoding,
      rows: alternativeRows(
        line,
        codec,
        node,
        node.schema !== undefined && !opaque,
        node.itemSchema !== undefined && !opaque,
      ),
    };
    if (node.schema !== undefined && !opaque) {
      result.schema = { key: schemaKeyAt(resolution, childKey(home, "schema")) };
    }

    if (node.itemSchema !== undefined && !opaque) {
      result.itemSchema = { key: schemaKeyAt(resolution, childKey(home, "itemSchema")) };
    }

    if (parts.itemEncoding !== undefined) {
      result.itemEncoding = parts.itemEncoding;
    }

    if (parts.refusedFields.length > 0) {
      result.refusedFields = parts.refusedFields;
    }

    const described = line === "3.2" && node.description !== undefined;

    return {
      alternative: result,
      findings: described ? [...parts.findings, descriptionIgnored(home)] : parts.findings,
    };
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
  scope: "element" | "field";
  severity: "notice" | "refusal";
  specSection: string;
}

// The use site is the operation's request body; when it is a reference, the element's own
// location in the target is `related[0]` (design 8.1). Otherwise the element names its own
// location, in whichever document of the set holds it.
const toDiagnostics = (
  ctx: Context,
  findings: readonly Finding[],
): Effect.Effect<readonly Diagnostic[]> =>
  Effect.all(
    findings.map((item) => {
      const fields: DiagnosticFields = {
        code: item.code,
        document: ctx.reference === undefined ? item.at.document : ctx.resolution.document,
        element: item.element,
        message: item.message,
        openapi: ctx.site.openapi,
        pointer: ctx.reference === undefined ? item.at.pointer : ctx.site.pointer,
        row: item.code.slice(0, item.code.indexOf("/")),
        scope: item.scope ?? "element",
        severity: item.severity,
        specSection: specSectionUrl(ctx.line, item.anchor),
      };
      if (item.hint !== undefined) {
        fields.hint = item.hint;
      }

      if (ctx.site.operation !== undefined) {
        fields.operation = ctx.site.operation;
      }

      const related = [...(ctx.reference === undefined ? [] : [item.at]), ...(item.related ?? [])];
      if (related.length > 0) {
        fields.related = related;
      }

      return Schema.decodeUnknownEffect(Diagnostic)(fields);
    }),
  ).pipe(Effect.orDie);

const emptyContent = (line: Line, at: CanonicalKey): Finding =>
  refusal(
    "RQB-07/empty-content",
    line === "3.0" ? "request-body-object" : "request-body-content",
    "Request body content",
    "The request body declares no media type, so nothing can be sent.",
    at,
  );

// --- The discriminator hint (design D-OQ9) ---

const Discriminated = Schema.Struct({
  anyOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  discriminator: Schema.Struct({
    mapping: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    propertyName: Schema.NonEmptyString,
  }),
  oneOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

const EntryComponents = Schema.Struct({
  components: Schema.optionalKey(
    Schema.Struct({ schemas: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
  ),
});

type Hint = typeof DiscriminatorHint.Encoded;

type Branch = Hint["branches"][number];

const jsonIn = (resolution: Resolution, key: CanonicalKey): Json | undefined => {
  const document = resolution.documents.get(key.document);

  return document === undefined ? undefined : jsonAt(document, key.pointer);
};

// Whether an element-scope refusal of check names the Discriminator Object of `root`: DSC-03,
// 04, 05, 09 and 10 all sit at or below it, so none is listed by code.
const discriminatorRefused = (findings: readonly Diagnostic[], root: CanonicalKey): boolean => {
  const at = childPointer(root.pointer, "discriminator");

  return findings.some(
    (finding) =>
      finding.severity === "refusal" &&
      finding.scope === "element" &&
      finding.document === root.document &&
      (finding.pointer === at || finding.pointer.startsWith(`${at}/`)),
  );
};

interface Component {
  readonly key: CanonicalKey;
  readonly name: string;
}

// The entry's component schemas, in document key order.
const entrySchemas = (resolution: Resolution): readonly Component[] => {
  const names = Option.match(Schema.decodeUnknownOption(EntryComponents)(resolution.value), {
    onNone: (): readonly string[] => [],
    onSome: (root) => Object.keys(root.components?.schemas ?? {}),
  });

  return names.map((name) => ({
    key: { document: resolution.document, pointer: formatPointer(["components", "schemas", name]) },
    name,
  }));
};

// The entry components whose own `allOf[<i>]` references `root` directly (DSC-11).
const allOfChildren = (
  resolution: Resolution,
  components: readonly Component[],
  root: CanonicalKey,
): readonly CanonicalKey[] => {
  const parents = new Set(
    (allOfReferrers(resolution).get(keyOf(root)) ?? []).map((site) =>
      keyOf({ document: site.document, pointer: site.pointer.replace(/\/allOf\/\d+$/u, "") }),
    ),
  );

  return components.flatMap((component) =>
    parents.has(keyOf(component.key)) ? [component.key] : [],
  );
};

// The composition that lists the branches itself: `oneOf` wins over `anyOf`.
const listedKeyword = (node: typeof Discriminated.Type): "anyOf" | "oneOf" | undefined => {
  if ((node.oneOf ?? []).length > 0) {
    return "oneOf";
  }

  return (node.anyOf ?? []).length > 0 ? "anyOf" : undefined;
};

// The usable discriminator of the schema at `site`, after its `$ref` chain; none when check
// refused it or no branch is found.
const hintAt = (
  resolution: Resolution,
  site: CanonicalKey,
  checkFindings: readonly Diagnostic[],
): Hint | undefined => {
  const root = settle(resolution, site);
  const node = Option.getOrUndefined(
    Schema.decodeUnknownOption(Discriminated)(jsonIn(resolution, root)),
  );
  if (node === undefined || discriminatorRefused(checkFindings, root)) {
    return undefined;
  }

  const components = entrySchemas(resolution);
  const names = new Map(components.map((component) => [keyOf(component.key), component.name]));
  const listed = listedKeyword(node);
  const targets =
    listed === undefined
      ? allOfChildren(resolution, components, root)
      : (node[listed] ?? []).map((_, index) =>
          settle(resolution, childKey(root, listed, String(index))),
        );
  const mapped = Object.entries(node.discriminator.mapping ?? {}).flatMap(([label, value]) =>
    Predicate.isString(value)
      ? Option.match(implicitComponent(resolution, "schemas", value), {
          onNone: () => [],
          onSome: (key) => [[keyOf(key), label] as const],
        })
      : [],
  );
  const branches = targets.map((target, index): Branch => {
    const key = keyOf(target);
    const component = names.get(key);
    const labels = mapped.flatMap(([at, label]) => (at === key ? [label] : []));

    return component === undefined
      ? { index, labels }
      : { component, index, labels: labels.length === 0 ? [component] : labels };
  });

  return branches.length === 0
    ? undefined
    : {
        branches,
        keyword: listed ?? "allOf",
        propertyName: node.discriminator.propertyName,
      };
};

/**
 * Adds the discriminator hint to each alternative of a request body whose root schema, after its
 * `$ref` chain, has a usable discriminator (design D-OQ9): the composition keyword, the property,
 * and the branches in composition order, each labeled by the mapping keys that target it, else by
 * its entry component name (implicit mapping); an inline branch has no label. With no `oneOf` or
 * `anyOf`, the branches are the entry components whose `allOf` references the schema (DSC-11). A
 * discriminator any element-scope refusal in `checkFindings` names gets no hint. The hint never
 * changes validation (DSC-06).
 */
export const hintDiscriminators = (
  resolution: Resolution,
  body: Body,
  checkFindings: readonly Diagnostic[],
): Effect.Effect<Body> =>
  Effect.gen(function* hint() {
    const hints = body.alternatives.map((alternative) =>
      alternative.schema === undefined
        ? undefined
        : hintAt(resolution, childKey(alternative.origin, "schema"), checkFindings),
    );
    if (hints.every((found) => found === undefined)) {
      return body;
    }

    const plain = yield* Schema.encodeEffect(Body)(body);

    return yield* Schema.decodeUnknownEffect(Body)({
      ...plain,
      alternatives: plain.alternatives.map((alternative, index) => {
        const found = hints[index];

        return found === undefined ? alternative : { ...alternative, discriminator: found };
      }),
    });
  }).pipe(Effect.orDie);

/**
 * Normalizes one Request Body Object into a `Body` whose alternatives are the media types that
 * survive, with element-scope refusals and notices for the rest (design 2.2, 6.3, 6.6). Codecs
 * follow the media type; encoding defaults follow the line's table; form-urlencoded and multipart
 * bodies take a rule per property; XML stays opaque; undecided constructs are refused rather than
 * dropped. A site the earlier stages should have stopped fails with `BodyNotReadable`.
 */
export const normalizeBody = (
  resolution: Resolution,
  site: BodySite,
  limits: ResolveLimits = defaultLimits,
): Effect.Effect<BodyOutcome, BodyNodeBudget | BodyNotReadable> =>
  Effect.gen(function* normalize() {
    const unreadable = new BodyNotReadable({ pointer: site.pointer, reason: "not-a-request-body" });
    const use = { document: resolution.document, pointer: site.pointer };
    const reference = referenceIn(resolution, use);
    const target = follow(resolution, use);
    const node = yield* nodeIn(resolution, target).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RequestBodyObject)),
      Effect.mapError(() => unreadable),
    );
    const walk: Walk = { maxNodes: limits.maxNodes, resolution, site, spent: 0 };
    const ctx: Context = { line: resolution.line, reference, resolution, site, walk };
    const required = node.required ?? false;
    const keys = Object.keys(node.content);
    if (keys.length === 0) {
      const empty = emptyContent(resolution.line, childKey(target, "content"));

      return { _tag: "Refused", diagnostics: yield* toDiagnostics(ctx, [empty]), required };
    }

    const results = yield* Effect.all(keys.map((key) => normalizeAlternative(ctx, target, key)));
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

/**
 * What the form rules decided for one form-urlencoded content entry outside a request body.
 * `Implemented` holds one rule per declared property in document order; `Refused` means a rule
 * refused the entry, as it would drop a form body alternative.
 */
export type FormContentOutcome =
  | {
      readonly _tag: "Implemented";
      readonly diagnostics: readonly Diagnostic[];
      readonly encoding: readonly EncodingRule[];
    }
  | { readonly _tag: "Refused"; readonly diagnostics: readonly Diagnostic[] };

/**
 * The form-urlencoded rules of the content entry `mediaType` of the element at `site`, decided
 * exactly as a form body alternative's are (design 6.1, 6.3), for a 3.2 `querystring` parameter
 * whose form content takes Encoding Objects "as for bodies". Content of any other media type has
 * no rules. Diagnostics are placed as a body's are, at `site` when the element is a reference.
 */
export const formContentRules = (
  resolution: Resolution,
  site: BodySite,
  mediaType: string,
  limits: ResolveLimits = defaultLimits,
): Effect.Effect<FormContentOutcome, BodyNodeBudget | BodyNotReadable> =>
  Effect.gen(function* rules() {
    if (codecOf(baseType(mediaType)) !== "form") {
      return { _tag: "Implemented", diagnostics: [], encoding: [] };
    }

    const use = { document: resolution.document, pointer: site.pointer };
    const reference = referenceIn(resolution, use);
    const walk: Walk = { maxNodes: limits.maxNodes, resolution, site, spent: 0 };
    const ctx: Context = { line: resolution.line, reference, resolution, site, walk };
    const media = yield* readMedia(
      resolution,
      childKey(follow(resolution, use), "content", mediaType),
    );
    const parts = yield* formParts(ctx, media, false);
    if (parts.refused) {
      return {
        _tag: "Refused",
        diagnostics: yield* toDiagnostics(ctx, anchorDrops(media.home, parts.findings)),
      };
    }

    return {
      _tag: "Implemented",
      diagnostics: yield* toDiagnostics(ctx, parts.findings),
      encoding: yield* Schema.decodeUnknownEffect(Schema.Array(EncodingRule))(parts.encoding).pipe(
        Effect.orDie,
      ),
    };
  });
