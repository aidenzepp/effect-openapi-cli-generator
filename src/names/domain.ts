import { Array as Arr, Order, Result, Schema } from "effect";
import { SafeIdentifier, foldIdentifier } from "./fold.ts";
import type { SafeIdentifierValue } from "./fold.ts";
import { suffixed } from "./plan.ts";

/**
 * The names every cli module imports besides its domain schemas.
 */
export const fixedNamespaces: ReadonlySet<string> = new Set([
  "Argument",
  "Command",
  "Describe",
  "Effect",
  "Flag",
  "Input",
  "Negotiate",
  "Option",
  "Output",
  "Serialize",
]);

/**
 * The names `cli/root.ts` holds besides the slice's fixed namespaces: the `services` layer it
 * defines (`Layer.mergeAll` of `BaseUrl`, `Auth` and `Input` layers) and the `servers` and
 * `security` tables it reads from `api/servers.ts` and `api/security.ts`.
 */
export const rootModuleNames: ReadonlySet<string> = new Set([
  "Auth",
  "BaseUrl",
  "Layer",
  "security",
  "servers",
  "services",
]);

// `domain/schemas.ts` imports `Schema`; a cli module imports the fixed namespaces beside the
// domain names it reads, and `cli/root.ts` also its own names. Keywords, predefined types and
// globals never get here: the fold suffixes them with `_`.
const reserved: ReadonlySet<string> = new Set(["Schema", ...fixedNamespaces, ...rootModuleNames]);

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
