import { createHash } from "node:crypto";
import { Array as Arr, Data, Effect, Order, Schema } from "effect";
import { printJson } from "../emit/printer.ts";
import { JsonLiteral } from "../model/brands.ts";

/**
 * The manifest file the writer commits last in the output directory (design 3.6, Write).
 */
export const manifestFileName = ".openapi-cli-manifest.json";

/**
 * Why a manifest could not be printed or read: `malformed` (not the manifest shape),
 * `duplicate-path` or `unprintable` (a value `printJson` cannot take). `subject` names the path
 * involved, or the manifest file when no path is.
 */
export class ManifestError extends Data.TaggedError("ManifestError")<{
  readonly reason: "duplicate-path" | "malformed" | "unprintable";
  readonly subject: string;
}> {}

const ManifestEntrySchema = Schema.Struct({
  path: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  sha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
});

const ManifestFile = Schema.Struct({ files: Schema.Array(ManifestEntrySchema) });

/**
 * One generated file: its path relative to the output directory and the sha256 of its bytes.
 */
export type ManifestEntry = (typeof ManifestEntrySchema)["Type"];

const strict = { onExcessProperty: "error" } as const;

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ManifestFile));

const encodeJson = Schema.decodeUnknownEffect(JsonLiteral);

const byPath = Order.mapInput(Order.String, (entry: ManifestEntry) => entry.path);

/**
 * The sha256 of `content` as 64 lowercase hex digits; text is hashed as its UTF-8 bytes.
 */
export const sha256Hex = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

const duplicatePath = (sorted: readonly ManifestEntry[]): string | undefined =>
  sorted.find((entry, index) => index > 0 && sorted[index - 1]?.path === entry.path)?.path;

const sortedUnique = (
  entries: readonly ManifestEntry[],
): Effect.Effect<readonly ManifestEntry[], ManifestError> => {
  const sorted = Arr.sort(entries, byPath);
  const duplicate = duplicatePath(sorted);

  return duplicate === undefined
    ? Effect.succeed(sorted)
    : Effect.fail(new ManifestError({ reason: "duplicate-path", subject: duplicate }));
};

/**
 * Prints the manifest in the `docs/printer.md` JSON layout: `{"files": [...]}` with entries sorted
 * by path (code-unit order), whatever the input order. A repeated path or a sha256 that is not 64
 * lowercase hex digits fails.
 */
export const printManifest = (
  entries: readonly ManifestEntry[],
): Effect.Effect<string, ManifestError> =>
  Schema.decodeUnknownEffect(Schema.Array(ManifestEntrySchema))(entries).pipe(
    Effect.mapError(() => new ManifestError({ reason: "malformed", subject: manifestFileName })),
    Effect.flatMap(sortedUnique),
    Effect.flatMap((sorted) =>
      encodeJson({ files: sorted }).pipe(
        Effect.mapError(
          () => new ManifestError({ reason: "unprintable", subject: manifestFileName }),
        ),
      ),
    ),
    Effect.map(printJson),
  );

/**
 * Reads a previous manifest's text into entries sorted by path. Anything but `{"files": [{path,
 * sha256}]}` (an unknown member, an empty path, a bad sha256, a repeated path) fails. A path that
 * leaves the output directory still decodes: the writer refuses it, not the codec.
 */
export const decodeManifest = (
  text: string,
): Effect.Effect<readonly ManifestEntry[], ManifestError> =>
  decodeFile(text, strict).pipe(
    Effect.mapError(() => new ManifestError({ reason: "malformed", subject: manifestFileName })),
    Effect.flatMap((file) => sortedUnique(file.files)),
  );
