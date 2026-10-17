import { Effect, Option, FileSystem, Path } from "effect";
import { CliError } from "effect/cli";
import { HttpClientRequest } from "effect/http";
import type { HttpBody } from "effect/http";

/**
 * Read binary bytes without exposing file contents or filesystem causes in CLI errors.
 */
export const file = (path: string | undefined) =>
  path === undefined
    ? Effect.succeed(path)
    : Effect.gen(function* readMultipartFile() {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const bytes = yield* fs.readFile(path).pipe(
          Effect.mapError(
            () =>
              new CliError.UserError({
                cause: undefined,
                userMessage:
                  "A multipart file could not be read. Check the file flag and its permissions; no request was sent.",
              }),
          ),
        );

        return new File([Uint8Array.from(bytes)], paths.basename(path), {
          type: "application/octet-stream",
        });
      });

/**
 * Preserve optional body omission and reject unknown-field collisions before native encoding.
 */
export const withBody =
  (
    fields: HttpBody.FormDataInput,
    additionalFields: Option.Option<Readonly<Record<string, string>>>,
    requiredFields: readonly string[],
    requiredBody: boolean,
  ) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* encodeMultipartBody() {
      const extra = Option.getOrElse(additionalFields, () => ({}));
      if (Object.keys(extra).some((name) => Object.hasOwn(fields, name))) {
        return yield* new CliError.UserError({
          cause: undefined,
          userMessage:
            "Additional multipart fields cannot override declared fields. Use their named flags instead.",
        });
      }

      const present =
        Option.isSome(additionalFields) ||
        Object.values(fields).some((value) => value !== undefined);
      if (!requiredBody && !present) {
        return request;
      }

      const missing = requiredFields.filter((name) => fields[name] === undefined);
      if (missing.length > 0) {
        return yield* new CliError.UserError({
          cause: undefined,
          userMessage: `Required multipart fields are missing: ${missing.join(", ")}. Supply their named flags; no request was sent.`,
        });
      }

      return HttpClientRequest.bodyFormDataRecord(request, { ...extra, ...fields });
    });
