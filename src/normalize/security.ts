import { Array as Arr, Effect, Option, pipe, Result, Schema, UndefinedOr } from "effect";
import { memoize } from "effect/Function";
import type { AuthorConfig } from "../model/author-config.ts";
import { CookieName, HeaderName } from "../model/brands.ts";
import type { DocumentUri } from "../model/brands.ts";
import { makeDiagnostic } from "../model/diagnostic.ts";
import type { Diagnostic } from "../model/diagnostic.ts";
import { SecurityPolicy, SecurityScheme } from "../model/entities.ts";
import type { Resolution } from "../resolve/index.ts";
import { declaredOpenapi } from "../validate/dispatch.ts";
import type { Line } from "../validate/index.ts";
import { implicitComponent } from "../resolve/index.ts";
import { childPointer, formatPointer, parsePointerResult } from "../model/pointer.ts";
import type { Json } from "../model/pointer.ts";
import { specSectionUrl } from "../model/spec-section.ts";
import { sanitize } from "./docs.ts";
import { follow, nodeOption } from "./document-set.ts";

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
  // Each related site; one without a document points into the spec.
  readonly related?: readonly {
    readonly document?: typeof DocumentUri.Type;
    readonly pointer: string;
  }[];
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
  oauth2MetadataUrl: Schema.optionalKey(Schema.String),
  openIdConnectUrl: Schema.optionalKey(Schema.String),
  scheme: Schema.optionalKey(Schema.String),
  type: Schema.String,
});

const FlowNode = Schema.Struct({
  authorizationUrl: Schema.optionalKey(Schema.String),
  deviceAuthorizationUrl: Schema.optionalKey(Schema.String),
  refreshUrl: Schema.optionalKey(Schema.String),
  scopes: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  tokenUrl: Schema.optionalKey(Schema.String),
});

type SchemeFields = typeof SchemeNode.Type;

const JsonMap = Schema.Record(Schema.String, Schema.Json);

const Requirement = Schema.Record(Schema.String, Schema.Array(Schema.String));

const AlternativeList = Schema.Array(Schema.Json);

const decodeSchemeNode = Schema.decodeUnknownOption(SchemeNode);

const decodeFlowNode = Schema.decodeUnknownOption(FlowNode);

const decodeJsonMap = Schema.decodeUnknownOption(JsonMap);

const decodeRequirement = Schema.decodeUnknownOption(Requirement);

const decodeAlternativeList = Schema.decodeUnknownOption(AlternativeList);

const decodeCookieName = Schema.decodeUnknownOption(CookieName);

const decodeHeaderName = Schema.decodeUnknownOption(HeaderName);

const decodeSecurityScheme = Schema.decodeUnknownOption(SecurityScheme);

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

const acquisitionHint = (permanent: boolean): string =>
  permanent
    ? "This flow is permanently refused. Supply an access token obtained elsewhere."
    : "The generated CLI does not acquire tokens. Supply an access token obtained elsewhere.";

const toDiagnostic = (resolution: Resolution, finding: Finding): Effect.Effect<Diagnostic> => {
  const openapi = Option.getOrElse(declaredOpenapi(resolution.value), () => "unknown");

  return makeDiagnostic({
    code: finding.code,
    document: finding.document ?? resolution.document,
    element: finding.element,
    hint: finding.hint,
    message: finding.message,
    openapi,
    pointer: finding.pointer,
    related: finding.related?.map((site) => ({
      document: site.document ?? resolution.document,
      pointer: site.pointer,
    })),
    scope: finding.scope ?? "element",
    severity: "refusal",
    specSection: specSectionUrl(resolution.line, finding.anchor),
  });
};

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
            pointer: childPointer(childPointer(pointer, "flows"), flow),
          },
        ];
  });
};

const apiKeyRows = new Map([
  ["cookie", "SSC-14"],
  ["header", "SSC-12"],
  ["query", "SSC-13"],
]);

// One flow's help-only data, sanitized; a URL is present only when the spec gives it (design 9 I3).
// `deviceAuthorizationUrl` belongs to the 3.2 `deviceAuthorization` flow and is read only there.
interface FlowHelp {
  authorizationUrl?: string;
  deviceAuthorizationUrl?: string;
  refreshUrl?: string;
  readonly scopes: readonly { readonly description: string; readonly name: string }[];
  tokenUrl?: string;
}

const flowHelp = (kind: string, flow: typeof FlowNode.Type): FlowHelp => {
  const help: FlowHelp = {
    scopes: Object.entries(flow.scopes ?? {}).map(([name, description]) => ({
      description: sanitize(description),
      name: sanitize(name),
    })),
  };
  if (flow.authorizationUrl !== undefined) {
    help.authorizationUrl = sanitize(flow.authorizationUrl);
  }

  if (kind === "deviceAuthorization" && flow.deviceAuthorizationUrl !== undefined) {
    help.deviceAuthorizationUrl = sanitize(flow.deviceAuthorizationUrl);
  }

  if (flow.refreshUrl !== undefined) {
    help.refreshUrl = sanitize(flow.refreshUrl);
  }

  if (flow.tokenUrl !== undefined) {
    help.tokenUrl = sanitize(flow.tokenUrl);
  }

  return help;
};

// The help-only flows of an `oauth2` node by flow kind, or none when a known flow is malformed.
// Unknown flow names carry nothing a help line needs and are skipped.
const flowsOf = (fields: SchemeFields): Option.Option<Readonly<Record<string, FlowHelp>>> => {
  const flows: Record<string, FlowHelp> = {};
  for (const [kind, json] of Object.entries(fields.flows ?? {})) {
    if (!flowRules.has(kind)) {
      continue;
    }

    const flow = decodeFlowNode(json);
    if (Option.isNone(flow)) {
      return Option.none();
    }

    flows[kind] = flowHelp(kind, flow.value);
  }

  return Option.some(flows);
};

// The modelled kind and inventory row of a scheme node, or undefined when the type is unknown or
// an `oauth2` flow is malformed. `oauth2MetadataUrl` is a 3.2 field and is recorded only on 3.2.
const kindOf = (
  fields: SchemeFields,
  line: Line,
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
    const flows = flowsOf(fields);

    const metadata =
      line === "3.2" && fields.oauth2MetadataUrl !== undefined
        ? { oauth2MetadataUrl: sanitize(fields.oauth2MetadataUrl) }
        : {};

    return Option.isNone(flows)
      ? undefined
      : { kind: { flows: flows.value, ...metadata, type: "oauth2Token" }, row: "SSC-18" };
  }

  // An openIdConnect node without its discovery URL is malformed and stays unmodelled.
  return fields.type === "openIdConnect" && fields.openIdConnectUrl !== undefined
    ? {
        kind: { openIdConnectUrl: sanitize(fields.openIdConnectUrl), type: "oidcToken" },
        row: "SSC-19",
      }
    : undefined;
};

/**
 * Where a scheme is declared: its pointer, the document that holds it, the OAS line of the spec it
 * serves and whether the spec or the author config declares it. A finding about an author-supplied
 * scheme points into the config.
 */
interface Site {
  readonly document: typeof DocumentUri.Type;
  readonly line: Line;
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
    Option.isNone(decodeCookieName(node.name))
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
    Option.isNone(decodeHeaderName(node.name))
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

  const modelled = kindOf(node, site.line);
  const decoded =
    modelled === undefined
      ? Option.none<SecurityScheme>()
      : decodeSecurityScheme({
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
    { document: resolution.document, line: resolution.line, pointer, source: "spec" },
    nodeOption(resolution, target).pipe(Option.flatMap((json) => decodeSchemeNode(json))),
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
const addedSchemes = (
  declared: ReadonlySet<string>,
  author: AuthorSecurity | undefined,
  line: Line,
): Added => {
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
            line,
            pointer: formatPointer(["security", "add", "schemes", name]),
            source: "author-supplied",
          },
          decodeSchemeNode(node),
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
 * scheme stays usable through an operator-supplied token, with its flows, scopes and discovery URL
 * recorded for help only; its token acquisition is refused at element scope (D-SEC1), and a scheme
 * whose every flow is refused stays usable (design 10.4). With
 * `author`, the schemes of `security.add` follow the declared ones, marked `author-supplied`; a
 * name that is also declared is refused at document scope and the declared scheme stays.
 * `checkFindings` are the spec-text check findings of the run; a requirement name they refuse as
 * unresolved gets no second diagnostic from `normalizeSecurityPolicy`.
 */
export const normalizeSecuritySchemes = Effect.fnUntraced(function* normalizeSecuritySchemes(
  resolution: Resolution,
  author: AuthorSecurity | undefined,
  checkFindings: readonly Diagnostic[],
): Effect.fn.Return<SchemeNormalization> {
  const schemes = { document: resolution.document, pointer: "/components/securitySchemes" };
  const names = nodeOption(resolution, schemes).pipe(
    Option.flatMap((json) => decodeJsonMap(json)),
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
  const extra = addedSchemes(new Set(names), author, resolution.line);
  const all = [...built, ...extra.built];
  const diagnostics = yield* Effect.forEach(
    all.flatMap((one) => one.findings),
    (finding) => toDiagnostic(resolution, finding),
  );

  const requirement = author?.config.security?.add?.requirement;
  const supplied =
    author === undefined || requirement === undefined
      ? undefined
      : { document: author.configDocument, requirement };

  return {
    added: new Set(Arr.difference(extra.names, names)),
    checkRefused: new Set(
      checkFindings
        .filter(
          (finding) =>
            finding.document === resolution.document && unresolvedCodes.has(finding.code),
        )
        .map((finding) => finding.pointer),
    ),
    diagnostics,
    schemes: Arr.getSomes(all.map((one) => Option.fromUndefinedOr(one.scheme))),
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

// Built once per SchemeNormalization (memoized by identity), so a requirement entry costs one map
// probe.
const lookupOf = memoize((schemes: SchemeNormalization): Lookup => ({
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
}));

// A 3.2 requirement name that is not a component name resolves as a URI inside the set. The result
// is the component name it reaches, or undefined when it reaches nothing that is a component.
const uriComponentName = (resolution: Resolution, name: string): string | undefined => {
  if (resolution.line !== "3.2") {
    return undefined;
  }

  const key = implicitComponent(resolution, "securitySchemes", name);
  if (Option.isNone(key)) {
    return undefined;
  }

  const tokens = Result.getOrUndefined(parsePointerResult(key.value.pointer));

  return tokens?.length === 3 && tokens[0] === "components" && tokens[1] === "securitySchemes"
    ? tokens[2]
    : undefined;
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
      : [{ pointer: childPointer(operation, "security"), rows: ["SEC-01", "SEC-04"] }]),
    { pointer: "/security", rows: ["SEC-01", "SEC-03"] },
  ];
  for (const source of candidates) {
    const list = nodeOption(resolution, {
      document: resolution.document,
      pointer: source.pointer,
    }).pipe(Option.flatMap((json) => decodeAlternativeList(json)));
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

// The refusal of a requirement name that names no usable scheme, or None when check already raised
// the one diagnostic for it; either way its alternative is dropped.
const nameRefusal = (resolution: Resolution, named: Named): Option.Option<Finding> => {
  const { name, resolved } = named;
  const pointer = childPointer(named.pointer, name);
  if (named.unusable.has(resolved)) {
    return Option.some({
      anchor: "security-requirements-name",
      code: "SEC-02/unusable-scheme",
      element: "Security Requirement Object",
      message: "The requirement names a security scheme that is refused.",
      pointer,
      related: [{ pointer: formatPointer(["components", "securitySchemes", resolved]) }],
    });
  }

  if (!named.supplied && named.checkRefused.has(pointer)) {
    return Option.none();
  }

  return Option.some({
    anchor: "security-requirements-name",
    code: `${resolution.line === "3.2" ? "SEC-10" : "SEC-09"}/undeclared-scheme`,
    element: "Security Requirement Object",
    message: "The requirement names a security scheme that is not declared.",
    pointer,
  });
};

// Whether a scheme writes the one `Authorization` header (design 6.5 Conflicting Authorization
// schemes): http basic or bearer, oauth2, openIdConnect, or an apiKey header named Authorization.
const setsAuthorization = ({ kind }: SecurityScheme): boolean => {
  if (kind.type === "apiKey") {
    return kind.in === "header" && kind.name.toLowerCase() === "authorization";
  }

  return kind.type === "http" || kind.type === "oauth2Token" || kind.type === "oidcToken";
};

// The refusal of an alternative whose schemes write the `Authorization` header more than once, so
// that every scheme cannot be satisfied (SEC-05); undefined when at most one writes it.
const conflictRefusal = (
  schemes: ReadonlyMap<string, SecurityScheme>,
  pointer: string,
): Finding | undefined => {
  const writers = [...schemes.values()].filter(setsAuthorization);

  return writers.length < 2
    ? undefined
    : {
        anchor: "security-requirement-object",
        code: "SEC-01/conflicting-authorization",
        element: "Security Requirement Object",
        hint: "Each of these schemes sets the Authorization header, so one request cannot carry both. Use another alternative.",
        message: "The alternative requires two schemes that both set the Authorization header.",
        pointer,
        related: writers.map((scheme) => ({
          document: scheme.origin.document,
          pointer: scheme.origin.pointer,
        })),
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
  const lookup = lookupOf(schemes);
  const { declared: byName, unusable } = supplied ? lookup.author : lookup.spec;
  const used: { readonly scheme: string; readonly scopes: readonly string[] }[] = [];
  const reached = new Map<string, SecurityScheme>();
  for (const [name, scopes] of entries) {
    const exact = byName.has(name) || unusable.has(name);
    const resolved = exact ? name : (uriComponentName(resolution, name) ?? name);
    const declared = byName.get(resolved);
    if (declared !== undefined) {
      used.push({ scheme: resolved, scopes });
      reached.set(resolved, declared);
    }

    if (declared === undefined) {
      const refusal = nameRefusal(resolution, {
        checkRefused: schemes.checkRefused,
        name,
        pointer,
        resolved,
        supplied,
        unusable,
      });
      if (Option.isNone(refusal)) {
        refused = true;
      } else {
        findings.push(refusal.value);
      }
    }
  }

  const conflict = conflictRefusal(reached, pointer);
  if (conflict !== undefined) {
    findings.push(conflict);
  }

  return findings.length > 0 || refused ? { findings } : { findings, use: used };
};

/**
 * Normalizes the effective security policy of an operation, or of the root when `operation` is
 * omitted (design 6.5). `operation` is the pointer of the operation object. An alternative that
 * names an undeclared or refused scheme, or two schemes that each set the `Authorization` header
 * (`SEC-01/conflicting-authorization`), is removed whole with element-scope refusals and never
 * dropped silently. A `mutualTLS` scheme is usable like any other (design 6.5, D-SEC3). A spec name
 * check already refused as unresolved keeps that one diagnostic and gets no second here. Raising an
 * operation with no alternative left is the caller's job (`listed`).
 */
export const normalizeSecurityPolicy = Effect.fnUntraced(function* normalizeSecurityPolicy(
  resolution: Resolution,
  schemes: SchemeNormalization,
  operation?: string,
): Effect.fn.Return<PolicyNormalization> {
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
    supplied ??
    pipe(
      spec,
      UndefinedOr.map((declared) => ({ ...declared, document: resolution.document })),
    );
  const source = effective?.source ?? { pointer: operation ?? "", rows: ["SEC-08"] };
  const judged = (effective?.list ?? []).map((json, index) => {
    const pointer = childPointer(source.pointer, String(index));
    const entries = decodeRequirement(json).pipe(
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
  const diagnostics = yield* Effect.forEach(
    judged.flatMap((one) => one.findings),
    (finding) =>
      toDiagnostic(
        resolution,
        supplied === undefined ? finding : { ...finding, document: supplied.document },
      ),
  );
  const policy = yield* Schema.decodeUnknownEffect(SecurityPolicy)({
    alternatives: Arr.getSomes(
      judged.map((one) => Option.map(Option.fromUndefinedOr(one.use), (uses) => ({ uses }))),
    ),
    declared: effective !== undefined,
    origin: { document: effective?.document ?? resolution.document, pointer: source.pointer },
    rows: source.rows,
  }).pipe(Effect.orDie);

  return { diagnostics, listed: judged.length, policy };
});
