import { Array as Arr, Data, Effect, Exit, Option, Order, Predicate, Schema } from "effect";
import type { DocumentUri } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import type { Line } from "../validate/index.ts";
import { documentBase, resolveUri, schemaBase, stringMember, stripFragment } from "./base-uri.ts";
import { defsKey, keyOf } from "./canonical.ts";
import type { CanonicalKey } from "./canonical.ts";
import { escapeToken, evaluateTokens, parseFragment, parsePointer } from "../model/pointer.ts";
import type { Json } from "../model/pointer.ts";
import { specSectionUrl } from "../model/spec-section.ts";

export type { CanonicalKey } from "./canonical.ts";

type Document = typeof DocumentUri.Type;

interface JsonObject {
  readonly [key: string]: Json;
}

/**
 * One document of the set (a set of one in Milestone 1), with the `openapi` line it declares.
 */
export interface ResolveInput {
  readonly document: Document;
  readonly line: Line;
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
 * document-scope refusal fails the resolution instead. `value` is the entry document, not a copy.
 */
export interface Resolution {
  readonly base: string;
  readonly defs: ReadonlyMap<string, string>;
  readonly diagnostics: readonly Diagnostic[];
  readonly document: Document;
  readonly line: Line;
  readonly operationIds: ReadonlyMap<string, CanonicalKey>;
  readonly references: ReadonlyMap<string, ResolvedReference>;
  readonly value: Json;
}

/**
 * The document set cannot be resolved; the model is not built (design 2.4).
 */
export class ResolveRefusal extends Data.TaggedError("ResolveRefusal")<{
  readonly diagnostic: Diagnostic;
}> {}

/**
 * A Components map whose names implicit connections refer to.
 */
export type ComponentSection = "schemas" | "securitySchemes";

const rules = {
  "DOC-23/non-schema-cycle": {
    anchor: "handling-reference-cycles",
    element: "Reference cycle",
    message: "A chain of non-schema references returns to an object already on the chain.",
  },
  "REF-05/sibling-ignored": {
    anchor: "reference-object",
    element: "Reference Object sibling",
    message: "Members beside $ref in a Reference Object are ignored.",
  },
  "REF-06/sibling-ignored": {
    anchor: "reference-object",
    element: "Reference Object sibling",
    message: "Members beside $ref other than summary and description are ignored.",
  },
  "REF-07/sibling-ignored": {
    anchor: "reference-object",
    element: "Schema $ref sibling",
    message: "Keywords beside a 3.0 schema $ref are ignored.",
  },
  "REF-11/invalid-base": {
    anchor: "relative-references-in-api-description-uris",
    element: "Schema $id",
    message: "The $id does not resolve to a URI.",
  },
  "REF-12/invalid-base": {
    anchor: "establishing-the-base-uri",
    element: "Base URI",
    message: "The $self or $id value does not resolve to a URI.",
  },
  "REF-14/duplicate-anchor": {
    anchor: "parsing-documents",
    element: "Schema $anchor",
    message: "Two schemas declare the same $anchor in one resource.",
  },
  "REF-14/duplicate-id": {
    anchor: "parsing-documents",
    element: "Schema $id",
    message: "Two schemas, or a schema and a document, declare the same URI.",
  },
  "REF-15/outside-set": {
    anchor: "reference-object",
    element: "Reference to another document",
    message: "The reference names a document outside the document set; nothing is fetched.",
  },
  "REF-16/outside-set": {
    anchor: "reference-object",
    element: "Reference to a remote URI",
    message: "The reference names a URI outside the document set; nothing is fetched.",
  },
  "REF-18/hop-limit": {
    anchor: "reference-object",
    element: "Reference chain",
    message: "The reference chain is longer than the hop limit.",
  },
  "REF-18/node-budget": {
    anchor: "reference-object",
    element: "Reference resolution",
    message: "Resolution visits more nodes than the node budget allows.",
  },
  "REF-18/unresolvable": {
    anchor: "reference-object",
    element: "Reference Object",
    message: "The reference target does not exist in the document set.",
  },
  "SCH-05/dynamic-ref": {
    anchor: "json-schema-keywords",
    element: "Schema $dynamicRef",
    message: "$dynamicRef is not supported.",
  },
  "SEC-10/uri-like-name": {
    anchor: "security-requirements-name",
    element: "Security Scheme component name",
    message: "A Security Scheme component name that parses as a URI is refused.",
  },
} as const;

type Code = keyof typeof rules;

type NoticeCode = "REF-05/sibling-ignored" | "REF-06/sibling-ignored" | "REF-07/sibling-ignored";

type ElementCode = "SCH-05/dynamic-ref" | "SEC-10/uri-like-name";

type DocumentCode = Exclude<Code, ElementCode | NoticeCode>;

const notices: ReadonlySet<Code> = new Set<Code>([
  "REF-05/sibling-ignored",
  "REF-06/sibling-ignored",
  "REF-07/sibling-ignored",
]);

const elementRefusals: ReadonlySet<Code> = new Set<Code>([
  "SCH-05/dynamic-ref",
  "SEC-10/uri-like-name",
]);

interface Finding {
  readonly code: Code;
  readonly pointer: string;
  readonly related?: CanonicalKey;
}

interface Failure {
  readonly finding: Finding & { readonly code: DocumentCode };
}

const failure = (code: DocumentCode, pointer: string, related?: CanonicalKey): Failure => ({
  finding: related === undefined ? { code, pointer } : { code, pointer, related },
});

const isObject = (value: Json): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isArray = (value: Json): value is readonly Json[] => Array.isArray(value);

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

const methods = ["delete", "get", "head", "options", "patch", "post", "put", "query", "trace"];

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

const schemaGrammar: Record<Line, ReadonlyMap<string, Field>> = {
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

const child = (pointer: string, token: string): string => `${pointer}/${escapeToken(token)}`;

const pointerOf = (tokens: readonly string[]): string =>
  tokens.map((token) => `/${escapeToken(token)}`).join("");

const tokensOf = (pointer: string): readonly string[] => {
  const exit = Effect.runSyncExit(parsePointer(pointer));

  return Exit.isSuccess(exit) ? exit.value : [];
};

const nodeAt = (root: Json, pointer: string): Json | undefined => {
  const exit = Effect.runSyncExit(evaluateTokens(root, tokensOf(pointer)));

  return Exit.isSuccess(exit) ? exit.value : undefined;
};

const fragmentPointer = (fragment: string): string | undefined => {
  const exit = Effect.runSyncExit(parseFragment(`#${fragment}`));

  return Exit.isSuccess(exit) ? pointerOf(exit.value) : undefined;
};

const memberOf = (node: Json, token: string): Json | undefined => {
  if (isArray(node)) {
    return node[Number(token)];
  }

  return isObject(node) && Object.hasOwn(node, token) ? node[token] : undefined;
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
  readonly site: string;
  readonly to: string;
}

// The nearest target that physically contains `pointer`, else the root.
const ownerOf = (pointer: string, targets: ReadonlySet<string>): string => {
  let prefix = pointer;
  while (prefix !== "") {
    prefix = prefix.slice(0, prefix.lastIndexOf("/"));
    if (targets.has(prefix)) {
      return prefix;
    }
  }

  return "";
};

// Iterative depth-first search from `start`; returns the edge that closes a cycle.
const cycleFrom = (
  start: string,
  edges: ReadonlyMap<string, readonly Edge[]>,
  done: Set<string>,
): Edge | undefined => {
  const active = new Set<string>([start]);
  const frames: { readonly node: string; next: number }[] = [{ next: 0, node: start }];
  let frame = done.has(start) ? undefined : frames.at(-1);
  while (frame !== undefined) {
    const edge = edges.get(frame.node)?.[frame.next];
    if (edge === undefined) {
      active.delete(frame.node);
      done.add(frame.node);
      frames.pop();
    } else if (active.has(edge.to)) {
      return edge;
    } else {
      frame.next += 1;
      if (!done.has(edge.to)) {
        active.add(edge.to);
        frames.push({ next: 0, node: edge.to });
      }
    }

    frame = frames.at(-1);
  }

  return undefined;
};

interface Visit {
  readonly base: string;
  readonly kind: Kind;
  readonly node: Json;
  readonly pointer: string;
}

interface Site {
  readonly base: string;
  readonly kind: ReferenceKind;
  readonly node: JsonObject;
  readonly pointer: string;
  readonly ref: string;
}

interface Located {
  readonly node: Json;
  readonly pointer: string;
}

// `waitOn` names the resource whose later $id or $anchor could still resolve the reference.
type Missing =
  | { readonly missing: "outside"; readonly waitOn?: string }
  | { readonly missing: "unresolvable"; readonly pointer?: string; readonly waitOn?: string };

interface Waiting {
  readonly order: number;
  readonly site: Site;
}

const byOrder = Order.mapInput(Order.Number, (entry: Waiting) => entry.order);

type Lookup = { readonly found: Located } | Missing;

/**
 * The resolver's working state for one run.
 */
class Resolver {
  // Resources that gained an $id or $anchor since the last round.
  readonly added = new Set<string>();
  readonly anchors = new Map<string, string>();
  readonly base: string;
  readonly defs = new Map<string, string>();
  readonly documents = new Map<string, string>();
  readonly findings: Finding[] = [];
  readonly ids = new Map<string, string>();
  readonly input: ResolveInput;
  readonly limits: ResolveLimits;
  readonly operationIds = new Map<string, CanonicalKey>();
  readonly references = new Map<string, ResolvedReference>();
  readonly stack: Visit[] = [];
  readonly visited = new Set<string>();
  nodes = 0;

  constructor(input: ResolveInput, base: string, limits: ResolveLimits) {
    this.input = input;
    this.base = base;
    this.limits = limits;
  }

  get line(): Line {
    return this.input.line;
  }

  key(pointer: string): CanonicalKey {
    return { document: this.input.document, pointer };
  }

  spend(): Failure | undefined {
    this.nodes += 1;

    return this.nodes > this.limits.maxNodes ? failure("REF-18/node-budget", "") : undefined;
  }

  // Walks every queued node, collecting reference sites in document order.
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
    const seen = `${item.kind}\u0000${item.pointer}`;
    if (this.visited.has(seen) || !isObject(item.node)) {
      return undefined;
    }

    this.visited.add(seen);

    const { node, pointer } = item;
    const spent = this.spend();
    if (spent !== undefined) {
      return spent;
    }

    let { base } = item;
    if (item.kind === "schema") {
      const own = schemaBase(this.line, base, node);
      if (own === undefined) {
        return failure(
          this.line === "3.2" ? "REF-12/invalid-base" : "REF-11/invalid-base",
          pointer,
        );
      }

      const indexed = this.index(node, own, base, pointer);
      if (indexed !== undefined) {
        return indexed;
      }

      base = own;
    }

    const ref = stringMember(node, "$ref");
    if (ref !== undefined && isReferenceKind(item.kind)) {
      sites.push({ base, kind: item.kind, node, pointer, ref });
      if (!this.walksSiblings(item.kind, node, pointer)) {
        return undefined;
      }
    }

    this.record(item.kind, node, pointer);
    this.push(item.kind, node, pointer, base);

    return undefined;
  }

  // Indexes a schema's $id and $anchor, and refuses $dynamicRef at element scope.
  index(node: JsonObject, own: string, enclosing: string, pointer: string): Failure | undefined {
    if (this.line === "3.0") {
      return undefined;
    }

    if (own !== enclosing && stringMember(node, "$id") !== undefined) {
      if (this.documents.has(own) || (this.ids.get(own) ?? pointer) !== pointer) {
        return failure("REF-14/duplicate-id", pointer);
      }

      this.ids.set(own, pointer);
      this.added.add(own);
    }

    const anchor = stringMember(node, "$anchor");
    if (anchor !== undefined) {
      const name = `${own}#${anchor}`;
      if ((this.anchors.get(name) ?? pointer) !== pointer) {
        return failure("REF-14/duplicate-anchor", pointer);
      }

      this.anchors.set(name, pointer);
      this.added.add(own);
    }

    if (stringMember(node, "$dynamicRef") !== undefined) {
      this.findings.push({ code: "SCH-05/dynamic-ref", pointer });
    }

    return undefined;
  }

  // Records the sibling notice; true when the siblings are fields to walk.
  walksSiblings(kind: ReferenceKind, node: JsonObject, pointer: string): boolean {
    if (kind === "pathItem" || (kind === "schema" && this.line !== "3.0")) {
      return true;
    }

    const allowed = this.line === "3.0" ? ["$ref"] : ["$ref", "description", "summary"];
    if (Object.keys(node).some((member) => !allowed.includes(member))) {
      let code: NoticeCode = "REF-06/sibling-ignored";
      if (this.line === "3.0") {
        code = kind === "schema" ? "REF-07/sibling-ignored" : "REF-05/sibling-ignored";
      }

      this.findings.push({ code, pointer });
    }

    return false;
  }

  record(kind: Kind, node: JsonObject, pointer: string): void {
    const operationId = kind === "operation" ? stringMember(node, "operationId") : undefined;
    if (operationId !== undefined && !this.operationIds.has(operationId)) {
      this.operationIds.set(operationId, this.key(pointer));
    }

    const schemes = kind === "components" ? memberOf(node, "securitySchemes") : undefined;
    if (this.line !== "3.2" || schemes === undefined || !isObject(schemes)) {
      return;
    }

    for (const name of Object.keys(schemes)) {
      if (uriSyntax.test(name)) {
        this.findings.push({
          code: "SEC-10/uri-like-name",
          pointer: child(child(pointer, "securitySchemes"), name),
        });
      }
    }
  }

  // Queues the structural children so that they pop in document order.
  push(kind: Kind, node: JsonObject, pointer: string, base: string): void {
    const members = memberKinds.get(kind);
    const childBase = kind === "schema" ? base : this.base;
    const queued: Visit[] = [];
    const enqueue = (childKind: Kind, value: Json, at: string): void => {
      queued.push({ base: childBase, kind: childKind, node: value, pointer: at });
    };

    for (const [name, value] of Object.entries(node)) {
      const at = child(pointer, name);
      const field = fieldOf(this.line, kind, name);
      if (members !== undefined && !name.startsWith("x-")) {
        enqueue(members, value, at);
      } else if (field?.[2] === "one") {
        enqueue(field[1], value, at);
      } else if (field?.[2] === "list" && isArray(value)) {
        for (const [index, item] of value.entries()) {
          enqueue(field[1], item, child(at, `${index}`));
        }
      } else if (field?.[2] === "map" && isObject(value)) {
        for (const [entry, item] of Object.entries(value)) {
          enqueue(field[1], item, child(at, entry));
        }
      }
    }

    for (let index = queued.length - 1; index >= 0; index -= 1) {
      const item = queued[index];
      if (item !== undefined) {
        this.stack.push(item);
      }
    }
  }

  // The pointer of the resource a URI names: a document of the set, or for a schema an $id.
  resourceRoot(resource: string, isSchema: boolean): string | undefined {
    return this.documents.get(resource) ?? (isSchema ? this.ids.get(resource) : undefined);
  }

  // Finds the node a reference names inside the document set, without fetching anything.
  lookup(ref: string, base: string, isSchema: boolean): Lookup {
    const hash = ref.indexOf("#");
    const uriPart = hash === -1 ? ref : ref.slice(0, hash);
    const fragment = hash === -1 ? "" : ref.slice(hash + 1);
    const resolved = uriPart === "" ? base : resolveUri(uriPart, base);
    const resource = resolved === undefined ? undefined : stripFragment(resolved);
    const root = resource === undefined ? undefined : this.resourceRoot(resource, isSchema);
    if (resource === undefined) {
      return { missing: "outside" };
    }

    if (root === undefined) {
      return isSchema ? { missing: "outside", waitOn: resource } : { missing: "outside" };
    }

    const pointer = this.fragmentTarget(resource, root, fragment, isSchema);
    const byAnchor =
      isSchema && this.line !== "3.0" && fragment !== "" && !fragment.startsWith("/");
    if (pointer === undefined) {
      return byAnchor ? { missing: "unresolvable", waitOn: resource } : { missing: "unresolvable" };
    }

    const node = nodeAt(this.input.value, pointer);
    const accepted =
      node !== undefined &&
      (isObject(node) || (isSchema && this.line !== "3.0" && Predicate.isBoolean(node)));

    return node !== undefined && accepted
      ? { found: { node, pointer } }
      : { missing: "unresolvable", pointer };
  }

  // An empty fragment names the resource, a pointer a node in it, a plain name a schema $anchor.
  fragmentTarget(
    resource: string,
    root: string,
    fragment: string,
    isSchema: boolean,
  ): string | undefined {
    if (fragment === "") {
      return root;
    }

    if (fragment.startsWith("/")) {
      const pointer = fragmentPointer(fragment);

      return pointer === undefined ? undefined : `${root}${pointer}`;
    }

    return isSchema && this.line !== "3.0"
      ? this.anchors.get(`${resource}#${fragment}`)
      : undefined;
  }

  lookupFailure(site: Site, outcome: Missing): Failure {
    if (outcome.missing === "outside") {
      return failure(
        remoteUri.test(site.ref) ? "REF-16/outside-set" : "REF-15/outside-set",
        site.pointer,
      );
    }

    return failure(
      "REF-18/unresolvable",
      site.pointer,
      outcome.pointer === undefined ? undefined : this.key(outcome.pointer),
    );
  }

  // Resolves one schema reference, or names the resource it waits on. Every attempt, retries
  // included, is charged to the node budget.
  schemaSite(site: Site): Failure | { readonly waitOn: string } | undefined {
    const spent = this.spend();
    if (spent !== undefined) {
      return spent;
    }

    const outcome = this.lookup(site.ref, site.base, true);
    if (!("found" in outcome)) {
      return outcome.waitOn === undefined
        ? this.lookupFailure(site, outcome)
        : { waitOn: outcome.waitOn };
    }

    const { found } = outcome;
    const target = this.key(found.pointer);
    const key = defsKey(this.input.document, target);
    this.defs.set(keyOf(target), key);
    this.references.set(keyOf(this.key(site.pointer)), {
      defsKey: key,
      kind: "schema",
      site: this.key(site.pointer),
      target,
      via: [],
    });
    this.stack.push({
      base: this.enclosingBase(found.pointer),
      kind: "schema",
      node: found.node,
      pointer: found.pointer,
    });

    return undefined;
  }

  // Follows a non-schema chain to its end, at most `maxHops` references.
  chainSite(site: Site): Failure | undefined {
    const onChain = new Set([site.pointer]);
    const via: CanonicalKey[] = [];
    let docs = this.line === "3.0" || site.kind === "pathItem" ? {} : docsOf(site.node);
    let { ref } = site;
    for (let hops = 1; hops <= this.limits.maxHops; hops += 1) {
      const spent = this.spend();
      if (spent !== undefined) {
        return spent;
      }

      const outcome = this.lookup(ref, this.base, false);
      if (!("found" in outcome)) {
        return this.lookupFailure({ ...site, ref }, outcome);
      }

      const { found } = outcome;
      if (onChain.has(found.pointer)) {
        return failure("DOC-23/non-schema-cycle", site.pointer, this.key(found.pointer));
      }

      const hop = this.key(found.pointer);
      if (this.line !== "3.0" && site.kind !== "pathItem") {
        docs = nearest(docs, docsOf(found.node));
      }

      const known = this.references.get(keyOf(hop));
      const next = stringMember(found.node, "$ref");
      if (known?.kind === site.kind) {
        const total = [...via, hop, ...known.via];
        if (total.length >= this.limits.maxHops) {
          return failure("REF-18/hop-limit", site.pointer);
        }

        this.settle(site, known.target, total, nearest(docs, known));

        return undefined;
      }

      if (next === undefined) {
        this.settle(site, hop, via, docs);

        return undefined;
      }

      onChain.add(found.pointer);
      via.push(hop);
      ref = next;
    }

    return failure("REF-18/hop-limit", site.pointer);
  }

  settle(site: Site, target: CanonicalKey, via: readonly CanonicalKey[], docs: Docs): void {
    this.references.set(keyOf(this.key(site.pointer)), {
      ...docs,
      kind: site.kind,
      site: this.key(site.pointer),
      target,
      via,
    });

    const node = nodeAt(this.input.value, target.pointer);
    if (node !== undefined) {
      this.stack.push({ base: this.base, kind: site.kind, node, pointer: target.pointer });
    }
  }

  // The base URI a target inherits from the schemas around it, found by walking down from the root.
  enclosingBase(pointer: string): string {
    let node: Json | undefined = this.input.value;
    let state: Step = { kind: "root" };
    let { base } = this;
    for (const token of tokensOf(pointer)) {
      if (node === undefined) {
        break;
      }

      if ("kind" in state && state.kind === "schema") {
        base = schemaBase(this.line, base, node) ?? base;
      }

      if ("container" in state) {
        state = { kind: state.container };
      } else if (state.kind !== undefined) {
        state = stepInto(this.line, state.kind, token);
      }

      node = memberOf(node, token);
    }

    return base;
  }

  // Refuses a cycle that passes through the content of a non-schema target (design 3.3).
  containment(): Failure | undefined {
    const references = [...this.references.values()].filter(
      (reference) => reference.kind !== "schema",
    );
    const targets = new Set(references.map((reference) => reference.target.pointer));
    const edges = new Map<string, Edge[]>();
    for (const reference of references) {
      const owner = ownerOf(reference.site.pointer, targets);
      const list = edges.get(owner) ?? [];
      list.push({ site: reference.site.pointer, to: reference.target.pointer });
      edges.set(owner, list);
    }

    // A target also reaches every target nested inside it, so a cycle through nested content shows.
    for (const target of targets) {
      const owner = ownerOf(target, targets);
      if (target !== "" && owner !== "") {
        const list = edges.get(owner) ?? [];
        list.push({ site: target, to: target });
        edges.set(owner, list);
      }
    }

    const done = new Set<string>();
    for (const start of ["", ...targets]) {
      const closing = cycleFrom(start, edges, done);
      if (closing !== undefined) {
        return failure("DOC-23/non-schema-cycle", closing.site, this.key(closing.to));
      }
    }

    return undefined;
  }

  // Walks to a fixed point: a schema reference may wait for an $id or $anchor found later. A
  // waiting site is retried only when its resource gains one, and only while the walk progresses.
  run(): Failure | undefined {
    const retrieval = resolveUri(this.input.document, this.input.document) ?? this.input.document;
    this.documents.set(stripFragment(retrieval), "");
    this.documents.set(this.base, "");
    this.stack.push({ base: this.base, kind: "root", node: this.input.value, pointer: "" });

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

    const outcome = this.lookup(first.site.ref, first.site.base, true);

    return this.lookupFailure(
      first.site,
      "found" in outcome ? { missing: "unresolvable" } : outcome,
    );
  }
}

const Declared = Schema.Struct({ openapi: Schema.String });

const toDiagnostic = (input: ResolveInput, finding: Finding): Effect.Effect<Diagnostic> => {
  const rule = rules[finding.code];
  const [row] = finding.code.split("/");
  const openapi = Schema.decodeUnknownOption(Declared)(input.value).pipe(
    Option.map((declared) => declared.openapi),
    Option.getOrElse(() => "unknown"),
  );
  let scope = "document";
  if (notices.has(finding.code) || elementRefusals.has(finding.code)) {
    scope = "element";
  }

  const fields = {
    code: finding.code,
    document: input.document,
    element: rule.element,
    message: rule.message,
    openapi,
    pointer: finding.pointer,
    row,
    scope,
    severity: notices.has(finding.code) ? "notice" : "refusal",
    specSection: specSectionUrl(input.line, rule.anchor),
  };

  return Schema.decodeUnknownEffect(Diagnostic)(
    finding.related === undefined ? fields : { ...fields, related: [finding.related] },
  ).pipe(Effect.orDie);
};

/**
 * Resolves every reference in a document set of one (design 3.3): canonical keys, base URIs per
 * line, sibling rules, hop and node budgets, cycles, and `$defs` keys for schema targets. A URI
 * outside the set is refused, never fetched.
 */
export const resolve = (
  input: ResolveInput,
  limits: Partial<ResolveLimits> = {},
): Effect.Effect<Resolution, ResolveRefusal> => {
  const base = documentBase(input.line, input.document, input.value);
  const resolver = new Resolver(input, base ?? input.document, { ...defaultLimits, ...limits });
  const failed = base === undefined ? failure("REF-12/invalid-base", "/$self") : resolver.run();
  if (failed !== undefined) {
    return toDiagnostic(input, failed.finding).pipe(
      Effect.flatMap((diagnostic) => Effect.fail(new ResolveRefusal({ diagnostic }))),
    );
  }

  return Effect.all(resolver.findings.map((finding) => toDiagnostic(input, finding))).pipe(
    Effect.map((diagnostics): Resolution => ({
      base: resolver.base,
      defs: resolver.defs,
      diagnostics,
      document: input.document,
      line: input.line,
      operationIds: resolver.operationIds,
      references: resolver.references,
      value: input.value,
    })),
  );
};

/**
 * The resolved reference whose use site is `pointer` in the entry document.
 */
export const referenceAt = (
  resolution: Resolution,
  pointer: string,
): ResolvedReference | undefined =>
  resolution.references.get(keyOf({ document: resolution.document, pointer }));

// A 3.2 Security Scheme URI (SEC-10), resolved inside the set only.
const schemeByUri = (resolution: Resolution, name: string): Option.Option<CanonicalKey> => {
  const resolved = resolveUri(name, resolution.base);
  const hash = resolved?.indexOf("#") ?? -1;
  const resource = resolved === undefined ? undefined : stripFragment(resolved);
  const retrieval = stripFragment(resolveUri(resolution.document, resolution.document) ?? "");
  const inSet = resource === resolution.base || resource === retrieval;
  const pointer =
    resolved === undefined || hash === -1 || !inSet
      ? undefined
      : fragmentPointer(resolved.slice(hash + 1));

  return pointer !== undefined && nodeAt(resolution.value, pointer) !== undefined
    ? Option.some({ document: resolution.document, pointer })
    : Option.none();
};

/**
 * Resolves an implicit connection by name from the entry document only (design 3.3). For a 3.2
 * security scheme, a name that is not a component name is a URI resolved inside the set.
 */
export const implicitComponent = (
  resolution: Resolution,
  section: ComponentSection,
  name: string,
): Option.Option<CanonicalKey> => {
  const pointer = pointerOf(["components", section, name]);
  if (nodeAt(resolution.value, pointer) !== undefined) {
    return Option.some({ document: resolution.document, pointer });
  }

  return resolution.line === "3.2" && section === "securitySchemes"
    ? schemeByUri(resolution, name)
    : Option.none();
};

/**
 * The operation with `operationId` in the entry document, for Link Objects (design 3.3).
 */
export const operationById = (
  resolution: Resolution,
  operationId: string,
): Option.Option<CanonicalKey> => Option.fromUndefinedOr(resolution.operationIds.get(operationId));
