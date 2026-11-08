import { Effect, Schema } from "effect";
import { printJson } from "../emit/printer.ts";
import { JsonLiteral } from "../model/brands.ts";
import type { Diagnostic } from "../model/diagnostic.ts";
import type { CommandNameSource as CommandNameSourceSchema } from "./index.ts";
import { Verdict } from "../model/verdict.ts";

export type VerdictValue = typeof Verdict.Type;

export type VerdictClass = VerdictValue["verdict"];

/**
 * What one corpus run knows about a pinned specification. `diagnostics` arrive already in
 * diagnostic order (design 3.7); the verdict keeps that order. `operations.refused` is derived, so
 * the three operation counts cannot disagree.
 */
export interface VerdictInput {
  // The report's `commandNames`, by the source of each command name.
  readonly commandNames: readonly { readonly command: CommandNameSource }[];
  readonly corpusVersion: number;
  readonly coverage: VerdictValue["coverage"];
  readonly diagnostics: readonly Diagnostic[];
  readonly generator: VerdictValue["generator"];
  readonly informational: number;
  // The report's `nonStandard` entries; only their choice, pointer and row reach the verdict.
  readonly nonStandard: VerdictValue["nonStandard"];
  readonly operations: { readonly generated: number; readonly total: number };
  readonly spec: VerdictValue["spec"];
  readonly twinEquality: VerdictValue["twinEquality"];
}

/**
 * The sources a command name can come from: the report's `CommandNameSource`.
 */
export type CommandNameSource = typeof CommandNameSourceSchema.Type;

type CommandSources = VerdictValue["commandSources"];

const sourceBucket: Record<CommandNameSource, keyof CommandSources> = {
  config: "config",
  operationId: "fold",
  route: "fold",
  "x-fern": "fern",
  "x-forge": "forge",
};

const countSources = (names: VerdictInput["commandNames"]): CommandSources => {
  const counts = { config: 0, fern: 0, fold: 0, forge: 0 };
  for (const { command } of names) {
    counts[sourceBucket[command]] += 1;
  }

  return counts;
};

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
 * refusal and notice listed in the order given. Non-standard entries are counted and listed but
 * never change the class.
 */
export const makeVerdict = (input: VerdictInput): VerdictValue => {
  const { diagnostics } = input;
  const notices = diagnostics.filter((diagnostic) => !isRefusal(diagnostic));

  return {
    commandSources: countSources(input.commandNames),
    corpusVersion: input.corpusVersion,
    counts: {
      informational: input.informational,
      nonStandard: input.nonStandard.length,
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
    nonStandard: input.nonStandard.map(({ choice, pointer, row }) => ({ choice, pointer, row })),
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
