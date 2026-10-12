# Effect observability examples

Read before implementing or reviewing application observability. These examples
follow this repository's Effect design, code documentation, and error-message
skills. They originate from Effect 4.0.1 examples and use an illustrative healthz API
contract defined below. Check APIs against the consuming package's installed version.

The goal is comprehensive useful tracing and logging: enough detail to locate
errors, isolate expensive work, explain recovery decisions, and assess which parts
of the codebase behave reliably or need improvement. The pairs below teach that
coverage at distinct boundaries; they are not a checklist for generating a test
for each span or log. Review instrumentation as part of normal code review.

Each code block is a complete alternative TypeScript module, not a sequence of
modules to combine. Exported names intentionally match within each pair. The
summary and catalog scenarios demonstrate operation boundaries; they do not add
features, database libraries, providers, or routes to this package.

## Nested expensive operations

The caller supplies lazy, already-decoded database and external-request effects.
For this example, neither the supplied effects nor their adapters already create
spans. Both alternatives preserve the effects' environment and typed failures.
In production, inspect existing adapter instrumentation before wrapping it.

### POSITIVE — Trace the work inside the application operation

Decisive evidence: executing `loadSummary` creates `summary.get` and two child spans, `summary.readCount` and `summary.fetchStatus`. Each wrapper covers execution of the supplied effect, so the database and external-request durations can be inspected separately.

```ts
import * as Effect from "effect/Effect";

/**
 * Reads the stored count and remote status used by a summary response.
 *
 * @param query - The lazy database read, with its result already decoded.
 * @param request - The lazy external request, with its result already decoded.
 * @returns The count and status, preserving either operation's typed failures.
 */
export const loadSummary = Effect.fn("summary.get")(function* loadSummary<E, R>(
  query: Effect.Effect<number, E, R>,
  request: Effect.Effect<string, E, R>,
) {
  const count = yield* query.pipe(Effect.withSpan("summary.readCount"));
  const status = yield* request.pipe(Effect.withSpan("summary.fetchStatus"));

  return { count, status };
});
```

### NEGATIVE — Trace only the outer function

Decisive evidence: executing the same supplied effects creates only `summary.get`. The database and external-request work still runs and failures still propagate, but neither internal operation has its own timing span.

```ts
import * as Effect from "effect/Effect";

/**
 * Reads the stored count and remote status used by a summary response.
 *
 * @param query - The lazy database read, with its result already decoded.
 * @param request - The lazy external request, with its result already decoded.
 * @returns The count and status, preserving either operation's typed failures.
 */
export const loadSummary = Effect.fn("summary.get")(function* loadSummary<E, R>(
  query: Effect.Effect<number, E, R>,
  request: Effect.Effect<string, E, R>,
) {
  const count = yield* query;
  const status = yield* request;

  return { count, status };
});
```

## Referenced endpoint handlers

These hypothetical HTTP adapter modules each define their own `Api` contract.
They illustrate referenced handler tracing, not an implemented generator feature.
Runtime assembly and telemetry wiring remain outside their boundary; no extra
tracer or runtime is constructed here.

### POSITIVE — Follow a referenced handler to its named Effect definition

Decisive evidence: `handlers.handle("get", getHealthz)` points to `Effect.fn("healthz.get")`. Executing that handler creates the stable application span even though registration contains no inline implementation.

```ts
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

/**
 * Defines the illustrative liveness contract for this example.
 */
const Api = HttpApi.make("example").add(
  HttpApiGroup.make("healthz").add(
    HttpApiEndpoint.get("get", "/healthz", {
      success: Schema.Struct({ ok: Schema.Boolean, runtime: Schema.String }),
    }),
  ),
);

/**
 * Returns the liveness response without reading external dependencies.
 *
 * @returns The schema-checked status identifying the Node runtime.
 */
export const getHealthz = Effect.fn("healthz.get")(function* getHealthz() {
  yield* Effect.logDebug("Liveness check completed").pipe(
    Effect.annotateLogs({ endpoint: "healthz" }),
  );

  return { ok: true, runtime: "node" } as const;
});

/**
 * Registers the named liveness handler against the existing API contract.
 *
 * @returns The handler layer used during runtime construction.
 */
export const makeHealthzHandlers = () =>
  HttpApiBuilder.group(Api, "healthz", (handlers) => handlers.handle("get", getHealthz));
```

### NEGATIVE — Mistake a JavaScript function name for a span name

Decisive evidence: registration still references `getHealthz`, and its generator is named, but unnamed `Effect.fn` creates no span in Effect 4.0.1. The response and debug logging remain identical to the positive alternative.

```ts
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

/**
 * Defines the illustrative liveness contract for this example.
 */
const Api = HttpApi.make("example").add(
  HttpApiGroup.make("healthz").add(
    HttpApiEndpoint.get("get", "/healthz", {
      success: Schema.Struct({ ok: Schema.Boolean, runtime: Schema.String }),
    }),
  ),
);

/**
 * Returns the liveness response without reading external dependencies.
 *
 * @returns The schema-checked status identifying the Node runtime.
 */
export const getHealthz = Effect.fn(function* getHealthz() {
  yield* Effect.logDebug("Liveness check completed").pipe(
    Effect.annotateLogs({ endpoint: "healthz" }),
  );

  return { ok: true, runtime: "node" } as const;
});

/**
 * Registers the named liveness handler against the existing API contract.
 *
 * @returns The handler layer used during runtime construction.
 */
export const makeHealthzHandlers = () =>
  HttpApiBuilder.group(Api, "healthz", (handlers) => handlers.handle("get", getHealthz));
```

## Logging and preserved causes

The catalog scenario is a read-only operation with a retryable source timeout.
Its adapter supplies a `CatalogTimeout` whose fixed message, bounded reason, and
validated timeout duration are safe to log; it contains no bodies or credentials.
The consuming HTTP endpoint must declare `CatalogUnavailable` in its error schema.
This module defines the translation boundary, not an endpoint or a new feature.
For real provider errors, inspect and sanitize their diagnostics before recording
them. Only this boundary logs the failure; callers must avoid logging it again.

### POSITIVE — Log the structured cause before translating the public failure

Decisive evidence: the error log receives the original sanitized `CatalogTimeout` instance, retaining its tag, timeout reason, and timeout duration with the operation annotation. The returned typed error carries only the curated read-retry message.

```ts
/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError is a schema class factory. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The sanitized timeout diagnostics allowed in internal catalog telemetry.
 */
export class CatalogTimeout extends Schema.TaggedError<CatalogTimeout>()("CatalogTimeout", {
  message: Schema.Literal("Catalog request timed out."),
  reason: Schema.Literal("Timeout"),
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

/**
 * The curated catalog-read failure declared by the consuming HTTP endpoint.
 */
export class CatalogUnavailable extends Schema.TaggedError<CatalogUnavailable>()(
  "CatalogUnavailable",
  {
    message: Schema.Literal(
      "The catalog could not be loaded because its source timed out. Retry the read request.",
    ),
  },
  { httpApiStatus: 503 },
) {}

/**
 * Reads the catalog while recording timeout diagnostics at the public boundary.
 *
 * @param read - The lazy read with timeout failures already sanitized by its adapter.
 * @returns The catalog text or a curated typed failure, with diagnostics logged once.
 */
export const loadCatalog = Effect.fn("catalog.get")(function* loadCatalog(
  read: Effect.Effect<string, CatalogTimeout>,
) {
  return yield* read.pipe(
    Effect.tapError((cause) =>
      Effect.logError(cause).pipe(Effect.annotateLogs({ operation: "catalog.get" })),
    ),
    Effect.mapError(
      () =>
        new CatalogUnavailable({
          message:
            "The catalog could not be loaded because its source timed out. Retry the read request.",
        }),
    ),
  );
});
```

### NEGATIVE — Keep only the cause message in the log

Decisive evidence: the log still has error level and the operation annotation, and the public typed failure is unchanged, but `cause.message` loses the original error object, timeout reason, and timeout duration. This example is negative only on preservation of diagnostic structure.

```ts
/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError is a schema class factory. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The sanitized timeout diagnostics allowed in internal catalog telemetry.
 */
export class CatalogTimeout extends Schema.TaggedError<CatalogTimeout>()("CatalogTimeout", {
  message: Schema.Literal("Catalog request timed out."),
  reason: Schema.Literal("Timeout"),
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

/**
 * The curated catalog-read failure declared by the consuming HTTP endpoint.
 */
export class CatalogUnavailable extends Schema.TaggedError<CatalogUnavailable>()(
  "CatalogUnavailable",
  {
    message: Schema.Literal(
      "The catalog could not be loaded because its source timed out. Retry the read request.",
    ),
  },
  { httpApiStatus: 503 },
) {}

/**
 * Reads the catalog while recording timeout diagnostics at the public boundary.
 *
 * @param read - The lazy read with timeout failures already sanitized by its adapter.
 * @returns The catalog text or a curated typed failure, with diagnostics logged once.
 */
export const loadCatalog = Effect.fn("catalog.get")(function* loadCatalog(
  read: Effect.Effect<string, CatalogTimeout>,
) {
  return yield* read.pipe(
    Effect.tapError((cause) =>
      Effect.logError(cause.message).pipe(Effect.annotateLogs({ operation: "catalog.get" })),
    ),
    Effect.mapError(
      () =>
        new CatalogUnavailable({
          message:
            "The catalog could not be loaded because its source timed out. Retry the read request.",
        }),
    ),
  );
});
```

## Training-data review

The intended lessons are comprehensive coverage of meaningful work, child spans
that isolate inefficient operations, tracing independent of inline syntax, and
structured diagnostics that make errors explainable while public failures remain
curated. Combine timing and outcome data with contextual logs to understand both
successful behavior and weak points; adding telemetry is part of building the
operation, not a reason to generate per-span regression tests. The
examples also preserve lazy execution, native Effect composition, typed failures,
explicit imports, schema-backed errors, and documented operation contracts.
The schema-factory lint exemption documents the factory syntax in these examples.

Do not infer that every helper needs a span, that existing driver spans should be
duplicated, that every failure should be logged, or that public error types should
carry raw provider causes. The supplied effects avoid choosing a database library;
they are an explicit example boundary, not a proposed application service design.

These are imported teaching examples, not package validation evidence. Validate
adapted code against the consuming runtime before use. Local instrumentation
checks do not establish exporter ingestion, sampling, or dashboard visibility.
