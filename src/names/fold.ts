import { Data, Result, Schema } from "effect";
import { reservedIdentifiers, windowsDeviceNames } from "./reserved.ts";

export type Casing = "kebab" | "camel" | "pascal";

/**
 * A fix the fold applied; every note is reported (design 4.4).
 */
export type FoldNote =
  | { readonly _tag: "DigitPrefix"; readonly prefix: string }
  | { readonly _tag: "ReservedSuffix"; readonly suffix: string };

export class EmptyFold extends Data.TaggedError("EmptyFold")<{ readonly input: string }> {}

export class UnsafeFileSegment extends Data.TaggedError("UnsafeFileSegment")<{
  readonly segment: string;
  readonly reason: "pattern" | "device";
}> {}

const digitPrefix = "n";

const reservedSuffix = "_";

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

const segmentPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const deviceStem = (segment: string): string => segment.split(".")[0]?.toUpperCase() ?? "";

const isDeviceName = (segment: string): boolean => windowsDeviceNames.has(deviceStem(segment));

/**
 * A generated identifier: ASCII, matches `^[A-Za-z_$][A-Za-z0-9_$]*$` and is not reserved.
 */
export const SafeIdentifier = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: string) => identifierPattern.test(value) && !reservedIdentifiers.has(value),
    ),
  ),
  Schema.brand("SafeIdentifier"),
);

export type SafeIdentifierValue = typeof SafeIdentifier.Type;

/**
 * A generated file segment: `^[a-z0-9][a-z0-9-]{0,63}$`, not a Windows device name in any case.
 */
export const SafeFileSegment = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => segmentPattern.test(value) && !isDeviceName(value)),
  ),
  Schema.brand("SafeFileSegment"),
);

export type SafeFileSegmentValue = typeof SafeFileSegment.Type;

export interface Folded<Name extends string> {
  readonly name: Name;
  readonly notes: readonly FoldNote[];
}

const capitalize = (word: string): string =>
  `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`;

/**
 * The fold's word split: NFKD, drop combining marks, keep `[A-Za-z0-9]`, break on everything
 * else and between a lowercase and an uppercase letter. Case is kept.
 */
export const words = (input: string): readonly string[] =>
  input
    .normalize("NFKD")
    .replaceAll(/\p{M}+/gu, "")
    .replaceAll(/[^A-Za-z0-9]+/gu, " ")
    .replaceAll(/(?<lower>[a-z])(?=[A-Z])/gu, "$<lower> ")
    .split(" ")
    .filter((word) => word !== "");

const joinWords = (parts: readonly string[], casing: Casing): string => {
  if (casing === "kebab") {
    return parts.map((word) => word.toLowerCase()).join("-");
  }

  if (casing === "pascal") {
    return parts.map(capitalize).join("");
  }

  return parts.map((word, index) => (index === 0 ? word.toLowerCase() : capitalize(word))).join("");
};

const withDigitPrefix = (
  parts: readonly string[],
): { readonly parts: readonly string[]; readonly notes: readonly FoldNote[] } =>
  /^[0-9]/u.test(parts[0] ?? "")
    ? { notes: [{ _tag: "DigitPrefix", prefix: digitPrefix }], parts: [digitPrefix, ...parts] }
    : { notes: [], parts };

/**
 * Fold to a kebab name for commands and flags. A leading digit gets the prefix `n`.
 */
export const foldKebab = (input: string): Result.Result<Folded<string>, EmptyFold> => {
  const parts = words(input);
  if (parts.length === 0) {
    return Result.fail(new EmptyFold({ input }));
  }

  const prefixed = withDigitPrefix(parts);

  return Result.succeed({ name: joinWords(prefixed.parts, "kebab"), notes: prefixed.notes });
};

/**
 * Fold to a camel or Pascal identifier. A leading digit gets the prefix `n`; a reserved word
 * gets the suffix `_`.
 */
export const foldIdentifier = (
  input: string,
  casing: "camel" | "pascal",
): Result.Result<Folded<SafeIdentifierValue>, EmptyFold> => {
  const parts = words(input);
  if (parts.length === 0) {
    return Result.fail(new EmptyFold({ input }));
  }

  const prefixed = withDigitPrefix(parts);
  const joined = joinWords(prefixed.parts, casing);
  if (!reservedIdentifiers.has(joined)) {
    return Result.succeed({
      name: Schema.decodeSync(SafeIdentifier)(joined),
      notes: prefixed.notes,
    });
  }

  return Result.succeed({
    name: Schema.decodeSync(SafeIdentifier)(`${joined}${reservedSuffix}`),
    notes: [...prefixed.notes, { _tag: "ReservedSuffix", suffix: reservedSuffix }],
  });
};

/**
 * Fold to a file segment. A Windows device name or a name over 64 characters is refused, never
 * renamed.
 */
export const foldFileSegment = (
  input: string,
): Result.Result<SafeFileSegmentValue, EmptyFold | UnsafeFileSegment> => {
  const parts = words(input);
  if (parts.length === 0) {
    return Result.fail(new EmptyFold({ input }));
  }

  const segment = joinWords(parts, "kebab");
  if (isDeviceName(segment)) {
    return Result.fail(new UnsafeFileSegment({ reason: "device", segment }));
  }

  if (!Schema.is(SafeFileSegment)(segment)) {
    return Result.fail(new UnsafeFileSegment({ reason: "pattern", segment }));
  }

  return Result.succeed(segment);
};
