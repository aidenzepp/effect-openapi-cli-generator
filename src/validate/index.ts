/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError<Self>()(tag, fields) declares a class; nothing is thrown */
import {
  validate as compile,
  registerSchema,
  setShouldValidateFormat,
} from "@hyperjump/json-schema/draft-2020-12";
import type { Validator } from "@hyperjump/json-schema/draft-2020-12";
import "@hyperjump/json-schema/draft-04";
// The vendored 3.1 and 3.2 meta-schemas require the OAS base vocabulary; these modules define it
// (design 3.2). They also register the library's own undated OAS ids, which are never validated
// against.
import "@hyperjump/json-schema/openapi-3-1";
import "@hyperjump/json-schema/openapi-3-2";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import type { PlatformError } from "effect";
import type { Digest } from "effect/crypto";
import { rewriteDialect } from "./dialect.ts";
import { matchDisagreement, noticeFor, refusalFor, knownDisagreements } from "./disagreements.ts";
import type { Refusal } from "./disagreements.ts";
import { lineOf, schemaUri } from "./dispatch.ts";
import { groupErrors } from "./locations.ts";
import { surrogateRefusal, surrogateSites } from "./surrogates.ts";
import type { ErrorGroup, InvalidInstanceLocation } from "./locations.ts";
import type { Line, UnsupportedOpenApiVersion } from "./dispatch.ts";
import type { Json } from "../model/pointer.ts";
import type { DocumentUri } from "../model/brands.ts";
import type { Diagnostic } from "../model/diagnostic.ts";
import { sha256Hex } from "../write/manifest.ts";
import { manifest } from "./schemas/manifest.ts";

type ValidatorInput = Parameters<Validator>[0];

type SchemaInput = Parameters<typeof registerSchema>[0];

export { UnsupportedOpenApiVersion } from "./dispatch.ts";

export type { Line } from "./dispatch.ts";

/**
 * A vendored schema file cannot be read or differs from the manifest.
 */
export class SchemaManifestError extends Schema.TaggedError<SchemaManifestError>()(
  "SchemaManifestError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    file: Schema.String,
    reason: Schema.Literals(["unreadable", "sha256-mismatch"]),
  },
) {}

/**
 * The validator library failed to register, compile or run a schema.
 */
export class ValidatorError extends Schema.TaggedError<ValidatorError>()("ValidatorError", {
  cause: Schema.Defect(),
}) {}

/**
 * One BASIC output error unit. `instanceLocation` is a URI fragment, not yet decoded (m1-va2).
 */
export interface ValidationUnit {
  readonly absoluteKeywordLocation: string;
  readonly instanceLocation: string;
  readonly keyword: string;
}

/**
 * The verdict of the official schema for the line the document declares.
 */
export interface ValidationResult {
  readonly errors: readonly ValidationUnit[];
  readonly line: Line;
  readonly schema: string;
  readonly valid: boolean;
}

/**
 * Reads the bytes of one vendored file.
 */
export type ReadSchema = (
  file: string,
) => Effect.Effect<
  Uint8Array,
  PlatformError.PlatformError | PlatformError.BadArgument,
  FileSystem.FileSystem | Path.Path
>;

const readVendored: ReadSchema = Effect.fnUntraced(function* readVendored(file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* path.fromFileUrl(new URL(`schemas/${file}`, import.meta.url));

  return yield* fs.readFile(target);
});

/**
 * Reads every vendored file and checks its sha256 against the manifest, in registration order.
 * Returns the verified bytes in manifest order.
 */
export const checkManifest = (
  read: ReadSchema,
): Effect.Effect<
  readonly Uint8Array[],
  SchemaManifestError,
  FileSystem.FileSystem | Path.Path | Digest.Digest
> =>
  Effect.all(
    manifest.map((entry) =>
      read(entry.file).pipe(
        Effect.mapError(
          (cause) => new SchemaManifestError({ cause, file: entry.file, reason: "unreadable" }),
        ),
        Effect.flatMap((bytes) =>
          sha256Hex(bytes).pipe(
            Effect.flatMap((hex) =>
              hex === entry.sha256
                ? Effect.succeed(bytes)
                : Effect.fail(
                    new SchemaManifestError({ file: entry.file, reason: "sha256-mismatch" }),
                  ),
            ),
          ),
        ),
      ),
    ),
  );

const decodeSchemaText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

const textDecoder = new TextDecoder();

const register = checkManifest(readVendored).pipe(
  Effect.flatMap((files) =>
    // Effect.forEach takes (items, f); it is not an array method with a thisArg.
    // oxlint-disable-next-line unicorn/no-array-method-this-argument
    Effect.forEach(files, (bytes) =>
      decodeSchemaText(textDecoder.decode(bytes)).pipe(
        Effect.mapError((cause) => new ValidatorError({ cause })),
      ),
    ),
  ),
  Effect.flatMap((schemas) =>
    Effect.try({
      catch: (cause) => new ValidatorError({ cause }),
      try: () => {
        setShouldValidateFormat(false);

        for (const schema of schemas) {
          // SAFETY: the sha256-checked vendored file is the library's own schema document, an object.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded Json to the library's schema input type
          registerSchema(schema as SchemaInput);
        }
      },
    }),
  ),
);

// Registration is global library state, so it runs once per process.
const registered = Effect.runSync(Effect.cached(register));

/**
 * Validates a document against the official schema of its `openapi` line (design 3.2): BASIC
 * output, format assertion off, no result cache. The only Promise boundary is `compile` (R7).
 */
export const validateDocument = (
  document: Json,
): Effect.Effect<
  ValidationResult,
  SchemaManifestError | UnsupportedOpenApiVersion | ValidatorError,
  FileSystem.FileSystem | Path.Path | Digest.Digest
> =>
  Effect.gen(function* validateDocumentGen() {
    const line = yield* lineOf(document);

    yield* registered;

    const schema = schemaUri[line];
    const validator = yield* Effect.tryPromise({
      catch: (cause) => new ValidatorError({ cause }),
      try: () => compile(schema),
    });
    // SAFETY: hyperjump's Instance.fromJs only reads its input; the readonly document is never written (a deep-frozen document is tested).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- readonly Json to the library's mutable input type, read-only use
    const output = validator(document as ValidatorInput, "BASIC");

    return {
      errors: output.valid
        ? []
        : (output.errors ?? []).map(
            ({ absoluteKeywordLocation, instanceLocation, keyword }): ValidationUnit => ({
              absoluteKeywordLocation,
              instanceLocation,
              keyword,
            }),
          ),
      line,
      schema,
      valid: output.valid,
    };
  });

/**
 * The diagnostics of one document: schema disagreements the text overrules as notices, every other
 * schema error as a document refusal.
 */
export interface Diagnosis {
  readonly notices: readonly Diagnostic[];
  readonly refusals: readonly Refusal[];
}

const Declared = Schema.Struct({ openapi: Schema.String });

// The 3.2 schema bars the uppercase fixed method names as `additionalOperations` keys. The text
// bars them in any capitalization (PTH-24), so the structure check refuses every spelling alike.
const fixedMethodKeyKeyword = "#/$defs/path-item/properties/additionalOperations/propertyNames/not";

const isFixedMethodKey = (group: ErrorGroup): boolean =>
  group.deepest.every((unit) => unit.absoluteKeywordLocation.endsWith(fixedMethodKeyKeyword));

const sch01 = Option.fromNullishOr(knownDisagreements.find((entry) => entry.row === "SCH-01"));

/**
 * Validates a document (design 3.2) and sorts the verdict into notices and refusals. The 3.1 line
 * is validated as a deep copy with the text's dialect id rewritten; the input is never changed.
 */
export const diagnoseDocument = (
  document: Json,
  uri: typeof DocumentUri.Type,
): Effect.Effect<
  Diagnosis,
  | InvalidInstanceLocation
  | Schema.SchemaError
  | SchemaManifestError
  | UnsupportedOpenApiVersion
  | ValidatorError,
  FileSystem.FileSystem | Path.Path | Digest.Digest
> =>
  Effect.gen(function* diagnoseDocumentGen() {
    const line = yield* lineOf(document);
    const openapi = Schema.decodeUnknownOption(Declared)(document).pipe(
      Option.map((found) => found.openapi),
      Option.getOrElse(() => line),
    );
    const where = { document: uri, line, openapi };
    const lone = surrogateSites(document);

    if (lone.length > 0) {
      const refusals = yield* Effect.all(lone.map((pointer) => surrogateRefusal(where, pointer)));

      return { notices: [], refusals };
    }

    const rewritten = yield* rewriteDialect(document);
    const result = yield* validateDocument(rewritten.copy);
    const groups = (yield* groupErrors(result.errors)).filter((group) => !isFixedMethodKey(group));
    const rewriteNotices = yield* Effect.all(
      rewritten.occurrences.map((pointer) =>
        Option.match(sch01, {
          onNone: () => Effect.die("SCH-01 is missing from the known-disagreement table"),
          onSome: (entry) =>
            noticeFor(entry, where, pointer, "the schema pins the dated dialect id instead"),
        }),
      ),
    );
    const matched = groups.map((group) => ({ entry: matchDisagreement(line, group), group }));
    const tableNotices = yield* Effect.all(
      matched.flatMap(({ entry, group }) =>
        entry === undefined
          ? []
          : [
              noticeFor(
                entry,
                where,
                group.pointer,
                `the schema rejects it at ${group.deepest[0]?.absoluteKeywordLocation ?? ""}`,
              ),
            ],
      ),
    );
    const refusals = yield* Effect.all(
      matched.flatMap(({ entry, group }) =>
        entry === undefined ? [refusalFor(where, group)] : [],
      ),
    );

    return { notices: [...rewriteNotices, ...tableNotices], refusals };
  });
