---
name: trace-effect
description: Write or review observability in Effect applications, including endpoint handlers, nested database and external API operations, expensive processing, structured logs, error causes, and telemetry verification. Use when adding or changing effectful application operations or investigating their latency and failures.
---

# Trace Effect

Maximize useful tracing and logging so maintainers can locate errors and
inefficiencies, understand execution paths, and identify the codebase's weak and
strong points. Treat observability as part of implementation, not optional polish.
Cover meaningful application and internal operations comprehensively; avoid duplicate
telemetry and events that add volume without diagnostic value.
Use this repository's `effect-design`, `document-code`, and `error-messages` skills
where applicable. Inspect `src/cli/main.ts` and the generated runtime assembly for
existing wiring. Preserve the consuming runtime's tracer and logger; do not add
exporters or infrastructure merely to apply this skill. Keep CLI stdout reserved
for the command result; route diagnostics through the owning runtime logger to
stderr so tracing and logs do not corrupt machine-readable output.

Before implementation or review, read [references/examples.md](references/examples.md).
Its POSITIVE and NEGATIVE pairs define the decision boundaries for nested spans,
referenced handlers, and structured failure logging.

## Inspect the owning runtime

1. Read repository instructions, relevant local skills, and existing telemetry wiring.
2. Check pinned Effect and integration versions. Read installed Effect guidance and
   source before choosing APIs; preserve dependency pins.
3. Identify the active tracer, logger, sampling, filtering, and export destination.
   Reuse the runtime's supported integration rather than installing a competing tracer.
4. Trace the execution path from handler registration through services and integrations.
   Follow named handlers, imported definitions, factories, and wrappers. An identifier
   passed to a handler registration is not evidence that its operation is traced.

## Choose span boundaries

- Give each application endpoint operation a stable, named span. If the runtime
  already supplies an equivalent application span, reuse it. A generic HTTP request
  span alone does not identify the application operation.
- Trace database queries, external API requests, storage operations, and processing
  that can materially contribute latency or fail independently. Also cover meaningful
  domain operations, retries, and fallback boundaries when they explain execution or
  failure. Instrument at the owning operation so callers reuse the same coverage.
- Inspect library and platform instrumentation first. Reuse existing spans when
  they expose the required operation and timing; add application spans when they
  explain distinct work. Avoid duplicate spans for the same boundary.
- Keep short glue functions and ordinary transformations untraced unless measuring
  them answers a concrete performance question. Do not decompose code solely to
  manufacture spans.

Use named `Effect.fn("operation")` for reusable traced operations, or
`Effect.withSpan("operation")` around an existing effect. In the source examples (Effect 4.0.1), unnamed
`Effect.fn` captures stack frames without creating a span; `Effect.fnUntraced`
does not create a span either. Verify these semantics against the consuming version.

A named outer function creates its own span; it does not automatically create spans
for every yielded effect. Nested traced operations inherit the active parent in
normal Effect composition. Preserve that context; do not introduce detached runtime
execution or root spans merely to instrument an internal call.

Wrap the actual work, including awaiting its completion, rather than just creating
an effect, query, promise, or stream. For lazy and streaming APIs, establish whether
the intended timing covers acquisition, consumption, or both. Keep cancellation,
resource cleanup, concurrency bounds, and error channels intact.

## Name and annotate deliberately

- Use stable names describing the operation, such as `orders.get`,
  `orders.loadFromDatabase`, or `shipping.fetchQuote`. Preserve established names.
  Keep record IDs, request URLs, and other dynamic values out of span names.
- Attach useful safe context using the installed span annotation APIs. Prefer
  scalar attributes compatible with the exporter. Check backend support before
  relying on attributes, events, links, or outbound trace propagation.
- Keep credentials, tokens, bodies, sensitive user content, and raw query parameters
  out of telemetry. Review captured error causes for sensitive provider diagnostics.
- Parent durations include child work; concurrent children overlap. Do not sum child
  durations as though they were sequential or treat a parent duration as exclusive.

## Log useful events and preserve failures

Use Effect logging and log annotations to retain operation context. Use debug for
routine diagnostics, info for meaningful application events, warning for recoverable
problems, and error for unexpected failures. Successful-event messages belong after
the described work completes; avoid logging every health poll at info level.

Record useful outcomes and decisions: recovery attempts, fallback selection, skipped
work, partial success, and exhausted retries when those explain system behavior.
Include safe structured context that connects the event to its operation. Choose
levels and filtering deliberately so detailed diagnostics remain available without
making normal production logs unreadable. A span alone does not explain a decision;
a log alone does not show the time spent in nested work.

Keep typed failures in Effect's error channel and preserve diagnostic causes at the
owning internal failure boundary while returning curated caller-facing errors.
Do not stringify away useful error structure, swallow failures, or log the same
failure at every layer. A failed span need not also produce a redundant error log.
Use the repository's error-message guidance for messages and public contracts.

## Verify the application contract

1. Review every changed handler registration and follow its implementation to check
   application span coverage, regardless of inline or referenced syntax.
2. Verify expensive nested operations have distinct useful spans or documented
   existing instrumentation. Verify nesting when changing context or runtime wiring.
3. Enforce instrumentation quality through implementation and review. Do not add
   a test for every endpoint, span name, log message, or generic span lifecycle.
   Add a focused test only when it protects a consequential application guarantee,
   such as retaining failure diagnostics at an error boundary, excluding secrets,
   or propagating context across a custom runtime bridge. State the actual failure
   the test would catch. Do not assert fixed latency against real external services.
4. Run repository checks and relevant tests. Test collectors belong only in tests;
   preserve production telemetry integration.
5. Distinguish local instrumentation evidence from export evidence. When authorized,
   check a sampled real request in the configured backend for the expected waterfall
   and diagnostics. Report unverified ingestion explicitly; a successful local
   response does not establish that the backend received a trace.

This skill guides implementation and review; it does not mechanically enforce coverage.
