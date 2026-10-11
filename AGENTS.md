# Agent instructions

Read README.md first. This repository is a foundation for an Effect-native OpenAPI CLI generator. Keep work within the assigned scope; source layout is intentionally undecided. Do not add examples, benchmarks, infrastructure, or artificial package hierarchies without a request.

## Engineering

- Follow existing repository and supplied reference patterns. Explain necessary deviations before introducing a different convention.
- Use Effect APIs and typed errors at runtime. Preserve HTTP request semantics and wire schemas; command names do not imply HTTP verbs.
- Prefer the smallest explicit implementation. Reject unsupported input with useful errors rather than silently guessing.
- Select relevant personal skills by task: `api-boundary-design`, `designing-trustworthy-functions-and-data`, `small-software`, `software-taste`, `contract-tests`, and `correctness`. Avoid bulk copying skills into the repository.
- Include new TypeScript source in tsconfig.json when implementation begins. Add meaningful targeted tests and build/package checks when there is code to exercise.
- Run `bun run check` and the relevant targeted checks before completion. Explain skipped or failed checks.
- Commit substantive completed work and report the hash plus verification evidence. Preserve unrelated edits.
- Confirm the target before remote changes. Push, publish, deploy, or mutate external services only within explicit user authorization.

## Review workflow

Keep changes local for user review. Do not push, publish, or deploy without explicit approval for that action.
