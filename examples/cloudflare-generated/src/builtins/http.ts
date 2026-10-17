import { Console, Effect } from "effect";
import type { HttpClientRequest } from "effect/http";
import { HttpClient, HttpClientResponse } from "effect/http";

/**
 * Execute a request once and print successful response text. Reject non-2xx
 * statuses and leave typed HTTP failures for the command boundary to format.
 */
export const runRequest = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.flatMap(Console.log),
  );
