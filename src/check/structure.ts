import { Array as Arr, Effect, Option, Predicate, Schema } from "effect";
import { ComponentName, componentNamePattern, MethodToken, PathTemplate } from "../model/brands.ts";
import { makeDiagnostic } from "../model/diagnostic.ts";
import type { Diagnostic } from "../model/diagnostic.ts";
import { keyOf } from "../resolve/canonical.ts";
import type { Resolution } from "../resolve/index.ts";
import { methodMembers } from "../model/path-item.ts";
import { expression, expressionsOf, locate, operationOf, pathItems, site } from "./path-items.ts";
import type { Operation, PathItem } from "./path-items.ts";
import { childPointer } from "../model/pointer.ts";
import { specSectionUrl, patchVersion } from "../model/spec-section.ts";
import { isObject, isArray, nodeAt, stringMember } from "../model/json-tree.ts";
import type { JsonObject } from "../model/json-tree.ts";

interface Rule {
  readonly anchor: string;
  readonly element: string;
  readonly hint?: string;
  readonly message: string;
  readonly scope: "document" | "operation";
}

const rules = {
  "CMP-13/invalid-key": {
    anchor: "components-object",
    element: "Component key",
    hint: "Use only letters, digits, '.', '-' and '_' in component keys.",
    message: `A component key is outside ${componentNamePattern.source}.`,
    scope: "document",
  },
  "OPR-07/duplicate-id": {
    anchor: "operation-object",
    element: "operationId",
    hint: "Give each operation its own operationId.",
    message: "An operationId is used by more than one operation.",
    scope: "document",
  },
  "PTH-03/missing-parameter": {
    anchor: "path-templating",
    element: "Path template expression",
    hint: "Declare a path parameter with the expression's exact name.",
    message: "A path template expression has no path parameter.",
    scope: "operation",
  },
  "PTH-04/template-identical": {
    anchor: "path-templating-matching",
    element: "Path key",
    hint: "Keep one of the paths, or make their templates differ.",
    message: "Another path differs from this one only in its expression names.",
    scope: "operation",
  },
  "PTH-07/invalid-path-key": {
    anchor: "path-templating",
    element: "Path key",
    hint: "Write the path as an absolute path-template: percent-encode reserved characters.",
    message: "The path key is outside the OpenAPI path-template grammar.",
    scope: "operation",
  },
  "PTH-07/repeated-expression": {
    anchor: "path-templating",
    element: "Path key",
    hint: "Use each template expression once per path.",
    message: "A template expression appears more than once in the path key.",
    scope: "operation",
  },
  "PTH-08/missing-expression": {
    anchor: "path-templating",
    element: "Path parameter",
    hint: "Add the parameter's name to the path as an expression, or remove the parameter.",
    message: "A path parameter has no expression in the path key.",
    scope: "operation",
  },
  "PTH-11/ref-sibling-conflict": {
    anchor: "path-item-ref",
    element: "Path Item $ref",
    hint: "Keep each field in one of the two Path Item Objects.",
    message:
      "A Path Item $ref has a sibling field the referenced Path Item also defines; which applies is undefined.",
    scope: "document",
  },
  "PTH-23/method-not-allowed": {
    anchor: "path-item-object",
    element: "additionalOperations key",
    hint: "Use a method token from the supported set, in its exact capitalization.",
    message: "The additionalOperations key is not a supported HTTP method token.",
    scope: "operation",
  },
  "PTH-24/fixed-method-key": {
    anchor: "path-item-object",
    element: "additionalOperations key",
    hint: "Move the operation to its fixed Path Item field.",
    message: "The additionalOperations key equals a method the Path Item Object has a field for.",
    scope: "operation",
  },
  "PTH-28/duplicate-parameter": {
    anchor: "operation-object",
    element: "Parameter",
    hint: "List each (name, in) pair once; header names compare case-insensitively.",
    message: "A parameter list repeats a name and location.",
    scope: "operation",
  },
  "STY-44/querystring-conflict": {
    anchor: "parameter-object",
    element: "Parameter",
    hint: "Use one querystring parameter and no query parameters.",
    message: "A querystring parameter appears more than once or beside a query parameter.",
    scope: "operation",
  },
} as const satisfies Record<string, Rule>;

type Code = keyof typeof rules;

interface Finding {
  readonly code: Code;
  readonly operation?: Operation;
  readonly pointer: string;
  readonly related?: readonly string[];
}

interface Parameter {
  readonly in: string;
  readonly name: string;
  readonly pointer: string;
}

const isComponentName = Schema.is(ComponentName);

const sections30 = [
  "schemas",
  "responses",
  "parameters",
  "examples",
  "requestBodies",
  "headers",
  "securitySchemes",
  "links",
  "callbacks",
] as const;

const componentSections = {
  "3.0": sections30,
  "3.1": [...sections30, "pathItems"],
  "3.2": [...sections30, "pathItems", "mediaTypes"],
} as const;

const operationsOf = (resolution: Resolution, item: PathItem): readonly Operation[] => {
  const members = methodMembers(resolution.line);
  const fixed = Object.keys(item.node).filter((name) => members.includes(name));
  const extra = item.node.additionalOperations;
  const additional =
    resolution.line === "3.2" && isObject(extra)
      ? Object.keys(extra).map(
          (name) =>
            [name, childPointer(childPointer(item.pointer, "additionalOperations"), name)] as const,
        )
      : [];
  const entries = [
    ...fixed.map((name) => [name, childPointer(item.pointer, name), false] as const),
    ...additional.map(([name, pointer]) => [name, pointer, true] as const),
  ];

  return entries.flatMap(([name, pointer, additionalKey]) => {
    const node = nodeAt(resolution.value, pointer);

    return isObject(node)
      ? [
          {
            additional: additionalKey,
            id: stringMember(node, "operationId"),
            item,
            method: additionalKey ? name : name.toUpperCase(),
            node,
            pointer,
          },
        ]
      : [];
  });
};

const parametersOf = (
  resolution: Resolution,
  owner: JsonObject,
  ownerPointer: string,
): readonly Parameter[] => {
  const list = owner.parameters;
  if (!isArray(list)) {
    return [];
  }

  return list.flatMap((entry, index) => {
    const pointer = childPointer(childPointer(ownerPointer, "parameters"), String(index));
    const located = locate(resolution, site(resolution, pointer), entry);
    const name = located === undefined ? undefined : stringMember(located.node, "name");
    const location = located === undefined ? undefined : stringMember(located.node, "in");

    return name === undefined || location === undefined ? [] : [{ in: location, name, pointer }];
  });
};

const keyOfParameter = (parameter: Parameter): string =>
  `${parameter.in}\u0000${parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name}`;

// Path-item parameters first, an operation's parameter replacing the one it overrides.
const effectiveParameters = (
  resolution: Resolution,
  operation: Operation,
): readonly Parameter[] => {
  const merged = new Map<string, Parameter>();
  const lists = [
    parametersOf(resolution, operation.item.node, operation.item.pointer),
    parametersOf(resolution, operation.node, operation.pointer),
  ];
  for (const parameter of lists.flat()) {
    merged.set(keyOfParameter(parameter), parameter);
  }

  return [...merged.values()];
};

const duplicates = (
  parameters: readonly Parameter[],
): readonly (readonly [Parameter, Parameter])[] => {
  const seen = new Map<string, Parameter>();
  const pairs: (readonly [Parameter, Parameter])[] = [];
  for (const parameter of parameters) {
    const first = seen.get(keyOfParameter(parameter));
    if (first === undefined) {
      seen.set(keyOfParameter(parameter), parameter);
    } else {
      pairs.push([first, parameter]);
    }
  }

  return pairs;
};

const normalizedTemplate = (key: string): string => key.replaceAll(expression, "{}");

// A sibling of a Path Item `$ref` that the target also defines leaves the result undefined (D-OC6,
// DOC-16). The target may sit in any document of the set.
const refSiblingFindings = (resolution: Resolution): readonly Finding[] => {
  const paths = isObject(resolution.value) ? resolution.value.paths : undefined;

  return Object.entries(isObject(paths) ? paths : {}).flatMap(([key, value]) => {
    const use = childPointer("/paths", key);
    const referenced = resolution.references.has(
      keyOf({ document: resolution.document, pointer: use }),
    );
    const target = referenced ? locate(resolution, site(resolution, use), value) : undefined;
    if (!isObject(value) || target === undefined) {
      return [];
    }

    const shared = Object.keys(value).filter(
      (member) => member !== "$ref" && Object.hasOwn(target.node, member),
    );

    return shared.length === 0
      ? []
      : [
          {
            code: "PTH-11/ref-sibling-conflict",
            pointer: use,
            related: shared.map((member) => childPointer(use, member)),
          },
        ];
  });
};

const componentFindings = (resolution: Resolution): readonly Finding[] => {
  const components = isObject(resolution.value) ? resolution.value.components : undefined;
  if (!isObject(components)) {
    return [];
  }

  return componentSections[resolution.line].flatMap((section) => {
    const map = components[section];

    return isObject(map)
      ? Object.keys(map)
          .filter((name) => !isComponentName(name))
          .map((name): Finding => ({
            code: "CMP-13/invalid-key",
            pointer: childPointer(childPointer("/components", section), name),
          }))
      : [];
  });
};

const duplicateIdFindings = (operations: readonly Operation[]): readonly Finding[] => {
  const first = new Map<string, string>();
  const found: Finding[] = [];
  for (const operation of operations) {
    if (operation.id !== undefined) {
      const pointer = childPointer(operation.pointer, "operationId");
      const earlier = first.get(operation.id);
      if (earlier === undefined) {
        first.set(operation.id, pointer);
      } else {
        found.push({ code: "OPR-07/duplicate-id", pointer, related: [earlier] });
      }
    }
  }

  return found;
};

const isMethodToken = Schema.is(MethodToken);

const additionalKeyFindings = (operation: Operation): readonly Finding[] => {
  if (!operation.additional) {
    return [];
  }

  if (methodMembers("3.2").includes(operation.method.toLowerCase())) {
    return [{ code: "PTH-24/fixed-method-key", operation, pointer: operation.pointer }];
  }

  return isMethodToken(operation.method)
    ? []
    : [{ code: "PTH-23/method-not-allowed", operation, pointer: operation.pointer }];
};

const templateFindings = (
  operation: Operation,
  parameters: readonly Parameter[],
  twins: readonly string[],
): readonly Finding[] => {
  const { key } = operation.item;
  const at = (code: Code, pointer: string, related: readonly string[] = []): Finding => ({
    code,
    operation,
    pointer,
    related,
  });
  const found = twins.map((twin) => at("PTH-04/template-identical", operation.pointer, [twin]));
  const names = expressionsOf(key);
  if (Option.isNone(Schema.decodeUnknownOption(PathTemplate)(key))) {
    return [...found, at("PTH-07/invalid-path-key", operation.pointer)];
  }

  const distinct = Arr.dedupe(names);
  const declared = new Map(
    parameters
      .filter((parameter) => parameter.in === "path")
      .map((parameter) => [parameter.name, parameter]),
  );

  return [
    ...found,
    ...(distinct.length === names.length
      ? []
      : [at("PTH-07/repeated-expression", operation.pointer)]),
    ...distinct
      .filter((name) => !declared.has(name))
      .map(() => at("PTH-03/missing-parameter", operation.pointer)),
    ...[...declared.entries()]
      .filter(([name]) => !distinct.includes(name))
      .map(([, parameter]) => at("PTH-08/missing-expression", parameter.pointer)),
  ];
};

const listFindings = (resolution: Resolution, operation: Operation): readonly Finding[] => {
  const lists = [
    parametersOf(resolution, operation.item.node, operation.item.pointer),
    parametersOf(resolution, operation.node, operation.pointer),
  ];

  return lists.flatMap((list) =>
    duplicates(list).map(([first, second]): Finding => ({
      code: "PTH-28/duplicate-parameter",
      operation,
      pointer: second.pointer,
      related: [first.pointer],
    })),
  );
};

const querystringFindings = (
  operation: Operation,
  parameters: readonly Parameter[],
): readonly Finding[] => {
  const strings = parameters.filter((parameter) => parameter.in === "querystring");
  const queries = parameters.filter((parameter) => parameter.in === "query");
  const conflict = strings.length > 1 || (strings.length > 0 && queries.length > 0);

  return conflict
    ? [
        {
          code: "STY-44/querystring-conflict",
          operation,
          pointer: operation.pointer,
          related: [...strings, ...queries].map((parameter) => parameter.pointer),
        },
      ]
    : [];
};

const operationFindings = (
  resolution: Resolution,
  operation: Operation,
  twins: readonly string[],
): readonly Finding[] => {
  const parameters = effectiveParameters(resolution, operation);

  return [
    ...templateFindings(operation, parameters, twins),
    ...listFindings(resolution, operation),
    ...querystringFindings(operation, parameters),
    ...additionalKeyFindings(operation),
  ];
};

const findingsOf = (resolution: Resolution): readonly Finding[] => {
  const items = pathItems(resolution);
  const byTemplate = new Map<string, PathItem[]>();
  for (const item of items) {
    const template = normalizedTemplate(item.key);
    byTemplate.set(template, [...(byTemplate.get(template) ?? []), item]);
  }

  const operations = items.flatMap((item) => operationsOf(resolution, item));
  const twinsOf = (item: PathItem): readonly string[] =>
    (byTemplate.get(normalizedTemplate(item.key)) ?? [])
      .filter((other) => other.use !== item.use)
      .map((other) => other.use);

  return [
    ...componentFindings(resolution),
    ...refSiblingFindings(resolution),
    ...operations.flatMap((operation) =>
      operationFindings(resolution, operation, twinsOf(operation.item)),
    ),
    ...duplicateIdFindings(operations),
  ];
};

const toDiagnostic = (resolution: Resolution, finding: Finding) => {
  const rule: Rule = rules[finding.code];
  const { operation } = finding;
  // Under a Reference Object the use site is the pointer and the target is related (design 3.3).
  const viaReference = operation !== undefined && operation.item.use !== operation.item.pointer;
  const related = [...(viaReference ? [finding.pointer] : []), ...(finding.related ?? [])];
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
    related: related.length === 0 ? undefined : related.map((pointer) => site(resolution, pointer)),
    scope: rule.scope,
    severity: "refusal",
    specSection: specSectionUrl(resolution.line, rule.anchor),
  });
};

/**
 * The spec-text checks on document, path and operation structure (design 3.4 rows 1 to 9): the
 * rules no schema expresses. Pure over the resolved document; every finding is a refusal.
 */
export const checkStructure = (resolution: Resolution): Effect.Effect<readonly Diagnostic[]> =>
  Effect.all(findingsOf(resolution).map((finding) => toDiagnostic(resolution, finding)));
