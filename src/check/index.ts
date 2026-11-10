import { Effect } from "effect";
import type { Diagnostic } from "../model/diagnostic.ts";
import { sortDiagnostics } from "../model/diagnostic.ts";
import type { Resolution } from "../resolve/index.ts";
import { checkGrammar } from "./grammar.ts";
import { checkStructure } from "./structure.ts";

/**
 * Every spec-text check (design 3.4): structure, then values and grammars, in document order
 * (pointer, then code). Pure over the resolved document.
 */
export const checkSpecText = Effect.fn("check.checkSpecText")(function* checkSpecText(
  resolution: Resolution,
): Effect.fn.Return<readonly Diagnostic[]> {
  const [structure, grammar] = yield* Effect.all([
    checkStructure(resolution),
    checkGrammar(resolution),
  ]);

  return sortDiagnostics([resolution.document], [...structure, ...grammar]);
});
