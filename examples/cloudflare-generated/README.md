# Cloudflare token-discovery CLI

This is actual generator output from three unchanged GET operations in Cloudflare's official OpenAPI specification:

| Endpoint                         | Command                                             |
| -------------------------------- | --------------------------------------------------- |
| `/user/tokens`                   | `cloudflare-api user tokens list`                   |
| `/user/tokens/verify`            | `cloudflare-api user tokens verify`                 |
| `/user/tokens/permission_groups` | `cloudflare-api user tokens permission-groups list` |

`openapi.json` retains the selected operations, upstream Fern naming extensions, security declarations and complete transitive component references. No naming overlay or schema relaxation is applied. The slice includes 33 schemas, one parameter and all four original security schemes. Only the effective bearer scheme and used parameter declarations appear in generated code. Root metadata, including Forge extensions, is preserved; this generator does not claim Forge parity.

## Run and regenerate

From the repository root:

```sh
bun run --cwd examples/cloudflare-generated build
node examples/cloudflare-generated/dist/main.js user tokens list --help
node examples/cloudflare-generated/dist/main.js user tokens verify --help
node examples/cloudflare-generated/dist/main.js user tokens permission-groups list --help
```

Help needs no credentials and makes no API requests. For an actual request, supply your own `--api-token` and `--base-url https://api.cloudflare.com/client/v4`. No live Cloudflare request was made during verification.

Regenerate by downloading the pinned public specification:

```sh
bun tools/generate-cloudflare.ts
```

Or reuse a local copy of the exact original bytes:

```sh
bun tools/generate-cloudflare.ts /path/to/cloudflare-openapi.json
```

Both paths verify the source SHA256 before writing anything. The tool refuses unexpected generated source files. Tests verify the committed slice checksum, reference extraction, exact regenerated files, build and all three help routes. Building inside this repository uses its installed dependencies; standalone use requires installing the generated package's dependencies first.

## Provenance and current boundaries

- [Official Cloudflare source](https://github.com/cloudflare/api-schemas/blob/15656f084dd7a0ada54f8f659c749a7248254b9f/openapi.json), revision `15656f084dd7a0ada54f8f659c749a7248254b9f`, committed October 16, 2026.
- Original SHA256: `d1d390a0d062d5686c448b01f57a7a72e7f61594929f1888137e81499efc97c9`.
- Original size: 27,454,891 bytes; OpenAPI 3.0.3; 3,761 operations, 2,347 paths and 7,173 schemas.
- `provenance.json` records the source URL/revision/hash, selected operations and SHA256 of `JSON.stringify` applied to the parsed slice. The full 27 MB snapshot is not duplicated in this repository.

The full original spec fails first on security combinations at `/paths/~1accounts/get/security`. The inspected Zones, DNS records and legacy Workers slices offer alternative authentication schemes that are also unsupported. Independent request-schema probes additionally found `anyOf` in DNS write bodies, structural `allOf` in Workers upload bodies, and `readOnly` on the token-detail identifier. These are the first observed blockers, not an exhaustive compatibility audit. This example adds no support for those features and generates no usage examples.

The upstream specification is distributed under the [BSD 3-Clause license](UPSTREAM-LICENSE), retained alongside this slice.
