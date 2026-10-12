# Agent instructions

Read README.md and docs/project.md first. For emitted code or reference changes, also read [generated code decisions](docs/generated-code-decisions.md). This repository is a foundation for an Effect-native OpenAPI CLI generator. Keep work within the assigned scope; use src/core/ for the reusable generator and src/cli/ for its executable interface, with kebab-case filenames. Do not add examples, benchmarks, infrastructure, or artificial package hierarchies without a request.

## Engineering

- Follow existing repository and supplied reference patterns. Explain necessary deviations before introducing a different convention.
- Use verified, version-pinned GitHub source URLs for external dependency `@see` links; do not link installed `node_modules` paths.
- In hand-written references and generated CLI output, preserve schema reuse declared by explicit OpenAPI model references. Keep inline constraints in their owning flags; do not infer shared schemas from structural similarity.
- Keep normal lint key ordering; do not add key-sort exceptions to preserve CLI flag order.
- Use Effect APIs and typed errors at runtime. Preserve HTTP request semantics and wire schemas; command names do not imply HTTP verbs.
- Prefer the smallest explicit implementation. Reject unsupported input with useful errors rather than silently guessing.
- Select relevant personal skills by task: `api-boundary-design`, `designing-trustworthy-functions-and-data`, `small-software`, `software-taste`, `contract-tests`, and `correctness`. Avoid bulk copying skills into the repository.
- Include new TypeScript source in tsconfig.json when implementation begins. Add meaningful targeted tests and build/package checks when there is code to exercise.
- Run `bun run check` and the relevant targeted checks before completion. Explain skipped or failed checks.
- Commit substantive completed work and report the hash plus verification evidence. Preserve unrelated edits.
- Confirm the target before remote changes. Push, publish, deploy, or mutate external services only within explicit user authorization.

## Review workflow

Keep changes local for user review. Do not push, publish, or deploy without explicit approval for that action.

## Repository skills

- Use `.agents/skills/conventional-commits/SKILL.md` when staging or committing.
- Use `.agents/skills/document-code/SKILL.md` when writing or reviewing code; keep JSDoc multiline and imports contiguous.
- For the hand-written reference and generated CLI output, prefer documentation from standard OpenAPI summaries and descriptions. This overrides blanket declaration coverage: add implementation comments only for meaningful non-obvious constraints, not redundant constant or group descriptions.
- Use `.agents/skills/effect-design/SKILL.md` when writing or reviewing Effect code, schemas, or configuration composition. Read its labeled examples and inspect installed APIs before building custom equivalents. Name selected native capabilities and justify custom glue in the handoff.
- Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow relevant links; consult installed source for uncovered APIs and preserve pinned versions.
- Use `.agents/skills/trace-effect/SKILL.md` when changing effectful operations or reviewing observability. Trace meaningful operations and external requests; review coverage without tests for every span or log.
- Use `.agents/skills/error-messages/SKILL.md` when changing caller-facing errors. Preserve the existing typed library and CLI error contracts; generic payload examples do not require a separate envelope.
