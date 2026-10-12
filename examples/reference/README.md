# Hand-written CLI reference

This is a manually maintained design reference for the single `GET /users` operation in `openapi.json`. Edit `src/main.ts` directly. There is no regeneration or overwrite command: review and change this reference before teaching the generator to produce it.

The root description comes from `info.description`, the users group from `tags[].description`, the command help from the operation summary and description, and the active flag help from its parameter description. The same prose supplies the reference JSDoc where useful. Implementation comments explain only non-obvious constraints such as keeping secrets out of validation errors. `--base-url` is runtime configuration, not an OpenAPI parameter.

Imports have no blank lines between them, as requested. All other style and structure choices are proposals for review, not settled generator requirements.

From this directory:

```sh
bun install
bun run build
bun run start -- users list --help
bun run start -- users list --active false --base-url http://127.0.0.1:43123/api
```

Inside this repository, the existing root dependencies also support building without a separate install. To start the demo server, run `bun examples/demo/server.ts` from the repository root in another terminal.

`--base-url` is required for requests and preserves a path prefix such as `/api`. `--active` accepts only explicit `true` or `false`; omitting it omits the query parameter. The command writes the response text to stdout and reports transport or non-success HTTP status failures through Effect CLI.

Only the spec, package, and hand-written entry point live here. This reference does not change the generator or the existing generated demo.

HTTP failures use shared generic descriptions and preserve the HTTP status. Error response bodies are not rendered.
