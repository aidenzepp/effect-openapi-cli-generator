import { Array as Arr, Effect, Order, Predicate } from "effect";
import { referenceAt } from "../../src/resolve/index.ts";
import type { Resolution } from "../../src/resolve/index.ts";
import { escapeToken, evaluatePointer } from "../../src/model/pointer.ts";
import type { Json, PointerEvalError, PointerSyntaxError } from "../../src/model/pointer.ts";
import { isObject, isArray } from "../../src/model/json-tree.ts";

type Document = Resolution["document"];

interface Site {
  readonly document: Document;
  readonly pointer: string;
}

/**
 * One request-affecting element at the outline level (design 8.3, R11), named by its use site: the
 * pointer is the path the element is reached by in the entry document, never the target of a
 * `$ref` it passes through.
 */
export type WalkElement =
  | (Site & {
      readonly kind: "operation";
      readonly method: string;
      readonly path: string;
      /**
       * The pointers, sorted, of the elements outside the operation that it takes: path-item
       * parameters it does not override by `(name, in)`, the path item's servers or else the
       * root's when it declares none, and the root security alternatives when it has no
       * `security` key.
       */
      readonly inherits: readonly string[];
      /**
       * No level (operation, path item, root) has a `servers` key, so the default `/` applies.
       */
      readonly defaultServer: boolean;
    })
  | (Site & { readonly kind: "parameter"; readonly in: string; readonly name: string })
  | (Site & { readonly kind: "requestMedia"; readonly mediaType: string })
  | (Site & { readonly kind: "response"; readonly key: string })
  | (Site & { readonly kind: "securityAlternative"; readonly schemes: readonly string[] })
  | (Site & { readonly kind: "server"; readonly url: string });

export type WalkError = PointerEvalError | PointerSyntaxError;

const member = (node: Json | undefined, key: string): Json | undefined =>
  isObject(node) ? node[key] : undefined;

// Own members in document order; a non-object has none.
const entries = (node: Json | undefined): readonly (readonly [string, Json])[] =>
  isObject(node) ? Object.entries(node) : [];

const items = (node: Json | undefined): readonly Json[] => (isArray(node) ? node : []);

const text = (node: Json | undefined): string | undefined =>
  Predicate.isString(node) ? node : undefined;

// Operation members of a path item (3.0 to 3.2). Callbacks and webhooks are not walked.
const methods: ReadonlySet<string> = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "query",
  "trace",
]);

const child = (pointer: string, ...tokens: readonly string[]): string =>
  `${pointer}${tokens.map((token) => `/${escapeToken(token)}`).join("")}`;

const byPointer = Order.mapInput(Order.String, (element: WalkElement) => element.pointer);

type Parameter = Extract<WalkElement, { readonly kind: "parameter" }>;

// Header names compare case-insensitively (design 2.2); every other location exactly.
const sameParameter = (left: Parameter, right: Parameter): boolean =>
  left.in === right.in &&
  (left.in === "header"
    ? left.name.toLowerCase() === right.name.toLowerCase()
    : left.name === right.name);

const isParameter = (element: WalkElement): element is Parameter => element.kind === "parameter";

// What an operation may take from outside itself: its path item's parameters, and the servers and
// security of the levels above it. `servers` is undefined when no level above has a `servers` key.
interface Inheritance {
  readonly parameters: readonly Parameter[];
  readonly security: readonly WalkElement[];
  readonly servers: readonly WalkElement[] | undefined;
}

/**
 * Lists the request-affecting elements of a resolved document: operations, `(name, in)`
 * parameters, request media, response keys, security alternatives and servers, each at its use
 * site, sorted by pointer. A `$ref` is followed only to read the object it stands for. The walker
 * imports the loader and resolver only, so it shares nothing with the model it checks.
 */
export const walk = (resolution: Resolution): Effect.Effect<readonly WalkElement[], WalkError> => {
  const { document } = resolution;
  const at = (pointer: string): Site => ({ document, pointer });

  // The object at a use site, through the reference there if there is one.
  const deref = (
    pointer: string,
    node: Json | undefined,
  ): Effect.Effect<Json | undefined, WalkError> => {
    const reference = referenceAt(resolution, pointer);

    return reference === undefined
      ? Effect.succeed(node)
      : evaluatePointer(resolution.value, reference.target.pointer);
  };

  const parameter = (
    pointer: string,
    node: Json,
  ): Effect.Effect<readonly WalkElement[], WalkError> =>
    deref(pointer, node).pipe(
      Effect.map((target): readonly WalkElement[] => {
        const name = text(member(target, "name"));
        const where = text(member(target, "in"));

        return name === undefined || where === undefined
          ? []
          : [{ ...at(pointer), in: where, kind: "parameter", name }];
      }),
    );

  const parameters = (
    owner: string,
    node: Json | undefined,
  ): Effect.Effect<readonly WalkElement[], WalkError> =>
    Effect.forEach(items(node), (entry, index) =>
      parameter(child(owner, "parameters", String(index)), entry),
    ).pipe(Effect.map(Arr.flatten));

  const servers = (owner: string, node: Json | undefined): readonly WalkElement[] =>
    Arr.flatMap(items(node), (entry, index): readonly WalkElement[] => {
      const url = text(member(entry, "url"));

      return url === undefined
        ? []
        : [{ ...at(child(owner, "servers", String(index))), kind: "server", url }];
    });

  const security = (owner: string, node: Json | undefined): readonly WalkElement[] =>
    Arr.map(items(node), (entry, index): WalkElement => ({
      ...at(child(owner, "security", String(index))),
      kind: "securityAlternative",
      schemes: Arr.sort(Object.keys(isObject(entry) ? entry : {}), Order.String),
    }));

  const requestMedia = (
    owner: string,
    node: Json | undefined,
  ): Effect.Effect<readonly WalkElement[], WalkError> =>
    deref(child(owner, "requestBody"), member(node, "requestBody")).pipe(
      Effect.map((body) =>
        Arr.map(entries(member(body, "content")), ([mediaType]): WalkElement => ({
          ...at(child(owner, "requestBody", "content", mediaType)),
          kind: "requestMedia",
          mediaType,
        })),
      ),
    );

  const operation = (
    path: string,
    owner: string,
    method: string,
    node: Json,
    above: Inheritance,
  ): Effect.Effect<readonly WalkElement[], WalkError> =>
    Effect.all([parameters(owner, member(node, "parameters")), requestMedia(owner, node)]).pipe(
      Effect.map(([own, media]): readonly WalkElement[] => [
        {
          ...at(owner),
          defaultServer: above.servers === undefined && member(node, "servers") === undefined,
          inherits: Arr.sort(
            [
              ...above.parameters.filter(
                (shared) => !own.filter(isParameter).some((mine) => sameParameter(mine, shared)),
              ),
              ...(member(node, "security") === undefined ? above.security : []),
              ...(member(node, "servers") === undefined ? (above.servers ?? []) : []),
            ].map((element) => element.pointer),
            Order.String,
          ),
          kind: "operation",
          method,
          path,
        },
        ...own,
        ...media,
        ...Arr.map(entries(member(node, "responses")), ([key]): WalkElement => ({
          ...at(child(owner, "responses", key)),
          key,
          kind: "response",
        })),
        ...security(owner, member(node, "security")),
        ...servers(owner, member(node, "servers")),
      ]),
    );

  const root = resolution.value;
  const rootSecurity = security("", member(root, "security"));
  const rootServers =
    member(root, "servers") === undefined ? undefined : servers("", member(root, "servers"));

  const pathItem = (
    path: string,
    owner: string,
    node: Json | undefined,
  ): Effect.Effect<readonly WalkElement[], WalkError> =>
    deref(owner, node).pipe(
      Effect.flatMap((item) => {
        const itemServers =
          member(item, "servers") === undefined
            ? undefined
            : servers(owner, member(item, "servers"));

        return parameters(owner, member(item, "parameters")).pipe(
          Effect.flatMap((shared) =>
            Effect.forEach(
              Arr.filter(entries(item), ([method]) => methods.has(method)),
              ([method, value]) =>
                operation(path, child(owner, method), method, value, {
                  parameters: shared.filter(isParameter),
                  security: rootSecurity,
                  servers: itemServers ?? rootServers,
                }),
            ).pipe(
              Effect.map((operations): readonly WalkElement[] => [
                ...shared,
                ...Arr.flatten(operations),
                ...(itemServers ?? []),
              ]),
            ),
          ),
        );
      }),
    );

  return Effect.forEach(entries(member(root, "paths")), ([path, node]) =>
    pathItem(path, child("", "paths", path), node),
  ).pipe(
    Effect.map((found) =>
      Arr.sort([...Arr.flatten(found), ...rootSecurity, ...(rootServers ?? [])], byPointer),
    ),
  );
};
