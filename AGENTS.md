# Agent instructions

Read README.md and docs/project.md first. docs/project.md is the committed direction for this repository: an Effect-native OpenAPI CLI generator that runs on Bun. Keep work within the assigned scope. Do not add examples, benchmarks, infrastructure, or artificial package hierarchies without a request.

## Layout

The generator has one directory per pipeline stage (docs/project.md, "Pipeline" and "Repository layout"):

- `src/load/`, `src/validate/`, `src/resolve/`, `src/check/`, `src/normalize/`, `src/names/`, `src/emit/`, `src/write/`, `src/report/`: the stages, in pipeline order.
- `src/model/`: branded values, entities and codecs. This is the trust boundary: specification values enter only through `Schema` decoding, and stages after `src/normalize/` read the model, never the source document.
- `src/runtime-src/`: the generated runtime's source, emitted verbatim. It imports only `effect`, `effect/http`, `effect/cli` and sibling runtime modules, and never names Bun.
- `src/index.ts` is the library entry; `src/main.ts` and `src/bin.ts` are the generator CLI.
- Tests live under `tests/`, mirroring the stage they cover.

Use kebab-case filenames.

## Engineering

- Follow existing repository and supplied reference patterns. Explain necessary deviations before introducing a different convention.
- Use Effect APIs and typed errors at runtime. Preserve HTTP request semantics and wire schemas; command names do not imply HTTP verbs.
- Prefer the smallest explicit implementation. Reject unsupported input with useful errors rather than silently guessing.
- Select relevant personal skills by task: `api-boundary-design`, `designing-trustworthy-functions-and-data`, `small-software`, `software-taste`, `contract-tests`, and `correctness`. Avoid bulk copying skills into the repository. The repository's own skills live in `.agents/skills/`: `conventional-commits` for commit messages and `document-code` for JSDoc.
- Include new TypeScript source in tsconfig.json when implementation begins. Add meaningful targeted tests and build/package checks when there is code to exercise.
- Run `bun run check` and the relevant targeted checks before completion. Explain skipped or failed checks. When work is split into slices (bounded units delegated to separate agents), a slice runs its own `validation` line only; `bun run check`, `bun run test` and the corpus run (which also runs the coverage join) are the lint, test and merge gates on the integration branch.
- Commit substantive completed work and report the hash plus verification evidence. Preserve unrelated edits.
- Confirm the target before remote changes. Push, publish, deploy, or mutate external services only within explicit user authorization.

## Effect

`effect` and `@effect/platform-bun` are pinned exactly to `4.1.2`. For Effect APIs, read the installed package's own `AGENTS.md`, `ai-docs/` and source (`node_modules/effect/`) before other material; other copies of the documentation may describe a different version.

- Prefer native Effect capabilities over custom equivalents. Before writing a parser, stream loop, dependency container, client wrapper, retry loop or cleanup mechanism, check the installed `effect/cli` (`Command`, `Argument`, `Flag`), `Schema`, `Config`, `effect/http` (`HttpClient`), `Stream`, `Sink`, `Context.Service`, `Layer`, `Scope`, `Schedule` and bounded concurrency. Do not claim a capability is missing without reading the installed source and its neighboring modules. When custom code remains necessary, name the verified gap at its owning boundary.
- Readability wins over decorative combinators. `Effect.gen` with plain `if`, `??` and ternaries is idiomatic. Use `Effect.fn("name")` for reusable operations that should create a span, and `Effect.fnUntraced` for library internals and hot paths; unnamed `Effect.fn` creates no span. Do not write functions that only wrap and return `Effect.gen`.
- Decode untrusted input with `Schema` into useful types and keep validation rules in the schema, not in scattered predicates. Use `Schema.TaggedError` classes with stable tags and safe structured fields; apply the `error-messages` skill to their messages.
- Keep provider causes for internal diagnostics and expose curated messages. Do not stringify away error structure or log the same failure at every layer.
- Preserve streaming, bounded memory, cancellation, cleanup and typed failures. A shorter pipeline is wrong if it buffers an unbounded body or loses a failure.
- Define a shared fact once at its owning boundary and derive the rest from it.
- Observability: give meaningful operations stable span names with no dynamic values in them, and keep credentials, bodies and raw query values out of spans and logs. Generated CLIs keep stdout for the command result and send diagnostics to stderr.

## Review workflow

Keep changes local for user review. Do not push, publish, or deploy without explicit approval for that action.
