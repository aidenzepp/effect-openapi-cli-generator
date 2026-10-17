# effect-openapi-cli-generator

Generate standalone, Effect-native TypeScript command-line applications from enriched OpenAPI 3.0/3.1 JSON. Inspired by [Cloudflare Forge](https://github.com/cloudflare/forge); independent of Cloudflare and Effect maintainers.

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

The output contains `src/main.ts`, `src/commands.ts`, required `src/builtins/` modules, optional `src/models.ts` and `src/auth.ts`, plus `package.json`, `tsconfig.json`, and `.gitignore`. Install dependencies and build inside that directory:

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

- Select operations with a string `operationId` and `x-fern-sdk-group-name` (dotted string or string array). `x-fern-sdk-method-name` supplies the action; otherwise the final operation ID segment is used. `x-forge-aliases` replaces primary projections. Missing selection metadata skips operations; malformed supplied metadata fails.
- Commands can nest arbitrarily. Command spelling never changes the HTTP method or wire names. Conflicting command addresses and flags fail generation.
- Every request requires `--base-url`; help does not. Scalar path/query/header parameters use explicit native flags. Boolean values are explicit `true`/`false`.
- JSON bodies use `--body` or `--body-file`. Original values, including false, zero, empty strings and unknown properties permitted by the schema, are preserved. No coercion, defaults, retries, or `@file` shorthand.
- Supported request schemas include primitive types, scalar enums, arrays, objects, required properties, boolean or schema-valued additionalProperties and explicit local references. Nullable behavior follows the OpenAPI version.
- Unsupported request features fail with a location-bearing diagnostic: remote/cyclic references, unsupported schema compositions/validation keywords, security alternatives/combinations, ordinary cookie parameters, complex parameter serialization, and non-JSON bodies. This is a deliberate subset, not full OpenAPI or Forge parity.

Read [the project direction](docs/project.md) for architecture and generated-code quality requirements, and [AGENTS.md](AGENTS.md) before contributing.

## Modular output and expanded request support

Generated code now follows [the approved output decisions](docs/generated-code-decisions.md): `main.ts` assembles the runtime, `commands.ts` declares native request pipelines, `models.ts` preserves explicit reference identity, and `auth.ts` exposes only effective security flags. Required shared runtime capabilities live under `builtins/`. Every API parameter, including the final path parameter, is an explicit flag; the old inferred positional-subject convention is retired.

Supported request schemas include scalar enums and nullability, objects with boolean or schema-valued additional properties, arrays, acyclic local references, exclusive `oneOf`, and `allOf` restricted to one reference plus annotations. Native checks implement string patterns and Unicode code-point lengths, numeric bounds and positive multiples, and array item-count bounds. Inline schemas remain inline; only explicit references create shared models. Formats are annotations, including UUID and binary; descriptions and defaults do not create validation, values or file behavior. Schema-valued rest validation excludes declared object keys.

Scalar path, query and header parameters preserve their wire names. Effective security uses operation-level requirements when present, otherwise root requirements; empty security disables inheritance. One bearer, Basic or API-key requirement is supported. API-key placement can be header, query or cookie. Alternatives/combinations, OAuth flows, unsupported serialization and auth/parameter wire-field collisions fail explicitly. Basic uses native checked transport encoding; Unicode outside the native encoder's range fails without exposing credentials.

JSON bodies remain optional unless explicitly required and accept mutually exclusive `--body` and `--body-file`. Native schemas validate without coercion or default insertion; allowed unknown properties are retained. Responses print successful text with a trailing newline. HTTP failures show neutral status/transport guidance without revealing server error bodies or request secrets; requests are never automatically retried.

Oxfmt is an explicit generator dependency. Its public API formats emitted TypeScript/JSON and organizes contiguous imports without a global executable. Repository Vite+ type-aware lint and formatting checks verify emitted artifacts; no runtime linter is claimed. The native Effect packages, including `@effect/platform-node-shared`, are pinned to 4.0.3 because newer transitive platform releases can require APIs absent from the pinned core.

[Generated Resend CLI](examples/resend-generated/README.md) is a reproducible real-spec acceptance example. Run `bun tools/generate-resend.ts`; the bounded tool applies the separate naming overlay and writes the enriched input plus generator output. The source snapshot is unchanged. See its README for help and execution commands.

For an object combining declared fields with typed additional properties, native runtime key checks exclude the declared names from extra-field validation. TypeScript cannot express a general string index signature excluding finitely many keys; the inferred native schema type retains that index-signature limitation. JSON decoding and request encoding preserve the correct runtime contract; emitted models are validators, not a generated SDK construction API.

Path templates support unreserved literal characters, Unicode, and mixed segments such as `{id}.json`. Static reserved URI delimiters and percent escapes are rejected explicitly because whole-segment encoding cannot preserve their exact syntax. Dynamic values are encoded as complete segments; literal whole dot segments fail before transport.
