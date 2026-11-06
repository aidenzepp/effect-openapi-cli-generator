import { Array as Arr, Data, Effect, Order, Schema } from "effect";
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
export class InvalidInstanceLocation extends Data.TaggedError("InvalidInstanceLocation")<{
  readonly location: string;
}> {}

const decodePointer = Schema.decodeUnknownEffect(JsonPointer);

/**
 * Strips the `#` and percent-decodes an error's `instanceLocation` into a JSON Pointer (design 3.2
 * Error locations). Custom code: the library reports URI fragments, the model compares pointers.
 */
export const decodeLocation = (
  instanceLocation: string,
): Effect.Effect<Pointer, InvalidInstanceLocation> =>
  instanceLocation.startsWith("#")
    ? Effect.try({
        catch: () => new InvalidInstanceLocation({ location: instanceLocation }),
        try: () => decodeURIComponent(instanceLocation.slice(1)),
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

/**
 * Groups errors under their deepest decoded location, in pointer order. An error at a location
 * with a deeper error beneath it is context of the first such deepest location.
 */
export const groupErrors = (
  errors: readonly ErrorUnit[],
): Effect.Effect<readonly ErrorGroup[], InvalidInstanceLocation> =>
  Effect.all(
    errors.map((unit) =>
      decodeLocation(unit.instanceLocation).pipe(
        Effect.map((pointer): Located => ({ pointer, unit })),
      ),
    ),
  ).pipe(
    Effect.map((located) => {
      const isDeepest = (item: Located): boolean =>
        !located.some(
          (other) => other.pointer !== item.pointer && isWithin(item.pointer, other.pointer),
        );
      const deepestItems = located.filter(isDeepest);
      const leaves = Arr.sort(
        deepestItems.filter(
          (item, index) =>
            deepestItems.findIndex((other) => other.pointer === item.pointer) === index,
        ),
        byPointer,
      );
      const contextOf = (leaf: Located): readonly ErrorUnit[] =>
        located
          .filter(
            (item) =>
              !isDeepest(item) &&
              leaves.find((other) => isWithin(item.pointer, other.pointer)) === leaf,
          )
          .map((item) => item.unit);

      return leaves.map((leaf): ErrorGroup => ({
        context: contextOf(leaf),
        deepest: located.filter((item) => item.pointer === leaf.pointer).map((item) => item.unit),
        pointer: leaf.pointer,
      }));
    }),
  );
