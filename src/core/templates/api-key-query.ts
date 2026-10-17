import { Effect, Redacted } from "effect";
import { HttpClientRequest } from "effect/http";
import * as Errors from "./authentication.js";

// template:body
/**
 * Place an opaque API key in query without retaining rejected credentials.
 */
export const queryApiKey =
  (name: string, credential: Redacted.Redacted) => (request: HttpClientRequest.HttpClientRequest) =>
    Effect.try({
      catch: () =>
        new Errors.AuthenticationError({
          reason: new Errors.CredentialUnavailable({
            credential: { location: "query", mechanism: "apiKey" },
          }),
        }),
      try: () => Redacted.value(credential),
    }).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          catch: () =>
            new Errors.AuthenticationError({
              reason: new Errors.ApiKeyPreparationError({ location: "query" }),
            }),
          try: () => HttpClientRequest.setUrlParam(request, name, value),
        }),
      ),
    );
