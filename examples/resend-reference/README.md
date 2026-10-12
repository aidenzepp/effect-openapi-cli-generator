# Resend OpenAPI slice

This fixture contains eight operations from the official [Resend OpenAPI repository](https://github.com/resend/resend-openapi), pinned to [8916b099d7f52b8552a2e1ef38a7f16fcd17864c](https://github.com/resend/resend-openapi/tree/8916b099d7f52b8552a2e1ef38a7f16fcd17864c). It is a specification slice for reviewing future CLI output; no CLI has been generated or hand-written here.

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

The command column describes the overlay's proposed CLI addresses, not an executable CLI.

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
