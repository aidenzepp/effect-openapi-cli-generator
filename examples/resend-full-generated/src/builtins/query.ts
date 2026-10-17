import { Effect } from "effect";
import { CliError } from "effect/cli";
import { HttpClientRequest } from "effect/http";

/**
 * Preserve form-array presence and reject ambiguous comma-delimited values before transport.
 */
export const setArray =
  (name: string, values: readonly (string | number | boolean)[] | undefined, explode: boolean) =>
  (request: HttpClientRequest.HttpClientRequest) => {
    if (values === undefined) {
      return Effect.succeed(request);
    }

    if (values.length === 0) {
      return Effect.fail(
        new CliError.UserError({
          cause: undefined,
          userMessage: `The query parameter ${name} cannot represent an empty array unambiguously. Omit an optional flag or supply at least one item.`,
        }),
      );
    }

    if (!explode && values.some((value) => String(value).includes(","))) {
      return Effect.fail(
        new CliError.UserError({
          cause: undefined,
          userMessage: `The query parameter ${name} contains a comma in an array item and cannot be represented unambiguously with comma-separated serialization. Use items without commas or an API operation supporting repeated query parameters.`,
        }),
      );
    }

    const value = explode ? values.map(String) : values.join(",");

    return Effect.succeed(HttpClientRequest.setUrlParams(request, { [name]: value }));
  };
