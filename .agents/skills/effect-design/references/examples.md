# Effect design examples

These imported teaching scenarios illustrate schema and composition decisions.
They do not prescribe adding HTTP endpoints, storage, or infrastructure to this
package. Validate adapted snippets against the consuming Effect version.

These examples are self-contained within this reference. The shared declarations below supply their schemas and imports; no application file is required. Handler excerpts run inside `Effect.gen`, with `request` an Effect HttpServerRequest, `params` the decoded AttachmentParams, and `bucket` an illustrative storage service whose `get` returns an Effect of a stored object or null. Each excerpt demonstrates only its labeled decision boundary.

```ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

/**
 * Validates decimal HTTP syntax and decodes a safe, nonnegative byte count.
 */
const ContentLength = Schema.String.check(Schema.isPattern(/^[0-9]+$/u)).pipe(
  Schema.decodeTo(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    SchemaTransformation.numberFromString,
  ),
);

/**
 * Identifies the invalid upload header and explains its required format.
 */
class InvalidContentLength extends Schema.TaggedError<InvalidContentLength>()(
  "InvalidContentLength",
  { field: Schema.Literal("content-length"), message: Schema.String },
  { httpApiStatus: 400 },
) {}

/**
 * Exposes a curated storage failure without leaking provider details.
 */
class AttachmentStorageError extends Schema.TaggedError<AttachmentStorageError>()(
  "AttachmentStorageError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

/**
 * Validates the ancestor identifier shared by descendant routes.
 */
class SpaceParams extends Schema.Class<SpaceParams>("SpaceParams")({
  spaceId: Schema.String.check(Schema.isUUID()),
}) {}

/**
 * Adds message validation while retaining the ancestor identifier.
 */
class MessageParams extends SpaceParams.extend<MessageParams>("MessageParams")({
  messageId: Schema.String.check(Schema.isUUID()),
}) {}

/**
 * Adds attachment validation while retaining both ancestor identifiers.
 */
class AttachmentParams extends MessageParams.extend<AttachmentParams>("AttachmentParams")({
  attachmentId: Schema.String.check(Schema.isUUID()),
}) {}
```

The descriptive-error example below supplies AttachmentNotFound for the other snippets. The upload endpoint must declare InvalidContentLength; the download endpoint declares AttachmentNotFound and AttachmentStorageError.

## Schema decoding

### POSITIVE — Decode before using an untrusted value

Decisive evidence: the shared ContentLength schema enforces decimal syntax and safe integer bounds; the handler receives a number and maps invalid input to a declared error before starting storage work.

Using the shared schema and tagged error above, inside the upload handler:

```ts
const contentLength = yield* Schema.decodeUnknownEffect(ContentLength)(
  request.headers["content-length"],
).pipe(
  Effect.mapError(
    () =>
      new InvalidContentLength({
        field: "content-length",
        message:
          "Provide Content-Length as decimal digits representing the file size in bytes, from 0 through 9007199254740991. The upload was not started.",
      }),
  ),
);
```

### NEGATIVE — Repeat schema rules manually in the handler

Decisive evidence: the failure remains explicit and typed, but validation rules are embedded in control flow instead of a reusable schema. This example is negative on validation ownership, not because `if` itself is inappropriate.

```ts
const length = request.headers["content-length"];
const contentLength = Number(length);

if (length === undefined || !/^[0-9]+$/u.test(length) || !Number.isSafeInteger(contentLength)) {
  return yield* Effect.fail(
    new InvalidContentLength({
      field: "content-length",
      message:
        "Provide Content-Length as decimal digits representing the file size in bytes, from 0 through 9007199254740991. The upload was not started.",
    }),
  );
}
```

## Readability and Effect

### POSITIVE — Keep clear control flow within Effect

Decisive evidence: the generator narrows the nullable object and fails with a declared tagged error. There is no JavaScript throw and no extra value-wrapping machinery.

```ts
const object = yield* bucket.get(params.attachmentId.toLowerCase());

if (object === null) {
  return yield* Effect.fail(
    new AttachmentNotFound({
      attachmentId: params.attachmentId,
      message:
        "No stored attachment exists for this attachment ID. Check the ID or upload the file before downloading it.",
    }),
  );
}
```

### NEGATIVE — Add combinators without an additional guarantee

Decisive evidence: this produces the same non-null value and typed failure as the preceding example, but adds nesting and success wrapping. The added syntax supplies no safety or behavior improvement to justify the readability cost. Combinators themselves are not discouraged.

```ts
const object = yield* bucket.get(params.attachmentId.toLowerCase()).pipe(
  Effect.flatMap((value) =>
    value === null
      ? Effect.fail(
          new AttachmentNotFound({
            attachmentId: params.attachmentId,
            message:
              "No stored attachment exists for this attachment ID. Check the ID or upload the file before downloading it.",
          }),
        )
      : Effect.succeed(value),
  ),
);
```

Keep simple value selection readable too:

```ts
contentLength === 0 ? new Uint8Array() : request.stream
request.headers["content-type"] ?? "application/octet-stream"
```

These two expression excerpts choose values; replacing them requires an actual benefit, not merely more Effect calls.

## Descriptive errors

### POSITIVE — Explain the specific missing resource and next action

Decisive evidence: the schema defines a stable tag, an attachment ID, and HTTP 404. Its usage gives the caller a specific repair instruction.

```ts
/**
 * Identifies an attachment with no stored object and carries a caller-facing explanation.
 */
class AttachmentNotFound extends Schema.TaggedError<AttachmentNotFound>()(
  "AttachmentNotFound",
  { attachmentId: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {}
```

Inside the download handler:

```ts
return yield* Effect.fail(
  new AttachmentNotFound({
    attachmentId: params.attachmentId,
    message:
      "No stored attachment exists for this attachment ID. Check the ID or upload the file before downloading it.",
  }),
);
```

### NEGATIVE — Return only a generic status error

Decisive evidence: assuming BadRequest is declared on the endpoint, this is type-valid but tells the caller neither the invalid field nor how to fix it.

```ts
return yield* Effect.fail(new HttpApiError.BadRequest());
```

Use [error-message examples](../../error-messages/references/examples.md) for additional audience-specific examples. Do not expose raw provider errors to make a response more detailed.

## Parent composition

### POSITIVE — Own each prefix once and compose descendants

Decisive evidence: the native HttpApi composition passes message and attachment endpoints through the space prefix. Editing that one prefix changes descendant routes and generated OpenAPI.

Using the shared imports, errors, and parameter classes in this reference:

```ts
/**
 * Declares attachment downloads relative to their parent message.
 */
const AttachmentsApi = HttpApiGroup.make("attachments").add(
  HttpApiEndpoint.get("get", "/attachments/:attachmentId", {
    error: [AttachmentNotFound, AttachmentStorageError],
    params: AttachmentParams,
    success: HttpApiSchema.StreamUint8Array(),
  }),
);

/**
 * Mounts all attachment endpoints beneath the owning message.
 */
const MessagesApi = HttpApi.make("messages")
  .add(AttachmentsApi)
  .prefix("/messages/:messageId");

/**
 * Owns the ancestor prefix inherited by all message descendants.
 */
const SpacesApi = HttpApi.make("spaces")
  .addHttpApi(MessagesApi)
  .prefix("/spaces/:spaceId");

/**
 * Mounts the composed hierarchy beneath the public API prefix.
 */
const Api = HttpApi.make("api").addHttpApi(SpacesApi.prefix("/api"));
```

Parameter classes separately derive `MessageParams` from `SpaceParams`, then `AttachmentParams` from `MessageParams`. Adding a prefix alone does not inherit parameter validation.

### NEGATIVE — Repeat ancestor paths in each endpoint

Decisive evidence: the endpoint can be valid, but this literal bypasses parent composition. Renaming `/spaces` now requires searching and editing individual descendants.

```ts
HttpApiEndpoint.get(
  "get",
  "/api/spaces/:spaceId/messages/:messageId/attachments/:attachmentId",
  {
    error: [AttachmentNotFound, AttachmentStorageError],
    params: AttachmentParams,
    success: HttpApiSchema.StreamUint8Array(),
  },
)
```

## Shared project identity

### POSITIVE — Reference the owning project configuration

Decisive evidence: consumers derive repository identity from one shared configuration; changes propagate to repository links and package metadata.

Define the shared configuration once:

```ts
/**
 * Owns the repository identity used by package consumers.
 */
const Project = {
  github: { owner: "aidenzepp", repository: "effect-openapi-cli-generator" },
} as const;
```

Object-field excerpt inside each repository-link consumer:

```ts
owner: Project.github.owner,
repository: Project.github.repository,
```

### NEGATIVE — Repeat the same identity at consumer sites

Decisive evidence: equivalent literals work today but can drift independently when the project is renamed or moved.

```ts
owner: "aidenzepp",
repository: "effect-openapi-cli-generator",
```

Keep concrete literals in the owning configuration. Derivation is for shared facts, not a requirement to eliminate every literal.
