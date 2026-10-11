# Agent instructions

Read README.md first. This repository is a foundation for an Effect-native OpenAPI CLI generator. Keep work within the assigned scope; source layout is intentionally undecided. Do not add examples, benchmarks, infrastructure, or artificial package hierarchies without a request.

## Coordination

- Load your personal `vivi` and `tugboat` skills. Tugboat stays personal; do not clone it into this repository.
- Run `vivi --version`, then `vivi boot --project .` before coordinating. Use `bun run setup:vivi` on a fresh checkout.
- Default to Tugboat Mind mode. Switch to Direct only when the user says so.
- Mind assigns concrete Vivi tasks with write scope and completion criteria. Workers load their role charter and task handle, work only that unit, report evidence through the same handle, and stop.
- Use only the Vivi CLI for coordination state. Never edit `.vivi/` internals or commit them. Do not send remote `vivi chat` messages or absorb records unless the user asks.

## Engineering

- Use Effect APIs and typed errors at runtime. Preserve HTTP request semantics and wire schemas; command names do not imply HTTP verbs.
- Prefer the smallest explicit implementation. Reject unsupported input with useful errors rather than silently guessing.
- Select relevant personal skills by task: `api-boundary-design`, `designing-trustworthy-functions-and-data`, `small-software`, `software-taste`, `contract-tests`, and `correctness`. Avoid bulk copying skills into the repository.
- Include new TypeScript source in tsconfig.json when implementation begins. Add meaningful targeted tests and build/package checks when there is code to exercise.
- Run `bun run check` and the relevant targeted checks before completion. Explain skipped or failed checks.
- Commit substantive completed work and report the hash plus verification evidence through the assigned handle. Preserve unrelated edits.
- Confirm the target before remote changes. Push, publish, deploy, or mutate external services only within explicit user authorization.
