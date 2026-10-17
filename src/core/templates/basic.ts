import { Effect, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import * as Errors from "./authentication.js";

// template:body
/**
 * HTTP Basic usernames exclude colons and ASCII control characters.
 */
// oxlint-disable-next-line no-control-regex -- HTTP Basic forbids ASCII control characters.
const BasicUsername = Schema.String.check(Schema.isPattern(/^[^\u0000-\u001F\u007F:]*$/u));

/**
 * HTTP Basic passwords exclude ASCII control characters; colons remain valid.
 */
// oxlint-disable-next-line no-control-regex -- HTTP Basic forbids ASCII control characters.
const BasicPassword = Schema.String.check(Schema.isPattern(/^[^\u0000-\u001F\u007F]*$/u));

/**
 * Redacted Basic credentials follow HTTP transport syntax, not API-specific rules.
 *
 * @see https://www.rfc-editor.org/rfc/rfc7617#section-2
 */
const BasicCredentials = Schema.Struct({
  password: Schema.Redacted(BasicPassword),
  username: Schema.Redacted(BasicUsername),
});

/**
 * Validate each Basic field through its native schema before encoding the pair.
 * Unavailable credentials, invalid fields and encoder failures stay distinct;
 * no failure retains credential values or raw native causes.
 */
export const basicAuth =
  (credentials: typeof BasicCredentials.Type) => (request: HttpClientRequest.HttpClientRequest) =>
    Effect.all({
      password: Effect.try({
        catch: () =>
          new Errors.AuthenticationError({
            reason: new Errors.CredentialUnavailable({
              credential: { field: "password", mechanism: "basic" },
            }),
          }),
        try: () => Redacted.value(credentials.password),
      }).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(BasicPassword)(value, { reportInput: false }).pipe(
            Effect.mapError(
              () =>
                new Errors.AuthenticationError({
                  reason: new Errors.InvalidBasicCredential({ field: "password" }),
                }),
            ),
          ),
        ),
      ),
      username: Effect.try({
        catch: () =>
          new Errors.AuthenticationError({
            reason: new Errors.CredentialUnavailable({
              credential: { field: "username", mechanism: "basic" },
            }),
          }),
        try: () => Redacted.value(credentials.username),
      }).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(BasicUsername)(value, { reportInput: false }).pipe(
            Effect.mapError(
              () =>
                new Errors.AuthenticationError({
                  reason: new Errors.InvalidBasicCredential({ field: "username" }),
                }),
            ),
          ),
        ),
      ),
    }).pipe(
      Effect.flatMap((decoded) =>
        Effect.try({
          catch: () =>
            new Errors.AuthenticationError({ reason: new Errors.BasicEncodingError({}) }),
          try: () => HttpClientRequest.basicAuth(request, decoded.username, decoded.password),
        }),
      ),
    );
