# Printer

The generator prints every TypeScript file it emits already formatted, and writes every JSON file in
one fixed layout. This file is the printer's specification (design X11). Emitters and runtime slices
conform to it; a construct it does not cover is a printer change, made here and in the printer in
the same commit.

## Conformance

- The conformance check is `vp fmt --check` with the repository's pins: `vite-plus` 1.0.0, which
  runs `oxfmt` 0.70.0, under the `fmt` block of `vite.config.ts`.
- Printed output is a fixed point: `vp fmt` run twice on a golden fixture or corpus output changes
  no byte. The rules below are written to stay inside the syntax subset where that holds (design
  §3.6, R9).
- Generated TypeScript must also pass `vp lint --type-aware` and `tsc --noEmit`. The lint rules that
  constrain layout are named where they apply.
- When `vp fmt --check` and this file disagree, the check wins. Fix this file and the printer in the
  same commit. A `vite-plus` pin bump that changes any rule below is a printer change (R9).

## Lines

- Output is UTF-8 with LF line endings, one final newline, no trailing whitespace, no tabs and no
  byte-order mark. Non-ASCII appears only inside string literals (see Strings).
- Indent is 2 spaces per level.
- Width is 100 display columns (see Layout). A line may not end past column 100 unless it holds a
  single token that cannot break, such as a long string literal.
- Statements end with `;`.
- Exactly one blank line separates top-level statements, and one follows the import block. No other
  blank lines appear. A JSDoc block belongs to the statement after it, so the blank line goes above
  the JSDoc. The lint rule `@stylistic/padding-line-between-statements` requires these blank lines.

## Imports

- Forms: `import { A, B } from "s";`, `import * as N from "s";`, `import type { A } from "s";` and
  `import type * as N from "s";`. Type-only imports use the top-level `type` keyword, never inline
  `type` specifiers (lint `import/consistent-type-specifier-style`).
- One statement per specifier and kind. Named specifiers are sorted by name in UTF-16 code-unit
  order. Aliases are not used.
- Order: package specifiers (not starting with `.`) first, then relative specifiers. Within each
  group, sort by specifier in code-unit order. For one specifier, the `import type` statement comes
  before the value statement. The block has no blank lines.
- The formatter does not sort imports. This order is the printer's own and keeps output
  deterministic.

## Object keys

- Keys are sorted in UTF-16 code-unit order of the key name (lint `sort-keys`: ascending,
  case-sensitive, not natural). So `"200"` sorts before `"404"`, `"10"` before `"9"`, `A` before
  `__proto__` before `_b` before `a`, and `a` before `"a-b"` before `a1`.
- A key that matches `^[A-Za-z_$][A-Za-z0-9_$]*$` is printed bare, reserved words included
  (`default`, `class`, `constructor`). Any other key is printed as a string literal by the Strings
  rules: `"a-b"`, `"200"`, `"address.city"`. The formatter unquotes bare-able keys one key at a
  time, so mixed objects are expected: `{ "200": [], default: [] }`.
- The key `__proto__` is always the computed key `["__proto__"]`, which defines an own property. A
  bare or quoted `__proto__` sets the prototype instead. It sorts by its name, `__proto__`.
- A quoted key escapes every non-ASCII code unit as `\u` and four lowercase hex digits. The formatter
  unquotes a quoted key whose text is a Unicode identifier name, so `"café"` would become `café`, but
  it keeps a key that holds an escape quoted (measured). Escaping keeps every quoted key quoted.
- Interface members follow the same key rules and are also sorted.

## Strings

- A string literal is `JSON.stringify(value)`, then every UTF-16 code unit of a code point in the
  escape set is replaced by `\u` and four lowercase hex digits. The escape set is Unicode Cc
  (controls), Cf (format characters, which include the bidi controls), U+2028, U+2029 and lone
  surrogates. A Cf code point outside the BMP becomes two escapes, one per surrogate.
  `JSON.stringify` already escapes controls below U+0020 and lone surrogates.
- Printable non-ASCII stays literal, so non-ASCII help text reads as written (R10). `vp fmt` keeps
  every `\uXXXX` escape and every literal character as written (measured on samples from U+007F to
  U+FFFF, including U+2028, U+2029, bidi controls and lone surrogates).
- Quote choice follows the formatter: double quotes, unless the value contains more `"` than `'`.
  Then the literal is single-quoted, each `'` is written `\'`, each `"` is written bare, and every
  other escape is the same as above. On a tie, double quotes are used.
- Spec strings reach source only as string literals: never in template literals, never in `//` or
  `/* */` comments, and never in JSDoc (see JSDoc).
- A regular expression from a spec is `new RegExp(<string literal>, "u")` (lint
  `require-unicode-regexp`).

## Layout

Columns are display columns, counted the way `vp fmt` counts them: a code point that is East Asian
Wide or Fullwidth (CJK ideographs, kana, Hangul syllables, fullwidth forms) or an emoji with default
emoji presentation counts two columns, a combining mark (Unicode Mn or Me) counts zero, and every
other code point counts one, whatever its UTF-16 length. Measured on U+4E2D, U+FF21 and U+1F600 (two
columns), U+0301 (zero), and U+00E9, U+00A0, U+E000 and U+0378 (one). So `中` is one code unit and two
columns, `😀` is two code units and two columns, and `e` followed by U+0301 is two code units and one
column. The printer's table of wide code points covers the Wide and Fullwidth blocks and the emoji
presentation property; a rare code point it classifies differently shows up as a `vp fmt --check`
failure.

A form is printed flat when its whole line, printed with the form flat, ends at or before
column 100. The line runs to the next line break the layout emits, so closing brackets, `,`, `;` and
`as const` count. Otherwise the form is printed broken, as below. Every broken list puts one element
per line, indented one level, each followed by `,`. Flat lists have no trailing comma.

- **Object literal.** `{}` when empty. Flat: `{ a: 1, b: 2 }`. Broken: `{`, one property per line,
  `}`. The formatter keeps an object broken whenever its first key starts a new line, so a broken
  object never returns to flat.
- **Interface body.** Always broken, one `readonly key: Type;` per line. Types inside it are printed
  flat.
- **Array literal.** `[]` when empty. Flat when it fits, otherwise broken. One case is always
  broken: two or more elements that are all object literals, or all array literals, with more than
  one entry each, such as `[["a", "b"], ["c", "d"]]`. An array of number literals, possibly signed,
  that does not fit is filled instead: as many elements per line as fit, separated by `, `, with `,`
  after the last.
- **Call arguments.** Flat: `f(a, b)`. If the last argument is an object literal, an array literal
  or an arrow function, the other arguments are flat, and the text up to that argument's opening
  (`{`, `[` or `=>`) fits, the last argument hugs: it opens on the call's line and is printed
  broken, and `)` follows its close. Otherwise all arguments are broken. A hugged arrow whose body
  moved to the next line ends with `,` and puts `)` on its own line. Measured details: an object or
  array literal hugs only when it is not empty; an arrow hugs only when its body is an object
  literal, an array literal or a call, and then its opening runs to the body's `({` or `[` when the
  body is a literal; the last argument does not hug when the argument before it is the same kind of
  form, or when it is an array of number literals and other arguments precede it.
- **Arrow function.** Parameters are always parenthesized: `(flags) =>`, `() =>`. Bodies are
  expressions, never blocks. An object or array literal body stays on the `=>` line (an object body
  in parentheses). Any other body stays on the `=>` line only when it fits flat; otherwise it starts
  on the next line, indented one level, and is laid out there.
- **Member chain.** The subset allows `Head.member(args)` with at most one more call group, normally
  `.pipe(args)`, where `Head` is a capitalized namespace identifier such as `Flag`, `Effect` or
  `Command`. A call group is `.name` with the call parentheses after it, curried calls included, as
  in `HttpClientRequest.make("PATCH")(url)`. `.pipe(` never starts a line. Each argument list breaks
  by the call rule, so `).pipe(` appears when the head breaks.
- **Assignment and property values.** The value starts on the same line as `=` or `:`. A string,
  identifier, member access, `undefined` or negative number that does not fit moves to the next
  line, indented one level, even when it still does not fit there. A property whose printed key is
  under 5 columns never moves its value, and a positive number or boolean never moves (measured).
  An `as const` value moves when a number or boolean before it does not fit.
- **Binary `+`.** Only two operands, and only as a call argument. Broken: `left +` ends the line and
  the right operand starts the next, one level deeper than `left`.

The subset is exactly the forms above plus: `export const`, unexported `const`, `export interface`,
`export type` with a flat type, `as const`, property access, string, number, boolean and `undefined`
literals, and `new RegExp`. Not in the subset: template literals, comments other than generator
JSDoc, block bodies, `if` and other statements, ternaries, classes, member chains longer than the
rule above, and type annotations that need breaking.

## JSDoc

- Form: `/**`, then per text line a space, `*`, a space and the text, then a space and `*/`, each at
  the declaration's indent. The single-line form `/** text */` is never printed; the formatter
  rewrites it to the multi-line form (`jsdoc.commentLineStrategy: "multiline"`).
- Text is one paragraph, filled greedily: a word goes on the current line when the line, with
  indentation and the `*` prefix, still ends at or before column 100. A word longer than that stands
  alone on its line.
- JSDoc text is generator-owned. It comes from fixed generator templates, and identifiers placed
  into them are folded names. Text is printable ASCII, starts with an uppercase letter, separates
  words with one space, contains none of ``* _ ` # < > [ ] { } | \ @ ~``, and has no word that
  starts with `-`, `+` or a digit, so no wrapped line can begin as a list item.
- The printer takes JSDoc text only as the `JsDocText` brand (`src/emit/escape.ts`), which decodes
  exactly this alphabet. Text outside it, such as `*/`, a line-leading `@`, a lone surrogate or
  non-ASCII, fails to decode, so it is refused as a generator defect and never escaped into a
  comment.
- Spec prose never enters JSDoc. The formatter's JSDoc pass treats the text as Markdown and rewrites
  it: it capitalizes the first word, turns `*a*` into `_a_`, drops a backslash before `_` and `*`,
  collapses runs of whitespace, inserts blank lines around list items and headings, and capitalizes
  list items and tag descriptions. Prose that byte-matched after that pass would need a Markdown
  printer, and nested layouts are where `oxfmt` stops being idempotent (design §3.6, SM-14). Spec
  prose stays in string literals, such as `Flag.withDescription("...")`, which the formatter keeps
  byte for byte.

## JSON

Every JSON file the generator or the corpus tools write uses this layout. `vp fmt --check` rejects
`JSON.stringify(v, null, 2)` output that holds a short array (`delivery/m1.md` §3).

- Indent 2 spaces, LF, one final newline, `:` followed by one space, no trailing commas.
- A non-empty object is always broken: `{`, one `"key": value` per line, `}`. Keys are sorted in
  UTF-16 code-unit order (design §3.7), except in `package.json`. Empty: `{}`.
- An array is flat, `["a", "b"]`, when the line holding it ends at or before column 100. Otherwise
  it is broken, one element per line. An array that holds an object is always broken, because the
  object is. An array of two or more arrays that each hold more than one element is broken:
  `[["a", "b"], ["c", "d"]]` prints as two element lines, each flat. `[["bearerAuth"]]` and
  `[["a"], ["b"]]` stay flat. An array of numbers that does not fit is filled, as many per line as
  fit, with no comma after the last. Empty: `[]`.
- Strings are `JSON.stringify` output. JSON files need no `\uXXXX` escaping of printable non-ASCII.
- `package.json` is the exception. The formatter prints it in the `JSON.stringify(v, null, 2)`
  layout, every array broken, and sorts its top-level keys. The generator writes it as that layout
  plus a final newline, with top-level keys in this order: `name`, `version`, `private`,
  `description`, `license`, `bin`, `files`, `type`, `exports`, `scripts`, `dependencies`,
  `devDependencies`, `engines`, `packageManager`. Dependency maps are sorted by package name. Other
  maps keep the generator's order. A top-level key outside this list is refused.

## Decisions for the Mind

- **R10, ASCII escaping: decided** (memo `a4543497`). Printable non-ASCII stays literal in string
  literals, and only the escape set is escaped (see Strings). The ASCII-only alternative escaped
  every non-ASCII code unit, which made non-ASCII help text unreadable in source. Both pass
  `vp fmt --check`; this was a readability choice. Quoted object keys still escape non-ASCII, because
  the formatter would otherwise unquote them (see Object keys).
- **JSDoc carries no spec prose: decided** (memo `a4543497`). JSDoc text comes only from generator
  templates and is checked against the JSDoc alphabet (see JSDoc). Design §3.6 once routed source
  prose through one JSDoc escaper, as in the §4.8 sample `/** Update a user. */`; the measured
  Markdown rewrites above rule that out, and spec prose stays in string literals.
