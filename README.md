# effect-openapi-cli-generator

Generate standalone, Effect-native command-line applications from Effect HttpApi definitions or OpenAPI 3.x specifications, following Forge/cf conventions and supporting optional overlays.

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

## Agent coordination

Read [AGENTS.md](AGENTS.md). Install [Vivi](https://github.com/ianzepp/vivarium) and keep the Vivi and Tugboat skills in your personal skill collection; Tugboat is not vendored here. Setup is tested with Vivi 10.2.0.

```sh
bun run setup:vivi
vivi boot --project .
```

The setup script initializes a local mailspace and registers Mind, Hand, and Auditor charters. It is safe to rerun. All `.vivi/` state stays local and ignored by Git; coordination uses the CLI only.
