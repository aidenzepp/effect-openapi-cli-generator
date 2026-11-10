/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError<Self>()(tag, fields) declares a class; nothing is thrown */
import {
  Array as Arr,
  Effect,
  Graph,
  Option,
  Order,
  Predicate,
  Record,
  Result,
  Schema,
} from "effect";
import type { DocumentUri } from "../model/brands.ts";
import { Diagnostic, makeDiagnostic } from "../model/diagnostic.ts";
import { declaredOpenapi } from "../validate/dispatch.ts";
import type { Line } from "../validate/index.ts";
import {
  documentBase,
  resolveUri,
  retrievalBase,
  schemaBase,
  splitFragment,
  stripFragment,
} from "./base-uri.ts";
import { defsKey, keyOf } from "./canonical.ts";
import type { CanonicalKey } from "./canonical.ts";
import {
  parseFragmentResult,
  parsePointerResult,
  formatPointer,
  childPointer,
} from "../model/pointer.ts";
import { fixedMethods, queryMethod } from "../model/path-item.ts";
import type { Json } from "../model/pointer.ts";
import { specSectionUrl } from "../model/spec-section.ts";
import { isObject, isArray, nodeAt, stringMember } from "../model/json-tree.ts";
import type { JsonObject } from "../model/json-tree.ts";

export type { CanonicalKey } from "./canonical.ts";

type Document = typeof DocumentUri.Type;

/**
 * A document of the set other than the entry, under its retrieval URI. `line` is the line its base
 * URIs follow, the entry's when absent. A member without an `openapi` field is a fragment: its root
 * may be the target of a reference, and it has no `$self`.
 */
export interface ResolveMember {
  readonly document: Document;
  readonly line?: Line;
  readonly value: Json;
}

/**
 * The entry document with the `openapi` line it declares, and the other documents of the set
 * (design 3.3); with no members the set is the entry alone.
 */
export interface ResolveInput {
  readonly document: Document;
  readonly line: Line;
  readonly members?: readonly ResolveMember[];
  readonly value: Json;
}

/**
 * Resolution budgets (design 3.3, 9 I5): hops per reference chain, and nodes visited plus hops
 * followed across the whole walk. The node budget is a proposal to calibrate on the corpus.
 */
export interface ResolveLimits {
  readonly maxHops: number;
  readonly maxNodes: number;
}

export const defaultLimits: ResolveLimits = { maxHops: 64, maxNodes: 10_000_000 };

/**
 * The object a reference stands for, fixed by the position of its use site.
 */
export type ReferenceKind =
  | "callback"
  | "example"
  | "header"
  | "link"
  | "mediaType"
  | "parameter"
  | "pathItem"
  | "requestBody"
  | "response"
  | "schema"
  | "securityScheme";

/**
 * Use-site documentation overrides (3.1 and 3.2 `summary` and `description`).
 */
export interface Docs {
  readonly description?: string;
  readonly summary?: string;
}

/**
 * One resolved use site. `target` is the end of the chain and `via` the intermediate Reference
 * Objects in order. A schema reference is one hop, never a chain: its target is lifted under
 * `defsKey`. `summary` and `description` are the use-site overrides, nearest first.
 */
export interface ResolvedReference extends Docs {
  readonly defsKey?: string;
  readonly kind: ReferenceKind;
  readonly site: CanonicalKey;
  readonly target: CanonicalKey;
  readonly via: readonly CanonicalKey[];
}

/**
 * The resolved document set. Maps are keyed by `keyOf` of a canonical key; `defs` maps each schema
 * target to its `$defs` key. `diagnostics` holds notices and element-scope refusals; a
 * document-scope refusal fails the resolution instead. `value` is the entry document, not a copy;
 * `documents` holds every document of the set, the entry included, by retrieval URI, so a target
 * key's node is `nodeAt(documents.get(key.document), key.pointer)`. `allOfReferrers` maps each
 * target to the `allOf` member use sites that reference it, in reference order.
 */
export interface Resolution {
  readonly allOfReferrers: ReadonlyMap<string, readonly CanonicalKey[]>;
  readonly base: string;
  readonly defs: ReadonlyMap<string, string>;
  readonly diagnostics: readonly Diagnostic[];
  readonly document: Document;
  readonly documents: ReadonlyMap<Document, Json>;
  readonly line: Line;
  readonly operationIds: ReadonlyMap<string, CanonicalKey>;
  readonly references: ReadonlyMap<string, ResolvedReference>;
  readonly value: Json;
}

/**
 * The document set cannot be resolved; the model is not built (design 2.4).
 */
export class ResolveRefusal extends Schema.TaggedError<ResolveRefusal>()("ResolveRefusal", {
  diagnostic: Diagnostic,
}) {}

/**
 * A Components map whose names implicit connections refer to.
 */
export type ComponentSection = "schemas" | "securitySchemes";

/**
 * How a resolve finding is reported: its scope and severity, and the text and spec section it
 * cites.
 */
interface Rule {
  readonly anchor: string;
  readonly element: string;
  readonly message: string;
  readonly scope: "document" | "element";
  readonly severity: "notice" | "refusal";
}

const rules = {
  "DOC-19/two-object-types": {
    anchor: "structural-interoperability",
    element: "Object used as two types",
    message:
      "One object is used as two different Object types; the related pointer names its other use.",
    scope: "document",
    severity: "refusal",
  },
  "DOC-23/non-schema-cycle": {
    anchor: "handling-reference-cycles",
    element: "Reference cycle",
    message: "A chain of non-schema references returns to an object already on the chain.",
    scope: "document",
    severity: "refusal",
  },
  "REF-02/non-schema-target": {
    anchor: "reference-object",
    element: "Reference to the document root",
    message: "The reference target is the document root, which is not an object of this kind.",
    scope: "document",
    severity: "refusal",
  },
  "REF-05/sibling-ignored": {
    anchor: "reference-object",
    element: "Reference Object sibling",
    message: "Members beside $ref in a Reference Object are ignored.",
    scope: "element",
    severity: "notice",
  },
  "REF-06/sibling-ignored": {
    anchor: "reference-object",
    element: "Reference Object sibling",
    message: "Members beside $ref other than summary and description are ignored.",
    scope: "element",
    severity: "notice",
  },
  "REF-07/sibling-ignored": {
    anchor: "reference-object",
    element: "Schema $ref sibling",
    message: "Keywords beside a 3.0 schema $ref are ignored.",
    scope: "element",
    severity: "notice",
  },
  "REF-11/invalid-base": {
    anchor: "relative-references-in-api-description-uris",
    element: "Schema $id",
    message: "The $id does not resolve to a URI.",
    scope: "document",
    severity: "refusal",
  },
  "REF-12/invalid-base": {
    anchor: "establishing-the-base-uri",
    element: "Base URI",
    message: "The $self or $id value does not resolve to a URI.",
    scope: "document",
    severity: "refusal",
  },
  "REF-14/duplicate-anchor": {
    anchor: "parsing-documents",
    element: "Schema $anchor",
    message: "Two schemas declare the same $anchor in one resource.",
    scope: "document",
    severity: "refusal",
  },
  "REF-14/duplicate-id": {
    anchor: "parsing-documents",
    element: "Schema $id",
    message: "Two schemas, or a schema and a document, declare the same URI.",
    scope: "document",
    severity: "refusal",
  },
  "REF-14/pointer-crosses-id": {
    anchor: "parsing-documents",
    element: "Schema $ref",
    message:
      "The JSON Pointer enters a schema with its own $id, which is not interoperable; reference that schema by its $id.",
    scope: "element",
    severity: "notice",
  },
  "REF-15/outside-set": {
    anchor: "reference-object",
    element: "Reference to another document",
    message: "The reference names a document outside the document set; nothing is fetched.",
    scope: "document",
    severity: "refusal",
  },
  "REF-16/outside-set": {
    anchor: "reference-object",
    element: "Reference to a remote URI",
    message: "The reference names a URI outside the document set; nothing is fetched.",
    scope: "document",
    severity: "refusal",
  },
  "REF-18/hop-limit": {
    anchor: "reference-object",
    element: "Reference chain",
    message: "The reference chain is longer than the hop limit.",
    scope: "document",
    severity: "refusal",
  },
  "REF-18/node-budget": {
    anchor: "reference-object",
    element: "Reference resolution",
    message: "Resolution visits more nodes than the node budget allows.",
    scope: "document",
    severity: "refusal",
  },
  "REF-18/unresolvable": {
    anchor: "reference-object",
    element: "Reference Object",
    message: "The reference target does not exist in the document set.",
    scope: "document",
    severity: "refusal",
  },
  "SCH-03/non-schema-target": {
    anchor: "json-schema-keywords",
    element: "Schema $ref target",
    message: "The $ref target is the document root, which is not a schema.",
    scope: "document",
    severity: "refusal",
  },
  "SCH-05/dynamic-ref": {
    anchor: "json-schema-keywords",
    element: "Schema $dynamicRef",
    message: "$dynamicRef is not supported.",
    scope: "element",
    severity: "refusal",
  },
  "SEC-10/uri-like-name": {
    anchor: "security-requirements-name",
    element: "Security Scheme component name",
    message: "A Security Scheme component name that parses as a URI is refused.",
    scope: "element",
    severity: "refusal",
  },
} as const satisfies Record.ReadonlyRecord<string, Rule>;

type Code = keyof typeof rules;

// 3.2 moved the DOC-19 rule to its own section; every other rule cites one anchor on each line.
const anchorOn = (code: Code, line: Line): string =>
  code === "DOC-19/two-object-types" && line === "3.2"
    ? "conflicts-between-field-types-and-reference-contexts"
    : rules[code].anchor;

// The codes whose rule has the fields of `R`.
type CodeOf<R> = { [C in Code]: (typeof rules)[C] extends R ? C : never }[Code];

type NoticeCode = CodeOf<{ readonly severity: "notice" }>;

type DocumentCode = CodeOf<{ readonly scope: "document" }>;

interface Finding {
  readonly code: Code;
  readonly document: Document;
  readonly pointer: string;
  readonly related?: CanonicalKey;
}

interface Failure {
  readonly finding: Finding & { readonly code: DocumentCode };
}

const failure = (code: DocumentCode, at: CanonicalKey, related?: CanonicalKey): Failure => ({
  finding: related === undefined ? { code, ...at } : { code, ...at, related },
});

type Kind =
  | ReferenceKind
  | "components"
  | "encoding"
  | "operation"
  | "paths"
  | "responses"
  | "root";

// How a field holds its children: one value, an array of values, or a map of named values.
type Arity = "list" | "map" | "one";

type Field = readonly [name: string, kind: Kind, arity: Arity];

const content: readonly Field[] = [["content", "mediaType", "map"]];

const examples: readonly Field[] = [["examples", "example", "map"]];

const encodings: readonly Field[] = [
  ["encoding", "encoding", "map"],
  ["itemEncoding", "encoding", "one"],
  ["prefixEncoding", "encoding", "list"],
];

const methods = [...fixedMethods, queryMethod];

const schema30: readonly Field[] = [
  ["additionalProperties", "schema", "one"],
  ["allOf", "schema", "list"],
  ["anyOf", "schema", "list"],
  ["items", "schema", "one"],
  ["not", "schema", "one"],
  ["oneOf", "schema", "list"],
  ["properties", "schema", "map"],
];

// JSON Schema 2020-12 applicators that hold subschemas (3.1 and 3.2).
const schema31: readonly Field[] = [
  ...schema30,
  ["$defs", "schema", "map"],
  ["contains", "schema", "one"],
  ["contentSchema", "schema", "one"],
  ["definitions", "schema", "map"],
  ["dependentSchemas", "schema", "map"],
  ["else", "schema", "one"],
  ["if", "schema", "one"],
  ["patternProperties", "schema", "map"],
  ["prefixItems", "schema", "list"],
  ["propertyNames", "schema", "one"],
  ["then", "schema", "one"],
  ["unevaluatedItems", "schema", "one"],
  ["unevaluatedProperties", "schema", "one"],
];

const objectFields: readonly (readonly [Exclude<Kind, "schema">, readonly Field[]])[] = [
  ["callback", []],
  [
    "components",
    [
      ["callbacks", "callback", "map"],
      ["examples", "example", "map"],
      ["headers", "header", "map"],
      ["links", "link", "map"],
      ["mediaTypes", "mediaType", "map"],
      ["parameters", "parameter", "map"],
      ["pathItems", "pathItem", "map"],
      ["requestBodies", "requestBody", "map"],
      ["responses", "response", "map"],
      ["schemas", "schema", "map"],
      ["securitySchemes", "securityScheme", "map"],
    ],
  ],
  ["encoding", [["headers", "header", "map"], ...encodings]],
  ["example", []],
  ["header", [["schema", "schema", "one"], ...content, ...examples]],
  ["link", []],
  [
    "mediaType",
    [["itemSchema", "schema", "one"], ["schema", "schema", "one"], ...examples, ...encodings],
  ],
  [
    "operation",
    [
      ["callbacks", "callback", "map"],
      ["parameters", "parameter", "list"],
      ["requestBody", "requestBody", "one"],
      ["responses", "responses", "one"],
    ],
  ],
  ["parameter", [["schema", "schema", "one"], ...content, ...examples]],
  [
    "pathItem",
    [
      ["additionalOperations", "operation", "map"],
      ["parameters", "parameter", "list"],
      ...methods.map((method): Field => [method, "operation", "one"]),
    ],
  ],
  ["paths", []],
  ["requestBody", content],
  ["response", [["headers", "header", "map"], ["links", "link", "map"], ...content]],
  ["responses", []],
  [
    "root",
    [
      ["components", "components", "one"],
      ["paths", "paths", "one"],
      ["webhooks", "pathItem", "map"],
    ],
  ],
  ["securityScheme", []],
];

const table = (fields: readonly Field[]): ReadonlyMap<string, Field> =>
  new Map(fields.map((field) => [field[0], field]));

const grammar = new Map(objectFields.map(([kind, fields]) => [kind, table(fields)]));

const schemaGrammar: Record.ReadonlyRecord<Line, ReadonlyMap<string, Field>> = {
  "3.0": table(schema30),
  "3.1": table(schema31),
  "3.2": table(schema31),
};

// Objects whose every non-extension member is one kind of child.
const memberKinds = new Map<Kind, Kind>([
  ["callback", "pathItem"],
  ["paths", "pathItem"],
  ["responses", "response"],
]);

const fieldOf = (line: Line, kind: Kind, name: string): Field | undefined =>
  (kind === "schema" ? schemaGrammar[line] : grammar.get(kind))?.get(name);

const referenceKinds = new Set<Kind>([
  "callback",
  "example",
  "header",
  "link",
  "mediaType",
  "parameter",
  "pathItem",
  "requestBody",
  "response",
  "schema",
  "securityScheme",
]);

const isReferenceKind = (kind: Kind): kind is ReferenceKind => referenceKinds.has(kind);

// A reference with a scheme or an authority names a remote URI (REF-16), else a relative file (REF-15).
const remoteUri = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/u;

const uriSyntax = /[:/?#]/u;

const tokensOf = (pointer: string): readonly string[] | undefined =>
  Result.getOrUndefined(parsePointerResult(pointer));

const fragmentPointer = (fragment: string): string | undefined => {
  const tokens = Result.getOrUndefined(parseFragmentResult(`#${fragment}`));

  return tokens === undefined ? undefined : formatPointer(tokens);
};

// The array branch keeps the index read: `Arr.get` floors its index (`Math.floor`, Array.ts:1921),
// so a token "1.5" from a `$ref` pointer would reach element 1 instead of no member.
const memberOf = (node: Json, token: string): Json | undefined => {
  if (isArray(node)) {
    return node[Number(token)];
  }

  return isObject(node) ? Option.getOrUndefined(Record.get(node, token)) : undefined;
};

type Step = { readonly kind: Kind | undefined } | { readonly container: Kind };

// The structural kind one pointer token leads to; a map or list field leads to a container first.
const stepInto = (line: Line, kind: Kind, token: string): Step => {
  const members = memberKinds.get(kind);
  if (members !== undefined && !token.startsWith("x-")) {
    return { kind: members };
  }

  const field = fieldOf(line, kind, token);
  if (field === undefined) {
    return { kind: undefined };
  }

  return field[2] === "one" ? { kind: field[1] } : { container: field[1] };
};

const docsFrom = (summary: string | undefined, description: string | undefined): Docs => {
  if (summary === undefined) {
    return description === undefined ? {} : { description };
  }

  return description === undefined ? { summary } : { description, summary };
};

const docsOf = (node: Json): Docs =>
  docsFrom(stringMember(node, "summary"), stringMember(node, "description"));

// Keeps the nearer override of each docs field.
const nearest = (near: Docs, far: Docs): Docs =>
  docsFrom(near.summary ?? far.summary, near.description ?? far.description);

interface Edge {
  readonly site: CanonicalKey;
  readonly target: CanonicalKey;
  readonly to: string;
}

const rootKey = (document: Document): string => keyOf({ document, pointer: "" });

// The nearest target in the same document that physically contains `key`, else that document's root.
const ownerOf = (key: CanonicalKey, targets: ReadonlySet<string>): string => {
  let prefix = key.pointer;
  while (prefix !== "") {
    prefix = prefix.slice(0, prefix.lastIndexOf("/"));
    const owner = keyOf({ document: key.document, pointer: prefix });
    if (targets.has(owner)) {
      return owner;
    }
  }

  return rootKey(key.document);
};

/**
 * One document of the set as the resolver walks it. `openapi` is true when the root is an OpenAPI
 * Object; a member without `openapi` is a fragment, whose root a reference may target as any kind.
 */
interface Member {
  readonly base: string;
  readonly document: Document;
  readonly line: Line;
  readonly openapi: boolean;
  readonly value: Json;
}

// A node of the set: the member that holds it and its pointer there.
interface Place {
  readonly member: Member;
  readonly pointer: string;
}

// `via` is the reference site that reached the node, absent for a node reached by its position.
interface Visit extends Place {
  readonly base: string;
  readonly kind: Kind;
  readonly node: Json;
  readonly via?: CanonicalKey;
}

interface Site extends Place {
  readonly base: string;
  readonly kind: ReferenceKind;
  readonly node: JsonObject;
  readonly ref: string;
}

interface Located extends Place {
  readonly node: Json;
}

const visitKey = (item: Visit): string =>
  `${item.member.document}\u0000${item.kind}\u0000${item.pointer}`;

// A Reference Object's siblings are fields only for a Path Item and a 3.1 or 3.2 schema.
const siblingsAreFields = (line: Line, kind: ReferenceKind): boolean =>
  kind === "pathItem" || (kind === "schema" && line !== "3.0");

// Pushes `items` so that they pop in their given order.
const pushInOrder = (stack: Visit[], items: readonly Visit[]): void => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined) {
      stack.push(item);
    }
  }
};

const keyAt = (place: Place): CanonicalKey => ({
  document: place.member.document,
  pointer: place.pointer,
});

const samePlace = (left: Place, right: Place): boolean =>
  left.member === right.member && left.pointer === right.pointer;

// `waitOn` names the resource whose later $id or $anchor could still resolve the reference.
type Missing =
  | { readonly missing: "outside"; readonly waitOn?: string }
  | { readonly missing: "unresolvable"; readonly target?: CanonicalKey; readonly waitOn?: string };

interface Waiting {
  readonly order: number;
  readonly site: Site;
}

const byOrder = Order.mapInput(Order.Number, (entry: Waiting) => entry.order);

// `crosses` is the innermost schema with its own $id that a pointer fragment enters (REF-14).
type Lookup = { readonly crosses?: CanonicalKey; readonly found: Located } | Missing;

const lookupFailure = (site: Site, outcome: Missing): Failure => {
  if (outcome.missing === "outside") {
    return failure(
      remoteUri.test(site.ref) ? "REF-16/outside-set" : "REF-15/outside-set",
      keyAt(site),
    );
  }

  return failure("REF-18/unresolvable", keyAt(site), outcome.target);
};

// The root of an OpenAPI document is no object a reference may stand for (D-AD12).
const isDocumentRoot = (found: Place): boolean => found.pointer === "" && found.member.openapi;

const rootCode = (line: Line): "REF-02/non-schema-target" | "SCH-03/non-schema-target" =>
  line === "3.0" ? "REF-02/non-schema-target" : "SCH-03/non-schema-target";

// The base URI a schema target inherits from the schemas around it, found by walking down from
// its document's root. A fragment document's root is taken as a schema.
const enclosingBase = (found: Place): string => {
  const { line } = found.member;
  let node: Json | undefined = found.member.value;
  let state: Step = { kind: found.member.openapi ? "root" : "schema" };
  let { base } = found.member;
  for (const token of tokensOf(found.pointer) ?? []) {
    if (node === undefined) {
      break;
    }

    if ("kind" in state && state.kind === "schema") {
      base = Option.getOrUndefined(schemaBase(line, base, node)) ?? base;
    }

    if ("container" in state) {
      state = { kind: state.container };
    } else if (state.kind !== undefined) {
      state = stepInto(line, state.kind, token);
    }

    node = memberOf(node, token);
  }

  return base;
};

// The structural children of a node, in document order.
const childrenOf = (place: Place, kind: Kind, node: JsonObject, base: string): Visit[] => {
  const { member, pointer } = place;
  const members = memberKinds.get(kind);
  const childBase = kind === "schema" ? base : member.base;
  const queued: Visit[] = [];
  const enqueue = (childKind: Kind, value: Json, at: string): void => {
    queued.push({ base: childBase, kind: childKind, member, node: value, pointer: at });
  };

  for (const [name, value] of Object.entries(node)) {
    const at = childPointer(pointer, name);
    const field = fieldOf(member.line, kind, name);
    if (members !== undefined && !name.startsWith("x-")) {
      enqueue(members, value, at);
    } else if (field?.[2] === "one") {
      enqueue(field[1], value, at);
    } else if (field?.[2] === "list" && isArray(value)) {
      for (const [index, item] of value.entries()) {
        enqueue(field[1], item, childPointer(at, `${index}`));
      }
    } else if (field?.[2] === "map" && isObject(value)) {
      for (const [entry, item] of Object.entries(value)) {
        enqueue(field[1], item, childPointer(at, entry));
      }
    }
  }

  return queued;
};

/**
 * The resolver's working state for one run over the whole document set.
 */
class Resolver {
  // Resources that gained an $id or $anchor since the last round.
  readonly added = new Set<string>();
  readonly all: readonly Member[];
  readonly anchors = new Map<string, Place>();
  readonly byDocument: ReadonlyMap<Document, Member>;
  // Nodes already charged to the node budget, so a node indexed and then walked costs once.
  readonly charged = new Set<string>();
  readonly defs = new Map<string, string>();
  // Every resource URI a member is known by (its retrieval URI and its base) to that member.
  readonly documents = new Map<string, Member>();
  readonly entry: Member;
  readonly findings: Finding[] = [];
  readonly ids = new Map<string, Place>();
  readonly limits: ResolveLimits;
  readonly operationIds = new Map<string, CanonicalKey>();
  readonly references = new Map<string, ResolvedReference>();
  // Every schema that declares its own $id, by `keyOf` of its place.
  readonly resources = new Set<string>();
  readonly stack: Visit[] = [];
  // The first Object type each node is walked as, and the site that reached it (DOC-19).
  readonly typed = new Map<string, { readonly by: CanonicalKey; readonly kind: Kind }>();
  readonly visited = new Set<string>();
  nodes = 0;

  constructor(entry: Member, others: readonly Member[], limits: ResolveLimits) {
    this.entry = entry;
    this.all = [entry, ...others];
    const byDocument = new Map<Document, Member>();
    for (const member of this.all) {
      if (!byDocument.has(member.document)) {
        byDocument.set(member.document, member);
      }
    }

    this.byDocument = byDocument;
    this.limits = limits;
  }

  // Charges one node, or one retry when `seen` is absent, to the node budget.
  spend(seen?: string): Failure | undefined {
    if (seen !== undefined) {
      if (this.charged.has(seen)) {
        return undefined;
      }

      this.charged.add(seen);
    }

    this.nodes += 1;

    return this.nodes > this.limits.maxNodes
      ? failure("REF-18/node-budget", { document: this.entry.document, pointer: "" })
      : undefined;
  }

  // Walks every queued node, collecting reference sites in walk order.
  drain(sites: Site[]): Failure | undefined {
    let next = this.stack.pop();
    while (next !== undefined) {
      const failed = this.visit(next, sites);
      if (failed !== undefined) {
        return failed;
      }

      next = this.stack.pop();
    }

    return undefined;
  }

  visit(item: Visit, sites: Site[]): Failure | undefined {
    const { member, node, pointer } = item;
    const seen = visitKey(item);
    if (this.visited.has(seen) || !isObject(node)) {
      return undefined;
    }

    this.visited.add(seen);

    const spent = this.spend(seen);
    if (spent !== undefined) {
      return spent;
    }

    const place: Place = { member, pointer };
    const conflict = this.typeOnce(item);
    if (conflict !== undefined) {
      return conflict;
    }

    let { base } = item;
    if (item.kind === "schema") {
      const own = Option.getOrUndefined(schemaBase(member.line, base, node));
      if (own === undefined) {
        return failure(
          member.line === "3.2" ? "REF-12/invalid-base" : "REF-11/invalid-base",
          keyAt(place),
        );
      }

      // A node reached only by a reference into a non-schema position is indexed here.
      const indexed = this.declare(place, node, own, base);
      if (indexed !== undefined) {
        return indexed;
      }

      if (member.line !== "3.0" && stringMember(node, "$dynamicRef") !== undefined) {
        this.findings.push({ code: "SCH-05/dynamic-ref", ...keyAt(place) });
      }

      base = own;
    }

    const ref = stringMember(node, "$ref");
    if (ref !== undefined && isReferenceKind(item.kind)) {
      sites.push({ base, kind: item.kind, member, node, pointer, ref });
      if (!this.walksSiblings(place, item.kind, node)) {
        return undefined;
      }
    }

    this.record(place, item.kind, node);
    this.push(place, item.kind, node, base);

    return undefined;
  }

  // Indexes a schema's $id and $anchor; indexing one place twice is a no-op.
  declare(place: Place, node: JsonObject, own: string, enclosing: string): Failure | undefined {
    if (place.member.line === "3.0") {
      return undefined;
    }

    if (own !== enclosing && stringMember(node, "$id") !== undefined) {
      const known = this.ids.get(own);
      if (this.documents.has(own) || (known !== undefined && !samePlace(known, place))) {
        return failure("REF-14/duplicate-id", keyAt(place));
      }

      this.ids.set(own, place);
      this.resources.add(keyOf(keyAt(place)));
      this.added.add(own);
    }

    const anchor = stringMember(node, "$anchor");
    if (anchor !== undefined) {
      const name = `${own}#${anchor}`;
      const known = this.anchors.get(name);
      if (known !== undefined && !samePlace(known, place)) {
        return failure("REF-14/duplicate-anchor", keyAt(place));
      }

      this.anchors.set(name, place);
      this.added.add(own);
    }

    return undefined;
  }

  // Indexes every $id and $anchor at a schema position of every member before any reference is
  // judged (design 3.3: resolution happens only after every supplied document is parsed). Each
  // node is charged to the node budget once, here or in the walk.
  index(): Failure | undefined {
    for (const member of this.all) {
      const stack: Visit[] = [
        {
          base: member.base,
          kind: member.openapi ? "root" : "schema",
          member,
          node: member.value,
          pointer: "",
        },
      ];
      let item = stack.pop();
      while (item !== undefined) {
        const failed = this.indexNode(item, stack);
        if (failed !== undefined) {
          return failed;
        }

        item = stack.pop();
      }
    }

    this.added.clear();

    return undefined;
  }

  // Indexes one node and queues its structural children; Reference Object siblings that are not
  // fields are skipped, as the walk skips them.
  indexNode(item: Visit, stack: Visit[]): Failure | undefined {
    const { kind, member, node } = item;
    const seen = visitKey(item);
    if (!isObject(node) || this.charged.has(seen)) {
      return undefined;
    }

    const spent = this.spend(seen);
    if (spent !== undefined) {
      return spent;
    }

    const place: Place = { member, pointer: item.pointer };
    let { base } = item;
    if (kind === "schema") {
      const own = Option.getOrUndefined(schemaBase(member.line, base, node));
      if (own === undefined) {
        return failure(
          member.line === "3.2" ? "REF-12/invalid-base" : "REF-11/invalid-base",
          keyAt(place),
        );
      }

      const declared = this.declare(place, node, own, base);
      if (declared !== undefined) {
        return declared;
      }

      base = own;
    }

    const ref = stringMember(node, "$ref");
    if (ref !== undefined && isReferenceKind(kind) && !siblingsAreFields(member.line, kind)) {
      return undefined;
    }

    pushInOrder(stack, childrenOf(place, kind, node, base));

    return undefined;
  }

  // Refuses a node walked as a second Object type (DOC-19), naming the site of each use.
  typeOnce(item: Visit): Failure | undefined {
    const at = keyAt(item);
    const by = item.via ?? at;
    const known = this.typed.get(keyOf(at));
    if (known === undefined) {
      this.typed.set(keyOf(at), { by, kind: item.kind });

      return undefined;
    }

    return known.kind === item.kind ? undefined : failure("DOC-19/two-object-types", by, known.by);
  }

  // Records the sibling notice; true when the siblings are fields to walk.
  walksSiblings(place: Place, kind: ReferenceKind, node: JsonObject): boolean {
    const { line } = place.member;
    if (siblingsAreFields(line, kind)) {
      return true;
    }

    const allowed = line === "3.0" ? ["$ref"] : ["$ref", "description", "summary"];
    if (Object.keys(node).some((member) => !allowed.includes(member))) {
      let code: NoticeCode = "REF-06/sibling-ignored";
      if (line === "3.0") {
        code = kind === "schema" ? "REF-07/sibling-ignored" : "REF-05/sibling-ignored";
      }

      this.findings.push({ code, ...keyAt(place) });
    }

    return false;
  }

  // Implicit connections resolve from the entry document only (design 3.3), so only it is recorded.
  record(place: Place, kind: Kind, node: JsonObject): void {
    if (place.member !== this.entry) {
      return;
    }

    const operationId = kind === "operation" ? stringMember(node, "operationId") : undefined;
    if (operationId !== undefined && !this.operationIds.has(operationId)) {
      this.operationIds.set(operationId, keyAt(place));
    }

    const schemes = kind === "components" ? memberOf(node, "securitySchemes") : undefined;
    if (this.entry.line !== "3.2" || schemes === undefined || !isObject(schemes)) {
      return;
    }

    for (const name of Object.keys(schemes)) {
      if (uriSyntax.test(name)) {
        this.findings.push({
          code: "SEC-10/uri-like-name",
          document: this.entry.document,
          pointer: childPointer(childPointer(place.pointer, "securitySchemes"), name),
        });
      }
    }
  }

  // Queues the structural children so that they pop in document order.
  push(place: Place, kind: Kind, node: JsonObject, base: string): void {
    pushInOrder(this.stack, childrenOf(place, kind, node, base));
  }

  // The node a resource URI names: a document of the set, or for a schema an $id.
  resourceRoot(resource: string, isSchema: boolean): Place | undefined {
    const member = this.documents.get(resource);
    if (member !== undefined) {
      return { member, pointer: "" };
    }

    return isSchema ? this.ids.get(resource) : undefined;
  }

  // Finds the node a reference names inside the document set, without fetching anything. `line` is
  // the line of the document that holds the reference.
  lookup(ref: string, base: string, isSchema: boolean, line: Line): Lookup {
    const [uriPart, fragmentPart] = splitFragment(ref);
    const fragment = Option.getOrElse(fragmentPart, () => "");
    const resolved = uriPart === "" ? Option.some(base) : resolveUri(uriPart, base);
    const resource = resolved.pipe(Option.map(stripFragment), Option.getOrUndefined);
    const root = resource === undefined ? undefined : this.resourceRoot(resource, isSchema);
    if (resource === undefined) {
      return { missing: "outside" };
    }

    if (root === undefined) {
      return isSchema ? { missing: "outside", waitOn: resource } : { missing: "outside" };
    }

    const target = this.fragmentTarget(resource, root, fragment, isSchema, line);
    const byAnchor = isSchema && line !== "3.0" && fragment !== "" && !fragment.startsWith("/");
    if (target === undefined) {
      return byAnchor ? { missing: "unresolvable", waitOn: resource } : { missing: "unresolvable" };
    }

    const node = nodeAt(target.member.value, target.pointer);
    const isBooleanSchema = isSchema && target.member.line !== "3.0" && Predicate.isBoolean(node);
    if (node !== undefined && (isObject(node) || isBooleanSchema)) {
      return this.foundAt(root, target, node, isSchema && fragment.startsWith("/"));
    }

    return { missing: "unresolvable", target: keyAt(target) };
  }

  // An empty fragment names the resource, a pointer a node in it, a plain name a schema $anchor.
  fragmentTarget(
    resource: string,
    root: Place,
    fragment: string,
    isSchema: boolean,
    line: Line,
  ): Place | undefined {
    if (fragment === "") {
      return root;
    }

    if (fragment.startsWith("/")) {
      const pointer = fragmentPointer(fragment);

      return pointer === undefined
        ? undefined
        : { member: root.member, pointer: `${root.pointer}${pointer}` };
    }

    return isSchema && line !== "3.0" ? this.anchors.get(`${resource}#${fragment}`) : undefined;
  }

  // The node a lookup found, with the $id its pointer fragment crosses to reach it, if any.
  foundAt(root: Place, target: Place, node: Json, byPointer: boolean): Lookup {
    const found = { member: target.member, node, pointer: target.pointer };
    const crosses = byPointer ? this.crossedId(root, target) : undefined;

    return crosses === undefined ? { found } : { crosses, found };
  }

  // The innermost schema with its own $id strictly between a pointer's resource and its target.
  crossedId(root: Place, target: Place): CanonicalKey | undefined {
    let { pointer } = target;
    while (pointer.length > root.pointer.length) {
      pointer = pointer.slice(0, pointer.lastIndexOf("/"));
      const key = { document: target.member.document, pointer };
      if (pointer.length > root.pointer.length && this.resources.has(keyOf(key))) {
        return key;
      }
    }

    return undefined;
  }

  // Resolves one schema reference, or names the resource it waits on. Every attempt, retries
  // included, is charged to the node budget.
  schemaSite(site: Site): Failure | { readonly waitOn: string } | undefined {
    const spent = this.spend();
    if (spent !== undefined) {
      return spent;
    }

    const outcome = this.lookup(site.ref, site.base, true, site.member.line);
    if (!("found" in outcome)) {
      return outcome.waitOn === undefined
        ? lookupFailure(site, outcome)
        : { waitOn: outcome.waitOn };
    }

    const { found } = outcome;
    const siteKey = keyAt(site);
    const target = keyAt(found);
    if (outcome.crosses !== undefined) {
      this.findings.push({
        code: "REF-14/pointer-crosses-id",
        ...siteKey,
        related: outcome.crosses,
      });
    }

    if (isDocumentRoot(found)) {
      // The root is no schema (D-AD12): the use site keeps a reference with no `$defs` key, nothing
      // is lifted and the root is not walked as a schema; schema normalization refuses the site.
      this.references.set(keyOf(siteKey), { kind: "schema", site: siteKey, target, via: [] });

      return undefined;
    }

    const key = defsKey(this.entry.document, target);
    this.defs.set(keyOf(target), key);
    this.references.set(keyOf(siteKey), {
      defsKey: key,
      kind: "schema",
      site: siteKey,
      target,
      via: [],
    });
    this.stack.push({
      base: enclosingBase(found),
      kind: "schema",
      member: found.member,
      node: found.node,
      pointer: found.pointer,
      via: siteKey,
    });

    return undefined;
  }

  // Follows a non-schema chain to its end, at most `maxHops` references, across documents. Each
  // hop resolves against the base of the document that holds its Reference Object.
  chainSite(site: Site): Failure | undefined {
    const siteKey = keyAt(site);
    const onChain = new Set([keyOf(siteKey)]);
    const via: CanonicalKey[] = [];
    const overrides = site.member.line !== "3.0" && site.kind !== "pathItem";
    let docs = overrides ? docsOf(site.node) : {};
    let { member, ref } = site;
    for (let hops = 1; hops <= this.limits.maxHops; hops += 1) {
      const spent = this.spend();
      if (spent !== undefined) {
        return spent;
      }

      const outcome = this.lookup(ref, member.base, false, member.line);
      if (!("found" in outcome)) {
        return lookupFailure({ ...site, ref }, outcome);
      }

      const { found } = outcome;
      if (isDocumentRoot(found)) {
        return failure(rootCode(site.member.line), siteKey);
      }

      const hop = keyAt(found);
      if (onChain.has(keyOf(hop))) {
        return failure("DOC-23/non-schema-cycle", siteKey, hop);
      }

      if (overrides) {
        docs = nearest(docs, docsOf(found.node));
      }

      const known = this.references.get(keyOf(hop));
      const next = stringMember(found.node, "$ref");
      if (known?.kind === site.kind) {
        const total = [...via, hop, ...known.via];
        if (total.length >= this.limits.maxHops) {
          return failure("REF-18/hop-limit", siteKey);
        }

        this.settle(site, known.target, total, nearest(docs, known));

        return undefined;
      }

      if (next === undefined) {
        this.settle(site, hop, via, docs);

        return undefined;
      }

      onChain.add(keyOf(hop));
      via.push(hop);
      ref = next;
      ({ member } = found);
    }

    return failure("REF-18/hop-limit", siteKey);
  }

  settle(site: Site, target: CanonicalKey, via: readonly CanonicalKey[], docs: Docs): void {
    const siteKey = keyAt(site);
    this.references.set(keyOf(siteKey), {
      ...docs,
      kind: site.kind,
      site: siteKey,
      target,
      via,
    });

    const member = this.byDocument.get(target.document);
    const node = member === undefined ? undefined : nodeAt(member.value, target.pointer);
    if (member !== undefined && node !== undefined) {
      this.stack.push({
        base: member.base,
        kind: site.kind,
        member,
        node,
        pointer: target.pointer,
        via: siteKey,
      });
    }
  }

  // Refuses a cycle that passes through the content of a non-schema target (design 3.3).
  containment(): Failure | undefined {
    const references = [...this.references.values()].filter(
      (reference) => reference.kind !== "schema",
    );
    const targets = new Map(
      references.map((reference): [string, CanonicalKey] => [
        keyOf(reference.target),
        reference.target,
      ]),
    );
    const names = new Set(targets.keys());
    const referenceEdges = references.map((reference) => ({
      edge: { site: reference.site, target: reference.target, to: keyOf(reference.target) },
      owner: ownerOf(reference.site, names),
    }));
    // A target also reaches every target nested inside it, so a cycle through nested content shows.
    const nestedEdges = [...targets].flatMap(([name, target]) => {
      const owner = ownerOf(target, names);

      return target.pointer !== "" && owner !== rootKey(target.document)
        ? [{ edge: { site: target, target, to: name }, owner }]
        : [];
    });
    // Owner keys hold `#`, never an integer-like key, so the record keeps insertion order.
    const grouped = Arr.groupBy([...referenceEdges, ...nestedEdges], ({ owner }) => owner);

    const graph = Graph.directed<string, Edge>((mutable) => {
      const nodes = new Map<string, Graph.NodeIndex>();
      const node = (name: string): Graph.NodeIndex => {
        const known = nodes.get(name);
        if (known !== undefined) {
          return known;
        }

        const index = Graph.addNode(mutable, name);
        nodes.set(name, index);

        return index;
      };

      for (const start of [rootKey(this.entry.document), ...names]) {
        node(start);
      }

      for (const [owner, list] of Object.entries(grouped)) {
        for (const { edge } of list) {
          Graph.addEdge(mutable, node(owner), node(edge.to), edge);
        }
      }
    });

    const closing = Graph.findCycle(graph).pipe(
      Option.flatMap((cycle) => Option.fromNullishOr(cycle.edges.at(-1))),
      Option.flatMap((index) => Graph.getEdge(graph, index)),
      Option.map((edge) => edge.data),
    );

    return Option.isSome(closing)
      ? failure("DOC-23/non-schema-cycle", closing.value.site, closing.value.target)
      : undefined;
  }

  // Makes a member reachable by its retrieval URI and its base; two members may not share one.
  register(member: Member): Failure | undefined {
    const retrieval = retrievalBase(member.document);
    for (const resource of [retrieval, member.base]) {
      const known = this.documents.get(resource);
      if (known !== undefined && known !== member) {
        return failure("REF-14/duplicate-id", {
          document: member.document,
          pointer: resource === retrieval ? "" : "/$self",
        });
      }

      this.documents.set(resource, member);
    }

    return undefined;
  }

  // Indexes every member, then walks to a fixed point from the entry root: members are walked
  // where references reach them. A schema reference may still wait for an $id or $anchor that only
  // a walked reference reveals (a schema under an extension, say); a waiting site is retried only
  // when its resource gains one, and only while the walk progresses.
  run(): Failure | undefined {
    for (const member of this.all) {
      const failed = this.register(member);
      if (failed !== undefined) {
        return failed;
      }
    }

    const indexed = this.index();
    if (indexed !== undefined) {
      return indexed;
    }

    this.stack.push({
      base: this.entry.base,
      kind: "root",
      member: this.entry,
      node: this.entry.value,
      pointer: "",
    });

    // Not `Arr.groupBy`: the keys come from side-effecting site outcomes evaluated in order with an
    // early return, and the map persists across iterations, pruned by `waiting.delete`. groupBy
    // takes a finished iterable, so it would run outcomes the failure path skips today.
    const waiting = new Map<string, Waiting[]>();
    let order = 0;
    for (;;) {
      const found: Site[] = [];
      const walked = this.drain(found);
      if (walked !== undefined) {
        return walked;
      }

      const retried = [...this.added].flatMap((resource) => waiting.get(resource) ?? []);
      for (const resource of this.added) {
        waiting.delete(resource);
      }

      this.added.clear();

      const offset = order;
      order += found.length;
      const pending = [
        ...Arr.sort(retried, byOrder),
        ...found.map((site, index) => ({ order: offset + index, site })),
      ];
      for (const entry of pending) {
        const outcome =
          entry.site.kind === "schema" ? this.schemaSite(entry.site) : this.chainSite(entry.site);
        if (outcome !== undefined && "waitOn" in outcome) {
          const list = waiting.get(outcome.waitOn);
          if (list === undefined) {
            waiting.set(outcome.waitOn, [entry]);
          } else {
            list.push(entry);
          }
        } else if (outcome !== undefined) {
          return outcome;
        }
      }

      // Nothing new to walk, so every waiting reference is final.
      if (this.stack.length === 0 && this.added.size === 0) {
        return this.finalWaiting(waiting) ?? this.containment();
      }
    }
  }

  // Refuses the earliest-found site still waiting, if any.
  finalWaiting(waiting: ReadonlyMap<string, readonly Waiting[]>): Failure | undefined {
    let first: Waiting | undefined;
    for (const entries of waiting.values()) {
      for (const entry of entries) {
        if (first === undefined || entry.order < first.order) {
          first = entry;
        }
      }
    }

    if (first === undefined) {
      return undefined;
    }

    const { site } = first;
    const outcome = this.lookup(site.ref, site.base, true, site.member.line);

    return lookupFailure(site, "found" in outcome ? { missing: "unresolvable" } : outcome);
  }
}

const toDiagnostic = (member: Member, finding: Finding): Effect.Effect<Diagnostic> => {
  const rule = rules[finding.code];

  return makeDiagnostic({
    code: finding.code,
    document: finding.document,
    element: rule.element,
    message: rule.message,
    openapi: Option.getOrElse(declaredOpenapi(member.value), () => "unknown"),
    pointer: finding.pointer,
    related: finding.related === undefined ? undefined : [finding.related],
    scope: rule.scope,
    severity: rule.severity,
    specSection: specSectionUrl(member.line, anchorOn(finding.code, member.line)),
  });
};

interface Prepared {
  readonly invalidBase: boolean;
  readonly member: Member;
}

// A document of the set with its base URI (design 3.3); a fragment has no `$self` to honour.
const prepare = (input: ResolveMember, line: Line, openapi: boolean): Prepared => {
  const base = openapi
    ? Option.getOrUndefined(documentBase(line, input.document, input.value))
    : retrievalBase(input.document);
  const member: Member = {
    base: base ?? input.document,
    document: input.document,
    line,
    openapi,
    value: input.value,
  };

  return { invalidBase: base === undefined, member };
};

const arrayIndex = /^[0-9]+$/u;

// A use site that is an `allOf` member: its pointer ends in `allOf` and an array index.
const isAllOfMember = (site: CanonicalKey): boolean => {
  const tokens = Result.getOrElse(parsePointerResult(site.pointer), (): readonly string[] => []);

  return tokens.at(-2) === "allOf" && arrayIndex.test(tokens.at(-1) ?? "");
};

const referrersOf = (
  references: ReadonlyMap<string, ResolvedReference>,
): ReadonlyMap<string, readonly CanonicalKey[]> => {
  // Target keys hold `#`, never an integer-like key, so the record keeps insertion order.
  const grouped = Arr.groupBy(
    [...references.values()].filter((reference) => isAllOfMember(reference.site)),
    (reference) => keyOf(reference.target),
  );

  return new Map(
    Object.entries(grouped).map(([key, list]): [string, readonly CanonicalKey[]] => [
      key,
      list.map((reference) => reference.site),
    ]),
  );
};

/**
 * Resolves every reference reachable from the entry document across the document set (design
 * 3.3): canonical keys, base URIs per document and line, sibling rules, hop and node budgets over
 * the whole set, cycles, and `$defs` keys for schema targets. A URI outside the set is refused,
 * never fetched.
 */
export const resolve = Effect.fn("resolve.resolve")(function* resolve(
  input: ResolveInput,
  limits: Partial<ResolveLimits> = {},
): Effect.fn.Return<Resolution, ResolveRefusal> {
  const head = prepare(input, input.line, true);
  const rest = (input.members ?? []).map((member) =>
    prepare(member, member.line ?? input.line, stringMember(member.value, "openapi") !== undefined),
  );
  const set = [head, ...rest];
  const entry = head.member;
  const others = rest.map((prepared) => prepared.member);
  const resolver = new Resolver(entry, others, { ...defaultLimits, ...limits });
  const invalid = set.find((prepared) => prepared.invalidBase)?.member;
  const failed =
    invalid === undefined
      ? resolver.run()
      : failure("REF-12/invalid-base", { document: invalid.document, pointer: "/$self" });
  const memberOfFinding = (finding: Finding): Member =>
    resolver.byDocument.get(finding.document) ?? entry;
  if (failed !== undefined) {
    const diagnostic = yield* toDiagnostic(memberOfFinding(failed.finding), failed.finding);

    return yield* new ResolveRefusal({ diagnostic });
  }

  const diagnostics = yield* Effect.all(
    resolver.findings.map((finding) => toDiagnostic(memberOfFinding(finding), finding)),
  );

  return {
    allOfReferrers: referrersOf(resolver.references),
    base: entry.base,
    defs: resolver.defs,
    diagnostics,
    document: input.document,
    documents: new Map(resolver.all.map((member) => [member.document, member.value])),
    line: input.line,
    operationIds: resolver.operationIds,
    references: resolver.references,
    value: input.value,
  };
});

/**
 * The resolved reference whose use site is `pointer` in the entry document.
 */
export const referenceAt = (
  resolution: Resolution,
  pointer: string,
): ResolvedReference | undefined =>
  resolution.references.get(keyOf({ document: resolution.document, pointer }));

// A name read as a URI, resolved inside the set only: a 3.2 Security Scheme URI (SEC-10) or a
// discriminator mapping value that is not a component name (DSC-03, DSC-08).
const componentByUri = (resolution: Resolution, name: string): Option.Option<CanonicalKey> => {
  const resolved = resolveUri(name, resolution.base).pipe(Option.map(splitFragment));
  const resource = resolved.pipe(
    Option.map(([uri]) => uri),
    Option.getOrUndefined,
  );
  const retrieval = stripFragment(
    Option.getOrElse(resolveUri(resolution.document, resolution.document), () => ""),
  );
  const inSet = resource === resolution.base || resource === retrieval;
  const pointer = inSet
    ? resolved.pipe(
        Option.flatMap(([, fragment]) => fragment),
        Option.map(fragmentPointer),
        Option.getOrUndefined,
      )
    : undefined;

  return pointer !== undefined && nodeAt(resolution.value, pointer) !== undefined
    ? Option.some({ document: resolution.document, pointer })
    : Option.none();
};

/**
 * Resolves an implicit connection by name from the entry document only (design 3.3). For a schema
 * on every line, and for a 3.2 security scheme, a name that is not a component name is a URI
 * resolved inside the set.
 */
export const implicitComponent = (
  resolution: Resolution,
  section: ComponentSection,
  name: string,
): Option.Option<CanonicalKey> => {
  const pointer = formatPointer(["components", section, name]);
  if (nodeAt(resolution.value, pointer) !== undefined) {
    return Option.some({ document: resolution.document, pointer });
  }

  return section === "schemas" || resolution.line === "3.2"
    ? componentByUri(resolution, name)
    : Option.none();
};

/**
 * The `allOf` members that reference each schema, keyed by `keyOf` of the target: the use sites
 * whose pointer ends `/allOf/<i>`, in every document and component, referenced by an operation or
 * not. These are the children of the allOf discriminator pattern (DSC-05, DSC-11). Built once,
 * when the set is resolved.
 */
export const allOfReferrers = (
  resolution: Resolution,
): ReadonlyMap<string, readonly CanonicalKey[]> => resolution.allOfReferrers;

/**
 * The operation with `operationId` in the entry document, for Link Objects (design 3.3).
 */
export const operationById = (
  resolution: Resolution,
  operationId: string,
): Option.Option<CanonicalKey> => Option.fromUndefinedOr(resolution.operationIds.get(operationId));
