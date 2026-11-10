import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Array as Arr, Order } from "effect";

const root = nodePath.resolve(import.meta.dir, "../..");

// Inside `function* name(...) { ... }` the name binds the raw generator, not the Effect function
// it is passed to, so a call through it skips the wrapper (and recurses on the native stack).
// typescript@7.0.2 exposes no classic compiler API and no parser is a declared dependency, so this
// check lexes: it blanks comments, string, template and regex literal text, then reads each
// `Effect.fn` / `Effect.fnUntraced` call to its closing parenthesis.

const regexAfterWord = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const word = /[\w$]+/uy;

// Whether a `/` after `last` (the previous punctuator or word) opens a regex literal.
const opensRegex = (last: string): boolean =>
  last === "" || /^[(,=:[!&|?{};+\-*%<>~^]$/u.test(last) || regexAfterWord.has(last);

// The end of a quoted, template or regex literal body starting at `from`, stopping before `close`
// (or at a template's `${` when `template`).
const literalEnd = (text: string, from: number, close: string, template: boolean): number => {
  let at = from;
  let inClass = false;
  while (at < text.length) {
    const char = text[at];
    if (char === "\\") {
      at += 2;
    } else if (template && char === "$" && text[at + 1] === "{") {
      return at;
    } else if (close === "/" && (char === "[" || char === "]")) {
      inClass = char === "[";
      at += 1;
    } else if ((char === close && !inClass) || (!template && char === "\n")) {
      return at;
    } else {
      at += 1;
    }
  }

  return at;
};

interface Flat {
  // The span to blank, the index to resume at, and whether the span was a value (not a comment).
  readonly from: number;
  readonly to: number;
  readonly next: number;
  readonly value: boolean;
}

// The comment, quoted string or regex literal starting at `at`, if one does.
const flatAt = (text: string, at: number, last: string): Flat | undefined => {
  const char = text[at];
  const after = text[at + 1];
  if (char === "/" && (after === "/" || after === "*")) {
    const close = after === "/" ? "\n" : "*/";
    const found = text.indexOf(close, at + 2);
    const next = found === -1 ? text.length : found + close.length;

    return { from: at, next, to: next, value: false };
  }

  if (char === '"' || char === "'" || (char === "/" && opensRegex(last))) {
    const end = literalEnd(text, at + 1, char, false);

    // A double-quoted string keeps its quotes so a span name still matches `call`.
    return char === '"'
      ? { from: at + 1, next: end + 1, to: end, value: true }
      : { from: at, next: end + 1, to: end + 1, value: true };
  }

  return undefined;
};

/**
 * `text` with comment, string, template and regex literal text replaced by spaces (line breaks and
 * the quotes of double-quoted strings kept), so the remaining parentheses and words are code.
 */
export const blank = (text: string): string => {
  const cleared = new Uint8Array(text.length);
  // The brace depth each open `${` returns to its template at.
  const templates: number[] = [];
  let braces = 0;
  let last = "";
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? "";
    const flat = flatAt(text, at, last);
    const resumes = char === "}" && templates.at(-1) === braces;
    word.lastIndex = at;
    if (flat !== undefined) {
      cleared.fill(1, flat.from, flat.to);
      last = flat.value ? "x" : last;
      at = flat.next;
    } else if (char === "`" || resumes) {
      if (resumes) {
        templates.pop();
      }

      const end = literalEnd(text, at + 1, "`", true);
      const closed = text[end] === "`";
      cleared.fill(1, at, closed ? end + 1 : end + 2);
      if (!closed) {
        templates.push(braces);
      }

      last = closed ? "x" : "{";
      at = closed ? end + 1 : end + 2;
    } else if (word.test(text)) {
      last = text.slice(at, word.lastIndex);
      at = word.lastIndex;
    } else {
      braces += char === "{" ? 1 : 0;
      braces -= char === "}" ? 1 : 0;
      last = /\s/u.test(char) ? last : char;
      at += 1;
    }
  }

  return text.replaceAll(/[^\n]/gu, (char: string, offset: number) =>
    cleared[offset] === 1 ? " " : char,
  );
};

// Each `Effect.fn(`, `Effect.fnUntraced(` or `Effect.fn("span")(` call, opening its argument list.
const call = /\bEffect\.fn(?:Untraced)?\s*(?:\(\s*"[^"]*"\s*\)\s*)?\(/gu;

// The `function* name(` that the call's first argument opens with.
const generator = /\s*function\s*\*\s*(?<name>[\w$]*)\s*\(/uy;

interface Scan {
  readonly sites: number;
  readonly read: number;
  readonly hits: readonly string[];
}

/**
 * Every `Effect.fn` / `Effect.fnUntraced` call in `text`: how many there are, how many were read
 * (a `function*` argument whose call closes), and `line: name` for each generator that names
 * itself between its `function* name(` and the call's closing parenthesis.
 */
export const scan = (text: string): Scan => {
  const code = blank(text);
  const matches = [...code.matchAll(call)];
  const read = matches.flatMap((match) => {
    generator.lastIndex = (match.index ?? 0) + match[0].length;
    const head = generator.exec(code);
    if (head === null) {
      return [];
    }

    let depth = 2;
    let end = generator.lastIndex;
    while (end < code.length && depth > 0) {
      depth += code[end] === "(" ? 1 : 0;
      depth -= code[end] === ")" ? 1 : 0;
      end += 1;
    }

    return depth === 0 ? [{ body: code.slice(generator.lastIndex, end), head, match }] : [];
  });
  const hits = read.flatMap(({ body, head, match }) => {
    const name = head.groups?.name ?? "";
    const named = new RegExp(`(?<![\\w$.])${name.replaceAll("$", "\\$")}(?![\\w$])`, "u");
    const line = code.slice(0, match.index).split("\n").length;

    return name !== "" && named.test(body) ? [`${line}: ${name}`] : [];
  });

  return { hits, read: read.length, sites: matches.length };
};

// Committed TypeScript under `dir`; `*.generated.ts` files are gitignored copies of runtime-src.
const sourceFiles = (dir: string): readonly string[] =>
  Arr.sort(
    nodeFs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".generated.ts"),
      )
      .map((entry) => nodePath.join(entry.parentPath, entry.name)),
    Order.String,
  );

const hitsOf = (lines: readonly string[]): readonly string[] => scan(lines.join("\n")).hits;

describe("scan", () => {
  test("flags a generator that names itself, whatever its const is called", () => {
    expect(
      hitsOf([
        "const walk = Effect.fnUntraced(function* walk(n: number): Effect.fn.Return<number> {",
        "  return n === 0 ? 0 : yield* walk(n - 1);",
        "});",
        "const step = Effect.fnUntraced(function* stepped(n: number) {",
        "  return yield* stepped(n - 1);",
        "});",
      ]),
    ).toEqual(["1: walk", "4: stepped"]);
  });

  test("reads typed consts, let, span names and a returned call with no const", () => {
    expect(
      hitsOf([
        "const walk: Walk = Effect.fnUntraced(function* walked(n: number) {",
        "  return yield* walked(n);",
        "});",
        'let read = Effect.fn("x.read")(',
        "  function* read(n: number) {",
        "    return yield* read(n);",
        "  },",
        ");",
        "const make = () => {",
        "  return Effect.fnUntraced(function* resolve(scheme: string) {",
        "    return yield* resolve(scheme);",
        "  });",
        "};",
      ]),
    ).toEqual(["1: walked", "4: read", "10: resolve"]);
  });

  test("reads past a regex literal or template holding an unbalanced parenthesis", () => {
    expect(
      hitsOf([
        "const walk = Effect.fnUntraced(function* walked(text: string) {",
        "  const open = /\\(|[)]/u.test(text);",
        // Escaped, so the probe keeps its template placeholders as text.
        `  const note = \`(\${text})\${\`)\`}\`;`,
        "  return open ? yield* walked(note) : 0;",
        "});",
      ]),
    ).toEqual(["1: walked"]);
  });

  test("passes a generator called through its Effect const, or mentioned only in text", () => {
    const text = [
      "const walk = Effect.fnUntraced(function* walked(n: number) {",
      "  return yield* walk(n - 1);",
      "});",
      "const read = Effect.fnUntraced(function* read(n: number) {",
      '  // read is mentioned here, in "read(" and `read`, and as other.read',
      "  return yield* other.read(n);",
      "});",
      "const after = read;",
    ].join("\n");

    expect(scan(text)).toEqual({ hits: [], read: 2, sites: 2 });
  });
});

test("no Effect generator in src names itself, and every Effect.fn site is read", () => {
  const scans = sourceFiles(nodePath.join(root, "src")).map((file) => ({
    file: nodePath.relative(root, file),
    ...scan(nodeFs.readFileSync(file, "utf-8")),
  }));
  const sites = scans.reduce((total, { sites: count }) => total + count, 0);
  const read = scans.reduce((total, { read: count }) => total + count, 0);
  console.log(`self-reference: read ${read} of ${sites} Effect.fn sites in src`);

  expect(scans.flatMap(({ file, hits }) => hits.map((hit) => `${file}:${hit}`))).toEqual([]);
  expect(sites).toBeGreaterThan(0);
  expect(read).toBe(sites);
});
