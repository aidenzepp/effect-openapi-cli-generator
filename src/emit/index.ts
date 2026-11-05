import { Array as Arr, Effect, Order } from "effect";
import { emitEntryFiles } from "./entry.ts";
import { emitPackageFiles } from "./package.ts";
import type { EmittedFile, GeneratorSource, PackageEmitError } from "./package.ts";
import type { PrinterError } from "./printer.ts";
import { emitReadme } from "./readme.ts";
import type { ReadmeInput } from "./readme.ts";
import { runtimeFiles } from "./runtime-files.generated.ts";

/**
 * What the scaffold is emitted from: the README input and the generator's own manifest and
 * compiler options.
 */
export interface ScaffoldInput extends ReadmeInput {
  readonly generator: GeneratorSource;
}

const byPath = Order.mapInput(Order.String, (file: EmittedFile) => file.path);

// `domain/errors.ts` and `runtime/*` from the build-time embed, copied verbatim under `src/`.
const runtime: readonly EmittedFile[] = Object.entries(runtimeFiles).map(([key, content]) => ({
  content,
  path: `src/${key}`,
}));

/**
 * Emits the package scaffold (design 4.1, 4.2, 4.3): `package.json` and both tsconfigs,
 * `src/bin.ts` and `src/main.ts`, `README.md`, and the embedded runtime, sorted by path. Refused
 * operations only shape the README's summary; they never fail the scaffold. The `domain/`,
 * `api/` and `cli/` layers are emitted by their own emitters.
 */
export const emitScaffold = (
  input: ScaffoldInput,
): Effect.Effect<readonly EmittedFile[], PackageEmitError | PrinterError> =>
  Effect.gen(function* emit() {
    const packageFiles = yield* emitPackageFiles(input.config, input.generator);
    const entryFiles = yield* emitEntryFiles(input.config);

    return Arr.sort([...packageFiles, ...entryFiles, emitReadme(input), ...runtime], byPath);
  });
