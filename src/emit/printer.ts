import { Array as Arr, Data, Effect, Match, Option, Order, Predicate, Schema } from "effect";
import type { JsonLiteral } from "../model/brands.ts";
import { asciiStringLiteral, jsDoc, stringLiteral } from "./escape.ts";
import type { JsDocText } from "./escape.ts";

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

const reservedWords: ReadonlySet<string> = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/**
 * A binding name: identifier-shaped ASCII and not a reserved word.
 */
export const Identifier = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(identifierPattern),
    Schema.makeFilter((value: string) => !reservedWords.has(value)),
  ),
  Schema.brand("Identifier"),
);

type IdentifierType = typeof Identifier.Type;

/**
 * A property name after `.`: identifier-shaped ASCII, reserved words allowed.
 */
export const MemberName = Schema.String.pipe(
  Schema.check(Schema.isPattern(identifierPattern)),
  Schema.brand("MemberName"),
);

type MemberNameType = typeof MemberName.Type;

/**
 * A module specifier in an import statement.
 */
export const ModuleSpecifier = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9@._/-]+$/u)),
  Schema.brand("ModuleSpecifier"),
);

type ModuleSpecifierType = typeof ModuleSpecifier.Type;

/**
 * The interpreter line of an executable module, after `#!`: an absolute path and its arguments.
 */
export const Shebang = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\/[!-~]+(?: [!-~]+)*$/u)),
  Schema.brand("Shebang"),
);

type ShebangType = typeof Shebang.Type;

type JsDocTextType = typeof JsDocText.Type;

export type TypeExpr =
  | {
      readonly _tag: "TypeRef";
      readonly head: IdentifierType;
      readonly members: readonly MemberNameType[];
      readonly args: readonly TypeExpr[];
    }
  | {
      readonly _tag: "TypeKeyword";
      readonly keyword:
        | "boolean"
        | "never"
        | "null"
        | "number"
        | "string"
        | "undefined"
        | "unknown";
    }
  | { readonly _tag: "TypeLiteral"; readonly value: boolean | number | string }
  | { readonly _tag: "TypeUnion"; readonly members: readonly TypeExpr[] };

export interface Param {
  readonly name: IdentifierType;
  readonly type?: TypeExpr;
}

export type Expr =
  | { readonly _tag: "String"; readonly value: string }
  | { readonly _tag: "Number"; readonly value: number }
  | { readonly _tag: "Boolean"; readonly value: boolean }
  | { readonly _tag: "Undefined" }
  | { readonly _tag: "Identifier"; readonly name: IdentifierType }
  | { readonly _tag: "Member"; readonly object: Expr; readonly name: MemberNameType }
  | { readonly _tag: "Object"; readonly entries: readonly (readonly [string, Expr])[] }
  | { readonly _tag: "Array"; readonly elements: readonly Expr[] }
  | { readonly _tag: "Call"; readonly callee: Expr; readonly args: readonly Expr[] }
  | {
      readonly _tag: "Arrow";
      readonly params: readonly Param[];
      readonly returns?: TypeExpr;
      readonly body: Expr;
    }
  | { readonly _tag: "New"; readonly callee: Expr; readonly args: readonly Expr[] }
  | {
      readonly _tag: "Conditional";
      readonly test: Expr;
      readonly consequent: Expr;
      readonly alternate: Expr;
    }
  | { readonly _tag: "Plus"; readonly left: Expr; readonly right: Expr };

export interface Field {
  readonly key: string;
  readonly optional: boolean;
  readonly type: TypeExpr;
}

export type Statement =
  | {
      readonly _tag: "Const";
      readonly exported: boolean;
      readonly name: IdentifierType;
      readonly type?: TypeExpr;
      readonly value: Expr;
      readonly asConst?: boolean;
      readonly doc?: JsDocTextType;
    }
  | {
      readonly _tag: "Interface";
      readonly name: IdentifierType;
      readonly fields: readonly Field[];
      readonly doc?: JsDocTextType;
    }
  | {
      readonly _tag: "TypeAlias";
      readonly name: IdentifierType;
      readonly type: TypeExpr;
      readonly doc?: JsDocTextType;
    }
  | { readonly _tag: "Expression"; readonly value: Expr };

export type Import =
  | {
      readonly _tag: "Named";
      readonly typeOnly: boolean;
      readonly names: readonly IdentifierType[];
      readonly from: ModuleSpecifierType;
    }
  | {
      readonly _tag: "Namespace";
      readonly typeOnly: boolean;
      readonly name: IdentifierType;
      readonly from: ModuleSpecifierType;
    };

export interface Module {
  readonly shebang?: ShebangType;
  readonly imports: readonly Import[];
  readonly statements: readonly Statement[];
}

/**
 * The module holds a construct outside the printer's syntax subset.
 */
export class PrinterError extends Data.TaggedError("PrinterError")<{
  readonly reason:
    | "duplicate-key"
    | "non-finite-number"
    | "unbreakable-line"
    | "unsupported-arrow-body"
    | "unsupported-chain"
    | "unsupported-conditional"
    | "unsupported-expression"
    | "unsupported-member"
    | "unsupported-new"
    | "unsupported-package-json"
    | "unsupported-plus";
  readonly subject: string;
}> {}

export const str = (value: string): Expr => ({ _tag: "String", value });

export const num = (value: number): Expr => ({ _tag: "Number", value });

export const bool = (value: boolean): Expr => ({ _tag: "Boolean", value });

export const undef: Expr = { _tag: "Undefined" };

export const ident = (name: IdentifierType): Expr => ({ _tag: "Identifier", name });

export const member = (object: Expr, name: MemberNameType): Expr => ({
  _tag: "Member",
  name,
  object,
});

export const obj = (entries: readonly (readonly [string, Expr])[]): Expr => ({
  _tag: "Object",
  entries,
});

export const arr = (elements: readonly Expr[]): Expr => ({ _tag: "Array", elements });

export const call = (callee: Expr, args: readonly Expr[]): Expr => ({ _tag: "Call", args, callee });

export const arrow = (params: readonly Param[], body: Expr, returns?: TypeExpr): Expr =>
  returns === undefined
    ? { _tag: "Arrow", body, params }
    : { _tag: "Arrow", body, params, returns };

export const newExpr = (callee: Expr, args: readonly Expr[]): Expr => ({
  _tag: "New",
  args,
  callee,
});

const regExpName = Schema.decodeSync(Identifier)("RegExp");

export const regExp = (source: string): Expr => newExpr(ident(regExpName), [str(source), str("u")]);

export const conditional = (test: Expr, consequent: Expr, alternate: Expr): Expr => ({
  _tag: "Conditional",
  alternate,
  consequent,
  test,
});

export const plus = (left: Expr, right: Expr): Expr => ({ _tag: "Plus", left, right });

export const typeRef = (
  head: IdentifierType,
  members: readonly MemberNameType[] = [],
  args: readonly TypeExpr[] = [],
): TypeExpr => ({ _tag: "TypeRef", args, head, members });

export const typeKeyword = (
  keyword: Extract<TypeExpr, { readonly _tag: "TypeKeyword" }>["keyword"],
): TypeExpr => ({ _tag: "TypeKeyword", keyword });

export const typeLiteral = (value: boolean | number | string): TypeExpr => ({
  _tag: "TypeLiteral",
  value,
});

export const typeUnion = (members: readonly TypeExpr[]): TypeExpr => ({
  _tag: "TypeUnion",
  members,
});

type ArrowExpr = Extract<Expr, { readonly _tag: "Arrow" }>;

type Entry = readonly [string, Expr];

const lineWidth = 100;

// East Asian Wide and Fullwidth blocks: vp fmt counts each such code point as two columns.
const wideRanges: readonly (readonly [number, number])[] = [
  [0x11_00, 0x11_5f],
  [0x23_29, 0x23_2a],
  [0x2e_80, 0x30_3e],
  [0x30_41, 0x33_ff],
  [0x34_00, 0x4d_bf],
  [0x4e_00, 0x9f_ff],
  [0xa0_00, 0xa4_cf],
  [0xa9_60, 0xa9_7f],
  [0xac_00, 0xd7_a3],
  [0xf9_00, 0xfa_ff],
  [0xfe_10, 0xfe_19],
  [0xfe_30, 0xfe_6f],
  [0xff_00, 0xff_60],
  [0xff_e0, 0xff_e6],
  [0x1_6f_e0, 0x1_6f_ff],
  [0x1_70_00, 0x1_8d_8f],
  [0x1_af_f0, 0x1_b2_ff],
  [0x1_f2_00, 0x1_f2_ff],
  [0x2_00_00, 0x2_ff_fd],
  [0x3_00_00, 0x3_ff_fd],
];

const zeroWidthPattern = /^[\p{Mn}\p{Me}\p{Cf}]/u;

const emojiPattern = /^\p{Emoji_Presentation}/u;

/**
 * The display columns of one code point, as `vp fmt` counts them.
 */
export const charWidth = (char: string): number => {
  const point = char.codePointAt(0) ?? 0;
  if (point < 0x7f) {
    return 1;
  }

  if (zeroWidthPattern.test(char)) {
    return 0;
  }

  const wide =
    emojiPattern.test(char) || wideRanges.some(([low, high]) => point >= low && point <= high);

  return wide ? 2 : 1;
};

/**
 * Display columns, as `vp fmt` counts them (docs/printer.md Layout).
 */
export const textWidth = (text: string): number => {
  let total = 0;
  for (const char of text) {
    total += charWidth(char);
  }

  return total;
};

const pad = (indent: number): string => " ".repeat(indent);

const endColumn = (start: number, text: string): number => {
  const lastBreak = text.lastIndexOf("\n");

  return lastBreak === -1 ? start + textWidth(text) : textWidth(text.slice(lastBreak + 1));
};

/**
 * Where a form starts, the indent of its line, and the width of the text after it up to the next
 * line break the layout emits.
 */
interface Place {
  readonly column: number;
  readonly indent: number;
  readonly tail: number;
}

type Render = (expr: Expr, place: Place) => string;

const fits = (text: string | undefined, place: Place): text is string =>
  text !== undefined && place.column + textWidth(text) + place.tail <= lineWidth;

const isDefined = (text: string | undefined): text is string => text !== undefined;

const flatList = (
  items: readonly (string | undefined)[],
  open: string,
  close: string,
): string | undefined => {
  if (items.length === 0) {
    return `${open.trim()}${close.trim()}`;
  }

  return items.every(isDefined) ? `${open}${items.join(", ")}${close}` : undefined;
};

const keyText = (key: string): string => {
  if (key === "__proto__") {
    return `[${stringLiteral(key)}]`;
  }

  return identifierPattern.test(key) ? key : asciiStringLiteral(key);
};

const byKey = Order.mapInput(Order.String, (entry: Entry) => entry[0]);

const sortEntries = (entries: readonly Entry[]): readonly Entry[] => Arr.sort(entries, byKey);

const numberText = (value: number): string =>
  value < 0 ? `-${numberText(-value)}` : String(value).replace("e+", "e");

const literalTypeText = (value: boolean | number | string): string => {
  if (Predicate.isString(value)) {
    return stringLiteral(value);
  }

  return Predicate.isNumber(value) ? numberText(value) : String(value);
};

const typeText = (type: TypeExpr): string =>
  Match.valueTags(type, {
    TypeKeyword: (keyword) => keyword.keyword,
    TypeLiteral: (literal) => literalTypeText(literal.value),
    TypeRef: (reference) => {
      const name = [reference.head, ...reference.members].join(".");
      const args = reference.args.map(typeText).join(", ");

      return reference.args.length === 0 ? name : `${name}<${args}>`;
    },
    TypeUnion: (union) => union.members.map(typeText).join(" | "),
  });

const paramText = (param: Param): string =>
  param.type === undefined ? param.name : `${param.name}: ${typeText(param.type)}`;

const arrowHead = (expr: ArrowExpr): string => {
  const returns = expr.returns === undefined ? "" : `: ${typeText(expr.returns)}`;

  return `(${expr.params.map(paramText).join(", ")})${returns} =>`;
};

const isPath = (expr: Expr): boolean =>
  expr._tag === "Identifier" || (expr._tag === "Member" && isPath(expr.object));

const entryCount = (expr: Expr): number => {
  if (expr._tag === "Object") {
    return expr.entries.length;
  }

  return expr._tag === "Array" ? expr.elements.length : 0;
};

// Two or more elements that are all object literals, or all array literals, with more than one
// entry each.
const alwaysBroken = (elements: readonly Expr[]): boolean => {
  const [first] = elements;

  return (
    elements.length > 1 &&
    elements.every(
      (element) =>
        (element._tag === "Object" || element._tag === "Array") &&
        element._tag === first?._tag &&
        entryCount(element) > 1,
    )
  );
};

const isNumberList = (elements: readonly Expr[]): boolean =>
  elements.length > 1 && elements.every((element) => element._tag === "Number");

// Values that move below `=` or `:` when they do not fit after it.
const movesWhenLong = (expr: Expr): boolean =>
  expr._tag === "String" ||
  expr._tag === "Undefined" ||
  (expr._tag === "Number" && expr.value < 0) ||
  isPath(expr);

const flatPair = (left: string | undefined, separator: string, right: string | undefined) =>
  left === undefined || right === undefined ? undefined : `${left}${separator}${right}`;

const flat = (expr: Expr): string | undefined =>
  Match.valueTags(expr, {
    Array: (list) =>
      alwaysBroken(list.elements) ? undefined : flatList(list.elements.map(flat), "[", "]"),
    Arrow: (fn) => {
      const body = flat(fn.body);

      return flatPair(arrowHead(fn), " ", fn.body._tag === "Object" ? `(${body})` : body);
    },
    Boolean: (literal) => String(literal.value),
    Call: (invocation) =>
      flatPair(flat(invocation.callee), "", flatList(invocation.args.map(flat), "(", ")")),
    Conditional: (choice) =>
      flatPair(
        flatPair(flat(choice.test), " ? ", flat(choice.consequent)),
        " : ",
        flat(choice.alternate),
      ),
    Identifier: (name) => name.name,
    Member: (access) => flatPair(flat(access.object), ".", access.name),
    New: (construct) =>
      flatPair(
        `new ${flat(construct.callee) ?? ""}`,
        "",
        flatList(construct.args.map(flat), "(", ")"),
      ),
    Number: (literal) => numberText(literal.value),
    Object: (literal) => {
      const entries = sortEntries(literal.entries).map(([key, value]) =>
        flatPair(keyText(key), ": ", flat(value)),
      );

      return flatList(entries, "{ ", " }");
    },
    Plus: (sum) => flatPair(flat(sum.left), " + ", flat(sum.right)),
    String: (literal) => stringLiteral(literal.value),
    Undefined: () => "undefined",
  });

const block = (open: string, lines: readonly string[], indent: number, close: string): string =>
  [open, ...lines, `${pad(indent)}${close}`].join("\n");

// Packs pre-punctuated items greedily, as many per line as end at or before column 100.
const fillLines = (items: readonly string[], indent: number): readonly string[] => {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    if (current === "") {
      current = item;
    } else if (indent + textWidth(current) + 1 + textWidth(item) <= lineWidth) {
      current = `${current} ${item}`;
    } else {
      lines.push(current);
      current = item;
    }
  }

  lines.push(current);

  return lines.map((line) => `${pad(indent)}${line}`);
};

// A conditional moves below `=` or `:` when its test does not fit after it.
const movesConditional = (expr: Expr, place: Place): boolean =>
  expr._tag === "Conditional" && !fits(flat(expr.test), { ...place, tail: 0 });

const renderProperty = (key: string, value: Expr, indent: number, render: Render): string => {
  const place = { column: indent + textWidth(key) + 2, indent, tail: 1 };
  const text = flat(value);
  if (movesWhenLong(value) && textWidth(key) >= 5 && !fits(text, place)) {
    return `${key}:\n${pad(indent + 2)}${text ?? ""}`;
  }

  if (textWidth(key) >= 5 && movesConditional(value, place)) {
    const inner = indent + 2;

    return `${key}:\n${pad(inner)}${render(value, { column: inner, indent: inner, tail: 1 })}`;
  }

  return `${key}: ${render(value, place)}`;
};

const renderObject = (entries: readonly Entry[], indent: number, render: Render): string => {
  if (entries.length === 0) {
    return "{}";
  }

  const inner = indent + 2;
  const lines = sortEntries(entries).map(
    ([key, value]) => `${pad(inner)}${renderProperty(keyText(key), value, inner, render)},`,
  );

  return block("{", lines, indent, "}");
};

const renderArray = (elements: readonly Expr[], indent: number, render: Render): string => {
  if (elements.length === 0) {
    return "[]";
  }

  const inner = indent + 2;
  const place = { column: inner, indent: inner, tail: 1 };
  const lines = isNumberList(elements)
    ? fillLines(
        elements.map((element) => `${flat(element) ?? ""},`),
        inner,
      )
    : elements.map((element) => `${pad(inner)}${render(element, place)},`);

  return block("[", lines, indent, "]");
};

const huggable = (expr: Expr): boolean => {
  if (expr._tag === "Object" || expr._tag === "Array") {
    return entryCount(expr) > 0;
  }

  return (
    expr._tag === "Arrow" &&
    (expr.body._tag === "Object" || expr.body._tag === "Array" || expr.body._tag === "Call")
  );
};

const canHug = (args: readonly Expr[]): boolean => {
  const last = args.at(-1);
  const before = args.at(-2);
  if (last === undefined || !huggable(last) || before?._tag === last._tag) {
    return false;
  }

  if (args.length === 2 && before?._tag === "Arrow" && last._tag === "Array") {
    return false;
  }

  return !(args.length > 1 && last._tag === "Array" && isNumberList(last.elements));
};

const opening = (expr: Expr): string => {
  if (expr._tag !== "Arrow") {
    return expr._tag === "Object" ? "{" : "[";
  }

  if (expr.body._tag === "Object") {
    return `${arrowHead(expr)} ({`;
  }

  return expr.body._tag === "Array" ? `${arrowHead(expr)} [` : arrowHead(expr);
};

const renderMovedBody = (expr: ArrowExpr, indent: number, tail: number, render: Render) => {
  const inner = indent + 2;

  return `${arrowHead(expr)}\n${pad(inner)}${render(expr.body, { column: inner, indent: inner, tail })}`;
};

// The last argument opens on the call's line and is printed broken. A hugged arrow whose body
// moves ends with `,` and leaves `)` to its own line.
const renderHugged = (expr: Expr, indent: number, render: Render): string => {
  if (expr._tag === "Object") {
    return renderObject(expr.entries, indent, render);
  }

  if (expr._tag === "Array") {
    return renderArray(expr.elements, indent, render);
  }

  if (expr._tag !== "Arrow") {
    return flat(expr) ?? "";
  }

  if (expr.body._tag === "Object") {
    return `${arrowHead(expr)} (${renderObject(expr.body.entries, indent, render)})`;
  }

  if (expr.body._tag === "Array") {
    return `${arrowHead(expr)} ${renderArray(expr.body.elements, indent, render)}`;
  }

  return `${renderMovedBody(expr, indent, 1, render)},\n${pad(indent)}`;
};

const renderArgs = (args: readonly Expr[], place: Place, render: Render): string => {
  const flats = args.map(flat);
  const flatText = flatList(flats, "(", ")");
  if (fits(flatText, place)) {
    return flatText;
  }

  const last = args.at(-1);
  const leading = flats.slice(0, -1);
  if (last !== undefined && canHug(args) && leading.every(isDefined)) {
    const prefix = `(${leading.map((text) => `${text}, `).join("")}`;
    if (place.column + textWidth(prefix) + textWidth(opening(last)) <= lineWidth) {
      return `${prefix}${renderHugged(last, place.indent, render)})`;
    }
  }

  const inner = place.indent + 2;
  const at = { column: inner, indent: inner, tail: 1 };
  const lines = args.map((arg) => `${pad(inner)}${render(arg, at)},`);

  return block("(", lines, place.indent, ")");
};

const renderArrow = (expr: ArrowExpr, place: Place, render: Render): string => {
  const head = arrowHead(expr);
  const column = place.column + textWidth(head) + 1;
  if (expr.body._tag === "Object") {
    const at = { column: column + 1, indent: place.indent, tail: place.tail + 1 };

    return `${head} (${render(expr.body, at)})`;
  }

  if (expr.body._tag === "Array") {
    return `${head} ${render(expr.body, { ...place, column })}`;
  }

  return renderMovedBody(expr, place.indent, place.tail, render);
};

type ConditionalExpr = Extract<Expr, { readonly _tag: "Conditional" }>;

// The test stays on the line; each branch starts a line one level deeper, after `? ` or `: `, and
// lays out two columns further in.
const renderConditional = (expr: ConditionalExpr, place: Place, render: Render): string => {
  const inner = place.indent + 2;
  const branch = { column: inner + 2, indent: inner + 2, tail: 0 };
  const test = render(expr.test, { ...place, tail: 0 });
  const consequent = render(expr.consequent, branch);
  const alternate = render(expr.alternate, { ...branch, tail: place.tail });

  return `${test}\n${pad(inner)}? ${consequent}\n${pad(inner)}: ${alternate}`;
};

const render: Render = (expr, place) => {
  const text = flat(expr);
  if (fits(text, place)) {
    return text;
  }

  const leaf = () => text ?? "";

  return Match.valueTags(expr, {
    Array: (list) => renderArray(list.elements, place.indent, render),
    Arrow: (fn) => renderArrow(fn, place, render),
    Boolean: leaf,
    Call: (invocation) => {
      const tail = invocation.args.length === 0 ? place.tail + 2 : 1;
      const callee = render(invocation.callee, { ...place, tail });
      const column = endColumn(place.column, callee);

      return `${callee}${renderArgs(invocation.args, { ...place, column }, render)}`;
    },
    Conditional: (choice) => renderConditional(choice, place, render),
    Identifier: leaf,
    Member: (access) => {
      const tail = place.tail + 1 + access.name.length;

      return `${render(access.object, { ...place, tail })}.${access.name}`;
    },
    New: (construct) => {
      const head = `new ${flat(construct.callee) ?? ""}`;
      const column = place.column + textWidth(head);

      return `${head}${renderArgs(construct.args, { ...place, column }, render)}`;
    },
    Number: leaf,
    Object: (literal) => renderObject(literal.entries, place.indent, render),
    Plus: (sum) => `${flat(sum.left) ?? ""} +\n${pad(place.indent + 2)}${flat(sum.right) ?? ""}`,
    String: leaf,
    Undefined: leaf,
  });
};

type Role = "argument" | "callee" | "value";

type Issue = Option.Option<PrinterError>;

const none = (): Issue => Option.none();

const issue = (reason: PrinterError["reason"], subject: string): Issue =>
  Option.some(new PrinterError({ reason, subject }));

const firstIssue = <A>(items: readonly A[], check: (item: A) => Issue): Issue => {
  for (const item of items) {
    const found = check(item);
    if (Option.isSome(found)) {
      return found;
    }
  }

  return Option.none();
};

const duplicateKey = (keys: readonly string[]): string | undefined =>
  keys.find((key, index) => keys.indexOf(key) !== index);

const pathHead = (expr: Expr): string | undefined => {
  if (expr._tag === "Identifier") {
    return expr.name;
  }

  return expr._tag === "Member" ? pathHead(expr.object) : undefined;
};

/**
 * The root of a callee and its number of call groups.
 */
interface Chain {
  readonly groups: number;
  readonly root: Expr;
}

// `Head.member(args)` is one call group, each `.name(args)` after a call adds one, and curried
// calls stay in their group.
const chainOf = (callee: Expr, groups: number): Chain => {
  if (callee._tag === "Call") {
    return chainOf(callee.callee, groups);
  }

  if (callee._tag === "Member" && callee.object._tag === "Call") {
    return chainOf(callee.object.callee, groups + 1);
  }

  return { groups, root: callee };
};

const checkChain = (callee: Expr): Issue => {
  const { groups, root } = chainOf(callee, 1);
  const head = isPath(root) ? pathHead(root) : undefined;
  if (head === undefined || groups > 2 || (groups === 2 && !/^[A-Z]/u.test(head))) {
    return issue("unsupported-chain", flat(callee) ?? "");
  }

  return Option.none();
};

const isLeaf = (expr: Expr): boolean =>
  expr._tag === "String" ||
  expr._tag === "Number" ||
  expr._tag === "Boolean" ||
  expr._tag === "Undefined" ||
  isPath(expr);

const checkObject = (entries: readonly Entry[], check: (expr: Expr) => Issue): Issue => {
  const duplicate = duplicateKey(entries.map(([key]) => key));

  return duplicate === undefined
    ? firstIssue(entries, ([, value]) => check(value))
    : issue("duplicate-key", duplicate);
};

const check = (expr: Expr, role: Role): Issue => {
  const asValue = (inner: Expr) => check(inner, "value");

  return Match.valueTags(expr, {
    Array: (list) => firstIssue(list.elements, asValue),
    Arrow: (fn) =>
      fn.body._tag === "Arrow" || fn.body._tag === "Conditional" || fn.body._tag === "Plus"
        ? issue("unsupported-arrow-body", fn.body._tag)
        : asValue(fn.body),
    Boolean: none,
    Call: (invocation) =>
      checkChain(invocation.callee).pipe(
        Option.orElse(() => check(invocation.callee, "callee")),
        Option.orElse(() => firstIssue(invocation.args, (arg) => check(arg, "argument"))),
      ),
    Conditional: (choice) => {
      const operands = [choice.test, choice.consequent, choice.alternate];
      const nested = operands.find(
        (operand) => operand._tag === "Conditional" || operand._tag === "Arrow",
      );

      return nested === undefined
        ? firstIssue(operands, asValue)
        : issue("unsupported-conditional", nested._tag);
    },
    Identifier: none,
    Member: (access) => {
      if (isPath(access)) {
        return Option.none();
      }

      return role === "callee" && access.object._tag === "Call"
        ? asValue(access.object)
        : issue("unsupported-member", access.name);
    },
    New: (construct) =>
      isPath(construct.callee)
        ? firstIssue(construct.args, (arg) => check(arg, "argument"))
        : issue("unsupported-new", construct.callee._tag),
    Number: (literal) =>
      Number.isFinite(literal.value)
        ? Option.none()
        : issue("non-finite-number", String(literal.value)),
    Object: (literal) => checkObject(literal.entries, asValue),
    Plus: (sum) =>
      role === "argument" && isLeaf(sum.left) && isLeaf(sum.right)
        ? Option.orElse(asValue(sum.left), () => asValue(sum.right))
        : issue("unsupported-plus", role),
    String: none,
    Undefined: none,
  });
};

const withDoc = (doc: JsDocTextType | undefined, text: string): string =>
  doc === undefined ? text : `${jsDoc(doc)}\n${text}`;

const unbreakable = (lines: readonly string[], subject: string): Issue =>
  lines.some((line) => textWidth(line) > lineWidth)
    ? issue("unbreakable-line", subject)
    : Option.none();

const succeedUnless = (failure: Issue, text: () => string): Effect.Effect<string, PrinterError> =>
  Option.match(failure, {
    onNone: () => Effect.succeed(text()),
    onSome: (error) => Effect.fail(error),
  });

const constBody = (statement: Extract<Statement, { readonly _tag: "Const" }>, head: string) => {
  const { value } = statement;
  const asConst = statement.asConst === true;
  const tail = asConst ? " as const;" : ";";
  const place = { column: textWidth(head) + 1, indent: 0, tail: tail.length };
  const text = flat(value);
  const moves =
    movesWhenLong(value) || (asConst && (value._tag === "Number" || value._tag === "Boolean"));
  if (movesConditional(value, place)) {
    return `${head}\n  ${render(value, { column: 2, indent: 2, tail: tail.length })}${tail}`;
  }

  const body = moves && !fits(text, place) ? `\n  ${text ?? ""}` : ` ${render(value, place)}`;

  return `${head}${body}${tail}`;
};

const printConst = (statement: Extract<Statement, { readonly _tag: "Const" }>) => {
  const type = statement.type === undefined ? "" : `: ${typeText(statement.type)}`;
  const head = `${statement.exported ? "export " : ""}const ${statement.name}${type} =`;
  const failure = check(statement.value, "value").pipe(
    Option.orElse(() => (type === "" ? Option.none() : unbreakable([head], statement.name))),
  );

  return succeedUnless(failure, () => withDoc(statement.doc, constBody(statement, head)));
};

const byFieldKey = Order.mapInput(Order.String, (field: Field) => field.key);

const printInterface = (statement: Extract<Statement, { readonly _tag: "Interface" }>) => {
  const head = `export interface ${statement.name} {`;
  const duplicate = duplicateKey(statement.fields.map((field) => field.key));
  const lines = Arr.sort(statement.fields, byFieldKey).map(
    (field) =>
      `  readonly ${keyText(field.key)}${field.optional ? "?" : ""}: ${typeText(field.type)};`,
  );
  const failure =
    duplicate === undefined
      ? unbreakable(lines, statement.name)
      : issue("duplicate-key", duplicate);
  const text = lines.length === 0 ? `${head}}` : [head, ...lines, "}"].join("\n");

  return succeedUnless(failure, () => withDoc(statement.doc, text));
};

// A top-level call, such as `BunRuntime.runMain(program);`. Other expressions are not statements
// the generator writes.
const printExpression = (statement: Extract<Statement, { readonly _tag: "Expression" }>) => {
  const { value } = statement;
  const failure =
    value._tag === "Call" ? check(value, "value") : issue("unsupported-expression", value._tag);

  return succeedUnless(failure, () => `${render(value, { column: 0, indent: 0, tail: 1 })};`);
};

const printStatement = (statement: Statement): Effect.Effect<string, PrinterError> =>
  Match.valueTags(statement, {
    Const: printConst,
    Expression: printExpression,
    Interface: printInterface,
    TypeAlias: (alias) => {
      const line = `export type ${alias.name} = ${typeText(alias.type)};`;

      return succeedUnless(unbreakable([line], alias.name), () => withDoc(alias.doc, line));
    },
  });

const importOrder = Order.combineAll([
  Order.mapInput(Order.Boolean, (entry: Import) => entry.from.startsWith(".")),
  Order.mapInput(Order.String, (entry: Import) => entry.from),
  Order.mapInput(Order.Boolean, (entry: Import) => !entry.typeOnly),
  Order.mapInput(Order.Boolean, (entry: Import) => entry._tag === "Named"),
  Order.mapInput(Order.String, (entry: Import) => (entry._tag === "Namespace" ? entry.name : "")),
]);

const importKey = (entry: Import): string =>
  [
    entry._tag,
    String(entry.typeOnly),
    entry.from,
    entry._tag === "Namespace" ? entry.name : "",
  ].join(":");

// One statement per specifier and kind: named imports of one kind from one specifier merge.
const mergeImports = (imports: readonly Import[]): readonly Import[] => {
  const merged = new Map<string, Import>();
  for (const entry of imports) {
    const previous = merged.get(importKey(entry));
    const earlier = previous?._tag === "Named" ? previous.names : [];
    const next = entry._tag === "Named" ? { ...entry, names: [...earlier, ...entry.names] } : entry;
    merged.set(importKey(entry), next);
  }

  return Arr.sort([...merged.values()], importOrder);
};

const importLine = (entry: Import): string => {
  const kind = entry.typeOnly ? "type " : "";
  const from = stringLiteral(entry.from);
  if (entry._tag === "Namespace") {
    return `import ${kind}* as ${entry.name} from ${from};`;
  }

  const names = Arr.sort(Arr.dedupe(entry.names), Order.String);
  const line = `import ${kind}{ ${names.join(", ")} } from ${from};`;
  if (textWidth(line) <= lineWidth) {
    return line;
  }

  return [`import ${kind}{`, ...names.map((name) => `  ${name},`), `} from ${from};`].join("\n");
};

/**
 * Prints a module in the `docs/printer.md` layout, after its shebang line when it has one. Fails
 * with a `PrinterError` when the module holds a construct outside the printer's syntax subset.
 */
export const printModule = (module: Module): Effect.Effect<string, PrinterError> =>
  Effect.map(Effect.all(module.statements.map(printStatement)), (statements) => {
    const imports = mergeImports(module.imports).map(importLine);
    const blocks = [
      ...(module.shebang === undefined ? [] : [`#!${module.shebang}`]),
      ...(imports.length === 0 ? [] : [imports.join("\n")]),
      ...statements,
    ];

    return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
  });

type Json = Schema.Json;

type JsonValue = (typeof JsonLiteral)["Type"];

const isJsonArray = (value: Json): value is Schema.JsonArray => Array.isArray(value);

const isJsonScalar = (value: Json): value is boolean | number | string | null =>
  value === null ||
  Predicate.isBoolean(value) ||
  Predicate.isNumber(value) ||
  Predicate.isString(value);

const isNonEmptyJsonObject = (value: Json): boolean =>
  !isJsonScalar(value) && !isJsonArray(value) && Object.keys(value).length > 0;

const isLongJsonArray = (value: Json): boolean => isJsonArray(value) && value.length > 1;

// An array holding a non-empty object, or two or more arrays that each hold more than one element.
const jsonAlwaysBroken = (values: readonly Json[]): boolean =>
  values.some((value) => isNonEmptyJsonObject(value)) ||
  (values.length > 1 && values.every((value) => isLongJsonArray(value)));

const jsonFlat = (value: Json): string | undefined => {
  if (isJsonScalar(value)) {
    return JSON.stringify(value);
  }

  if (isJsonArray(value)) {
    return jsonAlwaysBroken(value)
      ? undefined
      : flatList(
          value.map((item) => jsonFlat(item)),
          "[",
          "]",
        );
  }

  return Object.keys(value).length === 0 ? "{}" : undefined;
};

type RenderJson = (value: Json, place: Place) => string;

const jsonArrayLines = (
  values: Schema.JsonArray,
  indent: number,
  renderItem: RenderJson,
): readonly string[] => {
  const lastIndex = values.length - 1;
  const comma = (index: number) => (index === lastIndex ? "" : ",");
  if (values.length > 1 && values.every((item) => Predicate.isNumber(item))) {
    return fillLines(
      values.map((item, index) => `${JSON.stringify(item)}${comma(index)}`),
      indent,
    );
  }

  return values.map((item, index) => {
    const at = { column: indent, indent, tail: comma(index).length };

    return `${pad(indent)}${renderItem(item, at)}${comma(index)}`;
  });
};

const jsonObjectLines = (
  value: Schema.JsonObject,
  indent: number,
  renderItem: RenderJson,
): readonly string[] => {
  const keys = Arr.sort(Object.keys(value), Order.String);
  const lastIndex = keys.length - 1;

  return keys.map((key, index) => {
    const label = `${JSON.stringify(key)}: `;
    const comma = index === lastIndex ? "" : ",";
    const at = { column: indent + textWidth(label), indent, tail: comma.length };

    return `${pad(indent)}${label}${renderItem(value[key] ?? null, at)}${comma}`;
  });
};

const renderJson: RenderJson = (value, place) => {
  if (isJsonScalar(value)) {
    return JSON.stringify(value);
  }

  // `[]` and `{}` cannot break.
  const text = jsonFlat(value);
  if (text !== undefined && (text.length === 2 || fits(text, place))) {
    return text;
  }

  const inner = place.indent + 2;

  return isJsonArray(value)
    ? block("[", jsonArrayLines(value, inner, renderJson), place.indent, "]")
    : block("{", jsonObjectLines(value, inner, renderJson), place.indent, "}");
};

/**
 * Prints a JSON file in the `docs/printer.md` JSON layout: objects broken with sorted keys, arrays
 * flat when they fit, a final newline.
 */
export const printJson = (value: JsonValue): string =>
  `${renderJson(value, { column: 0, indent: 0, tail: 0 })}\n`;

const packageKeys: readonly string[] = [
  "name",
  "version",
  "private",
  "description",
  "license",
  "bin",
  "files",
  "type",
  "exports",
  "scripts",
  "dependencies",
  "devDependencies",
  "engines",
  "packageManager",
];

const knownPackageKeys: ReadonlySet<string> = new Set(packageKeys);

const dependencyKeys: ReadonlySet<string> = new Set(["dependencies", "devDependencies"]);

const byJsonKey = Order.mapInput(Order.String, (entry: readonly [string, Json]) => entry[0]);

const sortedMap = (value: Json): Json =>
  isJsonScalar(value) || isJsonArray(value)
    ? value
    : Object.fromEntries(Arr.sort(Object.entries(value), byJsonKey));

/**
 * Prints `package.json` in the layout the formatter keeps for it: `JSON.stringify(value, null, 2)`
 * plus a final newline, top-level keys in the `docs/printer.md` order, dependency maps sorted by
 * package name. Fails on a top-level key outside that order.
 */
export const printPackageJson = (manifest: JsonValue): Effect.Effect<string, PrinterError> => {
  if (isJsonScalar(manifest) || isJsonArray(manifest)) {
    return Effect.fail(new PrinterError({ reason: "unsupported-package-json", subject: "root" }));
  }

  const unknown = Object.keys(manifest).find((key) => !knownPackageKeys.has(key));
  if (unknown !== undefined) {
    return Effect.fail(new PrinterError({ reason: "unsupported-package-json", subject: unknown }));
  }

  const ordered = Object.fromEntries(
    packageKeys.flatMap((key) => {
      const value = manifest[key];
      if (value === undefined) {
        return [];
      }

      return [[key, dependencyKeys.has(key) ? sortedMap(value) : value]];
    }),
  );

  return Effect.succeed(`${JSON.stringify(ordered, null, 2)}\n`);
};
