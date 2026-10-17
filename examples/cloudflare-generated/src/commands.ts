import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { HttpClientRequest } from "effect/http";
import * as Errors from "./builtins/errors.js";
import * as Http from "./builtins/http.js";
import * as Url from "./builtins/url.js";
import * as Parameters from "./components/parameters.js";
import * as SecuritySchemes from "./components/security-schemes.js";

/**
 * List all access tokens you created. Results include active, disabled, and recently-expired tokens
 * when include_expired is set to true.
 */
const userApiTokensListTokensCommand = Command.make(
  "list",
  {
    apiToken: SecuritySchemes.ApiToken,
    baseUrl: Url.baseUrl,
    direction: Flag.Literals("direction", ["asc", "desc"]).pipe(Flag.optional),
    includeExpired: Parameters.IamIncludeExpired,
    page: Flag.Finite("page").pipe(
      Flag.withSchema(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))),
      Flag.optional,
    ),
    perPage: Flag.Finite("per-page").pipe(
      Flag.withSchema(
        Schema.Finite.check(Schema.isGreaterThanOrEqualTo(5), Schema.isLessThanOrEqualTo(50)),
      ),
      Flag.optional,
    ),
  },
  ({ apiToken, baseUrl: apiUrl, direction, includeExpired, page, perPage }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        direction: Option.getOrUndefined(direction),
        include_expired: Option.getOrUndefined(includeExpired),
        page: Option.getOrUndefined(page),
        per_page: Option.getOrUndefined(perPage),
      }),
      HttpClientRequest.bearerToken(apiToken),
      Url.appendPathSegments("user", "tokens"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("user-api-tokens-list-tokens"),
    ),
).pipe(
  Command.withDescription(
    "List all access tokens you created. Results include active, disabled, and recently-expired tokens when include_expired is set to true.",
  ),
);

/**
 * Find all available permission groups for API Tokens.
 */
const permissionGroupsListPermissionGroupsCommand = Command.make(
  "list",
  {
    apiToken: SecuritySchemes.ApiToken,
    baseUrl: Url.baseUrl,
    name: Flag.String("name").pipe(
      Flag.withDescription(
        "Filter by the name of the permission group.\nThe value must be URL-encoded.",
      ),
      Flag.optional,
    ),
    scope: Flag.String("scope").pipe(
      Flag.withDescription(
        "Filter by the scope of the permission group.\nThe value must be URL-encoded.",
      ),
      Flag.optional,
    ),
  },
  ({ apiToken, baseUrl: apiUrl, name, scope }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.setUrlParams({
        name: Option.getOrUndefined(name),
        scope: Option.getOrUndefined(scope),
      }),
      HttpClientRequest.bearerToken(apiToken),
      Url.appendPathSegments("user", "tokens", "permission_groups"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("permission-groups-list-permission-groups"),
    ),
).pipe(Command.withDescription("Find all available permission groups for API Tokens."));

/**
 * Test whether a token works.
 */
const userApiTokensVerifyTokenCommand = Command.make(
  "verify",
  { apiToken: SecuritySchemes.ApiToken, baseUrl: Url.baseUrl },
  ({ apiToken, baseUrl: apiUrl }) =>
    HttpClientRequest.get(apiUrl).pipe(
      HttpClientRequest.bearerToken(apiToken),
      Url.appendPathSegments("user", "tokens", "verify"),
      Effect.flatMap(Http.runRequest),
      Effect.mapError(Errors.toCliError),
      Effect.withSpan("user-api-tokens-verify-token"),
    ),
).pipe(Command.withDescription("Test whether a token works."));

const UserTokensPermissionGroupsCommand = Command.make("permission-groups").pipe(
  Command.withSubcommands([permissionGroupsListPermissionGroupsCommand]),
);

const UserTokensCommand = Command.make("tokens").pipe(
  Command.withSubcommands([
    userApiTokensListTokensCommand,
    userApiTokensVerifyTokenCommand,
    UserTokensPermissionGroupsCommand,
  ]),
);

export const UserCommand = Command.make("user").pipe(Command.withSubcommands([UserTokensCommand]));
