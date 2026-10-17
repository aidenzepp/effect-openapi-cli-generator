import { Flag } from "effect/cli";

/**
 * Bearer token for authentication.
 */
export const BearerAuth = Flag.Redacted("bearer-auth").pipe(
  Flag.withDescription("Bearer token for authentication."),
);
