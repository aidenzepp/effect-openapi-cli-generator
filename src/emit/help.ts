import { Schema } from "effect";
import type { Diagnostic } from "../model/diagnostic.ts";
import { SafeText } from "../model/brands.ts";
import type { Operation, Parameter, SecurityScheme } from "../model/entities.ts";

/**
 * Where a flag's value lands: a parameter (`negatable` for a three-state boolean) or a body
 * property at an RFC 6901 pointer inside the body.
 */
export type HelpFlagSource =
  | { readonly _tag: "Body"; readonly pointer: string }
  | { readonly _tag: "Parameter"; readonly negatable: boolean; readonly parameter: Parameter };

/**
 * A flag or argument by its visible name, without `--`.
 */
export interface HelpFlag {
  readonly name: string;
  readonly source: HelpFlagSource;
}

/**
 * The flag and environment names that carry one scheme's credential.
 */
export interface HelpCredential {
  readonly env: string;
  readonly flag: string;
  readonly scheme: string;
}

export interface HelpInput {
  readonly credentials: readonly HelpCredential[];
  readonly diagnostics: readonly Diagnostic[];
  readonly flags: readonly HelpFlag[];
  readonly operation: Operation;
  readonly schemes: readonly SecurityScheme[];
}

/**
 * The strings for one command; m1-em4b places them as literals.
 */
export interface OperationHelp {
  readonly arguments: Readonly<Record<string, string>>;
  readonly description: SafeTextValue;
  readonly flags: Readonly<Record<string, string>>;
  readonly sections: readonly (readonly [string, string])[];
}

type SafeTextValue = typeof SafeText.Type;

const maxProseLength = 2000;

const rejected = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

const decodeSafe = Schema.decodeSync(SafeText);

const truncate = (text: string): string => {
  let kept = "";
  let count = 0;
  for (const char of text) {
    if (count === maxProseLength) {
      break;
    }

    kept += char;
    count += 1;
  }

  return kept;
};

/**
 * Source prose made help-safe: removes exactly what the `SafeText` brand rejects, then caps the
 * length at 2000 code points, so the result always decodes.
 */
export const sanitizeProse = (text: string): SafeTextValue =>
  decodeSafe(truncate(text.replaceAll(rejected, "")));

// A single-line generated field: sanitized, with LF and TAB runs folded to one space.
const line = (text: string): string => sanitizeProse(text).replaceAll(/[\n\t]+/gu, " ");

const locationNote = (source: HelpFlagSource, name: string): string => {
  if (source._tag === "Body") {
    return `body ${line(source.pointer)}`;
  }

  const { location, wireName } = source.parameter;
  const note = `${location} ${line(wireName)}`;

  return source.negatable ? `${note}; --no-${line(name)} sends false` : note;
};

const record = (
  entries: readonly (readonly [string, string])[],
): Readonly<Record<string, string>> => Object.fromEntries(entries);

const mediaTypes = (alternatives: readonly { readonly mediaType: string }[]): string =>
  alternatives.map((alternative) => alternative.mediaType).join(" or ");

const requestLine = (operation: Operation): string => {
  const { body, key, operationId } = operation;
  const parts = [`${key.method} ${line(key.path)}`];
  if (body !== undefined) {
    const types = mediaTypes(body.alternatives);
    const required = body.required ? " (required)" : "";
    parts.push(`body${types === "" ? "" : ` ${types}`}${required}`);
  }

  if (operationId !== undefined) {
    parts.push(`operationId ${line(operationId)}`);
  }

  return parts.join(", ");
};

const kindNote = (scheme: SecurityScheme): string => {
  const { kind } = scheme;
  if (kind.type === "apiKey") {
    return `apiKey ${kind.in} ${line(kind.name)}`;
  }

  if (kind.type === "http") {
    return `http ${kind.scheme}`;
  }

  if (kind.type === "oauth2Token") {
    return "oauth2 token";
  }

  return kind.type === "oidcToken" ? "oidc token" : "mutualTls";
};

// The first entry per key, as a linear search would find it; built once per command.
const firstByKey = <T>(items: readonly T[], keyOf: (item: T) => string): ReadonlyMap<string, T> => {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) {
      map.set(key, item);
    }
  }

  return map;
};

interface UseLookup {
  readonly credentials: ReadonlyMap<string, HelpCredential>;
  readonly schemes: ReadonlyMap<string, SecurityScheme>;
}

const useLine = (lookup: UseLookup, name: string): string => {
  const scheme = lookup.schemes.get(name);
  const credential = lookup.credentials.get(name);
  const head = scheme === undefined ? line(name) : `${line(name)} (${kindNote(scheme)})`;
  if (credential === undefined) {
    return head;
  }

  return `${head}: --${line(credential.flag)} <path|->, env ${line(credential.env)}`;
};

const authLine = (input: HelpInput): string | undefined => {
  const { alternatives } = input.operation.security;
  if (alternatives.length === 0) {
    return undefined;
  }

  const lookup: UseLookup = {
    credentials: firstByKey(input.credentials, (credential) => credential.scheme),
    schemes: firstByKey(input.schemes, (scheme) => scheme.name),
  };

  return alternatives
    .map((alternative) => alternative.uses.map((use) => useLine(lookup, use.scheme)).join(" and "))
    .join(" or ");
};

const responseKey = (key: Operation["responses"][number]["key"]): string => {
  if (key === "default") {
    return key;
  }

  return "code" in key ? String(key.code) : `${key.range}XX`;
};

const responsesLine = (operation: Operation): string => {
  const cases = operation.responses.map((response) => {
    const types = mediaTypes(response.alternatives);

    return types === "" ? responseKey(response.key) : `${responseKey(response.key)} ${types}`;
  });

  return `${cases.join("; ")}. Non-2xx exits 1 (401/403 exit 3)`;
};

const refusedLine = (input: HelpInput): string | undefined => {
  const { key } = input.operation;
  const refused = input.diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity === "refusal" &&
      diagnostic.scope === "element" &&
      diagnostic.operation?.method === key.method &&
      diagnostic.operation.path === key.path,
  );

  return refused.length === 0
    ? undefined
    : refused
        .map(
          (diagnostic) =>
            `${line(diagnostic.wire ?? diagnostic.element)}: ${line(diagnostic.message)}`,
        )
        .join("; ");
};

const isArgument = (flag: HelpFlag): boolean =>
  flag.source._tag === "Parameter" && flag.source.parameter.location === "path";

const noted = (flag: HelpFlag): readonly [string, string] => [
  line(flag.name),
  locationNote(flag.source, flag.name),
];

/**
 * The description and generated notes of one command, from the model alone: source prose first,
 * then the wire name and location of each argument and flag, and the REQUEST, AUTH, RESPONSES and
 * REFUSED lines. The REFUSED line lists the command's refused elements by wire name and reason.
 */
export const operationHelp = (input: HelpInput): OperationHelp => {
  const { operation } = input;
  const auth = authLine(input);
  const refused = refusedLine(input);
  const sections: (readonly [string, string])[] = [["REQUEST", requestLine(operation)]];
  if (auth !== undefined) {
    sections.push(["AUTH", auth]);
  }

  sections.push(["RESPONSES", responsesLine(operation)]);
  if (refused !== undefined) {
    sections.push(["REFUSED", refused]);
  }

  return {
    arguments: record(input.flags.filter(isArgument).map(noted)),
    description: sanitizeProse(operation.docs.description ?? operation.docs.summary ?? ""),
    flags: record(input.flags.filter((flag) => !isArgument(flag)).map(noted)),
    sections,
  };
};
