import { Effect, Match, Redacted, Result, Schema, SchemaGetter } from "effect";
import { Cookies, HttpClientRequest } from "effect/http";
import * as Errors from "./errors.js";

/**
 * An API key security definition; the name and location specify its wire placement.
 * Credential values are supplied separately.
 */
export const ApiKeyScheme = Schema.Struct({
  in: Schema.Literals(["header", "query", "cookie"]),
  name: Schema.String,
  type: Schema.Literal("apiKey"),
});

/**
 * The supported HTTP authentication subset, decoded case-insensitively into
 * canonical lowercase scheme names. This does not resolve security requirements.
 */
export const HttpScheme = Schema.Struct({
  scheme: Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.toLowerCase(),
      encode: SchemaGetter.passthrough(),
    }),
    Schema.decodeTo(Schema.Literals(["bearer", "basic"])),
  ),
  type: Schema.Literal("http"),
});

/**
 * Supported security definitions, independent of credentials and activation.
 * OAuth and certificate-based authentication are not represented here.
 */
export const SecurityScheme = Schema.Union([ApiKeyScheme, HttpScheme]);

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
export const BasicCredentials = Schema.Struct({
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
        catch: () => new Errors.BasicAuthenticationError({ reason: "PasswordUnavailable" }),
        try: () => Redacted.value(credentials.password),
      }).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(BasicPassword)(value, { reportInput: false }).pipe(
            Effect.mapError(
              () => new Errors.BasicAuthenticationError({ reason: "PasswordInvalid" }),
            ),
          ),
        ),
      ),
      username: Effect.try({
        catch: () => new Errors.BasicAuthenticationError({ reason: "UsernameUnavailable" }),
        try: () => Redacted.value(credentials.username),
      }).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(BasicUsername)(value, { reportInput: false }).pipe(
            Effect.mapError(
              () => new Errors.BasicAuthenticationError({ reason: "UsernameInvalid" }),
            ),
          ),
        ),
      ),
    }).pipe(
      Effect.flatMap((decoded) =>
        Effect.try({
          catch: () => new Errors.BasicAuthenticationError({ reason: "Encoding" }),
          try: () => HttpClientRequest.basicAuth(request, decoded.username, decoded.password),
        }),
      ),
    );

/**
 * Place an opaque API key at its explicitly configured wire name and location.
 * Cookie keys preserve other parsed cookies and use native value encoding;
 * encoding failures do not retain the secret. No environment binding is inferred.
 */
export const apiKey =
  (scheme: typeof ApiKeyScheme.Type, credential: Redacted.Redacted) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.try({
      catch: () =>
        new Errors.ApiKeyAuthenticationError({
          location: scheme.in,
          reason: "CredentialUnavailable",
        }),
      try: () => Redacted.value(credential),
    }).pipe(
      Effect.flatMap((value) =>
        Match.value(scheme.in).pipe(
          Match.when("header", () =>
            Effect.try({
              catch: () =>
                new Errors.ApiKeyAuthenticationError({ location: "header", reason: "Preparation" }),
              try: () => HttpClientRequest.setHeader(request, scheme.name, value),
            }),
          ),
          Match.when("query", () =>
            Effect.try({
              catch: () =>
                new Errors.ApiKeyAuthenticationError({ location: "query", reason: "Preparation" }),
              try: () => HttpClientRequest.setUrlParam(request, scheme.name, value),
            }),
          ),
          Match.when("cookie", () =>
            Effect.try({
              catch: () =>
                new Errors.ApiKeyAuthenticationError({ location: "cookie", reason: "Encoding" }),
              try: () =>
                Result.all(
                  Object.entries({
                    ...Cookies.parseHeader(request.headers.cookie ?? ""),
                    [scheme.name]: value,
                  }).map(([name, entry]) => Cookies.makeCookie(name, entry)),
                ),
            }).pipe(
              Effect.flatMap((result) =>
                Effect.fromResult(result).pipe(
                  Effect.mapError(
                    () =>
                      new Errors.ApiKeyAuthenticationError({
                        location: "cookie",
                        reason: "InvalidConfiguration",
                      }),
                  ),
                ),
              ),
              Effect.map((cookies) =>
                HttpClientRequest.setHeader(
                  request,
                  "cookie",
                  Cookies.toCookieHeader(Cookies.fromIterable(cookies)),
                ),
              ),
            ),
          ),
          Match.exhaustive,
        ),
      ),
    );
