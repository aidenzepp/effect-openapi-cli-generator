import { Schema } from "effect";
import { Flag } from "effect/cli";

/**
 * Number of items to return.
 */
export const PaginationLimit = Flag.Int("limit").pipe(
  Flag.withSchema(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
  Flag.withDescription("Number of items to return."),
  Flag.optional,
);

/**
 * Return items after this cursor.
 */
export const PaginationAfter = Flag.String("after").pipe(
  Flag.withDescription("Return items after this cursor."),
  Flag.optional,
);

/**
 * Return items before this cursor.
 */
export const PaginationBefore = Flag.String("before").pipe(
  Flag.withDescription("Return items before this cursor."),
  Flag.optional,
);
