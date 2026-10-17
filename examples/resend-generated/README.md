# Generated Resend CLI

This directory is actual generator output from the pinned eight-operation Resend slice in [resend-reference](../resend-reference/README.md). Its `openapi.json` contains that slice enriched with the eight naming actions from `../resend-reference/naming.overlay.json`; the pinned upstream snapshot and extracted original remain unchanged.

Regenerate from the repository root:

```sh
bun tools/generate-resend.ts
bun run --cwd examples/resend-generated build
node examples/resend-generated/dist/main.js --help
```

The regeneration tool supports only this fixture's concrete naming targets. It is not a general OpenAPI Overlay processor. Unexpected source files stop regeneration for inspection; it does not silently delete them.

To use the generated CLI:

```sh
node examples/resend-generated/dist/main.js domains list \
  --base-url https://api.resend.com --bearer-auth YOUR_TOKEN
```

That command makes a real API request. Automated tests use local fixtures only. No credentials or environment defaults are generated. Optional JSON bodies accept `--body` or `--body-file`; supplying both fails.

The test suite compares every generated file against a fresh library result and checks for stale source modules. It compiles and executes all eight commands against a local server, preserving request methods, paths, headers, authentication, JSON values and declared constraints.
