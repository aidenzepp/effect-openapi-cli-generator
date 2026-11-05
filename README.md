# effect-openapi-cli-generator

Generate standalone command-line applications from OpenAPI 3.0, 3.1 and 3.2 specifications. Each API operation becomes a command. The generated code uses Effect's CLI, Schema and HTTP libraries and runs on Bun. Reading Effect `HttpApi` definitions is planned for later.

Inspired by [Cloudflare's Forge](https://github.com/cloudflare/forge) and its [cf CLI](https://github.com/cloudflare/cf). This is an independent project, unaffiliated with Cloudflare or the Effect maintainers.

**Status:** under construction. The generator is not usable yet, and the package is not published.

## What it does

- Keeps HTTP semantics exactly: method, path, parameter locations, serialization, body encoding and security. Command names never imply HTTP verbs.
- Refuses what it cannot implement with a diagnostic that names the location and the specification section. Nothing is dropped silently.
- Treats the input specification as untrusted. Nothing from it becomes executable code or a path outside the output directory.
- Produces the same output for the same input and options.
- Gives generated CLIs typed errors, stable exit codes, help built from the specification's own prose, and credentials that never appear in source, help or logs.

Read [the project direction](docs/project.md) for the pipeline, the generated package layout, request and error behavior, and the repository layout.

## Development

Use Bun 1.4.3 (the `packageManager` pin).

```sh
bun install --frozen-lockfile
bun run check
bun run fix
```

Vite+ provides Oxlint and Oxfmt with the Ultracite core and anti-slop presets. TypeScript is strict.

Read [AGENTS.md](AGENTS.md) before contributing.
