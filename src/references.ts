import { Effect } from "effect";
import { GenerationError } from "./errors.js";

export const pointerSegment = (value: string): string =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");

export const resolveReference = (
  document: unknown,
  ref: string,
  location: string,
  activeRefs: ReadonlySet<string>,
): Effect.Effect<
  { readonly value: unknown; readonly location: string; readonly activeRefs: ReadonlySet<string> },
  GenerationError
> =>
  Effect.gen(function* () {
    const fail = (message: string) =>
      Effect.fail(
        new GenerationError({
          code: "unsupported",
          location,
          message,
          hint: "Use an acyclic local #/... JSON Pointer reference.",
        }),
      );
    if (!ref.startsWith("#/"))
      return yield* fail("Only local JSON Pointer references are supported.");
    const decoded = yield* Effect.try({
      try: () => decodeURIComponent(ref.slice(1)),
      catch: () =>
        new GenerationError({
          code: "invalid_input",
          location,
          message: "Invalid percent escape in reference.",
          hint: "Use a valid URI fragment.",
        }),
    });
    const tokens = decoded.slice(1).split("/");
    if (tokens.some((token) => /~(?![01])/u.test(token)))
      return yield* fail("Invalid JSON Pointer escape.");
    const keys = tokens.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
    const target = `/${keys.map(pointerSegment).join("/")}`;
    if (activeRefs.has(target)) return yield* fail("Recursive references are unsupported.");
    let value: unknown = document;
    for (const key of keys) {
      if (
        typeof value !== "object" ||
        value === null ||
        !Object.hasOwn(value, key) ||
        (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(key))
      )
        return yield* fail("Reference does not resolve to an own JSON property.");
      value = (value as Record<string, unknown>)[key];
    }
    return { value, location: target, activeRefs: new Set([...activeRefs, target]) };
  });
