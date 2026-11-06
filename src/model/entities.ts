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

const nameList = Schema.Array(Schema.Struct({ name: HeaderName }));

const requestHeaders = Schema.Array(Schema.Struct({ name: HeaderName, required: Schema.Boolean }));

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
  headers: requestHeaders,
  serialization: Schema.optionalKey(explicitStyle),
  target: encodingTarget,
});

/**
 * A per-property or per-position encoding rule of a media alternative (design 2.2).
 */
export class EncodingRule extends Schema.Class<EncodingRule>("EncodingRule")({
  contentType: Schema.Array(MediaRange),
  headers: requestHeaders,
  nested: Schema.optionalKey(Schema.Array(nestedEncodingRule)),
  origin: Origin,
  rows,
  serialization: Schema.optionalKey(explicitStyle),
  target: encodingTarget,
}) {}

/**
 * One media type a body or response offers; `codec` is derived from the media type.
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
  encoding: Schema.Array(EncodingRule),
  itemEncoding: Schema.optionalKey(EncodingRule),
  itemSchema: Schema.optionalKey(SchemaRef),
  mediaType: Schema.Union([MediaType, MediaRange]),
  origin: Origin,
  prefixEncoding: Schema.Array(EncodingRule),
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
 * A parameter written in `style` form.
 */
export class StyleSerialization extends Schema.Class<StyleSerialization>("StyleSerialization")({
  allowReserved: Schema.Boolean,
  explode: Schema.Boolean,
  kind: Schema.Literal("style"),
  origin: Origin,
  rows,
  rules,
  style: styleName,
}) {}

/**
 * A parameter written in `content` form.
 */
export class ContentSerialization extends Schema.Class<ContentSerialization>(
  "ContentSerialization",
)({
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
  headers: nameList,
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
  Schema.Struct({ flows: Docs, type: Schema.Literal("oauth2Token") }),
  Schema.Struct({ type: Schema.Literal("oidcToken"), url: Docs }),
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
 * One operation, keyed by method token and path template.
 */
export class Operation extends Schema.Class<Operation>("Operation")({
  body: Schema.optionalKey(Body),
  deprecated: Schema.Boolean,
  docs: Docs,
  key: Schema.Struct({ method: MethodToken, path: PathTemplate }),
  naming: Schema.optionalKey(
    Schema.Struct({ command: Schema.NonEmptyString, group: Schema.NonEmptyString }),
  ),
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
  line: Schema.Literals(["3.0", "3.1", "3.2"]),
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
