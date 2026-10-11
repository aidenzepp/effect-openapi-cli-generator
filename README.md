# effect-openapi-cli-generator

Generate standalone, Effect-native command-line applications from Effect HttpApi definitions or OpenAPI 3.x specifications.

Inspired by [Cloudflare’s Forge](https://github.com/cloudflare/forge) and its [cf CLI](https://github.com/cloudflare/cf): adapt their schema-driven generation, command conventions, and optional overlays to Effect’s libraries and runtime. This is an independent project, unaffiliated with Cloudflare or the Effect maintainers.

**Status:** tooling and agent foundation only. No generator is implemented. Source layout and npm publishing are deferred until implementation and release work respectively.

## Development

Use Bun 1.4.3.

```sh
bun install --frozen-lockfile
bun run check
bun run fix
```

Vite+ provides Oxlint and Oxfmt with Ultracite core/anti-slop presets. TypeScript is strict. Checks currently cover the root TypeScript configuration; add real implementation checks as code lands.

## Implementation contract

- Use Effect libraries for runtime configuration, schemas, HTTP, files, processes, resources, and CLI behavior.
- Derive command names from operation metadata, independently of HTTP verbs.
- Preserve wire schemas and parameter serialization when constructing requests.
- Support JSON and file inputs; define conventions explicitly before generating them.
- Report unsupported cases clearly. Full Forge parity and every OpenAPI feature are not promised.

Starting references: [Forge](https://github.com/cloudflare/forge), [cf](https://github.com/cloudflare/cf), and [Effect openapi-generator](https://github.com/Effect-TS/effect/tree/main/packages/tools/openapi-generator).

Read [AGENTS.md](AGENTS.md) before contributing.
