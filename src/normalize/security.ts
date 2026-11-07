import { Effect, Option, Schema } from "effect";
import type { AuthorConfig } from "../model/author-config.ts";
import { CookieName, HeaderName } from "../model/brands.ts";
import type { DocumentUri } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import { SecurityPolicy, SecurityScheme } from "../model/entities.ts";
import type { Resolution } from "../resolve/index.ts";
import { implicitComponent } from "../resolve/index.ts";
import type { CanonicalKey } from "../resolve/canonical.ts";
import { escapeToken, unescapeToken, formatPointer } from "../model/pointer.ts";
import type { Json } from "../model/pointer.ts";
import { specSectionUrl } from "../model/spec-section.ts";
import { follow, nodeIn } from "./document-set.ts";

/**
 * The declared schemes of a document. `unusable` names schemes that were declared but refused, so
 * an alternative naming one is refused with it rather than treated as undeclared. `checkRefused`
 * holds the pointers of the requirement names check refused as unresolved. `added` names the
 * schemes `security.add` supplies that no declared scheme shares; only the author requirement
 * reaches them, so a spec requirement naming one stays undeclared (AS-1).
 */
export interface SchemeNormalization {
  readonly added: ReadonlySet<string>;
  readonly checkRefused: ReadonlySet<string>;
  readonly diagnostics: readonly Diagnostic[];
  readonly schemes: readonly SecurityScheme[];
  // The author-supplied requirement (D-OQ3 (b)), carried here so every policy built from these
  // schemes applies it where the spec declares no security.
  readonly supplied:
    | {
        readonly document: typeof DocumentUri.Type;
        readonly requirement: readonly Readonly<Record<string, readonly string[]>>[];
      }
    | undefined;
  readonly unusable: readonly string[];
}

/**
 * An effective policy. `listed` is the number of alternatives the effective list held before any
 * were refused; a caller raises an operation only when `listed > 0` and none remain.
 */
export interface PolicyNormalization {
  readonly diagnostics: readonly Diagnostic[];
  readonly listed: number;
  readonly policy: SecurityPolicy;
}

interface Finding {
  readonly anchor: string;
  readonly code: string;
  // The document the finding points into when it is not the spec (an author config finding).
  readonly document?: typeof DocumentUri.Type;
  readonly element: string;
  readonly hint?: string;
  readonly message: string;
  readonly pointer: string;
  readonly related?: string;
  // Element scope unless the finding refuses the whole document.
  readonly scope?: "document";
}

interface Built {
  readonly findings: readonly Finding[];
  readonly scheme?: SecurityScheme;
}

const SchemeNode = Schema.Struct({
  deprecated: Schema.optionalKey(Schema.Boolean),
  flows: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  in: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  scheme: Schema.optionalKey(Schema.String),
  type: Schema.String,
});

type SchemeFields = typeof SchemeNode.Type;

const JsonMap = Schema.Record(Schema.String, Schema.Json);

const Requirement = Schema.Record(Schema.String, Schema.Array(Schema.String));

const AlternativeList = Schema.Array(Schema.Json);

const Declared = Schema.Struct({ openapi: Schema.String });

const flowRules = new Map([
  [
    "authorizationCode",
    { anchor: "oauth-flows-authorization-code", permanent: false, row: "OAF-05" },
  ],
  [
    "clientCredentials",
    { anchor: "oauth-flows-client-credentials", permanent: false, row: "OAF-04" },
  ],
  [
    "deviceAuthorization",
    { anchor: "oauth-flows-device-authorization", permanent: false, row: "OAF-06" },
  ],
  ["implicit", { anchor: "oauth-flows-implicit", permanent: true, row: "OAF-02" }],
  ["password", { anchor: "oauth-flows-password", permanent: true, row: "OAF-03" }],
]);

// Staged refusals by modelled scheme kind (design 2.4 Staged features). The hint, never the code,
// names the milestone.
const stagedRules = new Map([
  ["mutualTls", { code: "SSC-20/not-implemented", what: "mutualTLS client certificates" }],
  ["oauth2Token", { code: "SSC-18/not-implemented", what: "oauth2 token pass-through" }],
  ["oidcToken", { code: "SSC-19/not-implemented", what: "openIdConnect token pass-through" }],
]);

const acquisitionHint = (permanent: boolean): string =>
  permanent
    ? "This flow is permanently refused. Supply an access token obtained elsewhere."
    : "The generated CLI does not acquire tokens. Supply an access token obtained elsewhere.";

const toDiagnostic = (resolution: Resolution, finding: Finding): Effect.Effect<Diagnostic> => {
  const [row] = finding.code.split("/");
  const openapi = Schema.decodeUnknownOption(Declared)(resolution.value).pipe(
    Option.map((declared) => declared.openapi),
    Option.getOrElse(() => "unknown"),
  );
  const base = {
    code: finding.code,
    document: finding.document ?? resolution.document,
    element: finding.element,
    message: finding.message,
    openapi,
    pointer: finding.pointer,
    row,
    scope: finding.scope ?? "element",
    severity: "refusal",
    specSection: specSectionUrl(resolution.line, finding.anchor),
  };
  const withHint = finding.hint === undefined ? base : { ...base, hint: finding.hint };
  const related = [{ document: resolution.document, pointer: finding.related }];
  const fields = finding.related === undefined ? withHint : { ...withHint, related };

  return Schema.decodeUnknownEffect(Diagnostic)(fields).pipe(Effect.orDie);
};

const nodeAt = (resolution: Resolution, at: CanonicalKey): Option.Option<Json> =>
  Effect.runSync(
    nodeIn(resolution, at).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<Json>()),
    ),
  );

const invalidScheme = (pointer: string): Built => ({
  findings: [
    {
      anchor: "security-scheme-type",
      code: "SSC-02/invalid-scheme",
      element: "Security Scheme Object",
      message: "The security scheme is malformed.",
      pointer,
    },
  ],
});

const acquisitionFindings = (fields: SchemeFields, pointer: string): readonly Finding[] => {
  if (fields.type === "openIdConnect") {
    return [
      {
        anchor: "security-scheme-open-id-connect-url",
        code: "SSC-19/token-acquisition",
        element: "Security Scheme Object",
        hint: acquisitionHint(false),
        message: "Token acquisition through OpenID Connect is refused.",
        pointer,
      },
    ];
  }

  return Object.keys(fields.flows ?? {}).flatMap((flow): readonly Finding[] => {
    const rule = fields.type === "oauth2" ? flowRules.get(flow) : undefined;

    return rule === undefined
      ? []
      : [
          {
            anchor: rule.anchor,
            code: `${rule.row}/token-acquisition`,
            element: "OAuth Flow Object",
            hint: acquisitionHint(rule.permanent),
            message: "Token acquisition through this OAuth flow is refused.",
            pointer: `${pointer}/flows/${escapeToken(flow)}`,
          },
        ];
  });
};

const apiKeyRows = new Map([
  ["cookie", "SSC-14"],
  ["header", "SSC-12"],
  ["query", "SSC-13"],
]);

// The modelled kind and inventory row of a scheme node, or undefined when the type is unknown.
const kindOf = (
  fields: SchemeFields,
): { readonly kind: unknown; readonly row: string } | undefined => {
  if (fields.type === "apiKey") {
    return {
      kind: { in: fields.in, name: fields.name, type: "apiKey" },
      row: apiKeyRows.get(fields.in ?? "") ?? "SSC-05",
    };
  }

  if (fields.type === "http") {
    const scheme = fields.scheme?.toLowerCase();

    return { kind: { scheme, type: "http" }, row: scheme === "basic" ? "SSC-15" : "SSC-16" };
  }

  if (fields.type === "mutualTLS") {
    return { kind: { type: "mutualTls" }, row: "SSC-20" };
  }

  if (fields.type === "oauth2") {
    return { kind: { flows: {}, type: "oauth2Token" }, row: "SSC-18" };
  }

  return fields.type === "openIdConnect"
    ? { kind: { type: "oidcToken", url: {} }, row: "SSC-19" }
    : undefined;
};

/**
 * Where a scheme is declared: its pointer, the document that holds it and whether the spec or the
 * author config declares it. A finding about an author-supplied scheme points into the config.
 */
interface Site {
  readonly document: typeof DocumentUri.Type;
  readonly pointer: string;
  readonly source: SecurityScheme["source"];
}

const modelFields = (name: string, site: Site, fields: Option.Option<SchemeFields>): Built => {
  const { pointer } = site;
  if (Option.isNone(fields)) {
    return invalidScheme(pointer);
  }

  const node = fields.value;
  const scheme = node.scheme?.toLowerCase();
  if (node.type === "http" && scheme !== "basic" && scheme !== "bearer") {
    return {
      findings: [
        {
          anchor: "security-scheme-scheme",
          code: "SSC-17/unsupported-scheme",
          element: "Security Scheme Object",
          hint: "Only the basic and bearer http schemes are supported.",
          message: "The http authentication scheme is not supported.",
          pointer,
        },
      ],
    };
  }

  if (
    node.type === "apiKey" &&
    node.in === "cookie" &&
    node.name !== undefined &&
    Option.isNone(Schema.decodeUnknownOption(CookieName)(node.name))
  ) {
    return {
      findings: [
        {
          anchor: "security-scheme-name",
          code: "SSC-14/invalid-cookie-name",
          element: "Security Scheme Object",
          hint: 'A cookie name must be an RFC 6265 token: no space, control, or any of ()<>@,;:\\"/[]?={}.',
          message: "The cookie apiKey name is not a valid cookie name.",
          pointer,
        },
      ],
    };
  }

  if (
    node.type === "apiKey" &&
    node.in === "header" &&
    node.name !== undefined &&
    Option.isNone(Schema.decodeUnknownOption(HeaderName)(node.name))
  ) {
    return {
      findings: [
        {
          anchor: "security-scheme-name",
          code: "SSC-12/invalid-header-name",
          element: "Security Scheme Object",
          hint: 'A header name must be an RFC 9110 token: no space, control, non-ASCII, or any of ()<>@,;:\\"/[]?={}.',
          message: "The header apiKey name is not a valid header name.",
          pointer,
        },
      ],
    };
  }

  const modelled = kindOf(node);
  const decoded =
    modelled === undefined
      ? Option.none<SecurityScheme>()
      : Schema.decodeUnknownOption(SecurityScheme)({
          credentialSources: node.type === "mutualTLS" ? ["env"] : ["file", "env", "prompt"],
          deprecated: node.deprecated ?? false,
          kind: modelled.kind,
          name,
          origin: { document: site.document, pointer },
          rows: ["SSC-01", modelled.row],
          source: site.source,
        });

  return Option.isNone(decoded)
    ? invalidScheme(pointer)
    : { findings: acquisitionFindings(node, pointer), scheme: decoded.value };
};

// Models one scheme node. An author-supplied scheme is judged by the same rules as a declared one;
// only the document its findings and origin name differs.
const modelScheme = (name: string, site: Site, fields: Option.Option<SchemeFields>): Built => {
  const built = modelFields(name, site, fields);

  return site.source === "spec"
    ? built
    : {
        ...built,
        findings: built.findings.map((finding) => ({ ...finding, document: site.document })),
      };
};

const buildScheme = (resolution: Resolution, name: string, pointer: string): Built => {
  const target = follow(resolution, { document: resolution.document, pointer });

  return modelScheme(
    name,
    { document: resolution.document, pointer, source: "spec" },
    nodeAt(resolution, target).pipe(
      Option.flatMap((json) => Schema.decodeUnknownOption(SchemeNode)(json)),
    ),
  );
};

/**
 * What author-supplied security needs: the author config and the document it was read from
 * (D-OQ3 (b)).
 */
export interface AuthorSecurity {
  readonly config: AuthorConfig;
  readonly configDocument: typeof DocumentUri.Type;
}

const addRequirementPointer = "/security/add/requirement";

const collision = (author: AuthorSecurity, name: string): Finding => ({
  anchor: "security-scheme-object",
  code: "CFG-1/scheme-name-collision",
  document: author.configDocument,
  element: "Author config",
  hint: "Rename the added scheme; the spec already declares a security scheme with this name.",
  message: "An added security scheme has the name of a declared one.",
  pointer: formatPointer(["security", "add", "schemes", name]),
  scope: "document",
});

interface Added {
  readonly built: readonly Built[];
  readonly names: readonly string[];
}

// The schemes `security.add` contributes, in config order. A collision with a declared name is a
// document-scope refusal and the added scheme is dropped.
const addedSchemes = (declared: ReadonlySet<string>, author: AuthorSecurity | undefined): Added => {
  const entries = Object.entries(author?.config.security?.add?.schemes ?? {});
  const built = entries.map(([name, node]): Built => {
    if (author === undefined) {
      return { findings: [] };
    }

    return declared.has(name)
      ? { findings: [collision(author, name)] }
      : modelScheme(
          name,
          {
            document: author.configDocument,
            pointer: formatPointer(["security", "add", "schemes", name]),
            source: "author-supplied",
          },
          Schema.decodeUnknownOption(SchemeNode)(node),
        );
  });

  return { built, names: entries.map(([name]) => name) };
};

// The codes check raises at a requirement name that reaches no scheme (src/check/grammar.ts).
const unresolvedCodes: ReadonlySet<string> = new Set([
  "SEC-09/unresolved-scheme",
  "SEC-10/unresolved-scheme",
]);

/**
 * Normalizes `components.securitySchemes` into scheme entities (design 6.5). A scheme that cannot
 * be modelled is refused at element scope and listed in `unusable`. An `oauth2` or `openIdConnect`
 * scheme stays modelled and its token acquisition is refused at element scope (D-SEC1). With
 * `author`, the schemes of `security.add` follow the declared ones, marked `author-supplied`; a
 * name that is also declared is refused at document scope and the declared scheme stays.
 * `checkFindings` are the spec-text check findings of the run; a requirement name they refuse as
 * unresolved gets no second diagnostic from `normalizeSecurityPolicy`.
 */
export const normalizeSecuritySchemes = (
  resolution: Resolution,
  author: AuthorSecurity | undefined,
  checkFindings: readonly Diagnostic[],
): Effect.Effect<SchemeNormalization> =>
  Effect.gen(function* normalize() {
    const schemes = { document: resolution.document, pointer: "/components/securitySchemes" };
    const names = nodeAt(resolution, schemes).pipe(
      Option.flatMap((json) => Schema.decodeUnknownOption(JsonMap)(json)),
      Option.match({ onNone: (): string[] => [], onSome: (map) => Object.keys(map) }),
    );
    const refused = new Set<string>(
      resolution.diagnostics
        .filter((diagnostic) => diagnostic.code === "SEC-10/uri-like-name")
        .map((diagnostic) => diagnostic.pointer),
    );
    const built = names.map((name): Built => {
      const pointer = formatPointer(["components", "securitySchemes", name]);

      // SEC-10 is already refused by resolve; the scheme is never modelled or given credentials.
      return refused.has(pointer) ? { findings: [] } : buildScheme(resolution, name, pointer);
    });
    const extra = addedSchemes(new Set(names), author);
    const all = [...built, ...extra.built];
    const diagnostics = yield* Effect.all(
      all.flatMap((one) => one.findings).map((finding) => toDiagnostic(resolution, finding)),
    );

    const requirement = author?.config.security?.add?.requirement;
    const supplied =
      author === undefined || requirement === undefined
        ? undefined
        : { document: author.configDocument, requirement };

    return {
      added: new Set(extra.names.filter((name) => !names.includes(name))),
      checkRefused: new Set(
        checkFindings
          .filter(
            (finding) =>
              finding.document === resolution.document && unresolvedCodes.has(finding.code),
          )
          .map((finding) => finding.pointer),
      ),
      diagnostics,
      schemes: all.flatMap((one) => (one.scheme === undefined ? [] : [one.scheme])),
      supplied,
      unusable: [
        ...names.filter((_, index) => built[index]?.scheme === undefined),
        // An added name that collides keeps meaning the declared scheme, so it is never unusable.
        ...extra.names.filter(
          (name, index) => !names.includes(name) && extra.built[index]?.scheme === undefined,
        ),
      ],
    };
  });

interface Scope {
  readonly declared: ReadonlyMap<string, SecurityScheme>;
  readonly unusable: ReadonlySet<string>;
}

// The author requirement reaches every scheme; a spec requirement reaches only the spec's (AS-1).
interface Lookup {
  readonly author: Scope;
  readonly spec: Scope;
}

// Built once per SchemeNormalization, so a requirement entry costs one map probe.
const lookups = new WeakMap<SchemeNormalization, Lookup>();

const lookupOf = (schemes: SchemeNormalization): Lookup => {
  const cached = lookups.get(schemes);
  if (cached !== undefined) {
    return cached;
  }

  const built = {
    author: {
      declared: new Map(schemes.schemes.map((scheme) => [scheme.name, scheme])),
      unusable: new Set(schemes.unusable),
    },
    spec: {
      declared: new Map(
        schemes.schemes
          .filter((scheme) => scheme.source === "spec")
          .map((scheme) => [scheme.name, scheme]),
      ),
      unusable: new Set(schemes.unusable.filter((name) => !schemes.added.has(name))),
    },
  };
  lookups.set(schemes, built);

  return built;
};

const componentPrefix = "/components/securitySchemes/";

// A 3.2 requirement name that is not a component name resolves as a URI inside the set. The result
// is the component name it reaches, or undefined when it reaches nothing that is a component.
const uriComponentName = (resolution: Resolution, name: string): string | undefined => {
  if (resolution.line !== "3.2") {
    return undefined;
  }

  const key = implicitComponent(resolution, "securitySchemes", name);
  if (Option.isNone(key) || !key.value.pointer.startsWith(componentPrefix)) {
    return undefined;
  }

  const token = key.value.pointer.slice(componentPrefix.length);

  return token.includes("/")
    ? undefined
    : Option.getOrUndefined(Effect.runSync(Effect.option(unescapeToken(token))));
};

interface Source {
  readonly pointer: string;
  readonly rows: readonly string[];
}

// Operation `security` replaces the root list; with neither the policy is undeclared (design 6.5).
const effectiveList = (
  resolution: Resolution,
  operation: string | undefined,
): { readonly list: readonly Json[]; readonly source: Source } | undefined => {
  const candidates: readonly Source[] = [
    ...(operation === undefined
      ? []
      : [{ pointer: `${operation}/security`, rows: ["SEC-01", "SEC-04"] }]),
    { pointer: "/security", rows: ["SEC-01", "SEC-03"] },
  ];
  for (const source of candidates) {
    const list = nodeAt(resolution, {
      document: resolution.document,
      pointer: source.pointer,
    }).pipe(Option.flatMap((json) => Schema.decodeUnknownOption(AlternativeList)(json)));
    if (Option.isSome(list)) {
      return { list: list.value, source };
    }
  }

  return undefined;
};

interface Judged {
  readonly findings: readonly Finding[];
  readonly use?: readonly { readonly scheme: string; readonly scopes: readonly string[] }[];
}

interface Named {
  readonly checkRefused: ReadonlySet<string>;
  readonly name: string;
  readonly pointer: string;
  readonly resolved: string;
  // The entries come from the author config, which check never reads.
  readonly supplied: boolean;
  readonly unusable: ReadonlySet<string>;
}

// The refusal of a requirement name that names no usable scheme, or `checked` when check already
// raised the one diagnostic for it; either way its alternative is dropped.
const nameRefusal = (resolution: Resolution, named: Named): Finding | "checked" => {
  const { name, resolved } = named;
  const pointer = `${named.pointer}/${escapeToken(name)}`;
  if (named.unusable.has(resolved)) {
    return {
      anchor: "security-requirements-name",
      code: "SEC-02/unusable-scheme",
      element: "Security Requirement Object",
      message: "The requirement names a security scheme that is refused.",
      pointer,
      related: formatPointer(["components", "securitySchemes", resolved]),
    };
  }

  if (!named.supplied && named.checkRefused.has(pointer)) {
    return "checked";
  }

  return {
    anchor: "security-requirements-name",
    code: `${resolution.line === "3.2" ? "SEC-10" : "SEC-09"}/undeclared-scheme`,
    element: "Security Requirement Object",
    message: "The requirement names a security scheme that is not declared.",
    pointer,
  };
};

// `supplied`: the entries come from the author config, so they alone reach the added schemes and
// normalize reports their undeclared names itself.
const judge = (
  resolution: Resolution,
  schemes: SchemeNormalization,
  entries: readonly (readonly [string, readonly string[]])[],
  pointer: string,
  supplied: boolean,
): Judged => {
  const findings: Finding[] = [];
  let refused = false;
  const staged = new Set<string>();
  const lookup = lookupOf(schemes);
  const { declared: byName, unusable } = supplied ? lookup.author : lookup.spec;
  const used: { readonly scheme: string; readonly scopes: readonly string[] }[] = [];
  for (const [name, scopes] of entries) {
    const exact = byName.has(name) || unusable.has(name);
    const resolved = exact ? name : (uriComponentName(resolution, name) ?? name);
    const declared = byName.get(resolved);
    if (declared !== undefined) {
      used.push({ scheme: resolved, scopes });
    }

    if (declared !== undefined && stagedRules.has(declared.kind.type)) {
      staged.add(declared.kind.type);
    } else if (declared === undefined) {
      const refusal = nameRefusal(resolution, {
        checkRefused: schemes.checkRefused,
        name,
        pointer,
        resolved,
        supplied,
        unusable,
      });
      if (refusal === "checked") {
        refused = true;
      } else {
        findings.push(refusal);
      }
    }
  }

  for (const kind of staged) {
    const rule = stagedRules.get(kind);
    findings.push({
      anchor: "security-requirement-object",
      code: rule?.code ?? "SEC-01/not-implemented",
      element: "Security Requirement Object",
      hint: `Milestone 3 implements ${rule?.what}; until then this alternative is refused. Use another alternative.`,
      message: "The alternative names a security scheme that is not yet implemented.",
      pointer,
    });
  }

  return findings.length > 0 || refused ? { findings } : { findings, use: used };
};

/**
 * Normalizes the effective security policy of an operation, or of the root when `operation` is
 * omitted (design 6.5). `operation` is the pointer of the operation object. An alternative that
 * names an undeclared or refused scheme, or an `oauth2`, `openIdConnect` or `mutualTLS` scheme
 * (staged, SSC-18 to SSC-20), is removed whole with element-scope refusals and never dropped
 * silently. A spec name check already refused as unresolved keeps that one diagnostic and gets no
 * second here. Raising an operation with no alternative left is the caller's job (`listed`).
 */
export const normalizeSecurityPolicy = (
  resolution: Resolution,
  schemes: SchemeNormalization,
  operation?: string,
): Effect.Effect<PolicyNormalization> =>
  Effect.gen(function* normalize() {
    const spec = effectiveList(resolution, operation);
    // `security.add` applies as if declared, only where the spec declares no security (D-OQ10).
    const supplied =
      spec === undefined && schemes.supplied !== undefined
        ? {
            document: schemes.supplied.document,
            list: schemes.supplied.requirement,
            source: { pointer: addRequirementPointer, rows: ["CFG-1", "SEC-01", "SEC-08"] },
          }
        : undefined;
    const effective =
      supplied ?? (spec === undefined ? undefined : { ...spec, document: resolution.document });
    const source = effective?.source ?? { pointer: operation ?? "", rows: ["SEC-08"] };
    const judged = (effective?.list ?? []).map((json, index) => {
      const pointer = `${source.pointer}/${index}`;
      const entries = Schema.decodeUnknownOption(Requirement)(json).pipe(
        Option.map((requirement) => Object.entries(requirement)),
      );

      return Option.isNone(entries)
        ? {
            findings: [
              {
                anchor: "security-requirement-object",
                code: "SEC-01/invalid-requirement",
                element: "Security Requirement Object",
                message: "The security requirement is malformed.",
                pointer,
              },
            ],
          }
        : judge(resolution, schemes, entries.value, pointer, supplied !== undefined);
    });
    const diagnostics = yield* Effect.all(
      judged
        .flatMap((one) => one.findings)
        .map((finding) =>
          toDiagnostic(
            resolution,
            supplied === undefined ? finding : { ...finding, document: supplied.document },
          ),
        ),
    );
    const policy = yield* Schema.decodeUnknownEffect(SecurityPolicy)({
      alternatives: judged.flatMap((one) => (one.use === undefined ? [] : [{ uses: one.use }])),
      declared: effective !== undefined,
      origin: { document: effective?.document ?? resolution.document, pointer: source.pointer },
      rows: source.rows,
    }).pipe(Effect.orDie);

    return { diagnostics, listed: judged.length, policy };
  });
