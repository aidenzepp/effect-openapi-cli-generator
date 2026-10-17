import { Flag } from "effect/cli";

/**
 * When true, includes recently-expired tokens in the response.
 */
export const IamIncludeExpired = Flag.Literals("include-expired", ["true", "false"])
  .pipe(Flag.map((value) => value === "true"))
  .pipe(
    Flag.withDescription("When true, includes recently-expired tokens in the response."),
    Flag.optional,
  );
