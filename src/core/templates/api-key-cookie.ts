import { Effect, Redacted, Result } from "effect";
import { Cookies, HttpClientRequest } from "effect/http";
import * as Errors from "./authentication.js";

// template:body
/**
 * Place an opaque API key in cookie without retaining rejected credentials.
 */
export const cookieApiKey =
  (name: string, credential: Redacted.Redacted) => (request: HttpClientRequest.HttpClientRequest) =>
    Effect.try({
      catch: () =>
        new Errors.AuthenticationError({
          reason: new Errors.CredentialUnavailable({
            credential: { location: "cookie", mechanism: "apiKey" },
          }),
        }),
      try: () => Redacted.value(credential),
    }).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          catch: () =>
            new Errors.AuthenticationError({ reason: new Errors.CookieEncodingError({}) }),
          try: () =>
            Result.all(
              Object.entries({
                ...Cookies.parseHeader(request.headers.cookie ?? ""),
                [name]: value,
              }).map(([key, entry]) => Cookies.makeCookie(key, entry)),
            ),
        }).pipe(
          Effect.flatMap((result) =>
            Effect.fromResult(result).pipe(
              Effect.mapError(
                () =>
                  new Errors.AuthenticationError({
                    reason: new Errors.CookieConfigurationError({}),
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
    );
