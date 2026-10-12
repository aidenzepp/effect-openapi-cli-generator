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
bun test
```

Both input and output are required. Output must be absent and its parent must exist. Existing files, directories, and symlinks are refused. Failed or interrupted writes clean up the directory claimed by this invocation.

`--name my-api` overrides the executable/package name; otherwise it is derived from `info.title`. Generated package and CLI versions start at `0.0.0` independently of the API version.

The output contains `src/main.ts`, `src/runtime.ts`, `package.json`, `tsconfig.json`, and `.gitignore`. Install dependencies and build inside that directory:

```sh
bun install
bun run build
node dist/main.js --help
node dist/main.js account items get item-id --base-url https://api.example.com/api
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
- Every request requires `--base-url`; help does not. Primitive path/query parameters use native flags or a subject argument according to the command conventions. Boolean values are explicit `true`/`false`.
- JSON bodies use `--body` or `--body-file`. Original values, including false, zero, empty strings and unknown properties permitted by the schema, are preserved. No coercion, defaults, retries, or `@file` shorthand.
- Supported request schemas include primitive types, scalar enums, arrays, objects, required properties, boolean additionalProperties and local references. Nullable behavior follows the OpenAPI version.
- Unsupported request features fail with a location-bearing diagnostic: remote/cyclic references, schema compositions and unsupported validation keywords, security requirements, header/cookie parameters, complex parameter serialization, and non-JSON bodies. This is a deliberate subset, not full OpenAPI or Forge parity.

Read [the project direction](docs/project.md) for architecture and generated-code quality requirements, and [AGENTS.md](AGENTS.md) before contributing.
