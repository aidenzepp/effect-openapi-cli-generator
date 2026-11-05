import { Effect, Option, Schema } from "effect";
import { CookieName, HeaderName } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import { SecurityPolicy, SecurityScheme } from "../model/entities.ts";
import type { Resolution } from "../resolve/index.ts";
import { implicitComponent, referenceAt } from "../resolve/index.ts";
import { escapeToken, evaluatePointer, unescapeToken, formatPointer } from "../model/pointer.ts";
import type { Json } from "../model/pointer.ts";
import { specSectionUrl } from "../model/spec-section.ts";

/**
 * The declared schemes of a document. `unusable` names schemes that were declared but refused, so
 * an alternative naming one is refused with it rather than treated as undeclared.
 */
export interface SchemeNormalization {
  readonly diagnostics: readonly Diagnostic[];
  readonly schemes: readonly SecurityScheme[];
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
  readonly element: string;
  readonly hint?: string;
  readonly message: string;
  readonly pointer: string;
  readonly related?: string;
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
    document: resolution.document,
    element: finding.element,
    message: finding.message,
    openapi,
    pointer: finding.pointer,
    row,
    scope: "element",
    severity: "refusal",
    specSection: specSectionUrl(resolution.line, finding.anchor),
  };
  const withHint = finding.hint === undefined ? base : { ...base, hint: finding.hint };
  const related = [{ document: resolution.document, pointer: finding.related }];
  const fields = finding.related === undefined ? withHint : { ...withHint, related };

  return Schema.decodeUnknownEffect(Diagnostic)(fields).pipe(Effect.orDie);
};

const nodeAt = (resolution: Resolution, pointer: string): Option.Option<Json> =>
  Effect.runSync(
    evaluatePointer(resolution.value, pointer).pipe(
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

const buildScheme = (resolution: Resolution, name: string, pointer: string): Built => {
  const target = referenceAt(resolution, pointer)?.target.pointer ?? pointer;
  const fields = nodeAt(resolution, target).pipe(
    Option.flatMap((json) => Schema.decodeUnknownOption(SchemeNode)(json)),
  );
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
          origin: { document: resolution.document, pointer },
          rows: ["SSC-01", modelled.row],
        });

  return Option.isNone(decoded)
    ? invalidScheme(pointer)
    : { findings: acquisitionFindings(node, pointer), scheme: decoded.value };
};

/**
 * Normalizes `components.securitySchemes` into scheme entities (design 6.5). A scheme that cannot
 * be modelled is refused at element scope and listed in `unusable`. An `oauth2` or `openIdConnect`
 * scheme stays modelled and its token acquisition is refused at element scope (D-SEC1).
 */
export const normalizeSecuritySchemes = (
  resolution: Resolution,
): Effect.Effect<SchemeNormalization> =>
  Effect.gen(function* normalize() {
    const names = nodeAt(resolution, "/components/securitySchemes").pipe(
      Option.flatMap((json) => Schema.decodeUnknownOption(JsonMap)(json)),
      Option.match({ onNone: () => [], onSome: (map) => Object.keys(map) }),
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
    const diagnostics = yield* Effect.all(
      built.flatMap((one) => one.findings).map((finding) => toDiagnostic(resolution, finding)),
    );

    return {
      diagnostics,
      schemes: built.flatMap((one) => (one.scheme === undefined ? [] : [one.scheme])),
      unusable: names.filter((_, index) => built[index]?.scheme === undefined),
    };
  });

interface Lookup {
  readonly declared: ReadonlyMap<string, SecurityScheme>;
  readonly unusable: ReadonlySet<string>;
}

// Built once per SchemeNormalization, so a requirement entry costs one map probe.
const lookups = new WeakMap<SchemeNormalization, Lookup>();

const lookupOf = (schemes: SchemeNormalization): Lookup => {
  const cached = lookups.get(schemes);
  if (cached !== undefined) {
    return cached;
  }

  const built = {
    declared: new Map(schemes.schemes.map((scheme) => [scheme.name, scheme])),
    unusable: new Set(schemes.unusable),
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
    const list = nodeAt(resolution, source.pointer).pipe(
      Option.flatMap((json) => Schema.decodeUnknownOption(AlternativeList)(json)),
    );
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

const judge = (
  resolution: Resolution,
  schemes: SchemeNormalization,
  entries: readonly (readonly [string, readonly string[]])[],
  pointer: string,
): Judged => {
  const findings: Finding[] = [];
  const staged = new Set<string>();
  const { declared: byName, unusable } = lookupOf(schemes);
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
      findings.push(
        unusable.has(resolved)
          ? {
              anchor: "security-requirements-name",
              code: "SEC-02/unusable-scheme",
              element: "Security Requirement Object",
              message: "The requirement names a security scheme that is refused.",
              pointer: `${pointer}/${escapeToken(name)}`,
              related: formatPointer(["components", "securitySchemes", resolved]),
            }
          : {
              anchor: "security-requirements-name",
              code: "SEC-09/undeclared-scheme",
              element: "Security Requirement Object",
              message: "The requirement names a security scheme that is not declared.",
              pointer: `${pointer}/${escapeToken(name)}`,
            },
      );
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

  return findings.length > 0 ? { findings } : { findings, use: used };
};

/**
 * Normalizes the effective security policy of an operation, or of the root when `operation` is
 * omitted (design 6.5). `operation` is the pointer of the operation object. An alternative that
 * names an undeclared or refused scheme, or an `oauth2`, `openIdConnect` or `mutualTLS` scheme
 * (staged, SSC-18 to SSC-20), is removed whole with element-scope refusals and never dropped
 * silently. Raising an operation with no alternative left is the caller's job (`listed`).
 */
export const normalizeSecurityPolicy = (
  resolution: Resolution,
  schemes: SchemeNormalization,
  operation?: string,
): Effect.Effect<PolicyNormalization> =>
  Effect.gen(function* normalize() {
    const effective = effectiveList(resolution, operation);
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
        : judge(resolution, schemes, entries.value, pointer);
    });
    const diagnostics = yield* Effect.all(
      judged.flatMap((one) => one.findings).map((finding) => toDiagnostic(resolution, finding)),
    );
    const policy = yield* Schema.decodeUnknownEffect(SecurityPolicy)({
      alternatives: judged.flatMap((one) => (one.use === undefined ? [] : [{ uses: one.use }])),
      declared: effective !== undefined,
      origin: { document: resolution.document, pointer: source.pointer },
      rows: source.rows,
    }).pipe(Effect.orDie);

    return { diagnostics, listed: judged.length, policy };
  });
