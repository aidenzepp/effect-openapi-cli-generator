# effect-openapi-cli-generator

Generate standalone, Effect-native TypeScript command-line applications from OpenAPI 3.0/3.1 JSON. Inspired by [Cloudflare Forge](https://github.com/cloudflare/forge); independent of Cloudflare and Effect maintainers.

This private package implements the OpenAPI generation path. An Effect HttpApi adapter is deferred. Publication is outside the current scope.

## Development and generation

Use Bun 1.4.3 and Node with ESM support.

```sh
bun install --frozen-lockfile
bun run build
node dist/cli.js --input ./openapi.json --output ./generated
bun run check
bun run test
```

`test`, `check`, and `build` embed the checked runtime templates automatically. Before invoking `bun test` directly on a clean checkout, run `bun run prepare:runtime`.

Both input and output are required. Output must be absent and its parent must exist. Existing files, directories, and symlinks are refused. Failed or interrupted writes clean up the directory claimed by this invocation.

`--name my-api` overrides the executable/package name; otherwise it is derived from `info.title`. Generated package and CLI versions start at `0.0.0` independently of the API version.

The output contains `src/main.ts`, `src/commands.ts`, required `src/builtins/` modules, used OpenAPI declarations under `src/components/`, plus `package.json`, `tsconfig.json`, and `.gitignore`. Install dependencies and build inside that directory:

```sh
bun install
bun run build
node dist/main.js --help
node dist/main.js account items get --id item-id --base-url https://api.example.com/api
```

Generated applications depend on Effect and its Node platform, not this generator.

## Library

```ts
import { Effect } from "effect";
import { generate } from "effect-openapi-cli-generator";

const application = await Effect.runPromise(generate(document, { name: "my-api" }));
// application.files contains relative paths and formatted source content.
```

The library accepts parsed JSON and performs no filesystem or network access. Failures are typed `GenerationError` values with code, location, message, and hint.

## Conventions and supported scope

- Naming extensions are optional. Slash-separated operation IDs become nested commands; other punctuation becomes kebab case. Without a usable operation ID, path segments and the HTTP method form the address; `/users/{id}` GET becomes `users by-id get`. Optional `x-fern-sdk-group-name` and `x-fern-sdk-method-name` override grouping/action. An explicit group without a method retains the final operation ID segment as its action. `x-forge-aliases` replaces primary projections; an empty list explicitly excludes an operation. Malformed supplied metadata fails.
- Commands can nest arbitrarily. Command spelling never changes the HTTP method or wire names. Conflicting command addresses and flags fail generation.
- Every request requires `--base-url`; help does not. Scalar path/query/header parameters use explicit native flags. Boolean values are explicit `true`/`false`.
- JSON bodies use `--body` or `--body-file`. Original values, including false, zero, empty strings and unknown properties permitted by the schema, are preserved. No coercion, default insertion, retries, or `@file` shorthand.
- Supported request schemas include primitive types, scalar enums, arrays, objects, required properties, boolean or schema-valued additionalProperties and explicit local references. Nullable behavior follows the OpenAPI version.
- Unsupported request features fail with a location-bearing diagnostic: remote/cyclic references, unsupported schema compositions/validation keywords, security alternatives/combinations, ordinary cookie parameters, complex parameter serialization, and unsupported body media types. This is a deliberate subset, not full OpenAPI or Forge parity.

Read [the project direction](docs/project.md) for architecture and generated-code quality requirements, and [AGENTS.md](AGENTS.md) before contributing.

## Modular output and expanded request support

Generated code now follows [the approved output decisions](docs/generated-code-decisions.md): `main.ts` assembles the runtime, `commands.ts` declares native request pipelines, `components/schemas.ts` preserves explicit schema identity, `components/parameters.ts` preserves referenced parameter flags, and `components/security-schemes.ts` exposes only effective security flags. Required shared runtime capabilities live under `builtins/`. Every API parameter, including the final path parameter, is an explicit flag; the old inferred positional-subject convention is retired.

Supported request schemas include scalar enums and nullability, objects with boolean or schema-valued additional properties, arrays, acyclic local references, exclusive `oneOf`, and `allOf` restricted to one reference plus annotations. Native checks implement string patterns and Unicode code-point lengths, numeric bounds and positive multiples, and array item-count bounds. Inline schemas remain inline; only explicit references create shared models. Formats are annotations in JSON bodies and ordinary parameters, including UUID and binary. Within multipart bodies only, this generator recognizes `string` with `format: binary` as a file input convention, including OpenAPI 3.1; this is not mandated by the 3.1 format keyword. Descriptions and defaults do not create validation or values. Schema-valued rest validation excludes declared object keys.

Scalar path, query and header parameters preserve their wire names. Effective security uses operation-level requirements when present, otherwise root requirements; empty security disables inheritance. One bearer, Basic or API-key requirement is supported. API-key placement can be header, query or cookie. Alternatives/combinations, OAuth flows, unsupported serialization and auth/parameter wire-field collisions fail explicitly. Basic uses native checked transport encoding; Unicode outside the native encoder's range fails without exposing credentials.

JSON bodies remain optional unless explicitly required and accept mutually exclusive `--body` and `--body-file`. Native schemas validate without coercion or default insertion; allowed unknown properties are retained. Responses print successful text with a trailing newline. HTTP failures show neutral status/transport guidance without revealing server error bodies or request secrets; requests are never automatically retried.

Oxfmt is an explicit generator dependency. Its public API formats emitted TypeScript/JSON and organizes contiguous imports without a global executable. Repository Vite+ type-aware lint and formatting checks verify emitted artifacts; no runtime linter is claimed. The native Effect packages, including `@effect/platform-node-shared`, are pinned to 4.0.3 because newer transitive platform releases can require APIs absent from the pinned core.

[Generated Resend CLI](examples/resend-generated/README.md) is a reproducible real-spec acceptance example. Run `bun tools/generate-resend.ts`; the bounded tool applies the separate naming overlay and writes the enriched input plus generator output. The source snapshot is unchanged. See its README for help and execution commands.

For an object combining declared fields with typed additional properties, native runtime key checks exclude the declared names from extra-field validation. TypeScript cannot express a general string index signature excluding finitely many keys; the inferred native schema type retains that index-signature limitation. JSON decoding and request encoding preserve the correct runtime contract; emitted models are validators, not a generated SDK construction API.

Path templates support unreserved literal characters, Unicode, and mixed segments such as `{id}.json`. Static reserved URI delimiters and percent escapes are rejected explicitly because whole-segment encoding cannot preserve their exact syntax. Dynamic values are encoded as complete segments; literal whole dot segments fail before transport.

## Full unannotated Resend example

[The complete generated CLI](examples/resend-full-generated/README.md) uses the untouched pinned upstream specification: 113 operations, 72 paths and 197 component schemas. Run `bun tools/generate-resend-full.ts`. No naming overlay is required or applied. OpenAPI 3.1 top-level webhook objects are accepted as inbound metadata, retained in the example input, and do not generate outbound commands or validate webhook payloads.

Annotation-only schemas use native `Schema.Json`. Unconstrained multi-type schemas use native unions; constraints alongside multiple types remain unsupported. Query arrays use JSON-array flags and native form serialization. Empty arrays are rejected because this transport cannot distinguish them reliably from an empty string item or omission. Non-exploded arrays reject comma-containing items; exploded arrays preserve repeated values. Optional omission, false, zero, and a single empty string remain distinct supported inputs.

Multipart bodies expose declared primitive text fields and binary file fields as named flags. Repeat an array-of-files flag for each file; item-count checks apply to the supplied list. An empty file list is not representable. Binary content constraints are rejected rather than applied to local path names. Optional body omission and schema-required fields are preserved. Files are read into memory; uploads are not streamed. Native FormData supplies boundaries and filenames.

When the schema permits unknown multipart fields, `--additional-fields` accepts a JSON object of text values. Declared field names cannot be overridden. Unknown binary parts, structured multipart fields, typed additional properties and custom encoding objects remain unsupported. These are explicit CLI transport limits, not changes to the input model. No prose constraints or defaults are inferred.

Explicit component references retain their category and author-defined identity. A schema reference shares its validator; a parameter reference shares its native flag. Identical inline definitions remain inline, and different named components remain distinct even when their shapes match. Schema, parameter, JSON request-body and multipart-view aliases refer to their targets rather than copying their definitions. OpenAPI 3.1 security references retain their effective description overrides; OpenAPI 3.0 ignores reference siblings. Distinct scheme names keep distinct credential flags, so they are not aliases of the same flag object. Reference-site descriptions remain local; operation parameter overrides are resolved before selecting shared components.

Referenced JSON request bodies reuse validators from `components/request-bodies.ts`. This module represents their validation contract, not a whole HTTP request definition: requiredness, mutual exclusion, serialization and transport stay in the handler. Explicitly referenced multipart schemas have named native flag bundles in `components/multipart.ts`, a generator-owned transport view rather than a standard OpenAPI component category. Commands reuse their members; optional bodies wrap only schema-required members in `Flag.optional` locally. Inline multipart definitions stay inline. These bundles retain file inputs without inventing JSON string validators for file contents. Only used component categories are emitted; responses and unrelated components do not acquire invented runtime behavior. Handwritten reference examples retain their historical layout.

Multipart bundle identity prefers an explicit schema reference. When the media schema is inline inside a referenced request body, its request-body pointer supplies the bundle identity instead; request-body aliases reuse that bundle. Names are allocated across both pointer categories without collisions.

API-derived descriptions retain source text, including whitespace and explicit empty descriptions. Summary or title is a fallback only when description is absent. The generator adds no default summaries, requiredness prose or JSON-array instructions to these descriptions; source prose mentioning defaults remains unchanged. Native Effect usage and choices remain available, and generator-owned flags retain their own help.

[Cloudflare token-discovery example](examples/cloudflare-generated/README.md) generates three unchanged operations from a checksum-pinned official specification. Its extraction tool preserves upstream naming and transitive references without overlays; the example README records current full-spec blockers.
