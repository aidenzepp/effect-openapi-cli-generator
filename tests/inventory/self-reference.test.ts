import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Array as Arr, Order } from "effect";

const root = nodePath.resolve(import.meta.dir, "../..");

// `const name = Effect.fn("span")(function* name(` or `Effect.fnUntraced(function* name(`,
// exported or not, with any line breaks the formatter puts between the parts.
const declaration =
  /\bconst\s+(?<name>[\w$]+)\s*=\s*Effect\.fn(?:Untraced)?\s*(?:\(\s*"[^"]*"\s*\)\s*)?\(\s*function\*\s*(?<inner>[\w$]+)\s*\(/gu;

// Comments and string literals, blanked so their parentheses and words do not count.
const noise =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/gu;

// A double-quoted string keeps its quotes so a span name still matches `declaration`.
const blank = (text: string): string =>
  text.replaceAll(noise, (token) =>
    token.startsWith('"') ? `"${" ".repeat(token.length - 2)}"` : " ".repeat(token.length),
  );

/**
 * Names of `Effect.fn` / `Effect.fnUntraced` generators in `text` whose `function*` name equals
 * the const it is assigned to and which name themselves inside their own generator. There the
 * name means the raw generator, so a recursive call skips the Effect wrapper and recurses on the
 * native stack.
 */
export const selfReferences = (text: string): readonly string[] => {
  const code = blank(text);

  return [...code.matchAll(declaration)].flatMap((match) => {
    const name = match.groups?.name ?? "";
    if (name !== match.groups?.inner) {
      return [];
    }

    // The generator runs to the parenthesis closing the call that opened just before `function*`.
    const start = (match.index ?? 0) + match[0].length;
    let depth = 2;
    let end = start;
    while (end < code.length && depth > 0) {
      if (code[end] === "(") {
        depth += 1;
      } else if (code[end] === ")") {
        depth -= 1;
      }

      end += 1;
    }

    return new RegExp(`(?<![\\w$.])${name.replaceAll("$", "\\$")}(?![\\w$])`, "u").test(
      code.slice(start, end),
    )
      ? [name]
      : [];
  });
};

const sourceFiles = (dir: string): readonly string[] =>
  Arr.sort(
    nodeFs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => nodePath.join(entry.parentPath, entry.name)),
    Order.String,
  );

describe("selfReferences", () => {
  test("finds a generator that calls itself by its const name", () => {
    const text = [
      "const walk = Effect.fnUntraced(function* walk(n: number): Effect.fn.Return<number> {",
      "  return n === 0 ? 0 : yield* walk(n - 1);",
      "});",
    ].join("\n");

    expect(selfReferences(text)).toEqual(["walk"]);
  });

  test("finds a span-named generator split across lines", () => {
    const text = [
      'export const walk = Effect.fn("x.walk")(',
      "  function* walk(n: number) {",
      "    return yield* walk(n);",
      "  },",
      ");",
    ].join("\n");

    expect(selfReferences(text)).toEqual(["walk"]);
  });

  test("passes a generator named apart from its const, or one that never names itself", () => {
    const text = [
      "const walk = Effect.fnUntraced(function* walked(n: number) {",
      "  return yield* walk(n - 1);",
      "});",
      "const read = Effect.fnUntraced(function* read(n: number) {",
      '  // read is mentioned here and in "read(" only',
      "  return yield* other(n);",
      "});",
      "const after = read;",
    ].join("\n");

    expect(selfReferences(text)).toEqual([]);
  });
});

test("no Effect generator in src calls itself by name", () => {
  const hits = sourceFiles(nodePath.join(root, "src")).flatMap((file) =>
    selfReferences(nodeFs.readFileSync(file, "utf-8")).map(
      (name) => `${nodePath.relative(root, file)}: ${name}`,
    ),
  );

  expect(hits).toEqual([]);
});
