import { Effect, Schema } from "effect";
import { printJson } from "../emit/printer.ts";
import { JsonLiteral } from "../model/brands.ts";
import type { Diagnostic } from "../model/diagnostic.ts";
import { Verdict } from "../model/verdict.ts";

export type VerdictValue = typeof Verdict.Type;

export type VerdictClass = VerdictValue["verdict"];

/**
 * What one corpus run knows about a pinned specification. `diagnostics` arrive already in
 * diagnostic order (design 3.7); the verdict keeps that order. `operations.refused` is derived, so
 * the three operation counts cannot disagree.
 */
export interface VerdictInput {
  readonly corpusVersion: number;
  readonly coverage: VerdictValue["coverage"];
  readonly diagnostics: readonly Diagnostic[];
  readonly generator: VerdictValue["generator"];
  readonly informational: number;
  readonly operations: { readonly generated: number; readonly total: number };
  readonly spec: VerdictValue["spec"];
  readonly twinEquality: VerdictValue["twinEquality"];
}

const isRefusal = (diagnostic: Diagnostic): boolean => diagnostic.severity === "refusal";

const refusalsOfScope = (diagnostics: readonly Diagnostic[], scope: Diagnostic["scope"]): number =>
  diagnostics.filter((diagnostic) => isRefusal(diagnostic) && diagnostic.scope === scope).length;

/**
 * Design 8.2: `refused` when any document refusal exists, `partly-refused` when any other refusal
 * exists (the CLI was emitted), otherwise `accepted`. Notices never change the class.
 */
export const classifyVerdict = (diagnostics: readonly Diagnostic[]): VerdictClass => {
  if (refusalsOfScope(diagnostics, "document") > 0) {
    return "refused";
  }

  return diagnostics.some(isRefusal) ? "partly-refused" : "accepted";
};

/**
 * Builds the verdict value (design 8.2) from a diagnostic list: counts, the class, and every
 * refusal and notice listed in the order given.
 */
export const makeVerdict = (input: VerdictInput): VerdictValue => {
  const { diagnostics } = input;
  const notices = diagnostics.filter((diagnostic) => !isRefusal(diagnostic));

  return {
    corpusVersion: input.corpusVersion,
    counts: {
      informational: input.informational,
      notices: notices.length,
      operations: {
        generated: input.operations.generated,
        refused: input.operations.total - input.operations.generated,
        total: input.operations.total,
      },
      refusals: {
        document: refusalsOfScope(diagnostics, "document"),
        element: refusalsOfScope(diagnostics, "element"),
        operation: refusalsOfScope(diagnostics, "operation"),
      },
    },
    coverage: input.coverage,
    generator: input.generator,
    notices: notices.map(({ code, pointer, row }) => ({ code, pointer, row })),
    refusals: diagnostics.filter(isRefusal).map(({ code, pointer, row, scope }) => ({
      code,
      pointer,
      row,
      scope,
    })),
    spec: input.spec,
    twinEquality: input.twinEquality,
    verdict: classifyVerdict(diagnostics),
  };
};

/**
 * Prints the verdict file: the value is encoded through the `Verdict` schema, so an invalid count
 * or digest fails here, then written in the `docs/printer.md` JSON layout that `vp fmt --check`
 * accepts, with sorted keys and a final newline.
 */
export const printVerdict = (verdict: VerdictValue): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(Verdict)(verdict).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(JsonLiteral)),
    Effect.map(printJson),
  );
