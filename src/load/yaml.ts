import { Data, Effect, Schema } from "effect";
import { isAlias, isScalar, isSeq, LineCounter, parseAllDocuments } from "yaml";
import type {
  Alias,
  Document as YamlDocument,
  ParsedNode,
  Scalar,
  YAMLError,
  YAMLMap,
  YAMLSeq,
} from "yaml";
import type { DocumentUri } from "../model/brands.ts";
import { escapeToken } from "../resolve/pointer.ts";
import type { Json } from "../resolve/pointer.ts";
import { refuse } from "./budget.ts";
import type { LoadCode, LoadLimits, LoadRefusal, Position } from "./budget.ts";

type Document = typeof DocumentUri.Type;

interface Failure {
  readonly code: LoadCode;
  /**
   * Character index into the decoded text, when the failure has a place.
   */
  readonly index?: number;
  readonly pointer: string;
}

/**
 * The one throwing seam: `yaml`'s parser, which can throw on pathological input (design 13.1 R7).
 */
class YamlParserFault extends Data.TaggedError("YamlParserFault")<{ readonly cause: unknown }> {}

const jsonTags: ReadonlySet<string> = new Set(
  ["bool", "float", "int", "map", "null", "seq", "str"].map((name) => `tag:yaml.org,2002:${name}`),
);

const isJsonScalar = Schema.is(Schema.Union([Schema.String, Schema.Boolean, Schema.Null]));

const isNumber = Schema.is(Schema.Number);

const isFinite = Schema.is(Schema.Finite);

const isString = Schema.is(Schema.String);

interface Built {
  readonly height: number;
  readonly size: number;
  readonly value: Json;
}

interface Walk {
  readonly active: Set<object>;
  readonly doc: YamlDocument.Parsed;
  readonly limits: LoadLimits;
  readonly memo: Map<object, Built>;
  readonly path: string[];
  failure: Failure | undefined;
  nodes: number;
}

const pointerOf = (path: readonly string[]): string =>
  path.map((token) => `/${escapeToken(token)}`).join("");

const fail = (walk: Walk, code: LoadCode, node: ParsedNode | null): void => {
  const index = node?.range[0];
  const pointer = pointerOf(walk.path);

  walk.failure ??= index === undefined ? { code, pointer } : { code, index, pointer };
};

const spend = (walk: Walk, count: number, node: ParsedNode | null): void => {
  walk.nodes += count;

  if (walk.nodes > walk.limits.maxNodes) {
    fail(walk, "DOC-14/node-budget", node);
  }
};

const leaf = (value: Json): Built => ({ height: 0, size: 1, value });

const nullLeaf = leaf(null);

const hasJsonTag = (tag: string | undefined): boolean => tag === undefined || jsonTags.has(tag);

const scalarOf = (walk: Walk, node: Scalar.Parsed): Built => {
  const { value } = node;

  if (!hasJsonTag(node.tag)) {
    fail(walk, "DOC-14/yaml-non-json-tag", node);
  } else if (isNumber(value) && !isFinite(value)) {
    fail(walk, "DOC-14/yaml-non-finite", node);
  } else if (isNumber(value) || isJsonScalar(value)) {
    return leaf(value);
  } else {
    fail(walk, "DOC-14/yaml-non-json-tag", node);
  }

  return nullLeaf;
};

const keyOf = (walk: Walk, key: ParsedNode | null): string => {
  if (isScalar(key) && isString(key.value)) {
    return key.value;
  }

  fail(walk, "DOC-14/yaml-non-string-key", key);

  return "";
};

const aliasOf = (walk: Walk, node: Alias.Parsed, depth: number): Built => {
  const target = node.resolve(walk.doc);
  const built = target === undefined ? undefined : walk.memo.get(target);

  if (target !== undefined && walk.active.has(target)) {
    fail(walk, "DOC-14/yaml-alias-cycle", node);
  } else if (built === undefined) {
    fail(walk, "DOC-14/invalid-yaml", node);
  } else if (depth + built.height > walk.limits.maxDepth) {
    fail(walk, "DOC-14/depth-limit", node);
  } else {
    spend(walk, built.size, node);

    return built;
  }

  return nullLeaf;
};

type Child = (node: ParsedNode | null, depth: number) => Built;

const buildSeq = (walk: Walk, node: YAMLSeq.Parsed, depth: number, child: Child): Built => {
  const items: Json[] = [];
  let height = 0;

  for (const [index, item] of node.items.entries()) {
    walk.path.push(String(index));

    const built = child(item, depth + 1);

    walk.path.pop();
    items.push(built.value);
    height = Math.max(height, built.height);

    if (walk.failure !== undefined) {
      break;
    }
  }

  return { height: height + 1, size: 1, value: items };
};

const buildMap = (walk: Walk, node: YAMLMap.Parsed, depth: number, child: Child): Built => {
  const entries: [string, Json][] = [];
  let height = 0;

  for (const pair of node.items) {
    const key = keyOf(walk, pair.key);

    walk.path.push(key);

    const built = child(pair.value, depth + 1);

    walk.path.pop();
    entries.push([key, built.value]);
    height = Math.max(height, built.height);

    if (walk.failure !== undefined) {
      break;
    }
  }

  return { height: height + 1, size: 1, value: Object.fromEntries(entries) };
};

const buildCollection = (
  walk: Walk,
  node: YAMLMap.Parsed | YAMLSeq.Parsed,
  depth: number,
  child: Child,
): Built => {
  if (!hasJsonTag(node.tag)) {
    fail(walk, "DOC-14/yaml-non-json-tag", node);
  } else if (depth > walk.limits.maxDepth) {
    fail(walk, "DOC-14/depth-limit", node);
  } else {
    return isSeq(node) ? buildSeq(walk, node, depth, child) : buildMap(walk, node, depth, child);
  }

  return nullLeaf;
};

/**
 * Builds the JSON value of one node. Anchored nodes are memoized by identity, so an alias costs its
 * target's size against the node budget but is never walked again (design 3.1).
 */
const build = (walk: Walk, node: ParsedNode | null, depth: number): Built => {
  if (isAlias(node)) {
    return aliasOf(walk, node, depth);
  }

  spend(walk, 1, node);

  if (node === null || walk.failure !== undefined) {
    return nullLeaf;
  }

  const before = walk.nodes - 1;
  const anchored = node.anchor !== undefined;

  if (anchored) {
    walk.active.add(node);
  }

  const child: Child = (next, nextDepth) => build(walk, next, nextDepth);
  const contents = isScalar(node)
    ? scalarOf(walk, node)
    : buildCollection(walk, node, depth, child);
  const built: Built = { ...contents, size: walk.nodes - before };

  if (anchored) {
    walk.active.delete(node);
    walk.memo.set(node, built);
  }

  return built;
};

const errorCodes = new Map<string, LoadCode>([
  ["DUPLICATE_KEY", "DOC-14/duplicate-key"],
  ["NON_STRING_KEY", "DOC-14/yaml-non-string-key"],
  ["TAG_RESOLVE_FAILED", "DOC-14/yaml-non-json-tag"],
]);

const failureOf = (error: YAMLError): Failure => ({
  code: errorCodes.get(error.code) ?? "DOC-14/invalid-yaml",
  index: error.pos[0],
  pointer: "",
});

type Outcome = { readonly failure: Failure } | { readonly value: Json };

const interpret = (documents: readonly YamlDocument.Parsed[], limits: LoadLimits): Outcome => {
  for (const doc of documents) {
    const problem = doc.errors[0] ?? doc.warnings[0];

    if (problem !== undefined) {
      return { failure: failureOf(problem) };
    }
  }

  const [first, second] = documents;

  if (first === undefined) {
    return { failure: { code: "DOC-14/invalid-yaml", pointer: "" } };
  }

  if (second !== undefined) {
    return {
      failure: { code: "DOC-14/yaml-multi-document", index: second.range[0], pointer: "" },
    };
  }

  const walk: Walk = {
    active: new Set(),
    doc: first,
    failure: undefined,
    limits,
    memo: new Map(),
    nodes: 0,
    path: [],
  };
  const built = build(walk, first.contents, 1);

  return walk.failure === undefined ? { value: built.value } : { failure: walk.failure };
};

const locate = (
  text: string,
  lineCounter: LineCounter,
  index: number,
  byteBase: number,
): Position => {
  const { col, line } = lineCounter.linePos(index);

  return {
    column: col,
    line,
    offset: byteBase + new TextEncoder().encode(text.slice(0, index)).length,
  };
};

const refuseYaml = (
  document: Document,
  code: LoadCode,
  pointer: string,
  position?: Position,
): Effect.Effect<never, LoadRefusal> =>
  refuse(document, code, position === undefined ? { pointer } : { pointer, position });

/**
 * Strict YAML 1.2 (design 3.1): `yaml`'s core schema with unique, string keys and no merge, then a
 * walk that builds the JSON value and refuses what the parser accepts but JSON cannot hold.
 * `byteBase` is the number of bytes before `text` (a byte order mark), so offsets are input
 * offsets.
 */
export const parseStrictYaml = (
  text: string,
  limits: LoadLimits,
  document: Document,
  byteBase: number,
): Effect.Effect<Json, LoadRefusal> => {
  const lineCounter = new LineCounter();

  return Effect.try({
    catch: (cause) => new YamlParserFault({ cause }),
    try: () =>
      parseAllDocuments(text, {
        lineCounter,
        merge: false,
        schema: "core",
        stringKeys: true,
        uniqueKeys: true,
        version: "1.2",
      }),
  }).pipe(
    Effect.matchEffect({
      onFailure: () => refuseYaml(document, "DOC-14/invalid-yaml", ""),
      onSuccess: (documents) => {
        const outcome = interpret(documents, limits);

        if ("value" in outcome) {
          return Effect.succeed(outcome.value);
        }

        const { code, index, pointer } = outcome.failure;

        return refuseYaml(
          document,
          code,
          pointer,
          index === undefined ? undefined : locate(text, lineCounter, index, byteBase),
        );
      },
    }),
  );
};
