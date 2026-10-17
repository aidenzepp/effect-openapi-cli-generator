import { Flag } from "effect/cli";

/**
 * Read the token for the specification's bearerAuth HTTP bearer security scheme
 * as a redacted value. Authentication requires an explicit --bearer-auth flag.
 */
export const bearerAuth = Flag.Redacted("bearer-auth").pipe(
  Flag.withDescription("Bearer token for authentication."),
);
