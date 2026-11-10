/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError<Self>()(tag, fields) declares a class; nothing is thrown */
import { Array as Arr, Effect, Order, Schema } from "effect";
import { JsonPointer } from "../model/brands.ts";

type Pointer = typeof JsonPointer.Type;

/**
 * The part of one validator error the diagnostic layer reads.
 */
export interface ErrorUnit {
  readonly absoluteKeywordLocation: string;
  readonly instanceLocation: string;
  readonly keyword: string;
}

/**
 * The errors at one deepest instance location, with the ancestor errors that wrap them.
 */
export interface ErrorGroup {
  readonly context: readonly ErrorUnit[];
  readonly deepest: readonly ErrorUnit[];
  readonly pointer: Pointer;
}

/**
 * An `instanceLocation` is not `#` followed by a percent-encoded JSON Pointer.
 */
export class InvalidInstanceLocation extends Schema.TaggedError<InvalidInstanceLocation>()(
  "InvalidInstanceLocation",
  { location: Schema.String },
) {}

const decodePointer = Schema.decodeUnknownEffect(JsonPointer);

// The library marks the location of a property name, as `propertyNames` checks it, as `#*`.
const fragmentOf = (instanceLocation: string): string =>
  instanceLocation.slice(instanceLocation.startsWith("#*") ? 2 : 1);

/**
 * Strips the `#` (or the `#*` of a property name) and percent-decodes an error's
 * `instanceLocation` into a JSON Pointer (design 3.2 Error locations). Custom code: the library
 * reports URI fragments, the model compares pointers.
 */
export const decodeLocation = (
  instanceLocation: string,
): Effect.Effect<Pointer, InvalidInstanceLocation> =>
  instanceLocation.startsWith("#")
    ? Effect.try({
        catch: () => new InvalidInstanceLocation({ location: instanceLocation }),
        try: () => decodeURIComponent(fragmentOf(instanceLocation)),
      }).pipe(
        Effect.flatMap(decodePointer),
        Effect.mapError(() => new InvalidInstanceLocation({ location: instanceLocation })),
      )
    : Effect.fail(new InvalidInstanceLocation({ location: instanceLocation }));

interface Located {
  readonly pointer: Pointer;
  readonly unit: ErrorUnit;
}

const isWithin = (ancestor: string, descendant: string): boolean =>
  descendant === ancestor || descendant.startsWith(`${ancestor}/`);

const byPointer = Order.mapInput(Order.String, (located: Located) => located.pointer);

const samePointer = (self: Located, that: Located): boolean => self.pointer === that.pointer;

// The first deepest location in pointer order that lies within a context error owns it.
const groupLocated = (located: readonly Located[]): readonly ErrorGroup[] => {
  const deepestItems = new Set(
    located.filter(
      (item) =>
        !located.some(
          (other) => other.pointer !== item.pointer && isWithin(item.pointer, other.pointer),
        ),
    ),
  );
  const leaves = Arr.sort(Arr.dedupeWith(deepestItems, samePointer), byPointer);
  const unitsAt = Arr.groupBy(located, (item) => item.pointer);
  const contextOf = (leaf: Located): readonly ErrorUnit[] =>
    located
      .filter(
        (item) =>
          !deepestItems.has(item) &&
          leaves.find((other) => isWithin(item.pointer, other.pointer)) === leaf,
      )
      .map((item) => item.unit);

  return leaves.map((leaf): ErrorGroup => ({
    context: contextOf(leaf),
    deepest: (unitsAt[leaf.pointer] ?? []).map((item) => item.unit),
    pointer: leaf.pointer,
  }));
};

/**
 * Groups errors under their deepest decoded location, in pointer order. An error at a location
 * with a deeper error beneath it is context of the first such deepest location.
 */
export const groupErrors = (
  errors: readonly ErrorUnit[],
): Effect.Effect<readonly ErrorGroup[], InvalidInstanceLocation> =>
  // Effect.forEach takes (items, f); it is not an array method with a thisArg.
  // oxlint-disable-next-line unicorn/no-array-method-this-argument
  Effect.forEach(errors, (unit) =>
    decodeLocation(unit.instanceLocation).pipe(
      Effect.map((pointer): Located => ({ pointer, unit })),
    ),
  ).pipe(Effect.map(groupLocated));
