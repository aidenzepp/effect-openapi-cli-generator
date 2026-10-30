# Generated code decisions

This is the canonical guide to the approved output style and its reasons. Read it before changing emission or the hand-written references. The goal is maintainable Effect CLI code whose choices can be traced to the OpenAPI specification. The [conversation audit](conversation-decision-audit.md) records the approval and rejection history, quote anchors, and remaining evidence limits; this guide owns the current rules.

## Target and implementation status

The content reference establishes the approved behavioral and formatting baseline. The Resend reference adds the approved modular layout below; the older content example remains in its existing file layout. Approval establishes the output style; it does not establish exhaustive correctness or generator parity, or authorize pushing, publishing or releasing.

[Users reference](../examples/reference/src/main.ts) and [content reference](../examples/content-reference/src/main.ts) are evolving hand-written targets. Their [specifications](../examples/reference/openapi.json) and [content specification](../examples/content-reference/openapi.json) demonstrate the intended relationship between input and output. They do not prove that the generator emits this style or supports all their keywords.

[README](../README.md) owns current generator support. The generator now implements native constraint mapping and explicit named-model reuse; the generated Resend example and emitter contract tests exercise these mappings. The content reference now inlines API flag definitions in each command and maps the shown constraints with native `Schema.isMinLength(1)` and `Schema.isPattern`. Its hand-written body error also remains an example-specific message, not a general message-generation contract.

## Name groups by their full ordered command path

Use individual PascalCase group constants built from the complete ordered group path, with a `Command` suffix. Append `Command` to operation constants too. Emit children before parents so each declaration refers to an already defined command. Keep the visible command names unchanged.

**POSITIVE — Make hierarchy and declaration order explicit.**

```ts
const UsersPostsFilesCommand = Command.make("files").pipe(
  Command.withDescription("Browse files attached to posts."),
  Command.withSubcommands([listFilesCommand]),
);

const UsersPostsCommand = Command.make("posts").pipe(
  Command.withDescription("Browse and create user posts."),
  Command.withSubcommands([listPostsCommand, createPostCommand, UsersPostsFilesCommand]),
);

const UsersCommand = Command.make("users").pipe(
  Command.withDescription("Work with content owned by a user."),
  Command.withSubcommands([UsersPostsCommand]),
);

const rootCommand = Command.make("content-reference").pipe(
  Command.withDescription("Manage user posts and their attached files."),
  Command.withSubcommands([UsersCommand]),
);
```

Run the root with `Command.run(rootCommand, { version: "0.0.0" })`. The root references `UsersCommand`; the CLI remains `content-reference users posts files list`. A reversed branch, `posts users`, gets `PostsUsersCommand`, distinct from `UsersPostsCommand`. Do not sort path segments when naming a group.

**NEGATIVE — Name groups using only the leaf or obscure them in nested assembly.**

```ts
const posts = Command.make("posts"); // Which parent owns this group?
const users = Command.make("users").pipe(
  Command.withSubcommands([
    Command.make("posts").pipe(Command.withSubcommands([Command.make("files")])),
  ]),
);
```

Prefer simple individual declarations over nested inline command trees or object namespaces. Use OpenAPI `operationId` as the naming source for operation declarations, with valid-identifier sanitization. Keep group identifiers separate from visible CLI spelling and HTTP method selection.

Full paths reduce ambiguity but do not guarantee unique TypeScript names: normalization can collapse different inputs, and a group name can collide with a model, helper or operation. The generator needs one deterministic identifier allocator that sanitizes and checks the complete shared declaration scope: imports, helpers, models, groups and operations. Reserve `rootCommand` for the root alongside imported and helper names; assign generated conflicts deterministic alternative names. Namespace imports separate module access but do not eliminate collisions within a module; the `Command` suffix can also collide with normalized input. Reserve owning-module namespaces (`SecuritySchemes`, `Parameters`, `RequestBodies`, `Schemas`, `Errors`, `Http`, `Url` and `Commands`) where imported. The root name alone does not prevent collisions. The generator allocates these identifiers deterministically; dedicated emitted-package checks exercise normalized-name collisions. The suffix affects source identifiers only; operation IDs in the OpenAPI document and visible CLI names stay unchanged.

## Separate OpenAPI components, builtins, commands and runtime assembly

The generated layout groups source-owned declarations by OpenAPI component category. Handwritten references retain their historical layout:

- `components/schemas.ts` owns named schemas declared by explicit OpenAPI references.
- `components/parameters.ts` owns explicitly referenced parameter flags.
- `components/request-bodies.ts` owns validators for explicitly referenced JSON request bodies; handlers retain requiredness and transport.
- `builtins/errors.ts` owns schema-backed transport failures and safe CLI conversion.
- `builtins/auth.ts` owns supported security-definition and credential schemas, checked Basic encoding and API key placement. Bearer requests use the native helper directly.
- `builtins/url.ts` owns base URL validation and literal path-segment encoding.
- `builtins/http.ts` owns one-shot HTTP execution and response output.
- `components/security-schemes.ts` owns flags for this specification's active security requirements.
- `commands.ts` contains only operation/group declarations after its imports.
- `main.ts` owns `rootCommand` and runtime layer provision.

Use namespace imports with quoted module specifiers, keeping imports contiguous. If a module imports both spec-owned `components/security-schemes.ts` and `builtins/auth.ts`, name the builtin namespace `BuiltinAuth` to keep ownership distinct:

```ts
// commands.ts
import * as SecuritySchemes from "./components/security-schemes.js";
import * as Errors from "./builtins/errors.js";
import * as Http from "./builtins/http.js";
import * as Url from "./builtins/url.js";
import * as Schemas from "./components/schemas.js";

// A body schema reference inside its owning flag.
Schema.fromJsonString(Schemas.SendEmailRequest);

// Keep flag keys stable when referencing shared configuration.
Command.make("list", { baseUrl: Url.baseUrl, bearerAuth: SecuritySchemes.BearerAuth });
```

```ts
// main.ts
import * as Commands from "./commands.js";

const rootCommand = Command.make("resend-reference").pipe(
  Command.withDescription("Resend is the email platform for developers."),
  Command.withSubcommands([Commands.DomainsCommand, Commands.EmailsCommand]),
);
```

Export only cross-module contracts and the explicitly showcased builtin capabilities. Keep operations, nested groups, model-only dependencies and error formatting details local. Use direct owning-module imports; there is no catch-all barrel. Keep inline API definitions in their commands; preserve explicit parameter and schema references across component modules.

The showcase includes potential builtin capabilities beyond the active Resend bearer scheme. The generator emits only required modules and declarations plus their transitive dependencies; API-key adapters are selected by active wire location. The schema definitions describe supported configuration, not a runtime OpenAPI interpreter. Credentials are separate redacted values.

Path and authentication failures use `Schema.TaggedError`. `AuthenticationError` wraps the `AuthenticationErrorReason` union. `CredentialUnavailable` carries a credential descriptor: `mechanism: "basic"` with a username/password field, or `mechanism: "apiKey"` with a header/query/cookie location. `InvalidBasicCredential` identifies its field; `BasicEncodingError`, `CookieConfigurationError` and `CookieEncodingError` encode their stage directly in the tag. `ApiKeyPreparationError` permits only header/query locations. Each reason owns `message`; the wrapper delegates `message` to its reason, and `toCliError` displays that message without a separate authentication formatter. This shape excludes meaningless field/location combinations. Authentication errors exclude credential values and raw causes. Header/query wire validation may be deferred until execution; these adapters do not claim to detect every malformed wire value. Server status failures remain neutral, without invented rejected-credential attribution. Raw path and HTTP errors become safe `CliError.UserError` values once at the command boundary. Body validation/encoding and base URL flags retain their existing safe native CLI boundaries. No retries or credential logging are added.

## Derive authentication from effective security requirements

Emit authentication only for an operation's effective OpenAPI security requirements: use operation-level `security` when present, otherwise root `security`. A declared but unused scheme does not require a flag; an empty operation-level security array disables inherited authentication.

The Resend reference activates `bearerAuth` at the root, whose definition is `type: "http"` and `scheme: "bearer"`. That definition selects native bearer authentication; the scheme key alone does not identify the authentication mechanism. Normalizing `bearerAuth` to the CLI flag `--bearer-auth` is our naming convention, not an OpenAPI requirement.

```ts
export const bearerAuth = Flag.Redacted("bearer-auth").pipe(
  Flag.withDescription("Bearer token for authentication."),
);
```

Inside each command handler, pass the parsed `bearerAuth` value directly to `HttpClientRequest.bearerToken(bearerAuth)`.

Environment bindings require explicit generator configuration. Do not infer vendor defaults from the API title, scheme key or description. The reference has no configured environment binding. The builtin showcase additionally exercises HTTP Basic and API keys in headers, queries and cookies. Only bearer authentication is exposed by the Resend commands. OAuth login/session flows, certificate management and security alternatives/combinations remain unsupported and fail explicitly. Basic credentials follow RFC 7617 transport restrictions; the native encoder's Unicode limitation is reported as a typed failure, without charset negotiation. Cookie placement preserves other parsed cookie values through native cookie serialization.

## Map declared constraints directly

Define inline API parameters directly in each owning `Command.make` configuration; use `Parameters.Name` for explicit parameter component references. Keep inline constraints in that flag definition. Prefer native Schema checks that visibly correspond to the input keywords; do not interpret a regex into a domain predicate or invent its explanation.

For this schema:

```json
{ "type": "string", "minLength": 1, "pattern": "^(?!\\.{1,2}$)" }
```

**POSITIVE — Preserve the declared checks and use native diagnostics.**

```ts
const listPostsCommand = Command.make("list", {
  user: Flag.String("user").pipe(
    Flag.withSchema(Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^(?!\.{1,2}$)/u))),
    Flag.withDescription("The owner of the posts."),
  ),
});
```

**NEGATIVE — Replace the spec with interpreted semantics and authored copy.**

```ts
const userFlag = Flag.String("user").pipe(
  Flag.withSchema(
    Schema.NonEmptyString.check(
      Schema.makeFilter((value) => value !== "." && value !== "..", {
        message: "Use a nonempty identifier other than . or ..",
      }),
    ),
  ),
);
```

The semantic shortcut obscures the original keyword. The predicate and message require understanding an arbitrary regex, which the generator cannot reliably do. Effect's default pattern diagnostic describes the actual pattern. A schema without `pattern` gets no pattern check; a schema without a length constraint gets no invented nonempty requirement.

Select native checks by semantics, not name alone. In the pinned Effect version, `isMinLength` counts UTF-16 code units; JSON Schema string lengths count Unicode code points. The illustrated bound of one is equivalent. For general string bounds, the installed native `Schema.isMinCodePoints` and `Schema.isMaxCodePoints` preserve JSON Schema semantics; use Unicode tests to verify their application. Regex flags and escaping likewise need verification before generalizing this example.

URL construction must preserve path segments independently of schema validation. A missing pattern does not authorize adding domain restrictions to the schema. Handling otherwise unrepresentable path values is a separate request-construction responsibility, implemented by the shared segment helpers described under [request construction](#share-cli-execution-keep-request-construction-explicit).

## Share only when the specification declares reuse

If two parameters reference `#/components/schemas/Identifier`, emit one corresponding schema and use it in both flags. These excerpts assume that model declares a string with `minLength: 1`.

**POSITIVE — Preserve explicit model identity.**

```ts
const Identifier = Schema.String.check(Schema.isMinLength(1));
const listFilesCommand = Command.make("list", {
  post: Flag.String("post").pipe(Flag.withSchema(Identifier)),
  user: Flag.String("user").pipe(Flag.withSchema(Identifier)),
});
```

**NEGATIVE — Use that same extraction merely because two inline schemas look alike.**

```ts
// Neither parameter references a shared OpenAPI model.
const PathId = Schema.String.check(Schema.isMinLength(1));
const listFilesCommand = Command.make("list", {
  post: Flag.String("post").pipe(Flag.withSchema(PathId)),
  user: Flag.String("user").pipe(Flag.withSchema(PathId)),
});
```

Independent inline schemas remain inline, even when identical. Structural similarity does not establish shared meaning or ownership. Explicit references establish that relationship. Keep named model schemas in `components/schemas.ts`, with dependencies declared first. Consumers import them through the `Schemas` namespace. Export only schemas consumed across modules; dependencies used solely within that module stay local. Model naming still requires the deterministic allocation described above.

A shared schema component shares the validator, not the flag. An explicitly referenced parameter component shares its native flag, including requiredness and source-owned help. Reference-site descriptions are applied locally, and operation-level overrides replace path-level parameters before component collection. The CLI-owned `baseUrl` flag may remain shared: it is executable configuration, not an API parameter model.

**POSITIVE — Keep the parameter at its command boundary.**

```ts
const listPostsCommand = Command.make("list", {
  baseUrl,
  user: Flag.String("user").pipe(Flag.withSchema(Identifier)),
});
const createPostCommand = Command.make("create", {
  baseUrl,
  user: Flag.String("user").pipe(Flag.withSchema(Identifier)),
});
```

**NEGATIVE — Hoist an API flag because commands happen to use it alike.**

```ts
const userFlag = Flag.String("user").pipe(Flag.withSchema(Identifier));
const listPostsCommand = Command.make("list", { baseUrl, user: userFlag });
const createPostCommand = Command.make("create", { baseUrl, user: userFlag });
```

## Let native validation own arbitrary constraint messages

Use native Schema diagnostics for schema keywords. OpenAPI `description` supplies help; it is not automatically an error message. Custom validation wording requires explicit input. The extension or configuration mechanism for that wording is undecided.

**POSITIVE — Keep help and validation separate.**

```ts
const listPostsCommand = Command.make("list", {
  user: Flag.String("user").pipe(
    Flag.withSchema(Schema.String.check(Schema.isPattern(/^[a-z]+$/u))),
    Flag.withDescription("The owner of the posts."),
  ),
});
```

**NEGATIVE — Treat ordinary description prose as a rejection message.**

```ts
Schema.String.check(Schema.isPattern(/^[a-z]+$/u, { message: "The owner of the posts." }));
```

The base URL is an explicit CLI-owned boundary. Its known checks can have precise messages. Retain native `Schema.URLFromString` decoding, separate protocol, username, password, query and fragment checks, and the existing safe issue formatter. It prevents rejected credentials or query secrets from being echoed by native flag error rendering.

**POSITIVE — A known URL check has a specific, safe correction.**

```ts
Schema.makeFilter((url: URL) => !url.username, {
  message: "Remove the username from the API base URL.",
});
```

**NEGATIVE — Collapse distinct causes or expose the rejected input.**

```ts
userMessage: `Invalid URL (credentials, query or fragment): ${value}`;
```

This accepted URL adapter does not justify custom interpretation of arbitrary parameter patterns. Preserve the typed cause and expose only safe issue messages; malformed URLs receive a static fallback.

## Keep one neutral HTTP error formatter

Each standalone CLI uses one synchronous `httpErrorMessage(reason): string`. It classifies the typed HTTP failure without depending on resource names. The shared `Errors.toCliError` boundary retains the original HTTP cause and passes the formatter result directly to `CliError.UserError`.

**POSITIVE — One complete message, one typed cause.**

```ts
Effect.mapError(
  (cause) =>
    new CliError.UserError({
      cause,
      userMessage: httpErrorMessage(cause.reason),
    }),
);
```

**NEGATIVE — Assemble operation-specific prose around the helper.**

```ts
userMessage: `Could not list users: ${httpErrorMessage(cause.reason)}`;
```

Do not generate helpers for each resource, parse response bodies for error text, or add status-description lookup machinery. The approved helper uses known reason variants and HTTP status for neutral guidance. Its bounded structure is intentional.

Authored messages begin with a capital letter and use complete sentences. Prefer semicolons or separate sentences to parenthetical explanations. Native library diagnostics and CLI help remain native; this is not a requirement to rewrite them.

**POSITIVE — Safe after a response-read failure, including POST.**

```text
The response could not be read. Check the API server and connection.
```

**NEGATIVE — Retry guidance without evidence that repeating the request is safe.**

```text
The response could not be read. Retry the request.
```

A server may have completed a POST before its response became unreadable. No automatic retries are added. The small GET-only reference has retry wording; do not copy that advice into a shared formatter that also handles writes.

## Share CLI execution, keep request construction explicit

`runRequest` owns execution, successful-status validation and text output. `Errors.toCliError` owns shared transport error conversion, applied once at each command boundary. This is shared executable behavior, separate from OpenAPI-driven model reuse. Each command still declares its own method, path, parameters, body and tracing span.

**POSITIVE — Compose the native client and response APIs at one boundary.**

```ts
const runRequest = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.flatMap(Console.log),
  );
```

`HttpClient.execute` gets the client from the Effect environment. The existing `NodeHttpClient.layerNodeHttp` provider supplies it; no additional service or layer is needed. Filtering status before reading the body preserves the neutral status error and avoids displaying error response bodies.

A command handler remains a direct request pipeline:

```ts
({ baseUrl: apiUrl, post, user }) =>
  HttpClientRequest.get(apiUrl).pipe(
    appendPathSegments("users", user, "posts", post, "files"),
    Effect.flatMap(runRequest),
    Effect.mapError(Errors.toCliError),
    Effect.withSpan("posts.files.list"),
  );
```

**NEGATIVE — Repeat client lookup, execution, output and error conversion in every handler.**

```ts
Effect.gen(function* fetchFiles() {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const response = yield* client.execute(request);
  yield* Console.log(yield* response.text);
}).pipe(
  Effect.mapError(
    (cause) => new CliError.UserError({ cause, userMessage: httpErrorMessage(cause.reason) }),
  ),
);
```

Use the approved `encodePathSegment` and `appendPathSegments` transport helpers across operations. `encodePathSegment` rejects only whole `.` and `..` segments, then wraps `encodeURIComponent` in `Effect.try`; invalid Unicode becomes a schema-backed `PathError` instead of an escaping exception. Commands convert it once through `Errors.toCliError`. Keep these transport checks separate from unchanged API schemas. Use native schema-backed tagged errors without subclassing `CliError`; do not introduce per-ID variables or `Effect.gen` handlers for this work.

```ts
const appendPathSegments =
  (...segments: readonly string[]) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.forEach(encodePathSegment)(segments).pipe(
      Effect.map((encoded) => HttpClientRequest.appendUrl(request, encoded.join("/"))),
    );
```

Assemble complete segments before encoding. `appendPathSegments("files", "bar.json")` retains the dotted filename; ``appendPathSegments("files", `${name}.json`)`` encodes the completed mixed segment, including any slash within `name`, as one segment. Do not split a parameter on slash or encode a multi-segment path string as one value. The helper preserves the configured base URL prefix. `runRequest` still owns HTTP execution/output; `Errors.toCliError` owns CLI conversion.

Use checked `HttpClientRequest.bodyJson` for JSON bodies. Encoding returns an Effect with `HttpBodyError`; the body helper owns its safe conversion before entering `runRequest`. Preserve the typed cause; the HTTP reason formatter handles HTTP errors, not JSON body errors. Keep encoding-error conversion inside the body operation. A mapping around the whole pipeline would incorrectly replace path errors with a JSON encoding message.

**POSITIVE — Keep encoding failure in the Effect error channel.**

```ts
HttpClientRequest.post(apiUrl).pipe(
  Url.appendPathSegments("users", user, "posts"),
  Effect.flatMap(Body.withBody(body, bodyFile, true, Schemas.CreatePost)),
  Effect.flatMap(Http.runRequest),
  Effect.mapError(Errors.toCliError),
);
```

**NEGATIVE — Rely on an unsafe encoder despite an available checked API.**

```ts
HttpClientRequest.post(apiUrl).pipe(HttpClientRequest.bodyJsonUnsafe(body), runRequest);
```

## Documentation must have a source or a reason

Use standard OpenAPI summaries, descriptions and applicable documentation metadata for API command help and JSDoc. Do not invent API operation, schema or group descriptions.

Document every emitted generator-owned builtin with concise authored JSDoc: helpers, CLI configuration flags and root command assembly have known contracts independent of API prose. State their purpose and relevant behavior, such as error safety, credential precedence or path encoding. This applies to conditionally emitted infrastructure too; it does not require every API to include bearer authentication or every helper. This replaces the earlier restriction that implementation comments require a nonobvious constraint.

Keep JSDoc multiline. Omit boilerplate tags, redundant types and comments that merely restate syntax.

**POSITIVE — Carry operation prose from the specification.**

```ts
/**
 * List an owner's posts, optionally filtered by status and publication state.
 */
```

**POSITIVE — Document a builtin from its known contract.**

```ts
/**
 * Append complete path segments while preserving the base URL path prefix.
 * Encode each segment separately so embedded slashes remain parameter data.
 */
```

**NEGATIVE — Leave a builtin undocumented because OpenAPI has no prose for it.**

```ts
const bearerAuth = Flag.Redacted("bearer-auth");
```

**NEGATIVE — Narrate syntax without adding a contract.**

```ts
/**
 * Defines the list posts command.
 */
```

Useful dependency `@see` links point to verified, version-pinned GitHub source, such as [SchemaIssue in Effect 4.0.3](https://github.com/Effect-TS/effect/blob/effect%404.0.3/packages/effect/src/SchemaIssue.ts). Do not link relative installed paths such as `../../../node_modules/effect/src/SchemaIssue.ts`.

## Preserve wire behavior and ordinary repository style

Command names and hierarchy are CLI presentation. The specification owns HTTP methods, paths, wire field names, values and declared constraints. Do not derive a CRUD operation from a command name or silently add defaults, coercion or retries.

**POSITIVE — Preserve omission and explicit false values.**

```ts
HttpClientRequest.setUrlParams({
  published: Option.getOrUndefined(published),
});
```

**NEGATIVE — Introduce a default where the API received no value.**

```ts
HttpClientRequest.setUrlParams({
  published: Option.getOrElse(published, () => "false"),
});
```

Keep original JSON values through body decoding and request construction. Preserve base URL path prefixes and encode each path parameter as one segment. Reject unsupported input clearly instead of silently changing its meaning.

Use contiguous imports, normal sorted object keys, and the repository's Vite+ formatting and lint rules. Do not introduce key-sort exceptions to influence help order or blank lines between imports. Format emitted source using the actual configured tools; visual similarity to formatted code is insufficient.

## Review against input, source and execution

Before accepting an output change:

- Trace every constraint and shared model to its OpenAPI keyword or explicit reference. Identify CLI-owned rules separately.
- Compare the emitted source with these decisions; ensure snippets still match the file being reviewed.
- Compile the output, then exercise real commands against a local HTTP fixture. Verify method, path prefix, escaped segments, omitted values, explicit false and original JSON bodies.
- Exercise invalid inputs without sending requests, safe base URL failures, HTTP failures and response-read failures after writes.
- Run configured formatting, lint and type checks against output as well as generator source.

[Reference tests](../tests/reference.test.ts) cover the small target's help, documentation, safe URL diagnostics and requests. [Content reference tests](../tests/content-reference.test.ts) cover richer requests, native pattern failures and write-response failure behavior. [Integration tests](../tests/integration.test.ts) exercise actual generated packages, wire behavior and source hygiene; [package tests](../tests/package.test.ts) exercise the installed library and executable.

Those suites prove their current fixtures, not all decisions in this guide. Add targeted executable cases when implementing missing mappings and explicit model reuse; do not claim reference tests prove generator parity.

## Resend reference decisions

The [Resend reference](../examples/resend-reference/README.md) applies this style to a pinned real-world slice. Its implementation decisions below are explicit reviewable choices; they do not expand current generator support or imply prior approval of every new boundary.

- Authentication follows the active `bearerAuth` security requirement: native `Flag.Redacted("bearer-auth")` passes directly to `HttpClientRequest.bearerToken`. Help does not require credentials, and execution requires an explicit token and base URL; no environment binding is configured.
- Omitted `requestBody.required` means the body flag is optional. The request receives no body when omitted. Supplied bodies retain their model's required fields and use checked JSON encoding.
- OpenAPI objects permit unspecified properties unless constrained. Native `Schema.StructWithRest` with `Schema.Record(Schema.String, Schema.Json)` preserves those values instead of stripping them. Only explicitly referenced request models get shared schema declarations; response text needs no unused response validators.
- `Schema.Union([...], { mode: "oneOf" })` expresses exclusive alternatives natively. Resend's alternatives are disjoint strings/arrays or strings/numbers. A template `allOf` containing a model reference and description-only annotation adds no validation rule.
- String `maxLength` uses `Schema.isMaxCodePoints`; UTF-16 `isMaxLength` is appropriate for array item counts, not general string code-point bounds. No handwritten counting adapter is needed.
- Formats remain annotations for this OpenAPI 3.1 reference. UUID fields stay strings; JSON binary content is not treated as a file. Prose-only limits and cross-field rules stay prose, including tags, capabilities, pagination cursor exclusion and the batch-summary limit.
- Path `.` and `..` are rejected by the shared encoder before sending because URL transport normalizes whole dot segments. Other segments use checked URI encoding; invalid Unicode also receives a safe typed error. These are request-boundary errors, separate from unconstrained OpenAPI string schemas.
- Native body diagnostics disable input reporting and preserve their Schema cause. They do not reinterpret regexes or synthesize a schema-specific summary. Token and base URL failure paths retain their safe diagnostic boundaries.

A representative optional body path keeps absence distinct from JSON data:

```ts
(request) =>
  Effect.suspend(() =>
    Option.isSome(body) ? HttpClientRequest.bodyJson(request, body.value) : Effect.succeed(request),
  );
```

The generator additionally retains mutually exclusive `--body-file` through a small native filesystem/body helper; the schema remains explicit at the command boundary. The body helper maps an encoding failure to a safe native CLI error before HTTP execution. Do not substitute a default object or array, or make the flag required because the endpoint usually expects a body.

## Generator utility choices

Use native Effect string capitalization and projected string orders where their semantics match exactly. Source identifiers preserve acronym spelling after the first character; command-token validation and title sanitization remain distinct contracts. Local Set/Map allocation and explicit composite ordering stay plain when that makes ownership and tie-breaking clearer. These utility choices do not change emitted source.

## Additional full-spec request contracts

OpenAPI 3.1 top-level `webhooks` describe inbound events. Preserve them in the source document and accept their object boundary without generating outbound commands or validating inbound payload schemas. OpenAPI 3.0 does not support this field.

An unconstrained request schema emits `Schema.Json`. Explicit multi-type arrays emit native unions with finite JSON numbers and direct null schemas. Constraints alongside a multi-type array currently fail explicitly. No constraints are dropped to achieve generation.

Primitive query arrays use a JSON array CLI value with `JSON_ARRAY` help and retain declared `form` serialization: `explode: false` joins items with commas; the default `explode: true` repeats the wire key. Empty arrays have no unambiguous representation and fail before HTTP; omission remains omission and a single empty string remains a present empty value. Comma-bearing items cannot be represented unambiguously with comma-delimited serialization and fail with a safe parameter-specific error. Repeated serialization permits commas within individual items. Source prose does not supply additional constraints, defaults or alternate CLI parsers.

## Naming without extensions and multipart transport

Naming extensions are optional. Slash-separated operation IDs define nesting; other punctuation is normalized to kebab case. An absent or punctuation-only identifier uses the path and method, with placeholders rendered as `by-name` groups. Explicit group and method overrides remain supported; group-only overrides retain the final operation ID segment action. Empty aliases explicitly exclude an operation. Collisions fail rather than renaming commands silently. The full Resend fixture uses raw upstream JSON without a naming overlay.

For multipart only, `string` plus `format: binary` selects native `Flag.File`; arrays of binary strings use repeated file flags. This is an explicit generator convention for legacy binary schemas in OpenAPI 3.1, not a standard-imposed interpretation of format. JSON binary formats remain annotations. Native FormData owns boundaries. Files are buffered in memory. Content constraints on binary strings are unsupported; do not apply them to filesystem paths. Array bounds apply to the list of supplied paths.

Unknown multipart fields use an explicit text-valued JSON object flag when allowed by the schema. Reject declared-name collisions. Do not infer binary parts, JSON structures, defaults or constraints from descriptions. Optional omission sends no body; required empty objects still send multipart. Structured multipart fields, typed rest fields and custom encoding remain unsupported. Emit only the file helpers actually used by that CLI.

## Preserve explicit component categories and aliases

Standard category names are fixed; names within each category come from the specification. Allocate safe identifiers deterministically within each category. Two categories may both export `Shared` without collision. Emit only used declarations and dependencies; do not generate unused responses or runtime implementations merely because a component exists.

**POSITIVE — A referenced parameter owns a reusable native flag.**

```ts
// components/parameters.ts
export const PaginationLimit = Flag.Int("limit").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  Flag.optional,
);
// commands.ts
Command.make("list", { baseUrl: Url.baseUrl, limit: Parameters.PaginationLimit });
```

**NEGATIVE — Extract equal inline parameters into a shared component without a source reference.**

```ts
// No parameter component exists in the input; this invents one.
export const SharedLimit = Flag.Int("limit");
```

Aliases retain explicit target reuse, such as `export const Alias = Base`; local descriptions can wrap a referenced flag with `Flag.withDescription`. A JSON request-body component exports its validator, including schema aliases through native destructuring when appropriate. Its handler still owns body requiredness and encoding; do not present this validator as the entire OpenAPI Request Body Object. Reference-site body descriptions remain on the local body flag. Explicit multipart schema references produce named native flag bundles in `components/multipart.ts`; their aliases retain target reuse. This file is a generator-owned transport view of source schemas, not an OpenAPI category or whole-body JSON validator.

## Named multipart transport views

Use `MultipartComponents` for named native flag bundles and `Multipart` for transport helpers. A schema-required file flag stays required in the bundle; an optional request body wraps that member locally. The handler still owns body presence, required-field checks, file reading and multipart encoding. Inline schemas stay inline. Do not infer reusable bundles from equal field shapes or pass file inputs through JSON string validators.

```ts
// components/multipart.ts
export const CreateContactImportOptions = {
  file: Flag.File("file", { mustExist: true }),
  on_conflict: Flag.Literals("on-conflict", ["upsert", "skip"]).pipe(Flag.optional),
};
// Required body: reuse the native member directly.
Command.make("create-import", { file: MultipartComponents.CreateContactImportOptions.file });
// Optional body: preserve omission without weakening the source component.
Command.make("preview-import", {
  file: MultipartComponents.CreateContactImportOptions.file.pipe(Flag.optional),
});
```

OpenAPI 3.1 Security Reference Object descriptions override inherited descriptions through alias chains, including empty-string overrides. Each effective scheme name owns its credential flag names, so security aliases are resolved contracts rather than shared flag objects. Do not claim general alias-object sharing for security schemes or rename an alias's credential flag to its target's flag.

Multipart bundle identity prefers the schema reference. A referenced request body with an inline media schema supplies its request-body identity instead; aliases reuse the target bundle. The allocator distinguishes equal names from the two pointer categories. The same schema used in JSON and multipart has a JSON validator and a native multipart flag view.

Security Reference Object description overrides apply only in OpenAPI 3.1. OpenAPI 3.0 ignores reference siblings. An explicit empty 3.1 description clears inherited CLI help.

Scalar request headers retain their raw values as an explicit interoperability convention; this is not full RFC 6570 header expansion. Resend’s [official idempotency example](https://resend.com/docs/dashboard/emails/idempotency-keys) uses `welcome-user/123456789` unchanged. Header serialization is unchanged by component extraction.

## Source-owned descriptions

API-derived help uses the source `description` verbatim, including casing and whitespace. An explicitly empty description remains empty. Use `summary`, then `title`, only when description is absent; do not concatenate them. Reference-site overrides remain local and preserve shared component identity.

```ts
Flag.Literals("on-conflict", ["upsert", "skip"]).pipe(
  Flag.withDescription("Strategy to use when an imported contact already exists."),
  Flag.optional,
);
```

**Negative — adding a sentence absent from the source:**

```ts
Flag.withDescription(
  'Strategy to use when an imported contact already exists. Server default when omitted: "skip".',
);
```

Do not append default values, requiredness explanations, JSON-array instructions, body-default sections or a generated “Deprecated.” sentence to API descriptions. If the source itself says “defaults to skip,” keep that text unchanged; do not parse or remove it. Schema defaults never insert request values and do not create help text.

Native Effect usage, enum choices and the `JSON_ARRAY` metavar remain native. Generator-owned flags such as `--body-file`, `--base-url` and `--additional-fields` retain concise descriptions of their own behavior. Authentication fallback help is used only when source documentation is absent. `--body` uses its request-body documentation without added prose.

JSDoc retains safe escaping and structural `@deprecated` and `@see` annotations. Do not replace native help rendering or infer validation/error messages from documentation.

Generated CLIs do not emit usage examples or `Command.withExamples`. OpenAPI example fields remain in the source specification and are not converted into command help.

## Executable identity and native help

The generator library option `name` and generator CLI `--name` explicitly override the executable/package name. Otherwise derive it from `info.title`. These are generation-time options, not flags of the generated API CLI. The generated package version is independent of `info.version`.

Keep generated flags in kebab case while retaining original API field names on the wire. Reject collisions with CLI-owned flags such as `--base-url`; do not overwrite either contract. The current normalizer also rejects conflicting native/global and body/auth flag names. TypeScript identifier collisions are a separate allocation problem from visible command/flag collisions.

Use native Effect help and validation. The installed help metadata records requiredness, but its default flag renderer does not label every required/optional flag. The user accepted that limitation rather than authoring extra description text. `Flag.optional` still controls runtime omission; `Flag.withDefault` changes runtime values and must not be used merely to display server defaults. Native enum choices are appropriate; invented enum choices are not.

Source prose about a format does not change the declared type. Resend's `column_map` describes JSON-encoded text but declares a string: the caller passes one shell-quoted JSON-looking string, and the CLI sends that string unchanged. Do not parse it as an object merely because the description says JSON.

## Output review and rejected presentation features

Develop a small, readable handwritten target from an actual specification, review it in chat, and then make the generator reproduce that style. Expand with pinned real specifications and compare input, generated source and actual CLI output. A handwritten reference is a design target, not proof of generator coverage.

Show snippets of proposed or changed output in chat and identify the exact file being reviewed. Read disk state and regenerate from current source when an editor view and a claimed change disagree. Do not attribute unexplained file reversions to the user or editor without evidence. Keep applicable template lint/format/skill conventions; database-specific machinery and Superpowers process documents are not product deliverables.

Do not add generated-file warning banners or blanket top-of-file JSDoc. The user withdrew that request and left reconsideration for later. This is separate from meaningful builtin JSDoc and source-derived API documentation.

No usage examples are emitted. `Command.withExamples` was implemented and then explicitly removed; the subsequent suggestion to select `servers[].url` instead of shell environment placeholders was never approved as replacement work. Do not revive either approach through an unrelated change.
