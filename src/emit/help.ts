import { Predicate, Schema } from "effect";
import type { Diagnostic } from "../model/diagnostic.ts";
import { SafeText } from "../model/brands.ts";
import type { DiscriminatorHint, Operation, Parameter, SecurityScheme } from "../model/entities.ts";
import type { NonStandardChoice, NonStandardUse } from "../model/non-standard.ts";
import { markedUses, nonStandardUses } from "../model/non-standard.ts";
import type { Json } from "../model/pointer.ts";

/**
 * The schema annotations of the body property a flag writes, read along its `$ref` chain: its
 * `enum` values, its `default` (never sent), and whether it is read-only or deprecated.
 */
export interface HelpBodyField {
  readonly default: Json | undefined;
  readonly deprecated: boolean;
  readonly enum: readonly Json[] | undefined;
  readonly readOnly: boolean;
}

/**
 * Where a flag's value lands: a parameter (`negatable` for a three-state boolean), a body property
 * at an RFC 6901 pointer inside the body, with that property's annotations, the `Content-Type`
 * of the multipart part at `part`, one of `choices`, or the ordered parts of a positional
 * `multipart/mixed` body, `prefix[i]` the content type of part `i + 1` and `item` that of every
 * later part.
 */
export type HelpFlagSource =
  | { readonly _tag: "Body"; readonly field?: HelpBodyField; readonly pointer: string }
  | { readonly _tag: "Parameter"; readonly negatable: boolean; readonly parameter: Parameter }
  | { readonly _tag: "PartOption"; readonly option: HelpPartOption; readonly part: string }
  | { readonly _tag: "Parts"; readonly item?: string; readonly prefix: readonly string[] };

/**
 * What a multipart part option sets: the part's content type, one of `choices`, or the value of
 * its Encoding header `name`, needed when `required` and the part flag `partFlag` is given.
 */
export type HelpPartOption =
  | { readonly choices: readonly string[]; readonly kind: "content-type" }
  | {
      readonly deprecated: boolean;
      readonly kind: "header";
      readonly name: string;
      readonly partFlag: string;
      readonly required: boolean;
    };

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

/**
 * The environment names that carry one `mutualTLS` scheme's client certificate, key and CA paths;
 * it has no flag (design 6.5, D-SEC3).
 */
export interface HelpCertificate {
  readonly caEnv: string;
  readonly certEnv: string;
  readonly keyEnv: string;
  readonly scheme: string;
}

export interface HelpInput {
  readonly certificates?: readonly HelpCertificate[];
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

// Each switch's flag note (design 6.1 Scalar switch, Marking).
const choiceNotes: Readonly<Record<NonStandardChoice, string>> = {
  deepObjectBrackets:
    "non-standard: sent as name[a][b]=v (author config nonStandard.deepObjectBrackets)",
  deepObjectScalars:
    "non-standard: a scalar value is sent as name=value (author config nonStandard.deepObjectScalars)",
};

const choices: readonly NonStandardChoice[] = ["deepObjectBrackets", "deepObjectScalars"];

// The distinct choices among use sites, bracket choice first.
const choicesOf = (uses: readonly NonStandardUse[]): readonly NonStandardChoice[] =>
  choices.filter((choice) => uses.some((use) => use.choice === choice));

// The first pointer token, unescaped: the form property a body flag writes.
const propertyOf = (pointer: string): string =>
  (pointer.split("/")[1] ?? "").replaceAll("~1", "/").replaceAll("~0", "~");

// The use sites the author config marked on the form property a body flag writes (design 6.1).
const bodyMarked = (operation: Operation, pointer: string): readonly NonStandardUse[] => {
  const name = propertyOf(pointer);

  return (operation.body?.alternatives ?? []).flatMap((alternative) =>
    alternative.encoding.flatMap((rule) =>
      rule.target.kind === "property" && rule.target.name === name ? markedUses(rule) : [],
    ),
  );
};

// The switches that marked the element a flag writes, bracket choice first; empty when unmarked.
const markedChoices = (operation: Operation, flag: HelpFlag): readonly NonStandardChoice[] => {
  const { source } = flag;
  if (source._tag === "Body") {
    return choicesOf(bodyMarked(operation, source.pointer));
  }

  if (source._tag === "PartOption" || source._tag === "Parts") {
    return [];
  }

  return choicesOf(nonStandardUses(source.parameter.serialization));
};

// Each position's content type, then every later part's (HT:B15): `part 1: a; parts 2+: b`.
const partsNote = (prefix: readonly string[], item: string | undefined): string => {
  const positions = prefix.map((type, index) => `part ${index + 1}: ${line(type)}`);
  const rest = item === undefined ? [] : [`parts ${prefix.length + 1}+: ${line(item)}`];

  return [...positions, ...rest].join("; ");
};

const locationNote = (source: HelpFlagSource, name: string): string => {
  if (source._tag === "Body") {
    return `body ${line(source.pointer)}`;
  }

  if (source._tag === "Parts") {
    return partsNote(source.prefix, source.item);
  }

  if (source._tag === "PartOption") {
    const part = `multipart part ${line(propertyOf(source.part))}`;

    return source.option.kind === "header"
      ? `header ${line(source.option.name)} of ${part}`
      : `content type of ${part}`;
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

type Hint = typeof DiscriminatorHint.Type;

// One branch of a discriminated body: the JSON-quoted values that select it, then its component;
// a branch no value selects names its place in the composition.
const branchText = (hint: Hint, branch: Hint["branches"][number]): string => {
  const place = `${hint.keyword}/${branch.index}`;
  if (branch.labels.length === 0) {
    return `${place} (inline, no ${line(hint.propertyName)} value)`;
  }

  const values = branch.labels.map((label) => line(JSON.stringify(label))).join(" | ");

  return `${values} (${branch.component === undefined ? place : line(branch.component)})`;
};

// The VARIANTS line: each hinted body alternative's branches by discriminator value (D-OQ9).
const variantsLine = (operation: Operation): string | undefined => {
  const hinted = (operation.body?.alternatives ?? []).flatMap(({ discriminator, mediaType }) =>
    discriminator === undefined
      ? []
      : [
          `${mediaType} ${discriminator.keyword} by ${line(discriminator.propertyName)}: ${discriminator.branches
            .map((branch) => branchText(discriminator, branch))
            .join(", ")}`,
        ],
  );

  return hinted.length === 0 ? undefined : hinted.join("; ");
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

// The marker column: what a reader must know about where a scheme came from and whether it is deprecated.
const markers = (scheme: SecurityScheme): readonly string[] => [
  ...(scheme.source === "author-supplied" ? ["author-supplied"] : []),
  ...(scheme.deprecated ? ["deprecated"] : []),
];

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
  readonly certificates: ReadonlyMap<string, HelpCertificate>;
  readonly credentials: ReadonlyMap<string, HelpCredential>;
  readonly schemes: ReadonlyMap<string, SecurityScheme>;
}

type Use = Operation["security"]["alternatives"][number]["uses"][number];

type Flows = Extract<SecurityScheme["kind"], { readonly type: "oauth2Token" }>["flows"];

// Flow kinds in a fixed order, so the line does not depend on the spec's key order.
const flowKinds = [
  "authorizationCode",
  "clientCredentials",
  "deviceAuthorization",
  "implicit",
  "password",
] as const;

const acquisition = "token acquisition is not supported; supply an access token";

// One flow: its URLs when the spec gives them, then its scope names and descriptions (OAF-01, OAF-12).
const flowText = (kind: string, flow: NonNullable<Flows[keyof Flows]>): string => {
  const urls = (["authorizationUrl", "tokenUrl", "refreshUrl"] as const).flatMap((field) => {
    const url = flow[field];

    return url === undefined ? [] : [`${field} ${line(url)}`];
  });
  const scopes =
    flow.scopes.length === 0
      ? "none"
      : flow.scopes
          .map(({ description, name }) =>
            description === "" ? line(name) : `${line(name)} (${line(description)})`,
          )
          .join(", ");

  return `${kind} flow ${[...urls, `scopes ${scopes}`].join(", ")}`;
};

// What help shows of a scheme besides its sources: the oauth2 flows and metadata URL, the OIDC
// discovery URL (neither URL is ever fetched, design 9 I3), and that no token is acquired.
const kindDetails = (scheme: SecurityScheme): readonly string[] => {
  const { kind } = scheme;
  if (kind.type === "oauth2Token") {
    const flows = flowKinds.flatMap((flowKind) => {
      const flow = kind.flows[flowKind];

      return flow === undefined ? [] : [flowText(flowKind, flow)];
    });
    const metadata =
      kind.oauth2MetadataUrl === undefined
        ? []
        : [`oauth2MetadataUrl ${line(kind.oauth2MetadataUrl)} (never fetched)`];

    return [...flows, ...metadata, acquisition];
  }

  return kind.type === "oidcToken"
    ? [`openIdConnectUrl ${line(kind.openIdConnectUrl)} (never fetched)`, acquisition]
    : [];
};

// The values of a requirement entry: required scopes for a token scheme (SEC-11), role names for
// any other (SEC-13). Help shows them; they are never sent.
const scopesNote = (scheme: SecurityScheme | undefined, scopes: readonly string[]): string[] => {
  if (scopes.length === 0) {
    return [];
  }

  const type = scheme?.kind.type;
  const label = type === "oauth2Token" || type === "oidcToken" ? "required scopes" : "roles";

  return [`${label} ${scopes.map(line).join(", ")} (never sent)`];
};

// Where the credential is read from: a token scheme's file flag and env name, then the TTY prompt
// when the scheme's credential sources hold it; a mutualTLS scheme's three env names and no flag.
const sourcesOf = (
  lookup: UseLookup,
  scheme: SecurityScheme | undefined,
  name: string,
): string | undefined => {
  const certificate = lookup.certificates.get(name);
  if (certificate !== undefined) {
    const envs = [certificate.certEnv, certificate.keyEnv, certificate.caEnv].map(line);

    return `env ${envs.join(", ")}; the certificate is presented only to accepted origins`;
  }

  const credential = lookup.credentials.get(name);
  const prompt = scheme?.credentialSources.includes("prompt") === true ? ", TTY prompt" : "";

  return credential === undefined
    ? undefined
    : `--${line(credential.flag)} <path|->, env ${line(credential.env)}${prompt}`;
};

const useLine = (lookup: UseLookup, use: Use): string => {
  const name = use.scheme;
  const scheme = lookup.schemes.get(name);
  const marked = scheme === undefined ? [] : markers(scheme);
  const mark = marked.length === 0 ? "" : ` [${marked.join(", ")}]`;
  const head = scheme === undefined ? line(name) : `${line(name)} (${kindNote(scheme)})${mark}`;
  const sources = sourcesOf(lookup, scheme, name);
  const details = [
    ...(scheme === undefined ? [] : kindDetails(scheme)),
    ...scopesNote(scheme, use.scopes),
  ];
  const text = sources === undefined ? head : `${head}: ${sources}`;

  return details.length === 0 ? text : `${text}; ${details.join("; ")}`;
};

const anonymous = "no authentication";

// The AUTH line: the alternatives in document order, `{}` as no authentication; an explicit
// `security: []` is no authentication and absent security is undocumented (D-OQ10 (a), design 2.2).
const authLine = (input: HelpInput): string => {
  const { alternatives, declared } = input.operation.security;
  if (alternatives.length === 0) {
    return declared ? anonymous : "no authentication documented";
  }

  const lookup: UseLookup = {
    certificates: firstByKey(input.certificates ?? [], (certificate) => certificate.scheme),
    credentials: firstByKey(input.credentials, (credential) => credential.scheme),
    schemes: firstByKey(input.schemes, (scheme) => scheme.name),
  };

  return alternatives
    .map((alternative) =>
      alternative.uses.length === 0
        ? anonymous
        : alternative.uses.map((use) => useLine(lookup, use)).join(" and "),
    )
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

type ResponseHeader = Operation["responses"][number]["headers"][number];

const headerMarks = (header: ResponseHeader): string => {
  const marks = [
    ...(header.required ? ["required"] : []),
    ...(header.deprecated ? ["deprecated"] : []),
  ];

  return marks.length === 0 ? header.name : `${header.name} (${marks.join(", ")})`;
};

// The RESPONSE HEADERS line: each case that declares headers, its names in document order with
// their required and deprecated marks (HDR-04); absent when no case declares one.
const responseHeadersLine = (operation: Operation): string | undefined => {
  const cases = operation.responses
    .filter((response) => response.headers.length > 0)
    .map(
      (response) => `${responseKey(response.key)}: ${response.headers.map(headerMarks).join(", ")}`,
    );

  return cases.length === 0 ? undefined : cases.join("; ");
};

const refusedLine = (input: HelpInput): string | undefined => {
  const { key } = input.operation;
  const refused = input.diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity === "refusal" &&
      (diagnostic.scope === "element" || diagnostic.scope === "field") &&
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

const isDeprecated = ({ source }: HelpFlag): boolean => {
  if (source._tag === "PartOption") {
    return source.option.kind === "header" && source.option.deprecated;
  }

  if (source._tag === "Parts") {
    return false;
  }

  return source._tag === "Parameter"
    ? source.parameter.deprecated
    : source.field?.deprecated === true;
};

// A schema value as help shows it: a string as itself, anything else as JSON.
const valueText = (value: Json): string =>
  line(Predicate.isString(value) ? value : JSON.stringify(value));

// A body field's schema notes: its allowed values, its default and its read-only mark. A content
// type option lists its choices, and a required part header names the part flag it goes with.
const fieldNotes = (source: HelpFlagSource): readonly string[] => {
  if (source._tag === "PartOption") {
    const { option } = source;
    if (option.kind === "content-type") {
      return [`choices: ${option.choices.map(line).join(", ")}`];
    }

    return option.required ? [`required when --${line(option.partFlag)} is given`] : [];
  }

  const field = source._tag === "Body" ? source.field : undefined;
  if (field === undefined) {
    return [];
  }

  return [
    ...(field.enum === undefined ? [] : [`choices: ${field.enum.map(valueText).join(", ")}`]),
    ...(field.default === undefined ? [] : [`default: ${valueText(field.default)}`]),
    ...(field.readOnly ? ["read-only"] : []),
  ];
};

// A flag's annotation: its location, then each switch's note, the body field's schema notes and
// `deprecated` when they apply.
const noted =
  (operation: Operation) =>
  (flag: HelpFlag): readonly [string, string] => {
    const notes = [
      locationNote(flag.source, flag.name),
      ...markedChoices(operation, flag).map((choice) => choiceNotes[choice]),
      ...fieldNotes(flag.source),
      ...(isDeprecated(flag) ? ["deprecated"] : []),
    ];

    return [line(flag.name), notes.join("; ")];
  };

// The NON-STANDARD line: for each switch, the flags it marked by visible name, then its choice.
const nonStandardLine = (input: HelpInput): string | undefined => {
  const groups = choices.flatMap((choice) => {
    const marked = input.flags.filter((flag) =>
      markedChoices(input.operation, flag).includes(choice),
    );

    return marked.length === 0
      ? []
      : [`${marked.map((flag) => `--${line(flag.name)}`).join(", ")} (${choice})`];
  });

  return groups.length === 0 ? undefined : groups.join("; ");
};

/**
 * The description and generated notes of one command, from the model alone: source prose first,
 * then the wire name and location of each argument and flag (with a body field's allowed values,
 * default and read-only and deprecated marks), and the REQUEST, VARIANTS, AUTH, RESPONSES,
 * RESPONSE HEADERS and REFUSED lines. VARIANTS lists a discriminated body's branches and is absent
 * without a hint; RESPONSE HEADERS is absent when no case declares a header; the REFUSED line lists
 * the command's refused elements and refused body fields by wire name and reason.
 */
export const operationHelp = (input: HelpInput): OperationHelp => {
  const { operation } = input;
  const auth = authLine(input);
  const refused = refusedLine(input);
  const nonStandard = nonStandardLine(input);
  const responseHeaders = responseHeadersLine(operation);
  const variants = variantsLine(operation);
  const sections: (readonly [string, string])[] = [
    ["REQUEST", requestLine(operation)],
    ...(variants === undefined ? [] : [["VARIANTS", variants] as const]),
    ["AUTH", auth],
  ];

  if (operation.deprecated) {
    sections.push([
      "DEPRECATED",
      "this command is deprecated; running it writes a notice to stderr",
    ]);
  }

  sections.push(["RESPONSES", responsesLine(operation)]);
  if (responseHeaders !== undefined) {
    sections.push(["RESPONSE HEADERS", responseHeaders]);
  }

  if (nonStandard !== undefined) {
    sections.push(["NON-STANDARD", nonStandard]);
  }

  if (refused !== undefined) {
    sections.push(["REFUSED", refused]);
  }

  return {
    arguments: record(input.flags.filter(isArgument).map(noted(operation))),
    description: sanitizeProse(operation.docs.description ?? operation.docs.summary ?? ""),
    flags: record(input.flags.filter((flag) => !isArgument(flag)).map(noted(operation))),
    sections,
  };
};
