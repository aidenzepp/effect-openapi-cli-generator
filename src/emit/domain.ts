import {
  Array as Arr,
  Data,
  Effect,
  JsonPointer,
  Match,
  Option,
  Order,
  Predicate,
  Schema,
  SchemaRepresentation,
} from "effect";
import { constVoid } from "effect/Function";
import type { JsonSchema } from "effect";
import { codeGenerationCopy } from "../normalize/schemas.ts";
import type { SchemaBudgetExceeded, SchemaLimits } from "../normalize/schemas.ts";
import type { Json } from "../resolve/pointer.ts";
import { asciiStringLiteral, stringLiteral } from "./escape.ts";
import type { EmittedFile } from "./package.ts";

/**
 * The code-generation copy cannot become `domain/schemas.ts`.
 */
export class DomainEmitError extends Data.TaggedError("DomainEmitError")<{
  readonly reason:
    | "import-failed"
    | "reference-cycle"
    | "unprintable-code"
    | "unsupported-artifact"
    | "unsupported-definition";
}> {}

// ---------------------------------------------------------------------------------------------
// The syntax of the code `SchemaRepresentation.toCodeDocument` writes. Effect writes each
// definition as one unformatted line, and `vp fmt` accepts exactly one layout of it, so the code
// is parsed and laid out here (docs/printer.md: the generator never runs a formatter).

type Ty =
  | { readonly _tag: "Inter"; readonly members: readonly Ty[] }
  | { readonly _tag: "Lit"; readonly text: string }
  | { readonly _tag: "Obj"; readonly members: readonly Member[] }
  | { readonly _tag: "Ref"; readonly args: readonly Ty[]; readonly path: readonly string[] }
  | { readonly _tag: "Tuple"; readonly elements: readonly TupleElement[] }
  | { readonly _tag: "Union"; readonly members: readonly Ty[] };

interface Member {
  readonly index: Ty | undefined;
  readonly key: string;
  readonly optional: boolean;
  readonly readonly: boolean;
  readonly type: Ty;
}

interface TupleElement {
  readonly optional: boolean;
  readonly rest: boolean;
  readonly type: Ty;
}

type Ex =
  | { readonly _tag: "Arr"; readonly elements: readonly Ex[] }
  | { readonly _tag: "Arrow"; readonly body: Ex; readonly returns: Ty }
  | { readonly _tag: "Call"; readonly args: readonly Ex[]; readonly callee: Ex }
  | { readonly _tag: "Ident"; readonly name: string }
  | { readonly _tag: "Member"; readonly name: string; readonly object: Ex }
  | { readonly _tag: "Num"; readonly value: number }
  | { readonly _tag: "Obj"; readonly entries: readonly Entry[] }
  | { readonly _tag: "Str"; readonly value: string };

interface Entry {
  readonly name: string;
  readonly value: Ex;
}

type TokenKind = "ident" | "number" | "punct" | "string";

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

const tokenPattern =
  /\s*(?:(?<bad>-?\d+n)|(?<string>"(?:[^"\\]|\\.)*")|(?<number>-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|(?<ident>[A-Za-z_$][A-Za-z0-9_$]*)|(?<punct>=>|\.\.\.|[{}()[\]<>,:.?|&]))/uy;

const kindOf = (groups: Record<string, string | undefined>): Token | undefined => {
  const kinds: readonly TokenKind[] = ["string", "number", "ident", "punct"];
  const kind = kinds.find((candidate) => groups[candidate] !== undefined);

  return kind === undefined ? undefined : { kind, text: groups[kind] ?? "" };
};

// `undefined` when the text holds something outside the grammar: a bigint, a template literal.
const tokenize = (source: string): readonly Token[] | undefined => {
  const tokens: Token[] = [];
  tokenPattern.lastIndex = 0;
  let end = 0;
  let found = tokenPattern.exec(source);
  while (found !== null) {
    const token = kindOf(found.groups ?? {});
    if (token === undefined) {
      return undefined;
    }

    tokens.push(token);
    end = tokenPattern.lastIndex;
    found = tokenPattern.exec(source);
  }

  return source.slice(end).trim() === "" ? tokens : undefined;
};

const decodeString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

const numberText = (value: number): string =>
  value < 0 ? `-${numberText(-value)}` : String(value).replace("e+", "e");

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

const placeholder: Ty = { _tag: "Lit", text: "" };

// A failed parse keeps returning placeholders; the caller reads `failed` once at the end.
class Parser {
  failed = false;
  private position = 0;
  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  done(): boolean {
    return !this.failed && this.position >= this.tokens.length;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.position + offset];
  }

  private next(): Token {
    const token = this.tokens[this.position];
    this.position += 1;
    if (token === undefined) {
      this.failed = true;
    }

    return token ?? { kind: "punct", text: "" };
  }

  private is(text: string, offset = 0): boolean {
    const token = this.peek(offset);

    return token?.kind === "punct" && token.text === text;
  }

  private accept(text: string): boolean {
    const matched = this.is(text);
    if (matched) {
      this.position += 1;
    }

    return matched;
  }

  private expect(text: string): void {
    if (!this.accept(text)) {
      this.failed = true;
      this.position += 1;
    }
  }

  private string(): string {
    const token = this.next();
    const decoded = token.kind === "string" ? decodeString(token.text) : Option.none();
    if (Option.isNone(decoded)) {
      this.failed = true;
    }

    return Option.getOrElse(decoded, () => "");
  }

  private list<A>(close: string, item: () => A): readonly A[] {
    const items: A[] = [];
    while (!this.failed && this.position < this.tokens.length && !this.is(close)) {
      items.push(item());
      if (!this.accept(",")) {
        break;
      }
    }

    this.expect(close);

    return items;
  }

  type(): Ty {
    const first = this.intersection();
    if (!this.is("|")) {
      return first;
    }

    const members = [first];
    while (this.accept("|")) {
      members.push(this.intersection());
    }

    return { _tag: "Union", members };
  }

  private intersection(): Ty {
    const first = this.typePrimary();
    if (!this.is("&")) {
      return first;
    }

    const members = [first];
    while (this.accept("&")) {
      members.push(this.typePrimary());
    }

    // Only the object intersections `toCodeDocument` writes have a layout here.
    this.failed ||= !members.every((member) => member._tag === "Obj");

    return { _tag: "Inter", members };
  }

  private member(): Member {
    const readonlyKeyword = this.peek()?.text === "readonly" && !this.is(":", 1);
    if (readonlyKeyword) {
      this.next();
    }

    if (this.accept("[")) {
      this.next();
      this.expect(":");

      const index = this.type();
      this.expect("]");
      this.expect(":");

      return { index, key: "", optional: false, readonly: readonlyKeyword, type: this.type() };
    }

    const key = this.peek()?.kind === "string" ? this.string() : this.next().text;
    const optional = this.accept("?");
    this.expect(":");

    return { index: undefined, key, optional, readonly: readonlyKeyword, type: this.type() };
  }

  private tupleElement(): TupleElement {
    const rest = this.accept("...");
    if (this.accept("(")) {
      const type = this.type();
      this.expect(")");

      return { optional: this.accept("?"), rest, type };
    }

    return { optional: false, rest, type: this.type() };
  }

  private reference(): Ty {
    const path = [this.next().text];
    while (this.accept(".")) {
      path.push(this.next().text);
    }

    return { _tag: "Ref", args: this.accept("<") ? this.list(">", () => this.type()) : [], path };
  }

  private typePrimary(): Ty {
    const token = this.peek();
    if (token?.kind === "string") {
      return { _tag: "Lit", text: stringLiteral(this.string()) };
    }

    if (token?.kind === "number") {
      this.next();

      return { _tag: "Lit", text: numberText(Number(token.text)) };
    }

    if (this.accept("{")) {
      return { _tag: "Obj", members: this.list("}", () => this.member()) };
    }

    if (token?.kind === "ident" && token.text === "readonly" && this.is("[", 1)) {
      this.next();
      this.next();

      return { _tag: "Tuple", elements: this.list("]", () => this.tupleElement()) };
    }

    if (token?.kind === "ident") {
      return this.reference();
    }

    this.failed = true;

    return placeholder;
  }

  private entry(): Entry {
    const computed = this.accept("[");
    const name = this.peek()?.kind === "string" ? this.string() : this.next().text;
    if (computed) {
      this.expect("]");
    }

    this.expect(":");

    return { name, value: this.expression() };
  }

  private primary(): Ex {
    const token = this.peek();
    if (token?.kind === "string") {
      return { _tag: "Str", value: this.string() };
    }

    if (token?.kind === "number") {
      this.next();

      return { _tag: "Num", value: Number(token.text) };
    }

    if (this.accept("{")) {
      return { _tag: "Obj", entries: this.list("}", () => this.entry()) };
    }

    if (this.accept("[")) {
      return { _tag: "Arr", elements: this.list("]", () => this.expression()) };
    }

    if (this.accept("(")) {
      this.expect(")");
      this.expect(":");

      const returns = this.type();
      this.expect("=>");

      return { _tag: "Arrow", body: this.expression(), returns };
    }

    if (token?.kind === "ident") {
      this.next();

      return { _tag: "Ident", name: token.text };
    }

    this.failed = true;

    return { _tag: "Ident", name: "" };
  }

  expression(): Ex {
    let expression = this.primary();
    while (!this.failed) {
      if (this.accept(".")) {
        expression = { _tag: "Member", name: this.next().text, object: expression };
      } else if (this.accept("(")) {
        expression = {
          _tag: "Call",
          args: this.list(")", () => this.expression()),
          callee: expression,
        };
      } else {
        break;
      }
    }

    return expression;
  }
}

const parseExpression = (source: string): Ex | undefined => {
  const tokens = tokenize(source);
  const parser = new Parser(tokens ?? []);
  const parsed = parser.expression();

  return tokens === undefined || !parser.done() ? undefined : parsed;
};

const parseType = (source: string): Ty | undefined => {
  const tokens = tokenize(source);
  const parser = new Parser(tokens ?? []);
  const parsed = parser.type();

  return tokens === undefined || !parser.done() ? undefined : parsed;
};

// ---------------------------------------------------------------------------------------------
// Documents: the group, indent and fill model of the formatter (`vp fmt` is `oxfmt`, a Prettier
// port), reduced to the forms these definitions need.

type Doc = string | readonly Doc[] | Node;

type Node =
  | { readonly _tag: "breakParent" }
  | { readonly _tag: "fill"; readonly parts: readonly Doc[] }
  | {
      readonly _tag: "group";
      readonly brk: boolean;
      readonly contents: Doc;
      readonly id: symbol | undefined;
      readonly states: readonly Doc[] | undefined;
    }
  | {
      readonly _tag: "ifBreak";
      readonly broken: Doc;
      readonly flat: Doc;
      readonly id: symbol | undefined;
    }
  | { readonly _tag: "indent"; readonly contents: Doc }
  | { readonly _tag: "indentIfBreak"; readonly contents: Doc; readonly id: symbol }
  | { readonly _tag: "line"; readonly hard: boolean; readonly soft: boolean };

const lineWidth = 100;

// East Asian Wide and Fullwidth blocks, as in printer.ts: `vp fmt` counts such a code point as two.
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

const charWidth = (char: string): number => {
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

// Display columns as `vp fmt` counts them (docs/printer.md Layout).
const textWidth = (text: string): number => {
  let total = 0;
  for (const char of text) {
    total += charWidth(char);
  }

  return total;
};

const isList = (doc: Doc): doc is readonly Doc[] => Array.isArray(doc);

const line: Doc = { _tag: "line", hard: false, soft: false };

const softline: Doc = { _tag: "line", hard: false, soft: true };

const hardline: Doc = { _tag: "line", hard: true, soft: false };

const breakParent: Doc = { _tag: "breakParent" };

const indent = (contents: Doc): Doc => ({ _tag: "indent", contents });

const ifBreak = (broken: Doc, flat: Doc = "", id?: symbol): Doc => ({
  _tag: "ifBreak",
  broken,
  flat,
  id,
});

const indentIfBreak = (contents: Doc, id: symbol): Doc => ({ _tag: "indentIfBreak", contents, id });

const join = (separator: Doc, docs: readonly Doc[]): readonly Doc[] =>
  docs.flatMap((doc, index) => (index === 0 ? [doc] : [separator, doc]));

// Whether a doc holds a forced line break; a group that does is itself broken.
const willBreak = (doc: Doc): boolean => {
  if (Predicate.isString(doc)) {
    return false;
  }

  if (isList(doc)) {
    return doc.some(willBreak);
  }

  return Match.valueTags(doc, {
    breakParent: () => true,
    fill: (node) => node.parts.some(willBreak),
    group: (node) => node.brk,
    ifBreak: (node) => willBreak(node.broken) || willBreak(node.flat),
    indent: (node) => willBreak(node.contents),
    indentIfBreak: (node) => willBreak(node.contents),
    line: (node) => node.hard,
  });
};

interface GroupOptions {
  readonly brk?: boolean;
  readonly id?: symbol;
}

const group = (contents: Doc, options: GroupOptions = {}): Doc => ({
  _tag: "group",
  brk: options.brk === true || willBreak(contents),
  contents,
  id: options.id,
  states: undefined,
});

// The first state that fits flat, else the last one, broken (Prettier's `conditionalGroup`).
const conditionalGroup = (states: readonly [Doc, ...Doc[]]): Doc => ({
  _tag: "group",
  brk: false,
  contents: states[0],
  id: undefined,
  states,
});

type Mode = "break" | "flat";

interface Command {
  readonly doc: Doc;
  readonly indent: number;
  readonly mode: Mode;
}

interface Probe {
  readonly doc: Doc;
  readonly mode: Mode;
}

const modeOf = (id: symbol | undefined, fallback: Mode, modes: ReadonlyMap<symbol, Mode>): Mode =>
  id === undefined ? fallback : (modes.get(id) ?? "flat");

interface Spend {
  readonly mode: Mode;
  readonly next: readonly Doc[];
  readonly width: number;
}

// What measuring one doc does: answer, or spend `width` columns and continue into `next`.
type Measure = "fits" | "overflow" | Spend;

const spend = (mode: Mode, next: readonly Doc[], width = 0): Spend => ({ mode, next, width });

const measure = (probe: Probe, modes: ReadonlyMap<symbol, Mode>, mustBeFlat: boolean): Measure => {
  const { doc, mode } = probe;
  if (Predicate.isString(doc)) {
    return spend(mode, [], textWidth(doc));
  }

  if (isList(doc)) {
    return spend(mode, doc);
  }

  return Match.valueTags(doc, {
    breakParent: () => spend(mode, []),
    fill: (node) => spend(mode, node.parts),
    group: (node): Measure => {
      if (mustBeFlat && node.brk) {
        return "overflow";
      }

      const groupMode = node.brk ? "break" : mode;
      const useLast = node.states !== undefined && groupMode === "break";

      return spend(groupMode, [(useLast ? node.states?.at(-1) : node.contents) ?? ""]);
    },
    ifBreak: (node) => {
      const broken = modeOf(node.id, mode, modes) === "break";

      return spend(mode, [broken ? node.broken : node.flat]);
    },
    indent: (node) => spend(mode, [node.contents]),
    indentIfBreak: (node) => spend(mode, [node.contents]),
    line: (node): Measure => {
      if (mode === "break" || node.hard) {
        return "fits";
      }

      return spend(mode, [], node.soft ? 0 : 1);
    },
  });
};

// Whether the doc, then the commands after it up to their first line break, fit in `width`.
const fits = (
  start: Probe,
  rest: readonly Command[],
  width: number,
  modes: ReadonlyMap<symbol, Mode>,
  mustBeFlat: boolean,
): boolean => {
  let remaining = width;
  let restIndex = rest.length;
  const stack: Probe[] = [start];
  while (remaining >= 0) {
    let probe = stack.pop();
    if (probe === undefined) {
      restIndex -= 1;
      probe = rest[restIndex];
      if (probe === undefined) {
        return true;
      }
    }

    const outcome = measure(probe, modes, mustBeFlat);
    if (outcome === "fits") {
      return true;
    }

    if (outcome === "overflow") {
      return false;
    }

    remaining -= outcome.width;
    stack.push(...Arr.reverse(outcome.next.map((doc): Probe => ({ doc, mode: outcome.mode }))));
  }

  return false;
};

type GroupNode = Extract<Node, { readonly _tag: "group" }>;

// Prints a doc at the formatter's width: a group is flat when it fits to the next line break the
// layout emits, otherwise broken.
class Printer {
  private column = 0;
  private current = "";
  private readonly lines: string[] = [];
  private readonly modes = new Map<symbol, Mode>();
  private remeasure = false;
  private readonly stack: Command[] = [];

  print(doc: Doc): string {
    this.stack.push({ doc, indent: 0, mode: "break" });
    let command = this.stack.pop();
    while (command !== undefined) {
      this.step(command);
      command = this.stack.pop();
    }

    this.lines.push(this.current.trimEnd());

    return this.lines.join("\n");
  }

  private emit(commands: readonly Command[]): void {
    this.stack.push(...Arr.reverse(commands));
  }

  private text(text: string): void {
    this.current += text;
    this.column += textWidth(text);
  }

  private newline(spaces: number): void {
    this.lines.push(this.current.trimEnd());
    this.current = " ".repeat(spaces);
    this.column = spaces;
  }

  private step(command: Command): void {
    const { doc } = command;
    if (Predicate.isString(doc)) {
      this.text(doc);

      return;
    }

    if (isList(doc)) {
      this.emit(doc.map((child) => ({ ...command, doc: child })));

      return;
    }

    Match.valueTags(doc, {
      breakParent: constVoid,
      fill: (node) => {
        this.fill(node.parts, command);
      },
      group: (node) => {
        this.group(node, command);
      },
      ifBreak: (node) => {
        const broken = modeOf(node.id, command.mode, this.modes) === "break";
        this.emit([{ ...command, doc: broken ? node.broken : node.flat }]);
      },
      indent: (node) => {
        this.emit([{ ...command, doc: node.contents, indent: command.indent + 2 }]);
      },
      indentIfBreak: (node) => {
        const extra = this.modes.get(node.id) === "break" ? 2 : 0;
        this.emit([{ ...command, doc: node.contents, indent: command.indent + extra }]);
      },
      line: (node) => {
        this.line(node, command);
      },
    });
  }

  private line(node: { readonly hard: boolean; readonly soft: boolean }, command: Command): void {
    if (command.mode === "flat" && !node.hard) {
      this.text(node.soft ? "" : " ");

      return;
    }

    this.remeasure ||= command.mode === "flat";
    this.newline(command.indent);
  }

  private group(node: GroupNode, command: Command): void {
    if (command.mode === "flat" && !this.remeasure) {
      const last = node.brk && node.states !== undefined ? node.states.at(-1) : node.contents;
      this.emit([{ ...command, doc: last ?? "", mode: node.brk ? "break" : "flat" }]);
    } else {
      this.remeasure = false;
      this.emit([this.choose(node, command)]);
    }

    if (node.id !== undefined) {
      this.modes.set(node.id, this.stack.at(-1)?.mode ?? "flat");
    }
  }

  // The commands to print a group with: flat when it fits, else its first fitting alternative.
  private choose(node: GroupNode, command: Command): Command {
    const room = lineWidth - this.column;
    const flat: Command = { ...command, doc: node.contents, mode: "flat" };
    if (!node.brk && fits(flat, this.stack, room, this.modes, false)) {
      return flat;
    }

    const { states } = node;
    if (states === undefined) {
      return { ...command, doc: node.contents, mode: "break" };
    }

    const alternatives = node.brk
      ? []
      : states.slice(1).map((state): Command => ({ ...command, doc: state, mode: "flat" }));
    const chosen = alternatives.find((candidate) =>
      fits(candidate, this.stack, room, this.modes, false),
    );

    return chosen ?? { ...command, doc: states.at(-1) ?? "", mode: "break" };
  }

  // Fills a line with as many parts as fit (Prettier's `fill`): [content, separator, content, ...].
  private fill(parts: readonly Doc[], command: Command): void {
    const [content, separator, second, ...more] = parts;
    if (content === undefined) {
      return;
    }

    const room = lineWidth - this.column;
    const as = (doc: Doc, mode: Mode): Command => ({ ...command, doc, mode });
    const contentFits = fits(as(content, "flat"), [], room, this.modes, true);
    const contentMode = contentFits ? "flat" : "break";
    if (separator === undefined || second === undefined) {
      this.emit(
        separator === undefined
          ? [as(content, contentMode)]
          : [as(content, contentMode), as(separator, contentMode)],
      );

      return;
    }

    const rest = as({ _tag: "fill", parts: [second, ...more] }, command.mode);
    const pairFits = fits(as([content, separator, second], "flat"), [], room, this.modes, true);
    const separatorMode = pairFits ? "flat" : "break";
    this.emit([as(content, pairFits ? "flat" : contentMode), as(separator, separatorMode), rest]);
  }
}

const printDoc = (doc: Doc): string => new Printer().print(doc);

// ---------------------------------------------------------------------------------------------
// Layout of types.

const keyText = (key: string): string => {
  if (key === "__proto__") {
    return `[${stringLiteral(key)}]`;
  }

  return identifierPattern.test(key) ? key : asciiStringLiteral(key);
};

const isObjectType = (type: Ty): boolean => type._tag === "Obj";

const isNullType = (type: Ty): boolean =>
  type._tag === "Ref" &&
  type.args.length === 0 &&
  type.path.length === 1 &&
  type.path[0] === "null";

// An object type with only `null` beside it hugs: `{ ... } | null`.
const hugsUnion = (members: readonly Ty[]): boolean =>
  members.filter(isNullType).length === members.length - 1 && members.some(isObjectType);

const isSimpleType = (type: Ty): boolean =>
  (type._tag === "Ref" && type.args.length === 0) || type._tag === "Lit";

const hugsType = (type: Ty): boolean =>
  isSimpleType(type) || isObjectType(type) || (type._tag === "Union" && hugsUnion(type.members));

// Where a type is printed decides whether a broken union indents under its parent.
type TypeContext = "argument" | "element" | "optional" | "position";

type PrintType = (type: Ty, context?: TypeContext) => Doc;

// An intersection keeps its parentheses beside `|`.
const unionMemberDoc = (member: Ty, print: PrintType): Doc =>
  member._tag === "Inter" ? ["(", print(member), ")"] : print(member);

const unionDoc = (members: readonly Ty[], context: TypeContext, print: PrintType): Doc => {
  if (hugsUnion(members)) {
    return join(
      " | ",
      members.map((member) => unionMemberDoc(member, print)),
    );
  }

  const indents = context === "position" || context === "optional";
  const code: Doc = [
    ifBreak([indents ? line : "", "| "]),
    join(
      [line, "| "],
      members.map((member) => indent(unionMemberDoc(member, print))),
    ),
  ];
  if (context === "optional") {
    return group([indent(code), softline]);
  }

  return group(indents ? indent(code) : code);
};

const referenceDoc = (type: Extract<Ty, { readonly _tag: "Ref" }>, print: PrintType): Doc => {
  const name = type.path.join(".");
  const [only] = type.args;
  if (only === undefined) {
    return name;
  }

  if (type.args.length === 1 && hugsType(only)) {
    return [name, "<", print(only, "argument"), ">"];
  }

  const args = type.args.map((arg) => print(arg, "argument"));

  return [name, group(["<", indent([softline, join([",", line], args)]), softline, ">"])];
};

const memberDoc = (member: Member, print: PrintType): Doc => {
  const head = member.readonly ? "readonly " : "";
  if (member.index !== undefined) {
    return [head, "[x: ", print(member.index), "]: ", print(member.type)];
  }

  return [head, keyText(member.key), member.optional ? "?" : "", ": ", print(member.type)];
};

const objectTypeDoc = (members: readonly Member[], print: PrintType): Doc => {
  if (members.length === 0) {
    return "{}";
  }

  const docs = members.map((member) => memberDoc(member, print));

  return group(["{", indent([line, join([";", line], docs)]), ifBreak(";"), line, "}"]);
};

// A tuple element needs parentheses before `?` unless it is a name, a literal or an object type.
const needsParentheses = (element: TupleElement): boolean =>
  element.optional && !["Lit", "Obj", "Ref"].includes(element.type._tag);

const elementDoc = (element: TupleElement, print: PrintType): Doc => {
  const wrapped = needsParentheses(element);
  const body = print(element.type, wrapped ? "optional" : "element");

  return [
    element.rest ? "..." : "",
    wrapped ? ["(", body, ")"] : body,
    element.optional ? "?" : "",
  ];
};

const tupleDoc = (elements: readonly TupleElement[], print: PrintType): Doc => {
  if (elements.length === 0) {
    return "readonly []";
  }

  const docs = elements.map((element) => elementDoc(element, print));

  return [
    "readonly ",
    group(["[", indent([softline, join([",", line], docs)]), ifBreak(","), softline, "]"]),
  ];
};

const typeDoc: PrintType = (type, context = "position") =>
  Match.valueTags(type, {
    Inter: (inter) =>
      join(
        " & ",
        inter.members.map((member) => typeDoc(member)),
      ),
    Lit: (literal) => literal.text,
    Obj: (object) => objectTypeDoc(object.members, typeDoc),
    Ref: (reference) => referenceDoc(reference, typeDoc),
    Tuple: (tuple) => tupleDoc(tuple.elements, typeDoc),
    Union: (union) => unionDoc(union.members, context, typeDoc),
  });

// A name or literal that does not fit moves under the `=`; other types open on its line.
const typeAliasDoc = (name: string, type: Ty): Doc => {
  const head = `export type ${name} =`;
  if (type._tag === "Lit" || (type._tag === "Ref" && type.args.length === 0)) {
    return group([head, group(indent([line, typeDoc(type)]))]);
  }

  return [head, " ", typeDoc(type)];
};

// ---------------------------------------------------------------------------------------------
// Layout of expressions.

type PrintEx = (ex: Ex) => Doc;

const isPath = (ex: Ex): boolean =>
  ex._tag === "Ident" || (ex._tag === "Member" && isPath(ex.object));

const isMemberPath = (ex: Ex): boolean => ex._tag === "Member" && isPath(ex);

const pathText = (ex: Ex): string => {
  if (ex._tag === "Ident") {
    return ex.name;
  }

  return ex._tag === "Member" ? `${pathText(ex.object)}.${ex.name}` : "";
};

const isShortArgument = (ex: Ex): boolean =>
  Match.valueTags(ex, {
    Arr: () => false,
    Arrow: () => false,
    Call: () => false,
    Ident: (ident) => ident.name.length <= lineWidth / 4,
    Member: () => false,
    Num: () => true,
    Obj: () => false,
    Str: (string) => textWidth(stringLiteral(string.value)) <= lineWidth / 4,
  });

// A call chain whose calls take nothing or one short argument: moving it under the `=` or `:` is
// the only way to break it.
const isPoorlyBreakableCall = (ex: Ex): boolean => {
  if (ex._tag === "Member") {
    return isPoorlyBreakableCall(ex.object);
  }

  if (ex._tag === "Call") {
    const [only] = ex.args;
    const short =
      ex.args.length === 0 || (ex.args.length === 1 && only !== undefined && isShortArgument(only));

    return short && isPoorlyBreakableCall(ex.callee);
  }

  return ex._tag === "Ident";
};

type Layout = "break-after-operator" | "fluid" | "never-break-after-operator";

const layoutOf = (value: Ex, shortKey: boolean): Layout => {
  if (value._tag === "Str" || isMemberPath(value)) {
    return shortKey ? "never-break-after-operator" : "break-after-operator";
  }

  const literal =
    (value._tag === "Num" && value.value >= 0) ||
    (value._tag === "Ident" && (value.name === "true" || value.name === "false"));
  if (literal) {
    return "never-break-after-operator";
  }

  return value._tag === "Call" && isPoorlyBreakableCall(value) ? "break-after-operator" : "fluid";
};

// `left operator value` in the formatter's assignment layouts (property values and declarations).
const assignment = (
  left: Doc,
  operator: string,
  value: Ex,
  shortKey: boolean,
  print: PrintEx,
): Doc => {
  const layout = layoutOf(value, shortKey);
  const right = print(value);
  if (layout === "break-after-operator") {
    return group([group(left), operator, group(indent([line, right]))]);
  }

  if (layout === "never-break-after-operator") {
    return group([group(left), operator, " ", right]);
  }

  const id = Symbol("assignment");

  return group([group(left), operator, group(indent(line), { id }), indentIfBreak(right, id)]);
};

const entryDoc = (entry: Entry, print: PrintEx): Doc => {
  const key = keyText(entry.name);

  return assignment(key, ":", entry.value, textWidth(key) < 5, print);
};

const byName = Order.mapInput(Order.String, (entry: Entry) => entry.name);

const objectDoc = (entries: readonly Entry[], print: PrintEx): Doc => {
  if (entries.length === 0) {
    return "{}";
  }

  const docs = Arr.sort(entries, byName).map((entry) => entryDoc(entry, print));

  return group(["{", indent([line, join([",", line], docs)]), ifBreak(","), line, "}"]);
};

const isNumber = (ex: Ex): boolean => ex._tag === "Num";

const entryCount = (ex: Ex): number =>
  Match.valueTags(ex, {
    Arr: (array) => array.elements.length,
    Arrow: () => 0,
    Call: () => 0,
    Ident: () => 0,
    Member: () => 0,
    Num: () => 0,
    Obj: (object) => object.entries.length,
    Str: () => 0,
  });

// Two or more object literals, or two or more array literals, with more than one entry each.
const alwaysBroken = (elements: readonly Ex[]): boolean => {
  const [first] = elements;

  return (
    elements.length > 1 &&
    first !== undefined &&
    (first._tag === "Obj" || first._tag === "Arr") &&
    elements.every((element) => element._tag === first._tag && entryCount(element) > 1)
  );
};

const arrayDoc = (elements: readonly Ex[], print: PrintEx): Doc => {
  if (elements.length === 0) {
    return "[]";
  }

  const docs = elements.map(print);
  if (elements.length > 1 && elements.every(isNumber)) {
    const id = Symbol("array");
    const last = docs.length - 1;
    const parts = join(
      line,
      docs.map((doc, index) => [doc, index === last ? ifBreak(",", "", id) : ","]),
    );

    return group(["[", indent([softline, { _tag: "fill", parts }]), softline, "]"], { id });
  }

  return group(["[", indent([softline, join([",", line], docs)]), ifBreak(","), softline, "]"], {
    brk: alwaysBroken(elements),
  });
};

const arrowDoc = (ex: Extract<Ex, { readonly _tag: "Arrow" }>, print: PrintEx): Doc =>
  group(["(): ", typeDoc(ex.returns), " =>", group(indent([line, print(ex.body)]))]);

// A last argument opens on the call's line when it is a non-empty object or array.
const hugsLast = (args: readonly Ex[]): boolean => {
  const last = args.at(-1);
  const before = args.at(-2);
  if (last === undefined || entryCount(last) === 0) {
    return false;
  }

  if (last._tag !== "Obj" && last._tag !== "Arr") {
    return false;
  }

  if (before?._tag === last._tag) {
    return false;
  }

  return !(args.length > 1 && last._tag === "Arr" && last.elements.every(isNumber));
};

const argumentsDoc = (args: readonly Ex[], print: PrintEx): Doc => {
  if (args.length === 0) {
    return "()";
  }

  const docs = args.map(print);
  const allBroken = group(["(", indent([line, join([",", line], docs)]), ifBreak(","), line, ")"], {
    brk: true,
  });
  if (docs.slice(0, -1).some(willBreak)) {
    return allBroken;
  }

  if (!hugsLast(args)) {
    return group(["(", indent([softline, join([",", line], docs)]), ifBreak(","), softline, ")"]);
  }

  const last = docs.at(-1) ?? "";
  const leading = docs.slice(0, -1).flatMap((doc) => [doc, ", "]);

  return [
    willBreak(last) ? breakParent : "",
    conditionalGroup([
      ["(", ...leading, last, ")"],
      ["(", ...leading, group(last, { brk: true }), ")"],
      allBroken,
    ]),
  ];
};

// A call argument is simple when it is a literal, a path, or a call, object or array of simple
// values with no call below the first level.
const isSimpleArgument = (ex: Ex, depth: number): boolean =>
  Match.valueTags(ex, {
    Arr: (array) => array.elements.every((element) => isSimpleArgument(element, depth + 1)),
    Arrow: () => false,
    Call: (call) =>
      depth === 0 &&
      isSimpleArgument(call.callee, depth) &&
      call.args.every((arg) => isSimpleArgument(arg, depth + 1)),
    Ident: () => true,
    Member: (member) => isSimpleArgument(member.object, depth),
    Num: () => true,
    Obj: (object) => object.entries.every((entry) => isSimpleArgument(entry.value, depth + 1)),
    Str: () => true,
  });

type ChainNode =
  | { readonly _tag: "call"; readonly args: readonly Ex[] }
  | { readonly _tag: "head"; readonly ex: Ex }
  | { readonly _tag: "member"; readonly name: string };

const isMemberish = (ex: Ex): boolean => ex._tag === "Member" || ex._tag === "Call";

// The head, then each `.name` and call, as Prettier's member chain reads them.
const chainNodes = (ex: Ex): readonly ChainNode[] => {
  if (ex._tag === "Call" && isMemberish(ex.callee)) {
    return [...chainNodes(ex.callee), { _tag: "call", args: ex.args }];
  }

  if (ex._tag === "Member") {
    return [...chainNodes(ex.object), { _tag: "member", name: ex.name }];
  }

  return [{ _tag: "head", ex }];
};

const chainNodeDoc = (node: ChainNode, print: PrintEx): Doc =>
  Match.valueTags(node, {
    call: (call) => argumentsDoc(call.args, print),
    head: (head) => print(head.ex),
    member: (member) => `.${member.name}`,
  });

const isFactory = (name: string): boolean => /^[A-Z]|^[$_]+$/u.test(name);

// How many nodes after the head stay in the first group: the calls that follow it, then members
// that only lead to the first call.
const leadingCount = (tail: readonly ChainNode[], headIsCall: boolean): number => {
  const calls = tail.findIndex((node) => node._tag !== "call");
  let count = calls === -1 ? tail.length : calls;
  if (headIsCall) {
    return count;
  }

  while (tail[count]?._tag === "member" && tail[count + 1]?._tag === "member") {
    count += 1;
  }

  return count;
};

// Prettier's member-chain groups: the head with its leading members, then one group per
// `.name(args)`.
const chainGroups = (nodes: readonly ChainNode[]): readonly (readonly ChainNode[])[] => {
  const [head, ...tail] = nodes;
  if (head === undefined) {
    return [];
  }

  const count = leadingCount(tail, head._tag === "head" && head.ex._tag === "Call");
  const groups: ChainNode[][] = [[head, ...tail.slice(0, count)]];
  let seenCall = false;
  let current: ChainNode[] = [];
  for (const node of tail.slice(count)) {
    if (seenCall && node._tag === "member") {
      groups.push(current);
      current = [];
      seenCall = false;
    }

    seenCall ||= node._tag === "call";
    current.push(node);
  }

  return current.length > 0 ? [...groups, current] : groups;
};

// The first call stays on the head's line when the head is a capitalized name, as in `Schema.X`.
const mergesFirstCall = (groups: readonly (readonly ChainNode[])[]): boolean => {
  const [first, second] = groups;
  if (first === undefined || second === undefined) {
    return false;
  }

  const last = first.at(-1);
  if (first.length === 1) {
    return last?._tag === "head" && last.ex._tag === "Ident" && isFactory(last.ex.name);
  }

  return last?._tag === "member" && isFactory(last.name);
};

const callDoc = (ex: Extract<Ex, { readonly _tag: "Call" }>, print: PrintEx): Doc => {
  if (!isMemberish(ex.callee)) {
    return [print(ex.callee), argumentsDoc(ex.args, print)];
  }

  const nodes = chainNodes(ex);
  const groups = chainGroups(nodes);
  const merge = mergesFirstCall(groups);
  const printedGroups = groups.map((chain) => chain.map((node) => chainNodeDoc(node, print)));
  if (groups.length <= (merge ? 3 : 2)) {
    return group(printedGroups);
  }

  const [first = [], ...rest] = printedGroups;
  const expanded: Doc = [
    first,
    merge ? rest.slice(0, 1) : [],
    indent([hardline, join(hardline, rest.slice(merge ? 1 : 0))]),
  ];
  const calls = nodes.filter((node) => node._tag === "call");
  const complex =
    calls.length > 2 && calls.some((node) => !node.args.every((arg) => isSimpleArgument(arg, 0)));
  if (complex || printedGroups.slice(0, -1).some(willBreak)) {
    return group(expanded);
  }

  return [willBreak(printedGroups) ? breakParent : "", conditionalGroup([printedGroups, expanded])];
};

const exDoc: PrintEx = (ex) =>
  Match.valueTags(ex, {
    Arr: (array) => arrayDoc(array.elements, exDoc),
    Arrow: (arrow) => arrowDoc(arrow, exDoc),
    Call: (call) => callDoc(call, exDoc),
    Ident: (ident) => ident.name,
    Member: (member) =>
      isPath(member) ? pathText(member) : [exDoc(member.object), ".", member.name],
    Num: (number) => numberText(number.value),
    Obj: (object) => objectDoc(object.entries, exDoc),
    Str: (string) => stringLiteral(string.value),
  });

// ---------------------------------------------------------------------------------------------
// The module.

interface Definition {
  readonly name: string;
  readonly runtime: Ex;
  readonly type: Ty | undefined;
}

const unprintable = () => new DomainEmitError({ reason: "unprintable-code" });

const definitionOf = (
  name: string,
  code: SchemaRepresentation.Code,
  recursive: boolean,
): Effect.Effect<Definition, DomainEmitError> =>
  Effect.gen(function* parse() {
    const runtime = parseExpression(code.runtime);
    const type = recursive ? parseType(code.Type) : undefined;
    if (runtime === undefined || (recursive && type === undefined)) {
      return yield* unprintable();
    }

    return { name, runtime, type };
  });

// Names a value reads when the module runs; the thunk of `Schema.suspend` runs later.
const dependenciesOf = (ex: Ex, names: ReadonlySet<string>): readonly string[] =>
  Match.valueTags(ex, {
    Arr: (array) => array.elements.flatMap((element) => dependenciesOf(element, names)),
    Arrow: () => [],
    Call: (call) => [call.callee, ...call.args].flatMap((part) => dependenciesOf(part, names)),
    Ident: (ident) => (names.has(ident.name) ? [ident.name] : []),
    Member: (member) => dependenciesOf(member.object, names),
    Num: () => [],
    Obj: (object) => object.entries.flatMap((entry) => dependenciesOf(entry.value, names)),
    Str: () => [],
  });

// Definitions in name order, each after the names it reads; `undefined` on a cycle.
const orderOf = (
  definitions: ReadonlyMap<string, Definition>,
): readonly Definition[] | undefined => {
  const names = new Set(definitions.keys());
  const done = new Set<string>();
  const active = new Set<string>();
  const ordered: Definition[] = [];
  const visit = (name: string): boolean => {
    const definition = definitions.get(name);
    if (definition === undefined || done.has(name)) {
      return true;
    }

    if (active.has(name)) {
      return false;
    }

    active.add(name);

    const reads = Arr.sort(Arr.dedupe(dependenciesOf(definition.runtime, names)), Order.String);
    const acyclic = reads.every((read) => visit(read));
    active.delete(name);
    done.add(name);
    ordered.push(definition);

    return acyclic;
  };

  return Arr.sort([...names], Order.String).every((name) => visit(name)) ? ordered : undefined;
};

const statementsOf = (definition: Definition): readonly string[] => {
  const constant = printDoc([
    assignment(["export const ", definition.name], " =", definition.runtime, false, exDoc),
    ";",
  ]);

  return definition.type === undefined
    ? [constant]
    : [printDoc([typeAliasDoc(definition.name, definition.type), ";"]), constant];
};

const multiDocumentOf = (
  definitions: ReadonlyMap<string, Json>,
): Effect.Effect<JsonSchema.MultiDocument<"draft-2020-12">, DomainEmitError> =>
  Effect.gen(function* collect() {
    const keys = Arr.sort([...definitions.keys()], Order.String);
    const entries: [string, JsonSchema.JsonSchema][] = [];
    for (const key of keys) {
      const node = definitions.get(key);
      if (!Predicate.isObject(node)) {
        return yield* new DomainEmitError({ reason: "unsupported-definition" });
      }

      entries.push([key, node]);
    }

    const [first, ...rest] = keys.map((key) => ({
      $ref: JsonPointer.formatUriFragment(["$defs", key]),
    }));
    if (first === undefined) {
      return yield* new DomainEmitError({ reason: "unsupported-definition" });
    }

    return {
      definitions: Object.fromEntries(entries),
      dialect: "draft-2020-12",
      schemas: [first, ...rest],
    };
  });

const importCode = (
  multi: JsonSchema.MultiDocument<"draft-2020-12">,
): Effect.Effect<SchemaRepresentation.CodeDocument, DomainEmitError> =>
  Effect.try({
    catch: () => new DomainEmitError({ reason: "import-failed" }),
    try: () => {
      const [first, ...rest] = SchemaRepresentation.fromJsonSchemaMultiDocument(multi);

      return SchemaRepresentation.toCodeDocument(
        SchemaRepresentation.toRepresentations([first.ast, ...rest.map((schema) => schema.ast)]),
      );
    },
  });

const modulePath = "src/domain/schemas.ts";

const emptyModule = "export {};\n";

/**
 * Emits `domain/schemas.ts` (design 3.5, 3.6, unit EM-2): the code-generation copy of `roots`
 * (examples and defaults removed, properties sorted) imported through
 * `SchemaRepresentation.fromJsonSchemaMultiDocument` and printed from `toCodeDocument`, one
 * `export const` per definition after the names it reads, and one `export type` before each
 * recursive definition, whose `Schema.suspend` names it.
 */
export const emitDomainSchemas = (
  validation: ReadonlyMap<string, Json>,
  roots: readonly string[],
  limits: SchemaLimits = {},
): Effect.Effect<EmittedFile, DomainEmitError | SchemaBudgetExceeded> =>
  Effect.gen(function* emit() {
    const copy = yield* codeGenerationCopy(validation, roots, limits);
    if (copy.size === 0) {
      return { content: emptyModule, path: modulePath };
    }

    const code = yield* importCode(yield* multiDocumentOf(copy));
    if (code.artifacts.length > 0) {
      return yield* new DomainEmitError({ reason: "unsupported-artifact" });
    }

    const parsed = yield* Effect.all([
      ...code.references.nonRecursives.map((entry) => definitionOf(entry.$ref, entry.code, false)),
      ...Object.entries(code.references.recursives).map(([name, entry]) =>
        definitionOf(name, entry, true),
      ),
    ]);
    const ordered = orderOf(new Map(parsed.map((definition) => [definition.name, definition])));
    if (ordered === undefined) {
      return yield* new DomainEmitError({ reason: "reference-cycle" });
    }

    const statements = ordered.flatMap(statementsOf);

    return {
      content: `import { Schema } from "effect";\n\n${statements.join("\n\n")}\n`,
      path: modulePath,
    };
  });
