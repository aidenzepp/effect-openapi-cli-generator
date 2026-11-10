import { Schema } from "effect";
import {
  CookieName,
  DocumentUri,
  HeaderName,
  JsonLiteral,
  JsonPointer,
  MediaRange,
  MediaType,
  MethodToken,
  PathTemplate,
  SafeText,
  ServerTemplate,
  WireName,
} from "./brands.ts";
import { SpecLine } from "./spec-section.ts";

const rowIdPattern = /^[A-Z][A-Z0-9]*-[0-9]+$/u;

/**
 * An inventory row id such as `PRM-27`.
 */
export const RowId = Schema.String.pipe(
  Schema.check(Schema.isPattern(rowIdPattern)),
  Schema.brand("RowId"),
);

/**
 * Where an entity came from: a document of the set and the RFC 6901 pointer of its use site.
 */
export const Origin = Schema.Struct({ document: DocumentUri, pointer: JsonPointer });

/**
 * Help text for an element; every field is optional.
 */
export const Docs = Schema.Struct({
  description: Schema.optionalKey(SafeText),
  summary: Schema.optionalKey(SafeText),
});

/**
 * A reference into the one `SchemaStore` by its `$defs` key.
 */
export const SchemaRef = Schema.Struct({ key: Schema.NonEmptyString });

const rows = Schema.Array(RowId);

const rules = Schema.NonEmptyString;

const styleName = Schema.Literals([
  "cookie",
  "deepObject",
  "form",
  "label",
  "matrix",
  "pipeDelimited",
  "simple",
  "spaceDelimited",
]);

// A response Header Object by name, with its `required` and `deprecated` marks (HDR-03, HDR-04);
// absent in the document, each is false.
const responseHeaders = Schema.Array(
  Schema.Struct({ deprecated: Schema.Boolean, name: HeaderName, required: Schema.Boolean }),
);

// The non-standard serializations the author config opted into for one entry (design 6.1, D-OQ1
// (b)), one marker per switch: `nonStandard` (`deepObjectBrackets`) sends a `deepObject` value's
// nested members in the bracket convention; `nonStandardScalars` (`deepObjectScalars`) sends a
// scalar `deepObject` value as `name=value`. Set only from the author config, never defaulted or
// inferred; absent is strict.
const nonStandard = Schema.optionalKey(Schema.Literal("deepObjectBrackets"));

const nonStandardScalars = Schema.optionalKey(Schema.Literal("deepObjectScalars"));

/**
 * A parameter written in `style` form. `nonStandard` marks a `deepObject` query parameter the
 * author config sends in the bracket convention, and `nonStandardScalars` one whose scalar value it
 * sends as `name=value`. `objectValued` says the schema, through `$ref`,
 * admits only objects (design 6.1): the operator gives the value as JSON, which the runtime expands
 * by its style.
 */
export class StyleSerialization extends Schema.Class<StyleSerialization>("StyleSerialization")({
  allowReserved: Schema.Boolean,
  explode: Schema.Boolean,
  kind: Schema.Literal("style"),
  nonStandard,
  nonStandardScalars,
  objectValued: Schema.Boolean,
  origin: Origin,
  rows,
  rules,
  style: styleName,
}) {}

/**
 * A parameter written in `content` form. `encoding` holds the rules of a 3.2 `querystring`
 * parameter's form-urlencoded content, one per declared property in document order, decided as a
 * form body alternative's are (design 6.1, 6.3); it is empty for any other content.
 */
export class ContentSerialization extends Schema.Class<ContentSerialization>(
  "ContentSerialization",
)({
  // An `EncodingRule`'s part headers carry a `Serialization`, so the reference is suspended and its
  // type stated: inferring it would be circular.
  // oxlint-disable-next-line eslint/no-use-before-define -- read lazily, after both classes exist
  encoding: Schema.Array(Schema.suspend((): Schema.Codec<EncodingRule, unknown> => EncodingRule)),
  kind: Schema.Literal("content"),
  mediaType: MediaType,
  origin: Origin,
  rows,
  rules,
  schema: SchemaRef,
}) {}

/**
 * How a parameter value reaches the wire: by style or by content.
 */
export const Serialization = Schema.Union([StyleSerialization, ContentSerialization]);

// A part header of an Encoding Object: a Header Object by name, typed and serialized as a header
// parameter is (HDR-01, ENC-03), with its `required` and `deprecated` marks.
const partHeaders = Schema.Array(
  Schema.Struct({
    deprecated: Schema.Boolean,
    name: HeaderName,
    required: Schema.Boolean,
    schema: SchemaRef,
    serialization: Serialization,
  }),
);

const encodingTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("property"), name: WireName }),
  Schema.Struct({ index: Schema.Int, kind: Schema.Literal("position") }),
]);

const explicitStyle = Schema.Struct({
  allowReserved: Schema.optionalKey(Schema.Boolean),
  explode: Schema.optionalKey(Schema.Boolean),
  style: Schema.optionalKey(styleName),
});

const nestedEncodingRule = Schema.Struct({
  contentType: Schema.Array(MediaRange),
  headers: partHeaders,
  serialization: Schema.optionalKey(explicitStyle),
  target: encodingTarget,
});

/**
 * A per-property or per-position encoding rule of a media alternative (design 2.2).
 * `contentEncoding` is the part's transfer encoding: base64, the one the runtime supports, from
 * 3.0 `format: byte` (ENC-38) or 3.1+ `contentEncoding` (ENC-37); absent, the part is sent as is.
 * `nonStandard` marks a form property the author config sends in the bracket convention, and
 * `nonStandardScalars` one whose scalar value it sends as `name=value`.
 * `nested` holds the one nested level's rules (design 6.3, HT:B16), by name and by position, and is
 * present whenever the part nests; `nestedItem` is the nested `itemEncoding`, the rule of every
 * nested position after the nested `prefixEncoding` (ENC-09).
 */
export class EncodingRule extends Schema.Class<EncodingRule>("EncodingRule")({
  contentEncoding: Schema.optionalKey(Schema.Literal("base64")),
  contentType: Schema.Array(MediaRange),
  headers: partHeaders,
  nested: Schema.optionalKey(Schema.Array(nestedEncodingRule)),
  nestedItem: Schema.optionalKey(nestedEncodingRule),
  nonStandard,
  nonStandardScalars,
  origin: Origin,
  rows,
  serialization: Schema.optionalKey(explicitStyle),
  target: encodingTarget,
}) {}

/**
 * One branch of a discriminated body: its composition `index`, the entry component it names when
 * its `$ref` chain ends at one, and the discriminator values that select it, in mapping order.
 */
export const DiscriminatorBranch = Schema.Struct({
  component: Schema.optionalKey(Schema.NonEmptyString),
  index: Schema.Int,
  labels: Schema.Array(Schema.String),
});

/**
 * The usable discriminator of a request body's root schema, a hint that never changes validation
 * (design D-OQ9, DSC-06). `keyword` is the composition its branches come from; for `allOf`, the
 * branches are the entry components whose own `allOf` references the schema (DSC-11).
 */
export const DiscriminatorHint = Schema.Struct({
  branches: Schema.Array(DiscriminatorBranch),
  keyword: Schema.Literals(["allOf", "anyOf", "oneOf"]),
  propertyName: Schema.NonEmptyString,
});

/**
 * One media type a body or response offers; `codec` is derived from the media type.
 * `discriminator` and `refusedFields` are set on a request body alternative only. `refusedFields`
 * names the alternative's properties refused at `field` scope, in property order (design 8.5);
 * absent, none is refused.
 */
export class MediaAlternative extends Schema.Class<MediaAlternative>("MediaAlternative")({
  codec: Schema.Literals([
    "binary",
    "form",
    "json",
    "jsonseq",
    "multipart",
    "ndjson",
    "sse",
    "text",
    "xml",
  ]),
  discriminator: Schema.optionalKey(DiscriminatorHint),
  encoding: Schema.Array(EncodingRule),
  itemEncoding: Schema.optionalKey(EncodingRule),
  itemSchema: Schema.optionalKey(SchemaRef),
  mediaType: Schema.Union([MediaType, MediaRange]),
  origin: Origin,
  prefixEncoding: Schema.Array(EncodingRule),
  refusedFields: Schema.optionalKey(Schema.Array(WireName)),
  rows,
  schema: Schema.optionalKey(SchemaRef),
}) {}

/**
 * A request body; alternatives keep document order.
 */
export class Body extends Schema.Class<Body>("Body")({
  alternatives: Schema.Array(MediaAlternative),
  docs: Docs,
  origin: Origin,
  required: Schema.Boolean,
  rows,
}) {}

/**
 * An operation parameter after path-item merge.
 */
export class Parameter extends Schema.Class<Parameter>("Parameter")({
  deprecated: Schema.Boolean,
  docs: Docs,
  location: Schema.Literals(["cookie", "header", "path", "query", "querystring"]),
  origin: Origin,
  required: Schema.Boolean,
  rows,
  schema: SchemaRef,
  serialization: Serialization,
  wireName: WireName,
}) {}

/**
 * One status code, status range or `default` response.
 */
export class ResponseCase extends Schema.Class<ResponseCase>("ResponseCase")({
  alternatives: Schema.Array(MediaAlternative),
  docs: Docs,
  headers: responseHeaders,
  key: Schema.Union([
    Schema.Struct({ code: Schema.Int.check(Schema.isBetween({ maximum: 599, minimum: 100 })) }),
    Schema.Struct({ range: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 })) }),
    Schema.Literal("default"),
  ]),
  origin: Origin,
  rows,
}) {}

/**
 * A server, at root, path item or operation level; `accepted` comes only from the author config.
 */
export class Server extends Schema.Class<Server>("Server")({
  accepted: Schema.Boolean,
  level: Schema.Literals(["operation", "pathItem", "root"]),
  name: Schema.optionalKey(SafeText),
  origin: Origin,
  origins: Schema.Array(DocumentUri),
  rows,
  template: ServerTemplate,
  variables: Schema.Array(
    Schema.Struct({
      default: Schema.String,
      enum: Schema.optionalKey(Schema.Array(Schema.String)),
      name: Schema.NonEmptyString,
    }),
  ),
}) {}

// One OAuth flow as help text: its URLs when the spec gives them and its scopes by name. No URL here
// ever becomes a request target (design 9 I3).
const OAuthFlow = Schema.Struct({
  authorizationUrl: Schema.optionalKey(SafeText),
  deviceAuthorizationUrl: Schema.optionalKey(SafeText),
  refreshUrl: Schema.optionalKey(SafeText),
  scopes: Schema.Array(Schema.Struct({ description: SafeText, name: SafeText })),
  tokenUrl: Schema.optionalKey(SafeText),
});

/**
 * The flows of an `oauth2` scheme by flow kind, recorded for help only.
 */
export const OAuthFlows = Schema.Struct({
  authorizationCode: Schema.optionalKey(OAuthFlow),
  clientCredentials: Schema.optionalKey(OAuthFlow),
  deviceAuthorization: Schema.optionalKey(OAuthFlow),
  implicit: Schema.optionalKey(OAuthFlow),
  password: Schema.optionalKey(OAuthFlow),
});

const schemeKind = Schema.Union([
  Schema.Struct({
    in: Schema.Literal("cookie"),
    name: CookieName,
    type: Schema.Literal("apiKey"),
  }),
  Schema.Struct({
    in: Schema.Literal("header"),
    name: HeaderName,
    type: Schema.Literal("apiKey"),
  }),
  Schema.Struct({
    in: Schema.Literal("query"),
    name: WireName,
    type: Schema.Literal("apiKey"),
  }),
  Schema.Struct({ scheme: Schema.Literals(["basic", "bearer"]), type: Schema.Literal("http") }),
  // `oauth2MetadataUrl` (3.2) is shown in help and never fetched (design 9 I3).
  Schema.Struct({
    flows: OAuthFlows,
    oauth2MetadataUrl: Schema.optionalKey(SafeText),
    type: Schema.Literal("oauth2Token"),
  }),
  Schema.Struct({ openIdConnectUrl: SafeText, type: Schema.Literal("oidcToken") }),
  Schema.Struct({ type: Schema.Literal("mutualTls") }),
]);

/**
 * A declared security scheme; flows and discovery URLs are recorded for help only.
 */
export class SecurityScheme extends Schema.Class<SecurityScheme>("SecurityScheme")({
  credentialSources: Schema.Array(Schema.NonEmptyString),
  deprecated: Schema.Boolean,
  kind: schemeKind,
  name: Schema.NonEmptyString,
  origin: Origin,
  rows,
  // Where the scheme came from; an author-supplied one must not reach help or the report unmarked.
  source: Schema.Literals(["spec", "author-supplied"]),
}) {}

/**
 * Alternatives are OR in document order; each alternative's uses are AND.
 */
export class SecurityPolicy extends Schema.Class<SecurityPolicy>("SecurityPolicy")({
  alternatives: Schema.Array(
    Schema.Struct({
      uses: Schema.Array(
        Schema.Struct({ scheme: Schema.NonEmptyString, scopes: Schema.Array(Schema.String) }),
      ),
    }),
  ),
  declared: Schema.Boolean,
  origin: Origin,
  rows,
}) {}

/**
 * The one schema store: a JSON document of `$defs`.
 */
export class SchemaStore extends Schema.Class<SchemaStore>("SchemaStore")({
  document: JsonLiteral,
  origin: Origin,
  rows,
}) {}

/**
 * An element that is read and counted but never affects requests.
 */
export class Informational extends Schema.Class<Informational>("Informational")({
  origin: Origin,
  reason: SafeText,
  row: RowId,
}) {}

/**
 * One naming extension source of an operation or alias (design 4.4): a group as its segments, top
 * level first, and a method name, both unfolded. `pointer` is the object that holds the keys, so a
 * key's own pointer is `pointer` plus the key. At least one of `group` and `method` is present.
 */
export const NamingHint = Schema.Struct({
  group: Schema.optionalKey(Schema.NonEmptyArray(Schema.NonEmptyString)),
  method: Schema.optionalKey(Schema.NonEmptyString),
  pointer: JsonPointer,
}).check(
  Schema.makeFilter(
    (hint) => hint.group !== undefined || hint.method !== undefined || "a hint names something",
  ),
);

/**
 * One usable entry of `x-forge-aliases`: its own Forge and Fern hints, never the operation's, its
 * own `operationId` (never the operation's), and its index in the array.
 */
export const NamingAlias = Schema.Struct({
  fern: Schema.optionalKey(NamingHint),
  forge: Schema.optionalKey(NamingHint),
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  operationId: Schema.optionalKey(Schema.NonEmptyString),
});

/**
 * The naming extensions an operation carries (design 4.4, D-NAME4): its own Forge and Fern hints
 * name its primary command, and each alias names one more command for it. Absent when the
 * operation has no usable naming extension.
 */
export const Naming = Schema.Struct({
  aliases: Schema.optionalKey(Schema.NonEmptyArray(NamingAlias)),
  fern: Schema.optionalKey(NamingHint),
  forge: Schema.optionalKey(NamingHint),
}).check(
  Schema.makeFilter(
    (naming) =>
      naming.aliases !== undefined ||
      naming.fern !== undefined ||
      naming.forge !== undefined ||
      "naming carries a hint or an alias",
  ),
);

/**
 * One operation, keyed by method token and path template.
 */
export class Operation extends Schema.Class<Operation>("Operation")({
  body: Schema.optionalKey(Body),
  deprecated: Schema.Boolean,
  docs: Docs,
  key: Schema.Struct({ method: MethodToken, path: PathTemplate }),
  naming: Schema.optionalKey(Naming),
  operationId: Schema.optionalKey(Schema.NonEmptyString),
  origin: Origin,
  parameters: Schema.Array(Parameter),
  responses: Schema.Array(ResponseCase),
  rows,
  security: SecurityPolicy,
  servers: Schema.Array(Server),
  tags: Schema.Array(SafeText),
}) {}

/**
 * The normalized model of one API document set.
 */
export class Api extends Schema.Class<Api>("Api")({
  documents: Schema.Array(DocumentUri),
  entry: DocumentUri,
  info: Docs,
  informational: Schema.Array(Informational),
  line: SpecLine,
  openapi: Schema.NonEmptyString,
  operations: Schema.Array(Operation),
  origin: Origin,
  rows,
  schemas: SchemaStore,
  securitySchemes: Schema.Array(SecurityScheme),
  servers: Schema.Array(Server),
  tags: Schema.Array(
    Schema.Struct({
      docs: Schema.optionalKey(Docs),
      kind: Schema.optionalKey(Schema.NonEmptyString),
      name: Schema.NonEmptyString,
      parent: Schema.optionalKey(Schema.NonEmptyString),
    }),
  ),
}) {}
