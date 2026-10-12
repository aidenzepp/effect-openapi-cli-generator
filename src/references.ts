import { Effect, Schema } from "effect";
import { GenerationError } from "./errors.js";

export const pointerSegment = (value: string): string =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");

const fail = (location: string, message: string) =>
  Effect.fail(
    new GenerationError({
      code: "unsupported",
      hint: "Use an acyclic local #/... JSON Pointer reference.",
      location,
      message,
    }),
  );

export const resolveReference = (
  document: Schema.Json,
  ref: string,
  location: string,
  activeRefs: ReadonlySet<string>,
): Effect.Effect<
  {
    readonly value: Schema.Json;
    readonly location: string;
    readonly activeRefs: ReadonlySet<string>;
  },
  GenerationError
> =>
  Effect.gen(function* resolveReferenceEffect1() {
    if (!ref.startsWith("#/")) {
      return yield* fail(location, "Only local JSON Pointer references are supported.");
    }
    const decoded = yield* Effect.try({
      catch: () =>
        new GenerationError({
          code: "invalid_input",
          hint: "Use a valid URI fragment.",
          location,
          message: "Invalid percent escape in reference.",
        }),
      try: () => decodeURIComponent(ref.slice(1)),
    });
    const tokens = decoded.slice(1).split("/");
    if (tokens.some((token) => /~(?![01])/u.test(token))) {
      return yield* fail(location, "Invalid JSON Pointer escape.");
    }
    const keys = tokens.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
    const target = `/${keys.map(pointerSegment).join("/")}`;
    if (activeRefs.has(target)) {
      return yield* fail(location, "Recursive references are unsupported.");
    }
    let value: Schema.Json = document;
    for (const key of keys) {
      let next: Schema.Json | undefined;
      if (Schema.is(Schema.Array(Schema.Json))(value)) {
        if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || !Object.hasOwn(value, key)) {
          return yield* fail(location, "Reference does not resolve to an own JSON property.");
        }
        next = value[Number(key)];
      } else if (Schema.is(Schema.JsonObject)(value) && Object.hasOwn(value, key)) {
        next = value[key];
      }
      if (next === undefined) {
        return yield* fail(location, "Reference does not resolve to an own JSON property.");
      }
      value = next;
    }
    return { activeRefs: new Set([...activeRefs, target]), location: target, value };
  });
