# Content CLI reference

This is a hand-written target for a richer generated CLI, not generator output. The contract is in `openapi.json`; the editable standalone entry point is `src/main.ts`. It sits alongside the smaller `examples/reference` without changing it or the generator.

From this directory, run `bun install` if dependencies are not already supplied by the repository, then `bun run build`. The build creates ignored `dist/main.js`. Help needs no base URL:

```sh
node dist/main.js users posts list --help
node dist/main.js users posts list --user alice --status draft --limit 20 --published false --base-url http://localhost:43123/api
node dist/main.js users posts create --user alice --body '{"title":"First post","published":false}' --base-url http://localhost:43123/api
node dist/main.js users posts files list --user alice --post post-123 --base-url http://localhost:43123/api
```

Supply an API implementing these routes; the existing users-only demo server does not implement this spec. The automated test `tests/content-reference.test.ts` supplies a local HTTP fixture for all three operations.

Path identifiers are nonempty and cannot equal `.` or `..`; each is encoded as one URL segment. The base URL retains its path prefix. Optional query flags remain absent when omitted, and `--published false` sends an explicit false value. Limit is an integer from 1 through 100.

`--body` accepts JSON with a nonempty string `title`, optional boolean `published`, and optional string-array `tags`. Unknown fields are rejected. Omitted fields stay absent, and false values, empty tag arrays and string contents are preserved. There are no defaults or body-file input.

Help and operation comments use standard OpenAPI descriptions. Requests retain their specified HTTP methods. Success response text goes to stdout; one shared neutral formatter renders HTTP failures and preserves their causes without displaying error bodies. No automatic retries or authentication are added.
