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
 * Basic credentials are redacted and obey HTTP Basic transport syntax: no
 * control characters or username colon. Password colons remain valid.
 *
 * @see https://www.rfc-editor.org/rfc/rfc7617#section-2
 */
export const BasicCredentials = Schema.Struct({
  // oxlint-disable-next-line no-control-regex -- HTTP Basic forbids ASCII control characters.
  password: Schema.Redacted(Schema.String.check(Schema.isPattern(/^[^\u0000-\u001F\u007F]*$/u))),
  // oxlint-disable-next-line no-control-regex -- HTTP Basic forbids ASCII control characters.
  username: Schema.Redacted(Schema.String.check(Schema.isPattern(/^[^\u0000-\u001F\u007F:]*$/u))),
});

/**
 * Apply native Basic authentication inside a typed failure boundary. The native
 * encoder rejects unsupported Unicode; failed credentials are never retained.
 */
export const basicAuth =
  (credentials: typeof BasicCredentials.Type) => (request: HttpClientRequest.HttpClientRequest) =>
    Schema.decodeUnknownEffect(BasicCredentials)(credentials, { reportInput: false }).pipe(
      Effect.flatMap((decoded) =>
        Effect.try({
          catch: () => new Errors.AuthenticationError({ reason: "BasicEncoding" }),
          try: () => HttpClientRequest.basicAuth(request, decoded.username, decoded.password),
        }),
      ),
      Effect.mapError(() => new Errors.AuthenticationError({ reason: "BasicEncoding" })),
    );

/**
 * Place an opaque API key at its explicitly configured wire name and location.
 * Cookie keys preserve other parsed cookies and use native value encoding;
 * encoding failures do not retain the secret. No environment binding is inferred.
 */
export const apiKey =
  (scheme: typeof ApiKeyScheme.Type, credential: Redacted.Redacted) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Match.value(scheme.in).pipe(
      Match.when("header", () =>
        Effect.try({
          catch: () => new Errors.AuthenticationError({ reason: "ApiKeyEncoding" }),
          try: () => HttpClientRequest.setHeader(request, scheme.name, Redacted.value(credential)),
        }),
      ),
      Match.when("query", () =>
        Effect.try({
          catch: () => new Errors.AuthenticationError({ reason: "ApiKeyEncoding" }),
          try: () =>
            HttpClientRequest.setUrlParam(request, scheme.name, Redacted.value(credential)),
        }),
      ),
      Match.when("cookie", () =>
        Effect.try({
          catch: () => new Errors.AuthenticationError({ reason: "ApiKeyEncoding" }),
          try: () =>
            Result.all(
              Object.entries({
                ...Cookies.parseHeader(request.headers.cookie ?? ""),
                [scheme.name]: Redacted.value(credential),
              }).map(([name, value]) => Cookies.makeCookie(name, value)),
            ),
        }).pipe(
          Effect.flatMap(Effect.fromResult),
          Effect.map((cookies) =>
            HttpClientRequest.setHeader(
              request,
              "cookie",
              Cookies.toCookieHeader(Cookies.fromIterable(cookies)),
            ),
          ),
          Effect.mapError(() => new Errors.AuthenticationError({ reason: "ApiKeyEncoding" })),
        ),
      ),
      Match.exhaustive,
    );
