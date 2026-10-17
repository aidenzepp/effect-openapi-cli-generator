import { Effect, Option } from "effect";
import { CliError } from "effect/cli";
import { HttpClientRequest } from "effect/http";
import type { HttpBody } from "effect/http";

// template:body
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
