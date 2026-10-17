import { Flag } from "effect/cli";

/**
 * Bearer token for authentication.
 */
export const ApiToken = Flag.Redacted("api-token").pipe(
  Flag.withDescription("Bearer token for authentication."),
);
