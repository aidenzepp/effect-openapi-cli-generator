import { Effect, Option, Schema } from "effect";
import type { CanonicalKey } from "../resolve/canonical.ts";
import type { Resolution } from "../resolve/index.ts";
import { follow, nodeIn } from "./document-set.ts";

/**
 * The marks a Header Object carries that the generator reads.
 */
export interface HeaderMarks {
  readonly deprecated: boolean;
  readonly required: boolean;
}

// A mark that is absent or not a boolean reads as false without discarding its sibling.
const Mark = Schema.Boolean.pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some(false))),
  Schema.withDecodingDefaultKey(Effect.succeed(false)),
);

const HeaderObject = Schema.Struct({ deprecated: Mark, required: Mark });

const unmarked: HeaderMarks = { deprecated: false, required: false };

/**
 * The `required` and `deprecated` marks of the Header Object at use site `site` (a response header
 * or an encoding part header), read where its `$ref` leads. An absent mark is false, and a site
 * that is no object has neither mark.
 */
export const headerMarks = (
  resolution: Resolution,
  site: CanonicalKey,
): Effect.Effect<HeaderMarks> =>
  nodeIn(resolution, follow(resolution, site)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(HeaderObject)),
    Effect.orElseSucceed(() => unmarked),
  );
