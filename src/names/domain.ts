import { Array as Arr, Order, Result, Schema } from "effect";
import { SafeIdentifier, foldIdentifier } from "./fold.ts";
import type { SafeIdentifierValue } from "./fold.ts";
import { suffixed } from "./plan.ts";

/**
 * The names a cli module imports by name from packages, as [name, module specifier]: the one list
 * the cli emitter writes those imports from and the names plan reserves from.
 */
export const packageImports: readonly (readonly [string, string])[] = [
  ["Effect", "effect"],
  ["Layer", "effect"],
  ["Option", "effect"],
  ["Schema", "effect"],
  ["Argument", "effect/cli"],
  ["Command", "effect/cli"],
  ["Flag", "effect/cli"],
];

/**
 * The runtime namespaces a cli module imports, as [name, module path]: the one list the cli
 * emitter writes its imports from and the names plan reserves from.
 */
export const runtimeNamespaces: readonly (readonly [string, string])[] = [
  ["Auth", "../runtime/auth.ts"],
  ["BaseUrl", "../runtime/base-url.ts"],
  ["Describe", "../runtime/describe.ts"],
  ["Input", "../runtime/input.ts"],
  ["Multipart", "../runtime/multipart.ts"],
  ["Negotiate", "../runtime/negotiate.ts"],
  ["Output", "../runtime/output.ts"],
  ["Serialize", "../runtime/serialize.ts"],
];

/**
 * The namespaces `cli/root.ts` imports besides the fixed ones, as [name, module specifier]: the
 * `Groups` runtime namespace and the `Arr` array namespace of the lazy root, and the `Client`
 * runtime namespace whose timeout, retry and verbose settings only the root registers.
 */
export const rootNamespaceImports: readonly (readonly [string, string])[] = [
  ["Arr", "effect/Array"],
  ["Client", "../runtime/client.ts"],
  ["Groups", "../runtime/groups.ts"],
];

/**
 * The names every cli module imports besides its domain schemas and api namespaces: every
 * package import and every runtime namespace. No planned module-level name takes one.
 */
export const fixedNamespaces: ReadonlySet<string> = new Set([
  ...packageImports.map(([name]) => name),
  ...runtimeNamespaces.map(([name]) => name),
]);

/**
 * The names `cli/root.ts` holds besides the fixed namespaces: its own namespace imports, the
 * `services` layer it defines, the `servers` and `security` tables it reads from
 * `api/servers.ts` and `api/security.ts`, and the lazy root's `table` of group loaders, `root`
 * function and its `args` and `groups` parameters.
 */
export const rootModuleNames: ReadonlySet<string> = new Set([
  ...rootNamespaceImports.map(([name]) => name),
  "args",
  "groups",
  "root",
  "security",
  "servers",
  "services",
  "table",
]);

// `domain/schemas.ts` imports `Schema`; a cli module imports the fixed namespaces beside the
// domain names it reads, and `cli/root.ts` also its own names. Keywords, predefined types and
// globals never get here: the fold suffixes them with `_`.
const reserved: ReadonlySet<string> = new Set([...fixedNamespaces, ...rootModuleNames]);

// The base of a key with no letters or digits to fold.
const unnamed = "Definition";

const toIdentifier = Schema.decodeSync(SafeIdentifier);

/**
 * The export name of every schema key in `domain/schemas.ts`, the one owner of those names: the
 * names plan imports them and the domain emitter checks Effect's output against them. Keys go in
 * code-point order; each folds to Pascal case, and a fold that is reserved (`Schema`, the fixed
 * cli imports, the `cli/root.ts` names) or already taken gets the first
 * free numeric suffix from 2. The same keys always give the same names, whatever their input
 * order.
 */
export const domainIdentifiers = (
  keys: Iterable<string>,
): ReadonlyMap<string, SafeIdentifierValue> => {
  const assigned = new Set<string>();
  const taken = (candidate: string): boolean => reserved.has(candidate) || assigned.has(candidate);
  const identifiers = new Map<string, SafeIdentifierValue>();
  for (const key of Arr.sort(Arr.dedupe([...keys]), Order.String)) {
    const folded = foldIdentifier(key, "pascal");
    const base = Result.isSuccess(folded) ? folded.success.name : unnamed;
    const identifier = taken(base) ? toIdentifier(suffixed(base, taken)) : toIdentifier(base);
    assigned.add(identifier);
    identifiers.set(key, identifier);
  }

  return identifiers;
};
