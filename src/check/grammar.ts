import { Effect, Exit, Option, Predicate, Schema } from "effect";
import { HeaderName, MediaRange } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import { keyOf } from "../resolve/canonical.ts";
import type { CanonicalKey } from "../resolve/canonical.ts";
import { allOfReferrers, defaultLimits, implicitComponent } from "../resolve/index.ts";
import type { Resolution, ResolveLimits } from "../resolve/index.ts";
import { childPointer } from "../model/pointer.ts";
import type { Json } from "../model/pointer.ts";
import { specSectionUrl, patchVersion } from "../model/spec-section.ts";
import { isObject, isArray, nodeAt, stringMember } from "../model/json-tree.ts";
import type { JsonObject } from "../model/json-tree.ts";

interface Rule {
  readonly anchor: string;
  readonly element: string;
  readonly hint?: string;
  readonly message: string;
  readonly scope: "document" | "element" | "operation";
  readonly severity: "notice" | "refusal";
}

const rules = {
  "DSC-03/unresolved-target": {
    anchor: "discriminator-mapping",
    element: "Discriminator mapping",
    hint: "Map to a component schema name or to a reference to a schema in the document.",
    message:
      "A discriminator mapping value does not resolve to a schema. The discriminator is not used.",
    scope: "element",
    severity: "refusal",
  },
  "DSC-04/unresolved-target": {
    anchor: "discriminator-default-mapping",
    element: "Discriminator defaultMapping",
    hint: "Point defaultMapping at a component schema name or a reference to a schema in the document.",
    message:
      "The discriminator defaultMapping does not resolve to a schema. The discriminator is not used.",
    scope: "element",
    severity: "refusal",
  },
  "DSC-05/no-composition": {
    anchor: "discriminator-object",
    element: "Discriminator",
    hint: "Put the discriminator beside oneOf or anyOf, or on a base schema that allOf children reference.",
    message:
      "A discriminator is legal only with oneOf, anyOf or allOf, and this schema uses none. The discriminator is not used.",
    scope: "element",
    severity: "refusal",
  },
  "DSC-09/property-not-required": {
    anchor: "discriminator-object",
    element: "Discriminator propertyName",
    hint: "List the property in required, on the schema or on every branch.",
    message: "The discriminating property is not required. The discriminator is not used.",
    scope: "element",
    severity: "refusal",
  },
  "DSC-10/missing-default-mapping": {
    anchor: "discriminator-default-mapping",
    element: "Discriminator",
    hint: "Require the property or add a defaultMapping.",
    message:
      "An optional discriminating property needs a defaultMapping. The discriminator is not used.",
    scope: "element",
    severity: "refusal",
  },
  "HDR-01/invalid-header-name": {
    anchor: "header-object",
    element: "Encoding header name",
    hint: "Name the header with an RFC 9110 token.",
    message: "An encoding header name is not an RFC 9110 token.",
    scope: "element",
    severity: "refusal",
  },
  "MED-24/invalid-media-type": {
    anchor: "media-types",
    element: "Media type key",
    hint: "Use a media type or range such as application/json, text/* or */*.",
    message: "A content key is not an RFC 9110 media type or range.",
    scope: "element",
    severity: "refusal",
  },
  "PRM-20/invalid-header-name": {
    anchor: "parameter-locations",
    element: "Header parameter name",
    hint: "Name the header with an RFC 9110 token.",
    message: "A header parameter name is not an RFC 9110 token.",
    scope: "element",
    severity: "refusal",
  },
  "REF-18/node-budget": {
    anchor: "reference-object",
    element: "Schema graph",
    hint: "Reduce how often schemas reuse each other through allOf, oneOf and anyOf.",
    message: "The schema graph needs more steps to check than the node budget allows.",
    scope: "document",
    severity: "refusal",
  },
  "RSP-09/invalid-header-name": {
    anchor: "response-headers",
    element: "Response header name",
    hint: "Name the header with an RFC 9110 token.",
    message: "A response header name is not an RFC 9110 token.",
    scope: "element",
    severity: "refusal",
  },
  "RSS-10/invalid-status": {
    anchor: "responses-code",
    element: "Response status key",
    hint: "Use a status code from 100 to 599, a range from 1XX to 5XX, or default.",
    message: "A responses key is not a status code in 100 to 599, a range 1XX to 5XX, or default.",
    scope: "element",
    severity: "refusal",
  },
  "S30-09/not-unicode-compilable": {
    anchor: "json-schema-keywords",
    element: "Schema pattern",
    hint: "Escape the pattern for Unicode mode, or accept that the server validates it.",
    message: "The pattern does not compile in Unicode mode; the value is sent unvalidated.",
    scope: "element",
    severity: "notice",
  },
  "S30-22/array-without-items": {
    anchor: "json-schema-keywords",
    element: "Schema items",
    hint: "Add items with the schema of the array elements.",
    message: "A 3.0 schema of type array has no items.",
    scope: "element",
    severity: "refusal",
  },
  "S30-30/read-and-write-only": {
    anchor: "schema-read-only",
    element: "Schema readOnly and writeOnly",
    hint: "Set at most one of readOnly and writeOnly to true.",
    message: "A schema sets readOnly and writeOnly to true together.",
    scope: "element",
    severity: "refusal",
  },
  "SCH-37/not-unicode-compilable": {
    anchor: "json-schema-keywords",
    element: "Schema pattern",
    hint: "Escape the pattern for Unicode mode, or accept that the server validates it.",
    message: "The pattern does not compile in Unicode mode; the value is sent unvalidated.",
    scope: "element",
    severity: "notice",
  },
  "SEC-09/unresolved-scheme": {
    anchor: "security-requirements-name",
    element: "Security requirement name",
    hint: "Declare the scheme under components.securitySchemes or fix the name.",
    message: "A security requirement names a scheme that is not declared.",
    scope: "element",
    severity: "refusal",
  },
  "SEC-10/unresolved-scheme": {
    anchor: "security-requirements-name",
    element: "Security requirement name",
    hint: "Name a component scheme, or a URI that identifies a Security Scheme in the document.",
    message:
      "A security requirement names neither a component scheme nor a Security Scheme URI in the document.",
    scope: "element",
    severity: "refusal",
  },
  "SEC-12/non-empty-scopes": {
    anchor: "security-requirements-name",
    element: "Security requirement scopes",
    hint: "Use an empty array for schemes other than oauth2 and openIdConnect.",
    message: "A 3.0 security requirement lists values for a scheme that takes none.",
    scope: "element",
    severity: "refusal",
  },
  "SRV-12/default-not-in-enum": {
    anchor: "server-variable-default",
    element: "Server variable default",
    hint: "Add the default to the enum, or change the default.",
    message: "A server variable default is not one of its enum values.",
    scope: "operation",
    severity: "refusal",
  },
  "SRV-18/query-or-fragment": {
    anchor: "server-url",
    element: "Server url",
    hint: "Remove the query or fragment from the server URL.",
    message: "A server URL contains a query or a fragment.",
    scope: "operation",
    severity: "refusal",
  },
  "SRV-19/repeated-variable": {
    anchor: "server-variable-object",
    element: "Server url",
    hint: "Use each server variable once in the URL.",
    message: "A server variable appears more than once in the server URL.",
    scope: "operation",
    severity: "refusal",
  },
} as const satisfies Record<string, Rule>;

type Code = keyof typeof rules;

interface Finding {
  readonly code: Code;
  readonly operation?: Operation;
  readonly pointer: string;
  readonly scope?: Rule["scope"];
  readonly severity?: Rule["severity"];
}

interface PathItem {
  readonly node: JsonObject;
  readonly pointer: string;
  readonly use: string;
  readonly key: string;
}

interface Operation {
  readonly id: string | undefined;
  readonly item: PathItem;
  readonly method: string;
  readonly node: JsonObject;
  readonly pointer: string;
}

// An object and where it sits: the document of the set that holds it, and its pointer there.
interface Place {
  readonly document: CanonicalKey["document"];
  readonly node: JsonObject;
  readonly pointer: string;
}

const statusKey = /^(?:[1-5][0-9]{2}|[1-5]XX|default)$/u;

const expression = /\{(?<name>[^{}]+)\}/gu;

const fixedMethods: readonly string[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];

const schemaMembers = [
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;

const schemaLists = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

const schemaMaps = [
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
] as const;

const entriesOf = (value: Json | undefined): readonly (readonly [string, Json])[] =>
  isObject(value) ? Object.entries(value) : [];

const listOf = (value: Json | undefined): readonly Json[] => (isArray(value) ? value : []);

const isReference = (node: JsonObject): boolean => Predicate.isString(node.$ref);

// An object at a use site, followed through its Reference Object to the end of the chain, which
// is read from the document of the set that holds it.
const locate = (
  resolution: Resolution,
  site: CanonicalKey,
  node: Json | undefined,
): Place | undefined => {
  const at = resolution.references.get(keyOf(site))?.target ?? site;
  const document = resolution.documents.get(at.document);
  const read = document === undefined ? undefined : nodeAt(document, at.pointer);
  const target = at === site ? node : read;

  return isObject(target)
    ? { document: at.document, node: target, pointer: at.pointer }
    : undefined;
};

// The site at `pointer` in the entry document.
const entrySite = (resolution: Resolution, pointer: string): CanonicalKey => ({
  document: resolution.document,
  pointer,
});

const isToken = (name: string): boolean =>
  Option.isSome(Schema.decodeUnknownOption(HeaderName)(name));

const isMediaRange = (name: string): boolean =>
  Option.isSome(Schema.decodeUnknownOption(MediaRange)(name));

const compilesWithU = (source: string): boolean =>
  Exit.isSuccess(Effect.runSyncExit(Effect.try(() => new RegExp(source, "u"))));

const at =
  (code: Code, pointer: string) =>
  (extra: Partial<Finding> = {}): Finding => ({ code, pointer, ...extra });

// A discriminator mapping value: a component schema name first, else a reference into the set
// (`implicitComponent`); either way the target must be a Schema Object.
const mappingResolves = (resolution: Resolution, value: string): boolean =>
  Option.match(implicitComponent(resolution, "schemas", value), {
    onNone: () => false,
    onSome: (key) => isObject(nodeAt(resolution.value, key.pointer)),
  });

// One checkGrammar call's walk through allOf, oneOf and anyOf: answers already settled, the
// schemas being walked (by depth) and the steps left. Reuse across members is a DAG, so each
// (schema, name) pair is settled once; the budget bounds a hostile graph that stays large anyway.
interface Search {
  readonly active: Map<string, number>;
  readonly budget: number;
  exhausted: boolean;
  readonly memo: Map<string, boolean>;
  steps: number;
}

const searches = new WeakMap<Resolution, Search>();

const startSearch = (resolution: Resolution, budget: number): Search => {
  const fresh: Search = { active: new Map(), budget, exhausted: false, memo: new Map(), steps: 0 };
  searches.set(resolution, fresh);

  return fresh;
};

const searchOf = (resolution: Resolution): Search =>
  searches.get(resolution) ?? startSearch(resolution, defaultLimits.maxNodes);

interface Answer {
  readonly found: boolean;
  // The shallowest schema still being walked that this answer assumed to be no; unsettled below it.
  readonly low: number;
}

const settled = (found: boolean): Answer => ({ found, low: Infinity });

// Whether the schema at `place` requires `name`: directly, through allOf, or in every
// oneOf/anyOf branch. References are followed; a schema already on the path counts as no.
// A no that leaned on such a schema is kept only once that schema is settled.
const requiresAt = (
  resolution: Resolution,
  search: Search,
  place: Place,
  name: string,
  depth: number,
): Answer => {
  const key = `${place.document}#${place.pointer}\u0000${name}`;
  const known = search.memo.get(key);
  const walking = search.active.get(key);
  search.steps += 1;

  if (known !== undefined) {
    return settled(known);
  }

  if (walking !== undefined) {
    return { found: false, low: walking };
  }

  if (search.steps > search.budget) {
    search.exhausted = true;

    return { found: false, low: -1 };
  }

  search.active.set(key, depth);

  const members = (keyword: string): readonly Place[] =>
    listOf(place.node[keyword]).flatMap((member, index) => {
      const located = locate(
        resolution,
        {
          document: place.document,
          pointer: childPointer(childPointer(place.pointer, keyword), String(index)),
        },
        member,
      );

      return located === undefined ? [] : [located];
    });
  const within = (member: Place): Answer => requiresAt(resolution, search, member, name, depth + 1);
  const answer = ((): Answer => {
    if (listOf(place.node.required).includes(name)) {
      return settled(true);
    }

    let low = Infinity;

    for (const member of members("allOf")) {
      const inner = within(member);

      if (inner.found) {
        return settled(true);
      }

      low = Math.min(low, inner.low);
    }

    const alternatives = [...members("oneOf"), ...members("anyOf")];

    if (alternatives.length === 0) {
      return { found: false, low };
    }

    for (const member of alternatives) {
      const inner = within(member);

      if (!inner.found) {
        return { found: false, low: Math.min(low, inner.low) };
      }
    }

    return settled(true);
  })();

  search.active.delete(key);

  if (answer.found || answer.low >= depth) {
    search.memo.set(key, answer.found);

    return settled(answer.found);
  }

  return answer;
};

const requires = (resolution: Resolution, place: Place, name: string): boolean =>
  requiresAt(resolution, searchOf(resolution), place, name, 0).found;

const composes = (node: JsonObject): boolean =>
  ["allOf", "anyOf", "oneOf"].some((keyword) => listOf(node[keyword]).length > 0);

const discriminatorFindings = (
  resolution: Resolution,
  place: Place,
  discriminator: JsonObject,
): readonly Finding[] => {
  const base = childPointer(place.pointer, "discriminator");
  const self = keyOf({ document: place.document, pointer: place.pointer });
  // An allOf base: the discriminator sits on the base and the children reference it (DSC-11).
  if (!composes(place.node) && !allOfReferrers(resolution).has(self)) {
    return [at("DSC-05/no-composition", base)()];
  }

  const name = stringMember(discriminator, "propertyName");
  const required = name !== undefined && requires(resolution, place, name);
  const defaultMapping = stringMember(discriminator, "defaultMapping");
  const property =
    name === undefined || required || resolution.line === "3.2"
      ? []
      : [at("DSC-09/property-not-required", childPointer(base, "propertyName"))()];
  const optional =
    name === undefined || required || resolution.line !== "3.2" || defaultMapping !== undefined
      ? []
      : [at("DSC-10/missing-default-mapping", base)()];
  const mapped = entriesOf(discriminator.mapping).flatMap(([key, value]) =>
    Predicate.isString(value) && !mappingResolves(resolution, value)
      ? [at("DSC-03/unresolved-target", childPointer(childPointer(base, "mapping"), key))()]
      : [],
  );
  const fallback =
    resolution.line === "3.2" &&
    defaultMapping !== undefined &&
    !mappingResolves(resolution, defaultMapping)
      ? [at("DSC-04/unresolved-target", childPointer(base, "defaultMapping"))()]
      : [];

  return [...property, ...optional, ...mapped, ...fallback];
};

const ownSchemaFindings = (resolution: Resolution, place: Place): readonly Finding[] => {
  const { node, pointer } = place;
  const pattern = Predicate.isString(node.pattern) ? node.pattern : undefined;
  const legacy = resolution.line === "3.0";
  const patternCode = legacy ? "S30-09/not-unicode-compilable" : "SCH-37/not-unicode-compilable";

  return [
    ...(pattern === undefined || compilesWithU(pattern)
      ? []
      : [at(patternCode, childPointer(pointer, "pattern"))()]),
    ...(legacy && node.type === "array" && node.items === undefined
      ? [at("S30-22/array-without-items", childPointer(pointer, "items"))()]
      : []),
    ...(legacy && node.readOnly === true && node.writeOnly === true
      ? [at("S30-30/read-and-write-only", pointer)()]
      : []),
    ...(isObject(node.discriminator)
      ? discriminatorFindings(resolution, place, node.discriminator)
      : []),
  ];
};

// A 3.0 Reference Object ignores its siblings (design 3.3); later lines keep them as keywords.
const schemaFindings = (
  resolution: Resolution,
  node: Json | undefined,
  pointer: string,
): readonly Finding[] => {
  if (!isObject(node) || (resolution.line === "3.0" && isReference(node))) {
    return [];
  }

  const below = (token: string, value: Json | undefined): readonly Finding[] =>
    schemaFindings(resolution, value, childPointer(pointer, token));

  return [
    ...ownSchemaFindings(resolution, { document: resolution.document, node, pointer }),
    ...schemaMembers.flatMap((keyword) => below(keyword, node[keyword])),
    ...schemaLists.flatMap((keyword) =>
      listOf(node[keyword]).flatMap((member, index) =>
        schemaFindings(
          resolution,
          member,
          childPointer(childPointer(pointer, keyword), String(index)),
        ),
      ),
    ),
    ...schemaMaps.flatMap((keyword) =>
      entriesOf(node[keyword]).flatMap(([name, member]) =>
        schemaFindings(resolution, member, childPointer(childPointer(pointer, keyword), name)),
      ),
    ),
  ];
};

type HeaderCode = "HDR-01/invalid-header-name" | "RSP-09/invalid-header-name";

// Header, Content, Media Type and Encoding objects refer to each other, so they share one record.
interface Media {
  readonly encoding: (
    resolution: Resolution,
    node: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
  readonly content: (
    resolution: Resolution,
    content: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
  readonly header: (
    resolution: Resolution,
    node: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
  readonly headers: (
    resolution: Resolution,
    headers: Json | undefined,
    pointer: string,
    code: HeaderCode,
  ) => readonly Finding[];
  readonly mediaType: (
    resolution: Resolution,
    node: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
}

const media: Media = {
  content: (resolution, content, pointer) =>
    entriesOf(content).flatMap(([name, mediaType]) => [
      ...(isMediaRange(name)
        ? []
        : [at("MED-24/invalid-media-type", childPointer(pointer, name))()]),
      ...media.mediaType(resolution, mediaType, childPointer(pointer, name)),
    ]),
  encoding: (resolution, node, pointer) =>
    isObject(node) && !isReference(node)
      ? media.headers(
          resolution,
          node.headers,
          childPointer(pointer, "headers"),
          "HDR-01/invalid-header-name",
        )
      : [],
  header: (resolution, node, pointer) =>
    isObject(node) && !isReference(node)
      ? [
          ...schemaFindings(resolution, node.schema, childPointer(pointer, "schema")),
          ...media.content(resolution, node.content, childPointer(pointer, "content")),
        ]
      : [],
  headers: (resolution, headers, pointer, code) =>
    entriesOf(headers).flatMap(([name, header]) => [
      ...(isToken(name) ? [] : [at(code, childPointer(pointer, name))()]),
      ...media.header(resolution, header, childPointer(pointer, name)),
    ]),
  mediaType: (resolution, node, pointer) => {
    if (!isObject(node) || isReference(node)) {
      return [];
    }

    return [
      ...schemaFindings(resolution, node.schema, childPointer(pointer, "schema")),
      ...schemaFindings(resolution, node.itemSchema, childPointer(pointer, "itemSchema")),
      ...entriesOf(node.encoding).flatMap(([name, encoding]) =>
        media.encoding(resolution, encoding, childPointer(childPointer(pointer, "encoding"), name)),
      ),
      ...media.encoding(resolution, node.itemEncoding, childPointer(pointer, "itemEncoding")),
      ...listOf(node.prefixEncoding).flatMap((encoding, index) =>
        media.encoding(
          resolution,
          encoding,
          childPointer(childPointer(pointer, "prefixEncoding"), String(index)),
        ),
      ),
    ];
  },
};

const parameterFindings = (
  resolution: Resolution,
  node: Json | undefined,
  pointer: string,
): readonly Finding[] => {
  if (!isObject(node) || isReference(node)) {
    return [];
  }

  const name = stringMember(node, "name");
  const badName =
    node.in === "header" && name !== undefined && !isToken(name)
      ? [at("PRM-20/invalid-header-name", childPointer(pointer, "name"))()]
      : [];

  return [...badName, ...media.header(resolution, node, pointer)];
};

const parameterListFindings = (
  resolution: Resolution,
  list: Json | undefined,
  pointer: string,
): readonly Finding[] =>
  listOf(list).flatMap((parameter, index) =>
    parameterFindings(resolution, parameter, childPointer(pointer, String(index))),
  );

const responseFindings = (
  resolution: Resolution,
  node: Json | undefined,
  pointer: string,
): readonly Finding[] =>
  isObject(node) && !isReference(node)
    ? [
        ...media.headers(
          resolution,
          node.headers,
          childPointer(pointer, "headers"),
          "RSP-09/invalid-header-name",
        ),
        ...media.content(resolution, node.content, childPointer(pointer, "content")),
      ]
    : [];

const responsesFindings = (
  resolution: Resolution,
  responses: Json | undefined,
  pointer: string,
): readonly Finding[] =>
  entriesOf(responses).flatMap(([code, response]) =>
    code.startsWith("x-")
      ? []
      : [
          ...(statusKey.test(code)
            ? []
            : [at("RSS-10/invalid-status", childPointer(pointer, code))()]),
          ...responseFindings(resolution, response, childPointer(pointer, code)),
        ],
  );

const requestBodyFindings = (
  resolution: Resolution,
  node: Json | undefined,
  pointer: string,
): readonly Finding[] =>
  isObject(node) && !isReference(node)
    ? media.content(resolution, node.content, childPointer(pointer, "content"))
    : [];

const methodMembers = (line: Resolution["line"]): readonly string[] =>
  line === "3.2" ? [...fixedMethods, "query"] : fixedMethods;

// Path Item, Operation and Callback objects refer to each other through callbacks.
interface Items {
  readonly callback: (
    resolution: Resolution,
    node: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
  readonly operation: (
    resolution: Resolution,
    node: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
  readonly pathItem: (
    resolution: Resolution,
    node: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
}

const items: Items = {
  callback: (resolution, node, pointer) =>
    isObject(node) && !isReference(node)
      ? entriesOf(node).flatMap(([key, item]) =>
          key.startsWith("x-") ? [] : items.pathItem(resolution, item, childPointer(pointer, key)),
        )
      : [],
  operation: (resolution, node, pointer) =>
    isObject(node)
      ? [
          ...parameterListFindings(
            resolution,
            node.parameters,
            childPointer(pointer, "parameters"),
          ),
          ...requestBodyFindings(
            resolution,
            node.requestBody,
            childPointer(pointer, "requestBody"),
          ),
          ...responsesFindings(resolution, node.responses, childPointer(pointer, "responses")),
          ...entriesOf(node.callbacks).flatMap(([name, callback]) =>
            items.callback(
              resolution,
              callback,
              childPointer(childPointer(pointer, "callbacks"), name),
            ),
          ),
        ]
      : [],
  pathItem: (resolution, node, pointer) => {
    if (!isObject(node) || isReference(node)) {
      return [];
    }

    const fixed = methodMembers(resolution.line).map(
      (method) => [childPointer(pointer, method), node[method]] as const,
    );
    const extra =
      resolution.line === "3.2"
        ? entriesOf(node.additionalOperations).map(
            ([name, operation]) =>
              [
                childPointer(childPointer(pointer, "additionalOperations"), name),
                operation,
              ] as const,
          )
        : [];

    return [
      ...parameterListFindings(resolution, node.parameters, childPointer(pointer, "parameters")),
      ...[...fixed, ...extra].flatMap(([place, operation]) =>
        items.operation(resolution, operation, place),
      ),
    ];
  },
};

const componentFindings = (resolution: Resolution): readonly Finding[] => {
  const components = isObject(resolution.value) ? resolution.value.components : undefined;
  if (!isObject(components)) {
    return [];
  }

  const each = (
    section: string,
    visit: (node: Json | undefined, pointer: string) => readonly Finding[],
  ): readonly Finding[] =>
    entriesOf(components[section]).flatMap(([name, node]) =>
      visit(node, childPointer(childPointer("/components", section), name)),
    );

  return [
    ...each("schemas", (node, pointer) => schemaFindings(resolution, node, pointer)),
    ...each("responses", (node, pointer) => responseFindings(resolution, node, pointer)),
    ...each("parameters", (node, pointer) => parameterFindings(resolution, node, pointer)),
    ...each("requestBodies", (node, pointer) => requestBodyFindings(resolution, node, pointer)),
    ...each("headers", (node, pointer) => media.header(resolution, node, pointer)),
    ...each("pathItems", (node, pointer) => items.pathItem(resolution, node, pointer)),
    ...each("callbacks", (node, pointer) => items.callback(resolution, node, pointer)),
    ...each("mediaTypes", (node, pointer) => media.mediaType(resolution, node, pointer)),
  ];
};

const elementFindings = (resolution: Resolution): readonly Finding[] => {
  const root = isObject(resolution.value) ? resolution.value : {};
  const under = (member: string): readonly Finding[] =>
    entriesOf(root[member]).flatMap(([key, item]) =>
      items.pathItem(resolution, item, childPointer(childPointer("", member), key)),
    );

  return [
    ...under("paths"),
    ...(resolution.line === "3.0" ? [] : under("webhooks")),
    ...componentFindings(resolution),
  ];
};

const pathItems = (resolution: Resolution): readonly PathItem[] =>
  entriesOf(isObject(resolution.value) ? resolution.value.paths : undefined).flatMap(
    ([key, value]) => {
      const use = childPointer("/paths", key);
      const located = locate(resolution, entrySite(resolution, use), value);

      // A path item in another document of the set is not walked: the checks read entry sites.
      return located === undefined || located.document !== resolution.document
        ? []
        : [{ key, node: located.node, pointer: located.pointer, use }];
    },
  );

const operationsOf = (resolution: Resolution, item: PathItem): readonly Operation[] => {
  const fixed = methodMembers(resolution.line).filter((name) => isObject(item.node[name]));
  const extra =
    resolution.line === "3.2"
      ? entriesOf(item.node.additionalOperations).map(([name]) => name)
      : [];
  const entries = [
    ...fixed.map((name) => [name, name.toUpperCase(), childPointer(item.pointer, name)] as const),
    ...extra.map(
      (name) =>
        [
          name,
          name,
          childPointer(childPointer(item.pointer, "additionalOperations"), name),
        ] as const,
    ),
  ];

  return entries.flatMap(([, method, pointer]) => {
    const node = nodeAt(resolution.value, pointer);

    return isObject(node)
      ? [{ id: stringMember(node, "operationId"), item, method, node, pointer }]
      : [];
  });
};

const serverFindings = (
  resolution: Resolution,
  server: Json,
  pointer: string,
): readonly Finding[] => {
  if (!isObject(server)) {
    return [];
  }

  const url = stringMember(server, "url");
  const names =
    url === undefined
      ? []
      : Array.from(url.matchAll(expression), (match) => match.groups?.name ?? "");
  const repeated = new Set(names).size !== names.length;
  const defaultSeverity = resolution.line === "3.0" ? "notice" : "refusal";
  const variables = entriesOf(server.variables).flatMap(([name, variable]) => {
    const fallback = isObject(variable) ? stringMember(variable, "default") : undefined;
    const members = isObject(variable) ? variable.enum : undefined;

    return fallback !== undefined &&
      isArray(members) &&
      members.length > 0 &&
      !members.includes(fallback)
      ? [
          at(
            "SRV-12/default-not-in-enum",
            childPointer(childPointer(pointer, "variables"), name),
          )({
            severity: defaultSeverity,
          }),
        ]
      : [];
  });

  return [
    ...(url !== undefined && /[?#]/u.test(url)
      ? [at("SRV-18/query-or-fragment", childPointer(pointer, "url"))()]
      : []),
    ...(repeated ? [at("SRV-19/repeated-variable", childPointer(pointer, "url"))()] : []),
    ...variables,
  ];
};

// Operation servers replace the path item's, which replace the root's (SRV-15).
const serversOf = (
  resolution: Resolution,
  operation: Operation,
): readonly [readonly Json[], string] => {
  if (isArray(operation.node.servers)) {
    return [operation.node.servers, operation.pointer];
  }

  if (isArray(operation.item.node.servers)) {
    return [operation.item.node.servers, operation.item.pointer];
  }

  return [listOf(isObject(resolution.value) ? resolution.value.servers : undefined), ""];
};

const effectiveServers = (
  resolution: Resolution,
  operation: Operation,
): readonly (readonly [Json, string])[] => {
  const [servers, owner] = serversOf(resolution, operation);

  return servers.map(
    (server, index) =>
      [server, childPointer(childPointer(owner, "servers"), String(index))] as const,
  );
};

const operationServerFindings = (
  resolution: Resolution,
  operation: Operation,
): readonly Finding[] =>
  effectiveServers(resolution, operation).flatMap(([server, pointer]) =>
    serverFindings(resolution, server, pointer).map((finding) => ({ ...finding, operation })),
  );

const schemeNode = (resolution: Resolution, name: string): JsonObject | undefined => {
  const key = implicitComponent(resolution, "securitySchemes", name);
  if (Option.isNone(key)) {
    return undefined;
  }

  const document = resolution.documents.get(key.value.document);
  const node = document === undefined ? undefined : nodeAt(document, key.value.pointer);

  return locate(resolution, key.value, node)?.node;
};

interface Requirement {
  readonly scopes: readonly Finding[];
  readonly unresolved: readonly Finding[];
}

// SEC-12 holds in 3.0 only: a scheme that takes no scopes must list none.
const scopesFinding = (
  resolution: Resolution,
  scheme: JsonObject,
  scopes: Json,
  pointer: string,
): readonly Finding[] => {
  const kind = stringMember(scheme, "type");
  const takesScopes = kind === "oauth2" || kind === "openIdConnect";

  return resolution.line === "3.0" && !takesScopes && listOf(scopes).length > 0
    ? [at("SEC-12/non-empty-scopes", pointer)()]
    : [];
};

const requirementFindings = (
  resolution: Resolution,
  alternative: Json,
  pointer: string,
): Requirement => {
  const code = resolution.line === "3.2" ? "SEC-10/unresolved-scheme" : "SEC-09/unresolved-scheme";
  const names = entriesOf(alternative).map(([name, scopes]) => {
    const scheme = schemeNode(resolution, name);
    const place = childPointer(pointer, name);

    return scheme === undefined
      ? { scopes: [], unresolved: [at(code, place)()] }
      : { scopes: scopesFinding(resolution, scheme, scopes, place), unresolved: [] };
  });

  return {
    scopes: names.flatMap((entry) => entry.scopes),
    unresolved: names.flatMap((entry) => entry.unresolved),
  };
};

interface SecurityList {
  readonly exhausted: boolean;
  readonly scopes: readonly Finding[];
  readonly unresolved: readonly Finding[];
}

// `exhausted`: every alternative names a scheme that does not resolve, so none remains usable.
const securityList = (
  resolution: Resolution,
  list: readonly Json[],
  pointer: string,
): SecurityList => {
  const requirements = list.map((alternative, index) =>
    requirementFindings(resolution, alternative, childPointer(pointer, String(index))),
  );

  return {
    exhausted:
      requirements.length > 0 &&
      requirements.every((requirement) => requirement.unresolved.length > 0),
    scopes: requirements.flatMap((requirement) => requirement.scopes),
    unresolved: requirements.flatMap((requirement) => requirement.unresolved),
  };
};

const operationScoped = (findings: readonly Finding[], operation: Operation): readonly Finding[] =>
  findings.map((finding) => ({ ...finding, operation, scope: "operation" }));

const ownSecurity = (resolution: Resolution, operation: Operation): readonly Finding[] => {
  const list = operation.node.security;
  if (!isArray(list)) {
    return [];
  }

  const found = securityList(resolution, list, childPointer(operation.pointer, "security"));

  return [
    ...(found.exhausted ? operationScoped(found.unresolved, operation) : found.unresolved),
    ...found.scopes,
  ];
};

// A root list that leaves an operation no alternative is that operation's refusal.
const rootSecurity = (
  resolution: Resolution,
  operations: readonly Operation[],
): readonly Finding[] => {
  const list = isObject(resolution.value) ? resolution.value.security : undefined;
  if (!isArray(list)) {
    return [];
  }

  const found = securityList(resolution, list, "/security");
  const inheriting = operations.filter((operation) => !isArray(operation.node.security));
  const unresolved =
    found.exhausted && inheriting.length > 0
      ? inheriting.flatMap((operation) => operationScoped(found.unresolved, operation))
      : found.unresolved;

  return [...unresolved, ...found.scopes];
};

const securityFindings = (
  resolution: Resolution,
  operations: readonly Operation[],
): readonly Finding[] => [
  ...rootSecurity(resolution, operations),
  ...operations.flatMap((operation) => ownSecurity(resolution, operation)),
];

const operationFindingsOf = (resolution: Resolution): readonly Finding[] => {
  const operations = pathItems(resolution).flatMap((item) => operationsOf(resolution, item));

  return [
    ...operations.flatMap((operation) => operationServerFindings(resolution, operation)),
    ...securityFindings(resolution, operations),
  ];
};

const site = (resolution: Resolution, pointer: string) => ({
  document: resolution.document,
  pointer,
});

const operationOf = (operation: Operation) =>
  operation.id === undefined
    ? { method: operation.method, path: operation.item.key }
    : { method: operation.method, operationId: operation.id, path: operation.item.key };

const underItem = (operation: Operation, pointer: string): boolean =>
  operation.item.use !== operation.item.pointer &&
  (pointer === operation.item.pointer || pointer.startsWith(`${operation.item.pointer}/`));

const toDiagnostic = (resolution: Resolution, finding: Finding) => {
  const rule: Rule = rules[finding.code];
  const [row = ""] = finding.code.split("/");
  const { operation } = finding;
  // Under a Reference Object the use site is the pointer and the target is related (design 3.3).
  const viaReference = operation !== undefined && underItem(operation, finding.pointer);
  const declared = isObject(resolution.value) ? resolution.value.openapi : undefined;
  const base = {
    code: finding.code,
    document: resolution.document,
    element: rule.element,
    hint: rule.hint,
    message: rule.message,
    openapi: Predicate.isString(declared) ? declared : patchVersion[resolution.line],
    pointer: viaReference ? operation.item.use : finding.pointer,
    row,
    scope: finding.scope ?? rule.scope,
    severity: finding.severity ?? rule.severity,
    specSection: specSectionUrl(resolution.line, rule.anchor),
  };
  const located = operation === undefined ? base : { ...base, operation: operationOf(operation) };
  const fields = viaReference
    ? { ...located, related: [site(resolution, finding.pointer)] }
    : located;

  return Schema.decodeUnknownEffect(Diagnostic)(fields).pipe(Effect.orDie);
};

/**
 * The spec-text checks on values and grammars (design 3.4 rows 10 to 17): server variables and
 * URLs, security requirement names, media type keys, header-name tokens, discriminators, status
 * keys and patterns, and the 3.0 rows on `items`, `readOnly` and `writeOnly`. Pure over the
 * resolved document; findings are refusals except the 3.0 server default and the pattern notices.
 * Walking allOf, oneOf and anyOf is bounded by `limits.maxNodes` steps; past it the only finding
 * is a document-scope refusal (design 9 I5).
 */
export const checkGrammar = (
  resolution: Resolution,
  limits: Pick<ResolveLimits, "maxNodes"> = defaultLimits,
): Effect.Effect<readonly Diagnostic[]> =>
  Effect.suspend(() => {
    const search = startSearch(resolution, limits.maxNodes);
    const findings = [...elementFindings(resolution), ...operationFindingsOf(resolution)];

    return Effect.all(
      (search.exhausted ? [at("REF-18/node-budget", "")()] : findings).map((finding) =>
        toDiagnostic(resolution, finding),
      ),
    );
  });
