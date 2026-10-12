---
name: effect-design
description: Write or review Effect code in this repository, especially native CLI and Node platform integrations, streaming, service dependencies, resource lifecycles, boundary schemas, typed HTTP errors, and readable composition.
---

# Effect Design

Maximize use of Effect's supported capabilities while maintaining readability. Prefer native Effect and platform APIs over custom equivalents. Check the installed version's documentation and source before assuming a capability is unavailable or inventing an adapter.

Before implementation or review, read [references/examples.md](references/examples.md). Its POSITIVE and NEGATIVE labels define decision boundaries, not mandatory syntax templates.

## Native capability review

Apply this review before implementing a nontrivial operation, not only after deciding to build a custom parser, adapter, stream consumer, dependency container, client wrapper, retry loop, or resource-management mechanism:

1. State the contract: accepted input, output, failures, limits, lifecycle, and guarantees.
2. Inspect the owning repository patterns and pinned dependency versions.
3. Check installed Effect core APIs, CLI/Schema facilities, relevant companion packages, and Node platform integrations. Use supported platform services for filesystem, HTTP, and runtime assembly; use Effect for composition and lifecycle. Keep the reusable generator independent of runtime IO.
4. Read the relevant API documentation and source for the installed version. Search neighboring APIs too; failing to find one guessed symbol does not establish that the capability is absent.
5. Select the supported primitive or integration that satisfies the contract with the clearest implementation. Check runtime compatibility, streaming behavior, cancellation, typed failures, and lifecycle guarantees before adapting it. If custom glue remains necessary, identify the specific missing capability and document the constraint at its owning boundary.
6. Review the final implementation for recreated framework behavior. In the handoff, name the selected native capabilities and their role; for custom glue, name the documentation/source checked, the verified gap, and why the adaptation is necessary. Keep this explanation proportional to the change.

Do not claim that a native capability is unavailable without checking. Do not upgrade dependencies or add a package merely to make an example convenient. Explain material findings in the work update; this review does not require a new report file.

## Capabilities to inspect

- CLI and platform boundaries: native `Command`, `Argument`, `Flag`, and Node
  service layers before custom parsers or runtime adapters. Keep generator options,
  emitted command inputs, and runtime configuration at their owning boundaries.
- Streaming: `Stream`, `Sink`, `Channel`, HTTP body helpers, and `Multipart` before
  custom read loops, mutable collection, or whole-body buffering. Prefer a supported
  collector when bounded collection is intended; stream operators alone do not
  establish size limits or guarantee the intended consumption order.
- Service dependencies: `Context.Service` and `Layer` before custom dependency
  containers, singleton registries, or manual service construction at every call.
  Use the platform-specific layers and adapters supported by the Node runtime.
- Cleanup and lifetime: `Scope`, scoped layers, and acquire/release primitives before
  ad hoc finalizer bookkeeping. Preserve interruption and release guarantees.
- HTTP, validation, and configuration: `HttpClient`, `HttpApi`, `Schema`, and `Config`
  before bespoke transport wrappers, routing, input parsers, or environment parsing.
- Concurrency, retries, and coordination: Effect's bounded concurrency, `Schedule`,
  `Queue`, and `PubSub` before promise orchestration, retry timers, or custom queues.

These are search starting points, not mandatory APIs for every function. Explore
neighboring modules and supported companion integrations as the contract requires.
A relevant companion package may be a better fit than custom code; verify its
compatibility and propose any dependency change explicitly within the chosen scope.
Use a platform-native API through the smallest Effect adaptation when no supported
integration covers the requirement. Prefer plain control flow when no framework
capability adds a useful guarantee; native-first does not mean decorative combinators.

## Readability review process

Use this process for new code and refactors:

1. Identify the responsibilities: reading transport data, decoding schemas, application behavior, error translation, and resource lifecycle. Separate responsibilities when it helps a reader; do not make a helper for every expression.
2. Look for nested generators/callbacks, mutable accumulation, repeated validation, manual parsing, and success wrapping. Ask which installed primitive already owns that responsibility.
3. Prefer a main operation that reads as a short sequence of meaningful steps. Use named `Effect.fn` / `Effect.fnUntraced` helpers for coherent effectful operations and native stream operators for stream transformations.
4. Put invariants in Schema where supported. Use native exhaustive matching when it makes error classification clearer and verifies all supported cases.
5. Check that the abstraction preserves execution order, bounded memory, cancellation, cleanup, and typed failures. A shorter pipeline is wrong if it skips file streams, buffers unbounded attachments, or loses failure information.
6. Compare the result for readability and behavior. Native capabilities are preferred while readable; plain `if`, ternaries, and `??` remain valid. Avoid trading understandable control flow for decorative combinators.
7. Verify with the repository's normal checks and relevant boundary tests. Check emitted error bodies and generated contracts when affected.

Read [references/readable-decoding.md](references/readable-decoding.md) when reviewing nested decoding or stream code. It contains self-contained positive and negative examples; application files are optional navigation, never the definition of correctness.

## Boundary schemas and errors

- Decode untrusted input with Schema into useful types. Keep validation rules in a schema rather than scattered manual conversions and predicates.
- Use schema-backed tagged errors and expose them in the owning library or CLI contract. For HTTP API adapters, declare errors in the endpoint contract. Give callers stable tags, specific messages, and safe structured facts. Apply the local `error-messages` skill when writing or changing errors.
- Prefer native CLI codecs and Schema decoding for command inputs, and preserve OpenAPI wire constraints in emitted request schemas. For HTTP adapters, use endpoint parameter, header, query, and payload schemas. Keep application failures distinct from ordinary schema failures.
- Verify the actual response body. Schema validation does not automatically guarantee a descriptive HTTP response: Effect's default validation response may be empty. Map validation failures explicitly when the caller needs an explanation.
- Keep provider causes in internal observability; expose curated messages. Do not promise that data was preserved unless the failure boundary proves it.

## Readable Effect

Use Effect broadly for schemas, errors, composition, resources, tracing, concurrency, and available native integrations. This is a positive preference, not a restriction to a small set of guarantees.

Choose Effect-native formulations when equally clear. Do not replace concise `if`, `??`, or ternary expressions with longer combinator chains unless the change provides a concrete safety, type-safety, resource, or behavioral advantage that justifies the readability cost. `Effect.gen` with ordinary control flow is idiomatic Effect.

## Derive shared choices

Define a shared fact at its owning boundary and compose descendants from it. Route prefixes belong to parent composition; parameter schemas inherit parent validation; emitted package consumers reference the shared generation options. Changes to a parent should propagate without editing repeated literals.

Keep dependencies acyclic: parent API assembly imports children, while child parameter schemas import parent parameter schemas in separate modules. Do not add a registry or generic abstraction when native composition suffices. A new abstraction should answer a present requirement.

## Verification

Follow repository checks and Bun tests. Verify boundary failures as well as success, generated contracts, and relevant cascade behavior. Keep dependency versions pinned and keep application-specific features out of the reusable generator.
