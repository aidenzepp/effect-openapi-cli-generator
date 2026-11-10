import { Array as Arr, Effect, Option, Predicate, Result, Schema } from "effect";
import { HeaderName, MediaRange } from "../model/brands.ts";
import { makeDiagnostic } from "../model/diagnostic.ts";
import { keyOf } from "../resolve/canonical.ts";
import { allOfReferrers, defaultLimits, implicitComponent } from "../resolve/index.ts";
import type { Resolution, ResolveLimits } from "../resolve/index.ts";
import { methodMembers } from "../model/path-item.ts";
import { expressionsOf, locate, operationOf, pathItems, site } from "./path-items.ts";
import type { Operation, PathItem, Place } from "./path-items.ts";
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
  "HDR-13/parameter-only-field": {
    anchor: "header-object",
    element: "Header Object field",
    hint: "Remove allowEmptyValue and allowReserved from the Header Object.",
    message: "A Header Object uses allowEmptyValue or allowReserved, which the text forbids.",
    scope: "document",
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
  "RSS-04/no-response-code": {
    anchor: "responses-object",
    element: "Responses Object",
    hint: "Add a status code, a status range or default.",
    message: "A Responses Object has only x- keys, so it holds no response code.",
    scope: "document",
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
  "SRV-04/duplicate-name": {
    anchor: "server-name",
    element: "Server name",
    hint: "Give each server in a list its own name.",
    message: "A server name is used by an earlier server in the same list.",
    scope: "operation",
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

const statusKey = /^(?:[1-5][0-9]{2}|[1-5]XX|default)$/u;

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

const isToken = Schema.is(HeaderName);

const isMediaRange = Schema.is(MediaRange);

const compilesWithU = (source: string): boolean =>
  Result.isSuccess(Result.try(() => new RegExp(source, "u")));

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

const startSearch = (budget: number): Search => ({
  active: new Map(),
  budget,
  exhausted: false,
  memo: new Map(),
  steps: 0,
});

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

const requires = (resolution: Resolution, search: Search, place: Place, name: string): boolean =>
  requiresAt(resolution, search, place, name, 0).found;

const composes = (node: JsonObject): boolean =>
  ["allOf", "anyOf", "oneOf"].some((keyword) => listOf(node[keyword]).length > 0);

const discriminatorFindings = (
  resolution: Resolution,
  search: Search,
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
  const required = name !== undefined && requires(resolution, search, place, name);
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

const ownSchemaFindings = (
  resolution: Resolution,
  search: Search,
  place: Place,
): readonly Finding[] => {
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
      ? discriminatorFindings(resolution, search, place, node.discriminator)
      : []),
  ];
};

// A 3.0 Reference Object ignores its siblings (design 3.3); later lines keep them as keywords.
const schemaFindings = (
  resolution: Resolution,
  search: Search,
  node: Json | undefined,
  pointer: string,
): readonly Finding[] => {
  if (!isObject(node) || (resolution.line === "3.0" && isReference(node))) {
    return [];
  }

  const below = (token: string, value: Json | undefined): readonly Finding[] =>
    schemaFindings(resolution, search, value, childPointer(pointer, token));

  return [
    ...ownSchemaFindings(resolution, search, { document: resolution.document, node, pointer }),
    ...schemaMembers.flatMap((keyword) => below(keyword, node[keyword])),
    ...schemaLists.flatMap((keyword) =>
      listOf(node[keyword]).flatMap((member, index) =>
        schemaFindings(
          resolution,
          search,
          member,
          childPointer(childPointer(pointer, keyword), String(index)),
        ),
      ),
    ),
    ...schemaMaps.flatMap((keyword) =>
      entriesOf(node[keyword]).flatMap(([name, member]) =>
        schemaFindings(
          resolution,
          search,
          member,
          childPointer(childPointer(pointer, keyword), name),
        ),
      ),
    ),
  ];
};

type HeaderCode = "HDR-01/invalid-header-name" | "RSP-09/invalid-header-name";

// The 3.1 and 3.2 schemas reject both fields on a Header Object; the 3.0 schema permits them.
const headerFieldFindings = (
  resolution: Resolution,
  node: Json | undefined,
  pointer: string,
): readonly Finding[] =>
  resolution.line === "3.0" && isObject(node) && !isReference(node)
    ? (["allowEmptyValue", "allowReserved"] as const)
        .filter((field) => node[field] !== undefined)
        .map((field) => at("HDR-13/parameter-only-field", childPointer(pointer, field))())
    : [];

// Header, Content, Media Type and Encoding objects refer to each other, so they share one record.
interface Media {
  readonly encoding: (
    resolution: Resolution,
    search: Search,
    node: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
  readonly content: (
    resolution: Resolution,
    search: Search,
    content: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
  readonly header: (
    resolution: Resolution,
    search: Search,
    node: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
  readonly headers: (
    resolution: Resolution,
    search: Search,
    headers: Json | undefined,
    pointer: string,
    code: HeaderCode,
  ) => readonly Finding[];
  readonly mediaType: (
    resolution: Resolution,
    search: Search,
    node: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
}

const media: Media = {
  content: (resolution, search, content, pointer) =>
    entriesOf(content).flatMap(([name, mediaType]) => [
      ...(isMediaRange(name)
        ? []
        : [at("MED-24/invalid-media-type", childPointer(pointer, name))()]),
      ...media.mediaType(resolution, search, mediaType, childPointer(pointer, name)),
    ]),
  encoding: (resolution, search, node, pointer) =>
    isObject(node) && !isReference(node)
      ? media.headers(
          resolution,
          search,
          node.headers,
          childPointer(pointer, "headers"),
          "HDR-01/invalid-header-name",
        )
      : [],
  header: (resolution, search, node, pointer) =>
    isObject(node) && !isReference(node)
      ? [
          ...schemaFindings(resolution, search, node.schema, childPointer(pointer, "schema")),
          ...media.content(resolution, search, node.content, childPointer(pointer, "content")),
        ]
      : [],
  headers: (resolution, search, headers, pointer, code) =>
    entriesOf(headers).flatMap(([name, header]) => [
      ...(isToken(name) ? [] : [at(code, childPointer(pointer, name))()]),
      ...headerFieldFindings(resolution, header, childPointer(pointer, name)),
      ...media.header(resolution, search, header, childPointer(pointer, name)),
    ]),
  mediaType: (resolution, search, node, pointer) => {
    if (!isObject(node) || isReference(node)) {
      return [];
    }

    return [
      ...schemaFindings(resolution, search, node.schema, childPointer(pointer, "schema")),
      ...schemaFindings(resolution, search, node.itemSchema, childPointer(pointer, "itemSchema")),
      ...entriesOf(node.encoding).flatMap(([name, encoding]) =>
        media.encoding(
          resolution,
          search,
          encoding,
          childPointer(childPointer(pointer, "encoding"), name),
        ),
      ),
      ...media.encoding(
        resolution,
        search,
        node.itemEncoding,
        childPointer(pointer, "itemEncoding"),
      ),
      ...listOf(node.prefixEncoding).flatMap((encoding, index) =>
        media.encoding(
          resolution,
          search,
          encoding,
          childPointer(childPointer(pointer, "prefixEncoding"), String(index)),
        ),
      ),
    ];
  },
};

const parameterFindings = (
  resolution: Resolution,
  search: Search,
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

  return [...badName, ...media.header(resolution, search, node, pointer)];
};

const parameterListFindings = (
  resolution: Resolution,
  search: Search,
  list: Json | undefined,
  pointer: string,
): readonly Finding[] =>
  listOf(list).flatMap((parameter, index) =>
    parameterFindings(resolution, search, parameter, childPointer(pointer, String(index))),
  );

const responseFindings = (
  resolution: Resolution,
  search: Search,
  node: Json | undefined,
  pointer: string,
): readonly Finding[] =>
  isObject(node) && !isReference(node)
    ? [
        ...media.headers(
          resolution,
          search,
          node.headers,
          childPointer(pointer, "headers"),
          "RSP-09/invalid-header-name",
        ),
        ...media.content(resolution, search, node.content, childPointer(pointer, "content")),
      ]
    : [];

// The 3.1 and 3.2 schemas refuse a Responses Object of `x-` keys alone; the 3.0 schema counts an
// `x-` key toward its one required member (D-OC3).
const extensionsOnly = (resolution: Resolution, responses: Json | undefined): boolean => {
  const keys = entriesOf(responses).map(([code]) => code);

  return (
    resolution.line === "3.0" && keys.length > 0 && keys.every((code) => code.startsWith("x-"))
  );
};

const responsesFindings = (
  resolution: Resolution,
  search: Search,
  responses: Json | undefined,
  pointer: string,
): readonly Finding[] => [
  ...(extensionsOnly(resolution, responses) ? [at("RSS-04/no-response-code", pointer)()] : []),
  ...entriesOf(responses).flatMap(([code, response]) =>
    code.startsWith("x-")
      ? []
      : [
          ...(statusKey.test(code)
            ? []
            : [at("RSS-10/invalid-status", childPointer(pointer, code))()]),
          ...responseFindings(resolution, search, response, childPointer(pointer, code)),
        ],
  ),
];

const requestBodyFindings = (
  resolution: Resolution,
  search: Search,
  node: Json | undefined,
  pointer: string,
): readonly Finding[] =>
  isObject(node) && !isReference(node)
    ? media.content(resolution, search, node.content, childPointer(pointer, "content"))
    : [];

// Path Item, Operation and Callback objects refer to each other through callbacks.
interface Items {
  readonly callback: (
    resolution: Resolution,
    search: Search,
    node: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
  readonly operation: (
    resolution: Resolution,
    search: Search,
    node: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
  readonly pathItem: (
    resolution: Resolution,
    search: Search,
    node: Json | undefined,
    pointer: string,
  ) => readonly Finding[];
}

const items: Items = {
  callback: (resolution, search, node, pointer) =>
    isObject(node) && !isReference(node)
      ? entriesOf(node).flatMap(([key, item]) =>
          key.startsWith("x-")
            ? []
            : items.pathItem(resolution, search, item, childPointer(pointer, key)),
        )
      : [],
  operation: (resolution, search, node, pointer) =>
    isObject(node)
      ? [
          ...parameterListFindings(
            resolution,
            search,
            node.parameters,
            childPointer(pointer, "parameters"),
          ),
          ...requestBodyFindings(
            resolution,
            search,
            node.requestBody,
            childPointer(pointer, "requestBody"),
          ),
          ...responsesFindings(
            resolution,
            search,
            node.responses,
            childPointer(pointer, "responses"),
          ),
          ...entriesOf(node.callbacks).flatMap(([name, callback]) =>
            items.callback(
              resolution,
              search,
              callback,
              childPointer(childPointer(pointer, "callbacks"), name),
            ),
          ),
        ]
      : [],
  pathItem: (resolution, search, node, pointer) => {
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
      ...parameterListFindings(
        resolution,
        search,
        node.parameters,
        childPointer(pointer, "parameters"),
      ),
      ...[...fixed, ...extra].flatMap(([place, operation]) =>
        items.operation(resolution, search, operation, place),
      ),
    ];
  },
};

const componentFindings = (resolution: Resolution, search: Search): readonly Finding[] => {
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
    ...each("schemas", (node, pointer) => schemaFindings(resolution, search, node, pointer)),
    ...each("responses", (node, pointer) => responseFindings(resolution, search, node, pointer)),
    ...each("parameters", (node, pointer) => parameterFindings(resolution, search, node, pointer)),
    ...each("requestBodies", (node, pointer) =>
      requestBodyFindings(resolution, search, node, pointer),
    ),
    ...each("headers", (node, pointer) => [
      ...headerFieldFindings(resolution, node, pointer),
      ...media.header(resolution, search, node, pointer),
    ]),
    ...each("pathItems", (node, pointer) => items.pathItem(resolution, search, node, pointer)),
    ...each("callbacks", (node, pointer) => items.callback(resolution, search, node, pointer)),
    ...each("mediaTypes", (node, pointer) => media.mediaType(resolution, search, node, pointer)),
  ];
};

const elementFindings = (resolution: Resolution, search: Search): readonly Finding[] => {
  const root = isObject(resolution.value) ? resolution.value : {};
  const under = (member: string): readonly Finding[] =>
    entriesOf(root[member]).flatMap(([key, item]) =>
      items.pathItem(resolution, search, item, childPointer(childPointer("", member), key)),
    );

  return [
    ...under("paths"),
    ...(resolution.line === "3.0" ? [] : under("webhooks")),
    ...componentFindings(resolution, search),
  ];
};

const operationsOf = (resolution: Resolution, item: PathItem): readonly Operation[] => {
  const fixed = methodMembers(resolution.line).filter((name) => isObject(item.node[name]));
  const extra =
    resolution.line === "3.2"
      ? entriesOf(item.node.additionalOperations).map(([name]) => name)
      : [];
  const entries = [
    ...fixed.map((name) => [name.toUpperCase(), childPointer(item.pointer, name), false] as const),
    ...extra.map(
      (name) =>
        [
          name,
          childPointer(childPointer(item.pointer, "additionalOperations"), name),
          true,
        ] as const,
    ),
  ];

  return entries.flatMap(([method, pointer, additional]) => {
    const node = nodeAt(resolution.value, pointer);

    return isObject(node)
      ? [{ additional, id: stringMember(node, "operationId"), item, method, node, pointer }]
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
  const names = url === undefined ? [] : expressionsOf(url);
  const repeated = Arr.dedupe(names).length !== names.length;
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

// A 3.2 server name is unique within its list (D-OC3); no schema enforces it.
const duplicateNameFindings = (
  resolution: Resolution,
  servers: readonly (readonly [Json, string])[],
): readonly Finding[] => {
  if (resolution.line !== "3.2") {
    return [];
  }

  const seen = new Set<string>();

  return servers.flatMap(([server, pointer]) => {
    const name = isObject(server) ? stringMember(server, "name") : undefined;
    if (name === undefined) {
      return [];
    }

    if (seen.has(name)) {
      return [at("SRV-04/duplicate-name", childPointer(pointer, "name"))()];
    }

    seen.add(name);

    return [];
  });
};

const operationServerFindings = (
  resolution: Resolution,
  operation: Operation,
): readonly Finding[] => {
  const servers = effectiveServers(resolution, operation);

  return [
    ...servers.flatMap(([server, pointer]) => serverFindings(resolution, server, pointer)),
    ...duplicateNameFindings(resolution, servers),
  ].map((finding) => ({ ...finding, operation }));
};

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

const underItem = (operation: Operation, pointer: string): boolean =>
  operation.item.use !== operation.item.pointer &&
  (pointer === operation.item.pointer || pointer.startsWith(`${operation.item.pointer}/`));

const toDiagnostic = (resolution: Resolution, finding: Finding) => {
  const rule: Rule = rules[finding.code];
  const { operation } = finding;
  // Under a Reference Object the use site is the pointer and the target is related (design 3.3).
  const viaReference = operation !== undefined && underItem(operation, finding.pointer);
  const declared = isObject(resolution.value) ? resolution.value.openapi : undefined;

  return makeDiagnostic({
    code: finding.code,
    document: resolution.document,
    element: rule.element,
    hint: rule.hint,
    message: rule.message,
    openapi: Predicate.isString(declared) ? declared : patchVersion[resolution.line],
    operation: operation === undefined ? undefined : operationOf(operation),
    pointer: viaReference ? operation.item.use : finding.pointer,
    related: viaReference ? [site(resolution, finding.pointer)] : undefined,
    scope: finding.scope ?? rule.scope,
    severity: finding.severity ?? rule.severity,
    specSection: specSectionUrl(resolution.line, rule.anchor),
  });
};

/**
 * The spec-text checks on values and grammars (design 3.4 rows 10 to 17): server variables, URLs
 * and 3.2 names, security requirement names, media type keys, header-name tokens, discriminators,
 * status keys and patterns, and the 3.0 rows the 3.0 schema leaves open: `items`, `readOnly` and
 * `writeOnly`, a Responses Object of `x-` keys alone and Header `allowEmptyValue` or
 * `allowReserved`. Pure over the resolved document; findings are refusals except the 3.0 server
 * default and the pattern notices.
 * Walking allOf, oneOf and anyOf is bounded by `limits.maxNodes` steps; past it the only finding
 * is a document-scope refusal (design 9 I5).
 */
export const checkGrammar = Effect.fnUntraced(function* checkGrammar(
  resolution: Resolution,
  limits: Pick<ResolveLimits, "maxNodes"> = defaultLimits,
) {
  const search = startSearch(limits.maxNodes);
  const findings = [...elementFindings(resolution, search), ...operationFindingsOf(resolution)];
  const reported = search.exhausted ? [at("REF-18/node-budget", "")()] : findings;

  // Effect.forEach takes (items, f); it is not an array method with a thisArg.
  // oxlint-disable-next-line unicorn/no-array-method-this-argument
  return yield* Effect.forEach(reported, (finding) => toDiagnostic(resolution, finding));
});
