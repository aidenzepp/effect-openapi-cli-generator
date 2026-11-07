import { Array as Arr, Order, Redacted } from "effect";
import { Base64 } from "effect/encoding";
import type { Credential } from "./auth.ts";

/**
 * A query name or value exactly as the request target carries it (audit M F1): percent-encoded
 * with no `+` for a space, and with the `'` an http(s) URL parser percent-encodes in a query
 * already encoded, so the client writes the normalized bytes and redaction matches them.
 */
export const queryWireForm = (text: string): string =>
  encodeURIComponent(text).replaceAll("'", "%27");

/**
 * Every form a credential travels in (audit F2): the raw value; for http basic also the base64
 * token `basicAuth` sends and the password alone; for an apiKey in the query also the form the
 * request target carries and the URLSearchParams form a server may echo. Empty forms are dropped.
 */
const wireForms = (credential: Credential): readonly string[] => {
  const value: string = Redacted.value(credential.value);
  const { definition } = credential;
  const forms = [value];

  if (definition.kind === "http" && definition.scheme === "basic" && value.includes(":")) {
    forms.push(Base64.encode(value), value.slice(value.indexOf(":") + 1));
  }

  if (definition.kind === "apiKey" && definition.in === "query") {
    forms.push(queryWireForm(value), new URLSearchParams([["", value]]).toString().slice(1));
  }

  return forms.filter((form) => form !== "");
};

/**
 * Every wire form, and each one as `strip` leaves it. Empty forms are dropped.
 */
const formsAround =
  (strip: (text: string) => string) =>
  (credential: Credential): readonly string[] =>
    wireForms(credential)
      .flatMap((form) => [form, strip(form)])
      .filter((form) => form !== "");

interface Covered {
  readonly start: number;
  readonly end: number;
  readonly placeholder: string;
}

const byStartThenLongest = Order.combine(
  Order.mapInput(Order.Number, (range: Covered) => range.start),
  Order.mapInput(Order.flip(Order.Number), (range: Covered) => range.end),
);

/**
 * Every occurrence of every wire form of every credential as a character range, overlapping
 * occurrences included.
 */
const occurrences = (
  text: string,
  credentials: readonly Credential[],
  formsOf: (credential: Credential) => readonly string[],
): readonly Covered[] =>
  credentials.flatMap((credential) =>
    formsOf(credential).flatMap((form) => {
      const placeholder = `<redacted:${credential.scheme}>`;
      const found: Covered[] = [];

      for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
        found.push({ end: at + form.length, placeholder, start: at });
      }

      return found;
    }),
  );

/**
 * Merge ranges that overlap or touch. A merged run keeps the placeholder of its earliest,
 * longest range.
 */
const mergeRuns = (ranges: readonly Covered[]): readonly Covered[] => {
  const runs: Covered[] = [];

  for (const range of Arr.sort(ranges, byStartThenLongest)) {
    const last = runs.at(-1);

    if (last !== undefined && range.start <= last.end) {
      runs[runs.length - 1] = { ...last, end: Math.max(last.end, range.end) };
    } else {
      runs.push(range);
    }
  }

  return runs;
};

const scrubForms = (
  text: string,
  credentials: readonly Credential[],
  formsOf: (credential: Credential) => readonly string[],
): string => {
  const runs = mergeRuns(occurrences(text, credentials, formsOf));
  let scrubbed = "";
  let at = 0;

  for (const run of runs) {
    scrubbed += text.slice(at, run.start) + run.placeholder;
    at = run.end;
  }

  return scrubbed + text.slice(at);
};

/**
 * Replace every wire form of every configured credential with `<redacted:<scheme>>` (design 7.5,
 * C5). Occurrences that overlap or touch merge into one run replaced by one placeholder, so no
 * character of any form survives (recheck N1), and placeholders are never rescanned.
 */
export const scrub = (text: string, credentials: readonly Credential[]): string =>
  scrubForms(text, credentials, wireForms);

/**
 * Scrub, apply `strip`, then scrub again (design 7.4, audit S2). The first pass runs before
 * anything is removed, so a credential holding a character `strip` removes is found as sent. The
 * second pass finds a credential that removed characters had split, matching each form both as
 * sent and as `strip` leaves it.
 */
export const scrubAround = (
  text: string,
  credentials: readonly Credential[],
  strip: (text: string) => string,
): string => scrubForms(strip(scrub(text, credentials)), credentials, formsAround(strip));

const encoder = new TextEncoder();

export const longestFormBytes = (credentials: readonly Credential[]): number =>
  Math.max(0, ...credentials.flatMap(wireForms).map((form) => encoder.encode(form).length));

/**
 * The length of the longest proper prefix of `form` that `text` ends with (Knuth-Morris-Pratt, so
 * a long credential costs linear time).
 */
const trailingPrefixLength = (text: string, form: string): number => {
  const fallback = [0];

  for (let at = 1, matched = 0; at < form.length; at += 1) {
    while (matched > 0 && form[at] !== form[matched]) {
      matched = fallback[matched - 1] ?? 0;
    }

    matched += form[at] === form[matched] ? 1 : 0;
    fallback.push(matched);
  }

  // Only the last form.length - 1 characters can hold a proper prefix, so a full match never forms.
  let matched = 0;

  for (let at = Math.max(0, text.length - form.length + 1); at < text.length; at += 1) {
    while (matched > 0 && text[at] !== form[matched]) {
      matched = fallback[matched - 1] ?? 0;
    }

    matched += text[at] === form[matched] ? 1 : 0;
  }

  return matched;
};

/**
 * Drop the trailing partial match of any credential form (audit F1). A read cut at its budget can
 * end inside a credential; that fragment never matches, so scrubbing would leave it, and a shorter
 * placeholder earlier in the text would pull it into the visible window.
 */
export const dropTrailingFragment = (text: string, credentials: readonly Credential[]): string => {
  const cut = Math.max(
    0,
    ...credentials.flatMap(wireForms).map((form) => trailingPrefixLength(text, form)),
  );

  return text.slice(0, text.length - cut);
};
