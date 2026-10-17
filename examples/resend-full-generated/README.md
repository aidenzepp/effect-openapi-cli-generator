# Full Resend generated CLI

This is actual generator output from the unchanged [pinned Resend snapshot](../resend-reference/upstream/resend.json.snapshot): 113 operations, 72 paths and 197 component schemas. `openapi.json` preserves every original JSON value, including webhooks; no naming overlay is applied. Commands use slash-separated upstream operation IDs.

```sh
bun tools/generate-resend-full.ts
bun run --cwd examples/resend-full-generated build
node examples/resend-full-generated/dist/main.js --help
node examples/resend-full-generated/dist/main.js contacts create-import --help
```

The generator refuses unexpected source files during regeneration. The test suite verifies exact regeneration, input preservation, all 113 help routes, and local HTTP wire behavior. Automated tests make no live Resend requests.

To upload a contact file, use this command with your own credentials; it makes a real API request:

```sh
node examples/resend-full-generated/dist/main.js contacts create-import \
  --base-url https://api.resend.com --bearer-auth YOUR_TOKEN --file ./contacts.csv
```

`--column-map`, `--segments` and `--topics` remain strings as declared upstream. Their descriptions do not cause automatic JSON parsing. `on_conflict` is omitted unless supplied; the generator does not insert its documented default. Unknown allowed multipart fields can be supplied through `--additional-fields '{"future":"text"}'`; declared names cannot be overridden. Files are buffered in memory, not streamed. Unknown fields support text only.

Query-array flags accept JSON arrays, for example `emails metrics --metrics '["sent","opened"]'`. Non-exploded arrays reject comma-containing items and all arrays reject an empty list because the form transport cannot preserve that distinction. See the [root README](../../README.md) for supported input boundaries.
