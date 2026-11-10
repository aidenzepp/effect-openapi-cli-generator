import { Array as Arr, Option, Order, Result, Schema } from "effect";
import { Url } from "effect/http";
import type { AuthorConfig } from "../model/author-config.ts";
import { DocumentUri as DocumentUriSchema, SafeText, ServerTemplate } from "../model/brands.ts";
import type { JsonPointer as JsonPointerSchema } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import { Server } from "../model/entities.ts";
import { childPointer, formatPointer } from "../model/pointer.ts";
import type { Json } from "../model/pointer.ts";

/**
 * The `servers` value of one level and where it sits; `value` is `undefined` when the level does
 * not declare `servers`.
 */
export interface ServerSource {
  readonly pointer: JsonPointer;
  readonly value: Json | undefined;
}

/**
 * The three levels an operation's servers can come from.
 */
export interface ServerLevels {
  readonly operation?: ServerSource;
  readonly pathItem?: ServerSource;
  readonly root: ServerSource;
}

/**
 * What servers normalization needs besides the spec value: the author config and the document it
 * was read from, the spec document and its full `openapi` string.
 */
export interface ServersContext {
  readonly config: AuthorConfig;
  readonly configDocument: DocumentUri;
  readonly document: DocumentUri;
  readonly openapi: string;
}

/**
 * Normalized servers and the diagnostics raised while producing them.
 */
export interface ServersResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly servers: readonly Server[];
}

/**
 * The bound origin set, sorted and without duplicates, and the diagnostics raised producing it.
 */
export interface BoundOrigins {
  readonly diagnostics: readonly Diagnostic[];
  readonly origins: readonly DocumentUri[];
}

type DocumentUri = typeof DocumentUriSchema.Type;

type JsonPointer = typeof JsonPointerSchema.Type;

type ServerLevel = Server["level"];

/**
 * Most origins one accepted server may expand to. A proposal, not a design value: it bounds the
 * product of enumerated authority variables (design 9 I5).
 */
const maxExpansions = 256;

const rawServer = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  url: Schema.String,
  variables: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        default: Schema.String,
        enum: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
  ),
});

type RawServer = typeof rawServer.Type;

type Variable = Readonly<{ default: string; enum?: readonly string[] }>;

interface Rule {
  readonly element: string;
  readonly hint?: string;
  readonly message: string;
  readonly scope: Diagnostic["scope"];
}

const rules = {
  "SRV-01/invalid-server": {
    element: "Server",
    hint: "Write servers as a list of objects with a url string.",
    message: "A servers value is not a list of Server Objects.",
    scope: "operation",
  },
  "SRV-02/insecure-scheme": {
    element: "Accepted server",
    hint: "Use https, or set allowInsecure in the author config for a local fixture.",
    message: "An accepted default must use https.",
    scope: "document",
  },
  "SRV-02/not-an-origin": {
    element: "Accepted origin",
    hint: "List the scheme and authority only, such as https://api.example.com.",
    message: "An accepted origin has a path.",
    scope: "document",
  },
  "SRV-02/unparseable": {
    element: "Accepted server",
    message: "An accepted default does not parse as an absolute URL.",
    scope: "document",
  },
  "SRV-02/unsupported-form": {
    element: "Accepted server",
    hint: "Write a relative server URL with a leading slash.",
    message: "A relative server URL must start with a slash.",
    scope: "document",
  },
  "SRV-02/unsupported-scheme": {
    element: "Accepted server",
    message: "An accepted default must use https, or http with allowInsecure.",
    scope: "document",
  },
  "SRV-02/userinfo": {
    element: "Accepted server",
    hint: "Remove the user and password from the server URL.",
    message: "An accepted default must not carry userinfo.",
    scope: "document",
  },
  "SRV-02/value-leaves-authority": {
    element: "Accepted server",
    hint: "Keep path variable values to path text that stays under the server's origin.",
    message: "A path variable value moves an accepted server to another origin.",
    scope: "document",
  },
  "SRV-05/too-many-origins": {
    element: "Accepted server",
    hint: "Narrow the enums, or list the origins in acceptedOrigins.",
    message: "An accepted server expands to more origins than the generator allows.",
    scope: "document",
  },
  "SRV-05/variable-needs-enum": {
    element: "Accepted server",
    hint: "Give the variable an enum, or list the server's origins in acceptedOrigins.",
    message: "A scheme or authority variable of an accepted server needs an enum.",
    scope: "document",
  },
  "SRV-11/undeclared-variable": {
    element: "Server",
    hint: "Declare the variable under variables, or remove it from the url.",
    message: "A server URL uses a variable that the server does not declare.",
    scope: "operation",
  },
  "SRV-16/empty-override": {
    element: "Servers",
    hint: "Remove the empty servers list, or list the servers this level uses.",
    message: "An empty servers list at the path item or operation has no defined meaning.",
    scope: "operation",
  },
  "SRV-17/relative-needs-retrieval-uri": {
    element: "Accepted server",
    hint: "Set retrievalUri in the author config, or accept an absolute server.",
    message: "A relative server URL needs retrievalUri to become a default.",
    scope: "document",
  },
  "SRV-18/query-or-fragment": {
    element: "Accepted server",
    hint: "Remove the query or fragment.",
    message: "A server URL must not contain a query or a fragment.",
    scope: "document",
  },
  "SRV-19/invalid-template": {
    element: "Server",
    message: "A server url is not a valid server URL template.",
    scope: "operation",
  },
} as const satisfies Readonly<Record<string, Rule>>;

type RuleCode = keyof typeof rules;

interface Site {
  readonly document: DocumentUri;
  readonly pointer: string;
}

const diagnose = (context: ServersContext, code: RuleCode, site: Site): Diagnostic => {
  const rule: Rule = rules[code];
  const fields = {
    code,
    document: site.document,
    element: rule.element,
    message: rule.message,
    openapi: context.openapi,
    pointer: site.pointer,
    row: code.slice(0, code.indexOf("/")),
    scope: rule.scope,
    severity: "refusal",
    specSection: `https://spec.openapis.org/oas/v${context.openapi}.html#server-url`,
  };

  return Schema.decodeUnknownSync(Diagnostic)(
    rule.hint === undefined ? fields : { ...fields, hint: rule.hint },
  );
};

const specSite = (context: ServersContext, pointer: string): Site => ({
  document: context.document,
  pointer,
});

const configSite = (context: ServersContext, pointer: string): Site => ({
  document: context.configDocument,
  pointer,
});

const variablePattern = /\{(?<name>[^{}/?#\s]+)\}/gu;

const variableNames = (text: string): readonly string[] =>
  Arr.dedupe(Array.from(text.matchAll(variablePattern), (match) => match.groups?.name ?? ""));

const authoritySpan = /^(?:[^/?#]*:)?\/\/[^/?#]*/u;

/**
 * The prefix of a template that decides its origin: scheme and authority, or an empty string for a
 * relative path.
 */
const originSpan = (template: string): string => authoritySpan.exec(template)?.[0] ?? "";

type Verdict =
  | { readonly _tag: "Refused"; readonly code: RuleCode }
  | { readonly _tag: "Origin"; readonly origin: DocumentUri };

const refused = (code: RuleCode): Verdict => ({ _tag: "Refused", code });

const isDocumentUri = Schema.is(DocumentUriSchema);

/**
 * Judges one concrete origin text against the baked-default rules and returns its origin as the
 * URL parser reads it.
 */
const judge = (text: string, base: string | undefined, allowInsecure: boolean): Verdict => {
  if (/[?#]/u.test(text)) {
    return refused("SRV-18/query-or-fragment");
  }

  const url = Url.fromString(text, base);

  if (Result.isFailure(url)) {
    return refused("SRV-02/unparseable");
  }

  const parsed = url.success;

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return refused("SRV-02/unsupported-scheme");
  }

  if (parsed.protocol === "http:" && !allowInsecure) {
    return refused("SRV-02/insecure-scheme");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return refused("SRV-02/userinfo");
  }

  return isDocumentUri(parsed.origin)
    ? { _tag: "Origin", origin: parsed.origin }
    : refused("SRV-02/unparseable");
};

const sortOrigins = (origins: readonly DocumentUri[]): readonly DocumentUri[] =>
  Arr.sort(Arr.dedupe(origins), Order.String);

const domainOf = (variable: Variable): readonly string[] =>
  Arr.dedupe([...(variable.enum ?? []), variable.default]);

interface Expansion {
  readonly code?: RuleCode;
  readonly origins: readonly DocumentUri[];
}

const assignments = (
  names: readonly string[],
  variables: Readonly<Record<string, Variable>>,
): readonly ReadonlyMap<string, string>[] =>
  Arr.reduce(names, [new Map()], (acc: readonly ReadonlyMap<string, string>[], name) => {
    const values = domainOf(variables[name] ?? { default: "" });

    return acc.flatMap((assignment) =>
      values.map((value) => new Map<string, string>([...assignment, [name, value]])),
    );
  });

/**
 * Judges the values of the variables outside the origin span, one value at a time with the other
 * variables at their defaults: a value must not carry a query or fragment, and the full URL must
 * stay on one of the origins already accepted. Returns the refusal, if any.
 */
const judgePathValues = (
  raw: RawServer,
  spanNames: readonly string[],
  origins: readonly DocumentUri[],
  base: string | undefined,
): RuleCode | undefined => {
  const variables = raw.variables ?? {};
  const defaults = (name: string) => variables[name]?.default ?? "";

  for (const name of Arr.difference(variableNames(raw.url), spanNames)) {
    for (const value of domainOf(variables[name] ?? { default: "" })) {
      if (/[?#]/u.test(value)) {
        return "SRV-18/query-or-fragment";
      }

      const full = raw.url.replace(variablePattern, (_match, each: string) =>
        each === name ? value : defaults(each),
      );

      const url = Url.fromString(full, base);

      if (Result.isFailure(url)) {
        return "SRV-02/unparseable";
      }

      const { origin } = url.success;

      if (!Arr.contains(origins, origin)) {
        return "SRV-02/value-leaves-authority";
      }
    }
  }

  return undefined;
};

const expandOrigins = (
  raw: RawServer,
  context: ServersContext,
  allowInsecure: boolean,
): Expansion => {
  const span = originSpan(raw.url);
  const { retrievalUri } = context.config;
  const variables = raw.variables ?? {};
  const names = variableNames(span);

  if (span === "" && !raw.url.startsWith("/")) {
    return { code: "SRV-02/unsupported-form", origins: [] };
  }

  if (!/^[^/?#]+:\/\//u.test(span) && retrievalUri === undefined) {
    return { code: "SRV-17/relative-needs-retrieval-uri", origins: [] };
  }

  if (names.some((name) => variables[name]?.enum === undefined)) {
    return { code: "SRV-05/variable-needs-enum", origins: [] };
  }

  const count = Arr.reduce(
    names,
    1,
    (product, name) => product * domainOf(variables[name] ?? { default: "" }).length,
  );

  if (count > maxExpansions) {
    return { code: "SRV-05/too-many-origins", origins: [] };
  }

  const verdicts = assignments(names, variables).map((assignment) =>
    span === ""
      ? judge(retrievalUri ?? "", undefined, allowInsecure)
      : judge(
          span.replace(variablePattern, (_match, name: string) => assignment.get(name) ?? ""),
          retrievalUri,
          allowInsecure,
        ),
  );
  const failure = verdicts.find((verdict) => verdict._tag === "Refused");

  if (failure?._tag === "Refused") {
    return { code: failure.code, origins: [] };
  }

  const origins = sortOrigins(
    verdicts.flatMap((verdict) => (verdict._tag === "Origin" ? [verdict.origin] : [])),
  );
  const valueCode = judgePathValues(raw, names, origins, retrievalUri);

  return valueCode === undefined ? { origins } : { code: valueCode, origins: [] };
};

const acceptedIndex = (raw: RawServer, line32: boolean, config: AuthorConfig): number =>
  (config.servers?.accepted ?? []).findIndex(
    (entry) => entry === raw.url || (line32 && raw.name !== undefined && entry === raw.name),
  );

const rowsOf = (raw: RawServer, level: ServerLevel, implicit: boolean): readonly string[] =>
  Arr.sort(
    [
      "SRV-01",
      "SRV-02",
      ...(Object.keys(raw.variables ?? {}).length > 0 ? ["SRV-05", "SRV-11"] : []),
      ...(implicit ? ["SRV-10"] : []),
      ...(level === "root" ? [] : ["SRV-15"]),
    ],
    Order.String,
  );

interface Built {
  readonly diagnostics: readonly Diagnostic[];
  readonly server?: Server;
}

const nameOf = (raw: RawServer, line32: boolean): string | undefined =>
  line32 && raw.name !== undefined && Schema.is(SafeText)(raw.name) ? raw.name : undefined;

const build = (
  raw: RawServer,
  level: ServerLevel,
  pointer: string,
  implicit: boolean,
  context: ServersContext,
): Built => {
  const site = specSite(context, pointer);

  if (!Schema.is(ServerTemplate)(raw.url)) {
    return { diagnostics: [diagnose(context, "SRV-19/invalid-template", site)] };
  }

  const variables = raw.variables ?? {};

  if (variableNames(raw.url).some((name) => variables[name] === undefined)) {
    return { diagnostics: [diagnose(context, "SRV-11/undeclared-variable", site)] };
  }

  const line32 = context.openapi.startsWith("3.2");
  const index = acceptedIndex(raw, line32, context.config);
  const hasQuery = /[?#]/u.test(raw.url);
  const expansion: Expansion =
    index === -1 || hasQuery
      ? { origins: [] }
      : expandOrigins(raw, context, context.config.allowInsecure === true);
  const code = index !== -1 && hasQuery ? "SRV-18/query-or-fragment" : expansion.code;
  const failed = code !== undefined;
  const name = nameOf(raw, line32);

  const fields = {
    accepted: index !== -1 && !failed,
    level,
    origin: { document: context.document, pointer },
    origins: failed ? [] : expansion.origins,
    rows: rowsOf(raw, level, implicit),
    template: raw.url,
    variables: Arr.sort(
      Object.entries(variables).map(([variable, { default: fallback, enum: members }]) =>
        members === undefined
          ? { default: fallback, name: variable }
          : { default: fallback, enum: members, name: variable },
      ),
      Order.mapInput(Order.String, (variable: { readonly name: string }) => variable.name),
    ),
  };
  const server = Schema.decodeUnknownSync(Server)(
    name === undefined ? fields : { ...fields, name },
  );

  return {
    diagnostics:
      code === undefined
        ? []
        : [
            diagnose(
              context,
              code,
              configSite(context, formatPointer(["servers", "accepted", String(index)])),
            ),
          ],
    server,
  };
};

const parseRaw = Schema.decodeUnknownOption(rawServer);

const normalizeLevel = (
  source: ServerSource,
  level: ServerLevel,
  context: ServersContext,
): ServersResult => {
  const { pointer, value } = source;

  if (value === undefined || (Arr.isArray(value) && value.length === 0 && level === "root")) {
    const built = build({ url: "/" }, level, pointer, true, context);

    return {
      diagnostics: built.diagnostics,
      servers: Arr.fromNullishOr(built.server),
    };
  }

  if (!Arr.isArray(value)) {
    return {
      diagnostics: [diagnose(context, "SRV-01/invalid-server", specSite(context, pointer))],
      servers: [],
    };
  }

  if (value.length === 0) {
    return {
      diagnostics: [diagnose(context, "SRV-16/empty-override", specSite(context, pointer))],
      servers: [],
    };
  }

  const built = value.map((entry, index) => {
    const itemPointer = childPointer(pointer, String(index));
    const raw = parseRaw(entry);

    return Option.isSome(raw)
      ? build(raw.value, level, itemPointer, false, context)
      : {
          diagnostics: [diagnose(context, "SRV-01/invalid-server", specSite(context, itemPointer))],
        };
  });

  return {
    diagnostics: built.flatMap((b) => b.diagnostics),
    servers: Arr.getSomes(built.map((b) => Option.fromUndefinedOr(b.server))),
  };
};

/**
 * Chooses the servers an operation uses (operation, then path item, then root) and normalizes that
 * level. An empty override at the operation or path item is refused; an absent or empty root means
 * the single server `/`. A spec server is accepted only when the author config lists it.
 */
export const effectiveServers = (levels: ServerLevels, context: ServersContext): ServersResult => {
  if (levels.operation?.value !== undefined) {
    return normalizeLevel(levels.operation, "operation", context);
  }

  if (levels.pathItem?.value !== undefined) {
    return normalizeLevel(levels.pathItem, "pathItem", context);
  }

  return normalizeLevel(levels.root, "root", context);
};

interface AcceptedOrigin {
  readonly diagnostics: readonly Diagnostic[];
  readonly origin?: DocumentUri;
}

const acceptedOrigin = (entry: string, index: number, context: ServersContext): AcceptedOrigin => {
  const site = configSite(context, formatPointer(["acceptedOrigins", String(index)]));
  const verdict = judge(entry, undefined, context.config.allowInsecure === true);

  if (verdict._tag === "Refused") {
    return { diagnostics: [diagnose(context, verdict.code, site)] };
  }

  const parsed = new URL(entry);

  return parsed.pathname === "/" && parsed.search === "" && parsed.hash === ""
    ? { diagnostics: [], origin: verdict.origin }
    : { diagnostics: [diagnose(context, "SRV-02/not-an-origin", site)] };
};

/**
 * The bound origin set (design 6.4, 9 I3): the origins of the accepted servers' expansions plus the
 * author's `acceptedOrigins`, each checked against the baked-default rules.
 */
export const boundOrigins = (servers: readonly Server[], context: ServersContext): BoundOrigins => {
  const listed = (context.config.acceptedOrigins ?? []).map((entry, index) =>
    acceptedOrigin(entry, index, context),
  );

  return {
    diagnostics: listed.flatMap((entry) => entry.diagnostics),
    origins: sortOrigins([
      ...servers.flatMap((server) => (server.accepted ? server.origins : [])),
      ...Arr.getSomes(listed.map((entry) => Option.fromUndefinedOr(entry.origin))),
    ]),
  };
};
