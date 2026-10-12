# Generated code decisions

This is the canonical guide to the approved output style and its reasons. Read it before changing emission or the hand-written references. The goal is maintainable Effect CLI code whose choices can be traced to the OpenAPI specification.

## Target and implementation status

[Users reference](../examples/reference/src/main.ts) and [content reference](../examples/content-reference/src/main.ts) are evolving hand-written targets. Their [specifications](../examples/reference/openapi.json) and [content specification](../examples/content-reference/openapi.json) demonstrate the intended relationship between input and output. They do not prove that the generator emits this style or supports all their keywords.

[README](../README.md) owns current generator support. In particular, the current schema emitter does not implement the constraint mapping or named-model reuse illustrated below. The content reference now inlines API flag definitions in each command and maps the shown constraints with native `Schema.isMinLength(1)` and `Schema.isPattern`. Its hand-written body error also remains an example-specific message, not a general message-generation contract.

## Map declared constraints directly

Define API flags directly in each owning `Command.make` configuration. Keep inline constraints in that flag definition. Prefer native Schema checks that visibly correspond to the input keywords; do not interpret a regex into a domain predicate or invent its explanation.

For this schema:

```json
{ "type": "string", "minLength": 1, "pattern": "^(?!\\.{1,2}$)" }
```

**POSITIVE — Preserve the declared checks and use native diagnostics.**

```ts
const listPosts = Command.make("list", {
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

Select native checks by semantics, not name alone. In the pinned Effect version, `isMinLength` counts UTF-16 code units; JSON Schema string lengths count Unicode code points. The illustrated bound of one is equivalent, but other bounds require a semantically faithful check and Unicode tests. Regex flags and escaping likewise need verification before generalizing this example.

URL construction must preserve path segments independently of schema validation. A missing pattern does not authorize adding domain restrictions to the schema. Handling otherwise unrepresentable path values is a separate request-construction responsibility; this guide does not settle its future API.

## Share only when the specification declares reuse

If two parameters reference `#/components/schemas/Identifier`, emit one corresponding schema and use it in both flags. These excerpts assume that model declares a string with `minLength: 1`.

**POSITIVE — Preserve explicit model identity.**

```ts
const Identifier = Schema.String.check(Schema.isMinLength(1));
const listFiles = Command.make("list", {
  post: Flag.String("post").pipe(Flag.withSchema(Identifier)),
  user: Flag.String("user").pipe(Flag.withSchema(Identifier)),
});
```

**NEGATIVE — Use that same extraction merely because two inline schemas look alike.**

```ts
// Neither parameter references a shared OpenAPI model.
const PathId = Schema.String.check(Schema.isMinLength(1));
const listFiles = Command.make("list", {
  post: Flag.String("post").pipe(Flag.withSchema(PathId)),
  user: Flag.String("user").pipe(Flag.withSchema(PathId)),
});
```

Independent inline schemas remain inline, even when identical. Structural similarity does not establish shared meaning or ownership. Explicit references establish that relationship. Model naming and module placement still need implementation decisions; these examples do not prescribe a new package hierarchy.

A shared OpenAPI model shares the schema, not the flag definition. Repeat each API flag where its command declares it, including its name and help. The CLI-owned `baseUrl` flag may remain shared: it is executable configuration, not an API parameter model.

**POSITIVE — Keep the parameter at its command boundary.**

```ts
const listPosts = Command.make("list", {
  baseUrl,
  user: Flag.String("user").pipe(Flag.withSchema(Identifier)),
});
const createPost = Command.make("create", {
  baseUrl,
  user: Flag.String("user").pipe(Flag.withSchema(Identifier)),
});
```

**NEGATIVE — Hoist an API flag because commands happen to use it alike.**

```ts
const userFlag = Flag.String("user").pipe(Flag.withSchema(Identifier));
const listPosts = Command.make("list", { baseUrl, user: userFlag });
const createPost = Command.make("create", { baseUrl, user: userFlag });
```

## Let native validation own arbitrary constraint messages

Use native Schema diagnostics for schema keywords. OpenAPI `description` supplies help; it is not automatically an error message. Custom validation wording requires explicit input. The extension or configuration mechanism for that wording is undecided.

**POSITIVE — Keep help and validation separate.**

```ts
const listPosts = Command.make("list", {
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

Each standalone CLI uses one synchronous `httpErrorMessage(reason): string`. It classifies the typed HTTP failure without depending on resource names. The shared `runRequest` execution helper retains the original cause and passes the formatter result directly to `CliError.UserError`.

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

`runRequest` owns execution, successful-status validation, text output and HTTP error conversion once per CLI. This is shared executable behavior, separate from OpenAPI-driven model reuse. Each command still declares its own method, path, parameters, body and tracing span.

**POSITIVE — Compose the native client and response APIs at one boundary.**

```ts
const runRequest = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.flatMap(Console.log),
    Effect.mapError(
      (cause) => new CliError.UserError({ cause, userMessage: httpErrorMessage(cause.reason) }),
    ),
  );
```

`HttpClient.execute` gets the client from the Effect environment. The existing `NodeHttpClient.layerNodeHttp` provider supplies it; no additional service or layer is needed. Filtering status before reading the body preserves the neutral status error and avoids displaying error response bodies.

A command handler remains a direct request pipeline:

```ts
({ baseUrl: apiUrl, post, user }) =>
  HttpClientRequest.get(apiUrl).pipe(
    HttpClientRequest.appendUrl(
      `/users/${encodeURIComponent(user)}/posts/${encodeURIComponent(post)}/files`,
    ),
    runRequest,
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

Keep URI encoding visible beside each parameter. The proposed `apiPath` abstraction was rejected; it hides simple path construction without a needed capability. The selected helper name is `runRequest`.

Use checked `HttpClientRequest.bodyJson` for JSON bodies. Encoding returns an Effect with `HttpBodyError`, so map that failure before entering `runRequest`. Preserve its typed cause; the HTTP reason formatter handles HTTP errors, not JSON body errors.

**POSITIVE — Keep encoding failure in the Effect error channel.**

```ts
HttpClientRequest.post(apiUrl).pipe(
  HttpClientRequest.appendUrl(`/users/${encodeURIComponent(user)}/posts`),
  HttpClientRequest.bodyJson(body),
  Effect.mapError(
    (cause) =>
      new CliError.UserError({
        cause,
        userMessage: "The request body could not be encoded as JSON. Check the body values.",
      }),
  ),
  Effect.flatMap(runRequest),
  Effect.withSpan("posts.create"),
);
```

**NEGATIVE — Rely on an unsafe encoder despite an available checked API.**

```ts
HttpClientRequest.post(apiUrl).pipe(HttpClientRequest.bodyJsonUnsafe(body), runRequest);
```

## Documentation must have a source or a reason

Use standard OpenAPI summaries, descriptions and applicable documentation metadata for command help and JSDoc. Add custom implementation comments only when they explain a meaningful constraint, such as why base URL error formatting must hide input. Do not invent comments merely to cover every declaration.

**POSITIVE — Carry operation prose from the specification.**

```ts
/**
 * List an owner's posts, optionally filtered by status and publication state.
 */
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
