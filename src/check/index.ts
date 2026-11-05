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
export const checkSpecText = (resolution: Resolution): Effect.Effect<readonly Diagnostic[]> =>
  Effect.all([checkStructure(resolution), checkGrammar(resolution)]).pipe(
    Effect.map(([structure, grammar]) =>
      sortDiagnostics([resolution.document], [...structure, ...grammar]),
    ),
  );
