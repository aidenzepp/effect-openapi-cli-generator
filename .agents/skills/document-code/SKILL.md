---
name: document-code
description: Use when writing or reviewing TypeScript or TSX functions, components, interfaces, types, services, callbacks, or other named program units, and when debugging, upstream documentation, source inspection, or experiments reveal a non-obvious constraint the code must preserve.
---

# Document Code

Make each program unit's contract and system role clear before a reader studies its implementation.

## Required coverage

Add a doc comment to every module-scope function, component, standalone domain or service type, class, service, enum, namespace, callback type, and `const` declaration. Also document every named file-local helper function. Local values declared inside a function are not program units unless the declaration is itself a helper function.

Component-local props interfaces and object types are structural support for the component, not separate documentation surfaces. The component comment owns their parameter contract. A standalone domain, service, or library interface owns its own contract because callers consume that interface directly.

## Format Every Doc Comment

Always use multiline JSDoc, including for one sentence:

```ts
/**
 * The largest username accepted by the authentication boundary.
 */
```

Never use `/** ... */` on one line. `vp fmt` enforces this across formatted source with `jsdoc.commentLineStrategy: "multiline"` in `vite.config.ts`. The rule binds both the generator source and the source it emits.

## Write in the repository's voice

Follow the library contracts in `src/` once they exist, and the voice below:

- Open with a direct, complete sentence that defines a type or states what a function does.
- Start functions with an active verb such as “Construct,” “Execute,” “Display,” or “Convert.”
- Start types with a definitional noun phrase such as “A value…” or “The failure branch…”.
- Add one concise follow-up only for a mental model, invariant, rationale, ecosystem fit, or ownership boundary.
- Describe the consumer-facing contract, not the implementation sequence.
- Reuse the exact vocabulary of the domain, framework, and underlying library. Pin Effect links and source permalinks to `effect` 4.1.2, the repository's exact dependency version.
- Omit filler. A comment that only expands the symbol's name is incomplete documentation.

## Preserve Consequential Knowledge

After debugging, reading documentation or upstream source, or running experiments reveals new knowledge, re-review the documentation on the affected code even when an existing comment already looks complete.

Embed the knowledge when all three conditions hold:

1. It changes which implementation is correct, safe, or interoperable.
2. It is not apparent from the current code, types, or ordinary ecosystem knowledge.
3. A reasonable maintainer could remove the constraint or repeat costly discovery without it.

Write qualifying knowledge for a first-time reader:

1. State the program unit's current contract or role.
2. Give the causal chain as present facts: the governing invariant, why it requires the current design, and the guarantee that design provides.
3. Add navigation for the causal chain: link a local owning symbol when the relationship crosses a repository boundary, canonical documentation for public behavior, and pinned upstream source when exact implementation matters.

The explanation must stand alone without knowledge of past implementations or the incidents, prior defaults, successes, and failures that led to it. Translate discovery history into present-tense invariants; do not write “previously,” “this fixes,” “after this failed,” or similar chronology.

Put the knowledge in the smallest owning program unit's doc comment. Use an inline comment only when the constraint belongs to one statement or to execution order and moving it outward would obscure the relationship.

Do not add a knowledge comment when the code or types already make the fact clear, when another skill or lint rule owns the policy, or when the information is only temporary debugging evidence. Those comments add maintenance cost without improving understanding.

## Apply tags by contract

| Program unit                                     | Required documentation                                                                                                                                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Function, component, or named helper             | `@param` for every argument and `@returns` for its semantic result. For destructuring, document both `props` and every `props.property`.                                                                                                           |
| Component-local props type                       | Leave it structural. Put the prop meanings and callback completion contract on the component's `@param` tags.                                                                                                                                      |
| Standalone callback signature                    | Describe the capability or intent, then document every callback argument with `@param` and its completion with `@returns`.                                                                                                                         |
| Standalone domain, service, or library interface | Define the whole contract. Document every callable member with its arguments and semantic result. Document a data property only when the comment adds a constraint, invariant, or domain meaning not already established by the interface comment. |
| Module-scope non-callable `const`                | State the invariant, policy, shared consumers, or system role that the value establishes.                                                                                                                                                          |
| Public overload set                              | Document each public overload whose contract differs. Do not separately document the implementation signature.                                                                                                                                     |

For a `void` function, omit `@returns` when completion has no consumer-facing meaning. Include it when completion establishes a meaningful side-effect contract. For components, describe the rendered responsibility rather than writing “JSX.”

Document each fact once at the surface that owns it. For a component, that is the component comment—not its local props interface. For a standalone interface, that is the interface and its non-obvious members—not every function that happens to accept it.

For an inline object parameter, the function's `@param` entry defines the object as a whole and each property entry defines one member; do not add a second standalone comment. Overloads differ when they accept different representations, return different guarantees, or expose different failures. Put shared invariants in each public contract only when callers of that overload need them.

Use optional tags only when their condition holds:

- `@see` and inline `{@link Symbol}` for a useful relationship to a real program unit, composition, counterpart, or protocol.
- `@example` for non-obvious public usage, using one focused and valid example.
- `@throws` for each failure intentionally allowed to escape and the condition that causes it.
- `@deprecated` only for a deprecated unit; name and link the supported replacement.

Do not repeat TypeScript types in prose or add tags with no information. Small file-local helpers still receive a concise purpose plus applicable `@param` and `@returns` tags; they do not receive optional tags by default.

## Cite Authoritative Sources

Add `@see` links whenever a reader would otherwise need to rediscover the external rule behind the code. Common triggers include framework behavior, provider configuration, protocol requirements, version-specific error values, compatibility constraints, and adaptations of an upstream primitive.

- Link canonical documentation for the supported public behavior.
- Also link a versioned source permalink when the exact implementation or emitted value matters.
- Use `@see {@link Symbol}` for a useful relationship to another repository unit.
- Place the link on the smallest unit that owns the sourced behavior.
- Omit generic homepages and links that add nothing beyond an import or parameter type.

## Labeled Examples

**REQUIRED REFERENCE:** Read [references/examples.md](references/examples.md) before writing or reviewing code documentation. Treat each `POSITIVE` and `NEGATIVE` label as acceptance data: reproduce the documented contract quality, not merely the comment shape.

## Review

Confirm every required unit, argument, and destructured property is documented; component-local props do not duplicate component prose; standalone interfaces retain their own contracts; every block is multiline; tags follow the unit's contract; authoritative links sit beside sourced behavior; and links resolve to useful relationships. After learning a non-obvious constraint, confirm the owning comment captures its present-tense causal chain for a first-time reader. Reject comments that narrate syntax, duplicate types, merely restate names, recount implementation history, or repeat policy already enforced elsewhere.
