import { Flag } from "effect/cli";

/**
 * Bearer token for authentication.
 */
export const bearerAuth = Flag.Redacted("bearer-auth").pipe(
  Flag.withDescription("Bearer token for authentication."),
);
