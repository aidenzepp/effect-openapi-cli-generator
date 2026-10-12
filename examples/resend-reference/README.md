# Resend CLI reference

This fixture contains eight operations from the official [Resend OpenAPI repository](https://github.com/resend/resend-openapi), pinned to [8916b099d7f52b8552a2e1ef38a7f16fcd17864c](https://github.com/resend/resend-openapi/tree/8916b099d7f52b8552a2e1ef38a7f16fcd17864c). The pinned specification slice is paired with a hand-written Effect CLI split into `src/models.ts` for explicit request schemas, `src/commands.ts` for commands and shared execution helpers, and `src/main.ts` for the root and runtime layers. This is target output for review, not output emitted by the current generator.

## Provenance and rebuild

- `upstream/resend.json.snapshot` is the exact downloaded JSON source, including unrelated operations. The `.snapshot` suffix keeps repository formatters from rewriting upstream bytes.
- `upstream/LICENSE` preserves Resend's MIT license and copyright notice.
- `provenance.json` records immutable download URLs, revision and SHA-256 checksums for both files.
- `openapi.json` contains only the selected operations and their required components. Operation and component values are preserved exactly as JSON values; whitespace is repository-formatted.
- `naming.overlay.json` is our separate OpenAPI Overlay 1.0 document. Its eight concrete JSONPath targets add our CLI naming extensions; the slice itself has no added naming metadata. Original operation IDs remain unchanged.

From the repository root, using Python 3 and the existing repository formatter:

```sh
python3 examples/resend-reference/prepare.py
bunx vp fmt examples/resend-reference/openapi.json examples/resend-reference/naming.overlay.json
python3 examples/resend-reference/prepare.py --check
```

Rebuilding uses the committed snapshot without network access or new dependencies. To reacquire source, download the immutable URLs in `provenance.json` into their recorded paths; `--check` rejects any checksum difference. Extraction retains root metadata, servers, security, relevant tags and path-level fields, then follows the full component-reference closure across component kinds. Named security requirements also retain their schemes. Unresolved or nonlocal references fail rather than being silently rewritten.

The integrity check verifies checksums, exact operation selection, unchanged operation/component values, the reproducible full slice, resolved component/security references and eight distinct overlay targets addressing existing operation objects. It checks preservation, not full OpenAPI validity or live API behavior.

## Selected operations

The command column gives the implemented CLI addresses after the executable name `resend-reference`.

| HTTP operation                                       | Upstream operationId      | Command after naming overlay |
| ---------------------------------------------------- | ------------------------- | ---------------------------- |
| GET `/domains`                                       | `domains/list`            | `domains list`               |
| POST `/domains`                                      | `domains/create`          | `domains create`             |
| PATCH `/domains/{domain_id}`                         | `domains/update`          | `domains update`             |
| DELETE `/domains/{domain_id}`                        | `domains/remove`          | `domains delete`             |
| POST `/emails`                                       | `emails/send`             | `emails send`                |
| POST `/emails/batch`                                 | `emails/send-batch`       | `emails batch send`          |
| GET `/emails/{email_id}/attachments`                 | `emails/list-attachments` | `emails attachments list`    |
| GET `/emails/{email_id}/attachments/{attachment_id}` | `emails/get-attachment`   | `emails attachments get`     |

## Retained models and limits

The closure contains **21 components: 17 schemas, 3 parameters and 1 security scheme**. Root bearer authentication and `https://api.resend.com` remain intact.

Schemas: `SendEmailRequest`, `Attachment`, `Tag`, `EmailTemplateInput`, `SendEmailResponse`, `CreateBatchEmailsResponse`, `DomainCapabilities`, `CreateDomainRequest`, `CreateDomainResponse`, `UpdateDomainOptions`, `DomainRecord`, `ListDomainsResponse`, `ListDomainsItem`, `UpdateDomainResponseSuccess`, `DeleteDomainResponse`, `RetrievedAttachment`, `ListAttachmentsResponse`.

Parameters: `PaginationLimit`, `PaginationAfter`, `PaginationBefore`. Security scheme: `bearerAuth`.

The source is OpenAPI 3.1.2. It retains `oneOf`, `allOf`, defaults, formats, required fields, enums, array/length constraints, `additionalProperties`, and the send operations' `Idempotency-Key` header. Several of these features, including authentication, header parameters, composition and validation constraints, are outside the current generator's supported subset. No schema was flattened, stripped or coerced to make generation succeed. Future support must preserve their semantics; the fixture does not authorize applying defaults or sending real email.

No unresolved references were found in this closure. Descriptions and constraints are upstream data; the extraction does not reconcile any disagreement between prose and machine-readable rules.

## Build and run

From the repository root:

```sh
bun run --cwd examples/resend-reference build
node examples/resend-reference/dist/main.js --help
node examples/resend-reference/dist/main.js emails attachments get --help
```

Dependencies use the repository's pinned Effect 4.0.3 packages. A standalone copy can run `bun install` inside this directory before building. No API call occurs during build or help.

Every execution requires an explicit `--base-url` and a bearer token, supplied through `--api-key` or `RESEND_API_KEY`. The explicit flag takes precedence. The token uses native Redacted values and is passed directly to the native bearer-token request helper. No production base URL or credential is supplied automatically.

Against a local HTTP fixture implementing these routes:

```sh
RESEND_API_KEY=fixture-token node examples/resend-reference/dist/main.js domains list --base-url http://127.0.0.1:43124/api --limit 10
RESEND_API_KEY=fixture-token node examples/resend-reference/dist/main.js domains update --base-url http://127.0.0.1:43124/api --domain-id domain-1 --body '{"open_tracking":false}'
RESEND_API_KEY=fixture-token node examples/resend-reference/dist/main.js emails send --base-url http://127.0.0.1:43124/api --idempotency-key local-example --body '{"from":"sender@example.com","to":["recipient@example.com"],"subject":"Example"}'
RESEND_API_KEY=fixture-token node examples/resend-reference/dist/main.js emails batch send --base-url http://127.0.0.1:43124/api --body '[{"from":"sender@example.com","to":"recipient@example.com","subject":"Example"}]'
```

These commands need a running fixture; this directory does not start a server. The default users demo server does not implement these routes. No live Resend requests were used to develop this reference. Choosing Resend's real server and credentials can create/delete domains or send email.

## Reference boundary decisions

- All four request bodies are optional because upstream omits `requestBody.required`. Missing `--body` sends no body; present JSON is checked against its model. Required object fields remain required when a body is supplied.
- `StructWithRest` and `Schema.Json` preserve unknown JSON properties allowed by upstream. No defaults, coercion, automatic retries or response-model decoding are applied. Responses remain text.
- Seven named request models follow explicit references: `Attachment`, `Tag`, `EmailTemplateInput`, `DomainCapabilities`, `SendEmailRequest`, `CreateDomainRequest`, `UpdateDomainOptions`. Response-only models are retained in the spec, not emitted as unused code.
- Native `Schema.Union` with `mode: "oneOf"` preserves the recipient and template-variable alternatives. The template `allOf` adds only a description to a referenced model, so its validation remains that model.
- `Schema.isMaxCodePoints(256)` enforces the declared idempotency-key length using Unicode code points. Array item bounds use native length checks. No constraints are inferred from descriptions: tag spelling/length, enabled-capability rules, cursor mutual exclusion and the batch summary's limit are not machine-readable constraints here.
- OpenAPI 3.1 formats are treated as annotations in this reference. UUID inputs remain strings with no version restriction; `binary` inside JSON remains a string, with no file/base64 conversion. This is an explicit reference policy, not a claim of universal format validation.
- Dot-only path values `.` and `..` fail at the request boundary because URL parsing would normalize them to a different route. This is transport safety, not an invented schema pattern. All operations use `appendPathSegments` with the shared checked `encodePathSegment` helper. Dotted filenames stay intact, slashes inside parameter values are escaped, and invalid Unicode receives a safe CLI error. Complete mixed segments are assembled before encoding.
- Body failures use native Schema diagnostics with input reporting disabled, preserving typed causes without echoing the entire JSON body. JSON encoding uses checked `bodyJson`; credentials and sensitive base URL fragments are excluded from user-facing HTTP errors.

These choices exercise capabilities that the generator does not yet support; handwritten execution does not establish generator parity. The naming allocator described in the canonical decision guide also remains future work.

## Source layout

`commands.ts` imports `* as Models` from `./models.js`; `main.ts` imports `* as Commands` from `./commands.js`. Only the three request schemas consumed by commands and the two top-level command groups are exported. Model dependencies remain local. Operation and group names end in `Command`, and nested groups retain their complete ordered path, such as `EmailsAttachmentsCommand`. `rootCommand` remains the entrypoint root. This supersedes the earlier single-file layout without changing wire behavior.
