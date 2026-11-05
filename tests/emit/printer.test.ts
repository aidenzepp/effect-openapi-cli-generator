import { describe, expect, test } from "bun:test";
import nodePath from "node:path";
import { Effect, Exit, Schema } from "effect";
import hostileSeeds from "../fixtures/seeds/hostile.json" with { type: "json" };
import { JsonLiteral } from "../../src/model/brands.ts";
import {
  asciiStringLiteral,
  guardTemplateCurly,
  JsDocText,
  stringLiteral,
} from "../../src/emit/escape.ts";
import {
  Identifier,
  MemberName,
  ModuleSpecifier,
  Shebang,
  arr,
  arrow,
  bool,
  call,
  conditional,
  ident,
  member,
  newExpr,
  num,
  obj,
  plus,
  printJson,
  printModule,
  printPackageJson,
  regExp,
  str,
  typeKeyword,
  typeReadonlyArray,
  typeLiteral,
  typeRef,
  typeUnion,
  undef,
} from "../../src/emit/printer.ts";
import type { Expr, Module, Param, Statement, TypeExpr } from "../../src/emit/printer.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const vp = nodePath.resolve(root, "node_modules/.bin/vp");

const encoder = new TextEncoder();

const decoder = new TextDecoder();

// `vp fmt --stdin-filepath` runs the same formatter and config as `vp fmt --check`: output equal to
// input is a passing check.
const format = (text: string, extension: "json" | "ts") => {
  const result = Bun.spawnSync([vp, "fmt", `--stdin-filepath=tests/emit/printed.${extension}`], {
    cwd: root,
    stdin: encoder.encode(text),
  });

  return { exitCode: result.exitCode, stdout: decoder.decode(result.stdout) };
};

const expectFixedPoint = (text: string, extension: "json" | "ts") => {
  const first = format(text, extension);
  expect(first.exitCode).toBe(0);
  expect(first.stdout).toBe(text);

  const second = format(first.stdout, extension);
  expect(second.exitCode).toBe(0);
  expect(second.stdout).toBe(first.stdout);
};

const I = Schema.decodeUnknownSync(Identifier);

const M = Schema.decodeUnknownSync(MemberName);

const S = Schema.decodeUnknownSync(ModuleSpecifier);

const doc = Schema.decodeUnknownSync(JsDocText);

const shebang = Schema.decodeUnknownSync(Shebang);

const json = Schema.decodeUnknownSync(JsonLiteral);

// `path("a.b.c")` is the member access `a.b.c`.
const path = (dotted: string): Expr => {
  const [head = "", ...rest] = dotted.split(".");
  let expr = ident(I(head));
  for (const name of rest) {
    expr = member(expr, M(name));
  }

  return expr;
};

const ref = (dotted: string, args: readonly TypeExpr[] = []): TypeExpr => {
  const [head = "", ...rest] = dotted.split(".");

  return typeRef(
    I(head),
    rest.map((name) => M(name)),
    args,
  );
};

const param = (name: string, type?: TypeExpr): Param =>
  type === undefined ? { name: I(name) } : { name: I(name), type };

const fn = (dotted: string, ...args: readonly Expr[]) => call(path(dotted), args);

const pipe = (head: Expr, ...args: readonly Expr[]) => call(member(head, M("pipe")), args);

const constant = (
  name: string,
  value: Expr,
  exported = true,
): Extract<Statement, { readonly _tag: "Const" }> => ({
  _tag: "Const",
  exported,
  name: I(name),
  value,
});

const print = (module: Module): string => Effect.runSync(printModule(module));

const failureOf = (module: Module) => Effect.runSync(Effect.flip(printModule(module)));

const strings = (...values: readonly string[]) => arr(values.map(str));

const usersModule: Module = {
  imports: [
    {
      _tag: "Namespace",
      from: S("../runtime/serialize.ts"),
      name: I("Serialize"),
      typeOnly: false,
    },
    {
      _tag: "Named",
      from: S("../runtime/negotiate.ts"),
      names: [I("MediaDeclaration")],
      typeOnly: true,
    },
    {
      _tag: "Named",
      from: S("../runtime/auth.ts"),
      names: [I("SecurityRequirement")],
      typeOnly: true,
    },
  ],
  statements: [
    {
      _tag: "Interface",
      fields: [
        {
          key: "notify",
          optional: true,
          type: typeUnion([typeKeyword("boolean"), typeKeyword("undefined")]),
        },
        { key: "id", optional: false, type: typeKeyword("string") },
        { key: "body", optional: false, type: ref("Serialize.Body") },
        {
          key: "ifMatch",
          optional: true,
          type: typeUnion([typeKeyword("string"), typeKeyword("undefined")]),
        },
      ],
      name: I("UpdateInput"),
    },
    {
      _tag: "Const",
      doc: doc("Request builder for users update, not an HttpApi definition."),
      exported: true,
      name: I("update"),
      value: arrow(
        [param("input", ref("UpdateInput"))],
        fn(
          "Serialize.request",
          str("PATCH"),
          obj([
            [
              "path",
              fn(
                "Serialize.path",
                str("/users/{id}"),
                arr([
                  fn(
                    "Serialize.simple",
                    str("id"),
                    path("input.id"),
                    obj([
                      ["explode", bool(false)],
                      ["allowReserved", bool(false)],
                    ]),
                  ),
                ]),
              ),
            ],
            ["body", fn("Serialize.body", str("application/json"), path("input.body"))],
            [
              "headers",
              arr([
                fn(
                  "Serialize.header",
                  str("If-Match"),
                  path("input.ifMatch"),
                  obj([
                    ["required", bool(false)],
                    ["explode", bool(false)],
                  ]),
                ),
              ]),
            ],
            [
              "query",
              arr([
                fn(
                  "Serialize.form",
                  str("notify"),
                  path("input.notify"),
                  obj([
                    ["required", bool(false)],
                    ["explode", bool(true)],
                    ["allowReserved", bool(false)],
                  ]),
                ),
              ]),
            ],
          ]),
        ),
        ref("Serialize.Request"),
      ),
    },
    {
      _tag: "Const",
      exported: false,
      name: I("updateMedia"),
      type: ref("MediaDeclaration"),
      value: obj([
        [
          "responses",
          obj([
            ["default", strings("application/json")],
            ["404", arr([])],
            ["200", strings("application/json")],
          ]),
        ],
        ["request", strings("application/json")],
      ]),
    },
    {
      _tag: "Const",
      exported: false,
      name: I("updateSecurity"),
      type: ref("SecurityRequirement"),
      value: arr([strings("bearerAuth")]),
    },
    constant(
      "updateMeta",
      obj([
        ["security", path("updateSecurity")],
        ["pathTemplate", str("/users/{id}")],
        [
          "origin",
          obj([
            ["pointer", str("/paths/~1users~1{id}/patch")],
            ["document", str("openapi.json")],
          ]),
        ],
        ["operationId", str("users-update")],
        ["method", str("PATCH")],
        ["media", path("updateMedia")],
      ]),
    ),
  ],
};

const usersExpected = `import type { SecurityRequirement } from "../runtime/auth.ts";
import type { MediaDeclaration } from "../runtime/negotiate.ts";
import * as Serialize from "../runtime/serialize.ts";

export interface UpdateInput {
  readonly body: Serialize.Body;
  readonly id: string;
  readonly ifMatch?: string | undefined;
  readonly notify?: boolean | undefined;
}

/**
 * Request builder for users update, not an HttpApi definition.
 */
export const update = (input: UpdateInput): Serialize.Request =>
  Serialize.request("PATCH", {
    body: Serialize.body("application/json", input.body),
    headers: [Serialize.header("If-Match", input.ifMatch, { explode: false, required: false })],
    path: Serialize.path("/users/{id}", [
      Serialize.simple("id", input.id, { allowReserved: false, explode: false }),
    ]),
    query: [
      Serialize.form("notify", input.notify, {
        allowReserved: false,
        explode: true,
        required: false,
      }),
    ],
  });

const updateMedia: MediaDeclaration = {
  request: ["application/json"],
  responses: { "200": ["application/json"], "404": [], default: ["application/json"] },
};

const updateSecurity: SecurityRequirement = [["bearerAuth"]];

export const updateMeta = {
  media: updateMedia,
  method: "PATCH",
  operationId: "users-update",
  origin: { document: "openapi.json", pointer: "/paths/~1users~1{id}/patch" },
  pathTemplate: "/users/{id}",
  security: updateSecurity,
};
`;

const binding = (location: string, pointer: string, wireName: string) =>
  obj([
    ["location", str(location)],
    ["pointer", str(pointer)],
    ["wireName", str(wireName)],
  ]);

const commandModule: Module = {
  imports: [
    {
      _tag: "Named",
      from: S("effect/cli"),
      names: [I("Flag"), I("Command"), I("Argument")],
      typeOnly: false,
    },
    { _tag: "Namespace", from: S("../api/users.ts"), name: I("Users"), typeOnly: false },
    { _tag: "Named", from: S("effect"), names: [I("Option"), I("Effect")], typeOnly: false },
    { _tag: "Namespace", from: S("../runtime/input.ts"), name: I("Input"), typeOnly: false },
  ],
  statements: [
    constant(
      "update",
      pipe(
        fn(
          "Command.make",
          str("update"),
          obj([
            [
              "notify",
              pipe(
                fn("Flag.Boolean", str("notify")),
                path("Flag.optional"),
                fn("Flag.withDescription", str("Send a notification email.")),
              ),
            ],
            [
              "id",
              pipe(
                fn("Argument.String", str("id")),
                fn("Argument.withDescription", str("User id.")),
              ),
            ],
            ["ifMatch", pipe(fn("Flag.String", str("if-match")), path("Flag.optional"))],
            ["body", path("Input.bodyFlag")],
          ]),
          arrow(
            [param("flags")],
            pipe(
              fn(
                "Input.mergeBody",
                obj([
                  ["body", path("flags.body")],
                  ["required", bool(true)],
                  [
                    "fields",
                    obj([
                      ["/name", path("flags.name")],
                      ["/address/city", path("flags.addressCity")],
                    ]),
                  ],
                ]),
              ),
              fn(
                "Effect.flatMap",
                arrow(
                  [param("merged")],
                  fn(
                    "Users.update",
                    obj([
                      ["notify", fn("Option.getOrUndefined", path("flags.notify"))],
                      ["ifMatch", fn("Option.getOrUndefined", path("flags.ifMatch"))],
                      ["id", path("flags.id")],
                      ["body", path("merged")],
                    ]),
                  ),
                ),
              ),
              fn("Effect.flatMap", fn("Output.send", path("Users.updateMeta"))),
            ),
          ),
        ),
        fn("Command.withDescription", str("Update a user.")),
        fn(
          "Command.annotate",
          path("Describe.Binding"),
          obj([
            ["operation", path("Users.updateMeta")],
            [
              "parameters",
              obj([
                ["id", binding("path", "/paths/~1users~1{id}/patch/parameters/0", "id")],
                [
                  "if-match",
                  binding("header", "/paths/~1users~1{id}/patch/parameters/2", "If-Match"),
                ],
              ]),
            ],
          ]),
        ),
        fn(
          "Command.annotate",
          path("Output.Help"),
          obj([
            [
              "sections",
              arr([
                strings(
                  "REQUEST",
                  "PATCH /users/{id}, body application/json (required), operationId users-update",
                ),
                strings(
                  "AUTH",
                  "bearerAuth (http bearer): --bearer-auth-file <path|->, env EXAMPLE_BEARER_AUTH",
                ),
                strings(
                  "RESPONSES",
                  "200 application/json; 404; default application/json. Non-2xx exits 1 (401/403 exit 3)",
                ),
              ]),
            ],
          ]),
        ),
      ),
    ),
    constant(
      "group",
      pipe(fn("Command.make", str("users")), fn("Command.withSubcommands", arr([path("update")]))),
    ),
  ],
};

const commandExpected = `import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as Users from "../api/users.ts";
import * as Input from "../runtime/input.ts";

export const update = Command.make(
  "update",
  {
    body: Input.bodyFlag,
    id: Argument.String("id").pipe(Argument.withDescription("User id.")),
    ifMatch: Flag.String("if-match").pipe(Flag.optional),
    notify: Flag.Boolean("notify").pipe(
      Flag.optional,
      Flag.withDescription("Send a notification email."),
    ),
  },
  (flags) =>
    Input.mergeBody({
      body: flags.body,
      fields: { "/address/city": flags.addressCity, "/name": flags.name },
      required: true,
    }).pipe(
      Effect.flatMap((merged) =>
        Users.update({
          body: merged,
          id: flags.id,
          ifMatch: Option.getOrUndefined(flags.ifMatch),
          notify: Option.getOrUndefined(flags.notify),
        }),
      ),
      Effect.flatMap(Output.send(Users.updateMeta)),
    ),
).pipe(
  Command.withDescription("Update a user."),
  Command.annotate(Describe.Binding, {
    operation: Users.updateMeta,
    parameters: {
      id: { location: "path", pointer: "/paths/~1users~1{id}/patch/parameters/0", wireName: "id" },
      "if-match": {
        location: "header",
        pointer: "/paths/~1users~1{id}/patch/parameters/2",
        wireName: "If-Match",
      },
    },
  }),
  Command.annotate(Output.Help, {
    sections: [
      ["REQUEST", "PATCH /users/{id}, body application/json (required), operationId users-update"],
      ["AUTH", "bearerAuth (http bearer): --bearer-auth-file <path|->, env EXAMPLE_BEARER_AUTH"],
      [
        "RESPONSES",
        "200 application/json; 404; default application/json. Non-2xx exits 1 (401/403 exit 3)",
      ],
    ],
  }),
);

export const group = Command.make("users").pipe(Command.withSubcommands([update]));
`;

const range = (from: number, to: number): readonly number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

const units = ["a", "\u00E9", "\u4E2D", "\u{1F600}", "e\u0301", "\uFF21"] as const;

// Statements whose lines straddle column 100, so every flat-or-broken decision is exercised on
// both sides of the limit.
const sweepModule: Module = {
  imports: [
    {
      _tag: "Named",
      from: S("./a-module-with-a-long-name.ts"),
      names: [
        "Alpha",
        "Bravo",
        "Charlie",
        "Delta",
        "Echo",
        "Foxtrot",
        "Golf",
        "Hotel",
        "India",
      ].map((name) => I(name)),
      typeOnly: false,
    },
    {
      _tag: "Named",
      from: S("./a-module-with-a-long-name.ts"),
      names: [I("Kilo")],
      typeOnly: true,
    },
  ],
  statements: [
    ...units.flatMap((unit, u) =>
      range(70, 92).map((n) =>
        constant(
          `call${u}x${n}`,
          fn("f", str(`${"a".repeat(n - 4)}${unit.repeat(2)}`), path("bb")),
        ),
      ),
    ),
    ...range(2, 7).flatMap((k) =>
      range(86, 96).map((n) =>
        constant(
          `prop${k}x${n}`,
          obj([
            ["k".repeat(k), str("v".repeat(n - k))],
            ["a-b", path("x")],
          ]),
        ),
      ),
    ),
    ...range(80, 100).map((n) => constant(`ident${n}`, path(`z${"z".repeat(n - 20)}`))),
    ...range(80, 100).map((n) => constant(`string${n}`, str("s".repeat(n - 20)))),
    constant("numbers", arr(range(1, 70).map((n) => num(n * 37 - 1000)))),
    constant("decimals", arr([num(0.5), num(1e21), num(-0.25), num(1e-7)])),
    constant("pairs", arr([strings("a", "b"), strings("c", "d")])),
    constant("single", arr([strings("bearerAuth")])),
    constant("singles", arr([strings("a"), strings("b")])),
    constant(
      "objects",
      arr([
        obj([
          ["a", num(1)],
          ["b", num(2)],
        ]),
        obj([
          ["c", num(3)],
          ["d", num(4)],
        ]),
      ]),
    ),
    constant(
      "hugArray",
      fn(
        "Serialize.path",
        str("/users/{id}/avatars/{avatarId}/variants"),
        arr([path("first"), path("secondItem")]),
      ),
    ),
    constant(
      "hugArrow",
      fn(
        "Effect.flatMap",
        arrow(
          [param("selected")],
          fn(
            "Users.setAvatar",
            obj([
              ["body", path("selected.body")],
              ["contentType", path("selected.contentType")],
              ["id", path("flags.id")],
            ]),
          ),
        ),
      ),
    ),
    constant(
      "arrowObject",
      arrow(
        [param("value")],
        obj([
          ["alpha", path("value.alpha")],
          ["bravo", path("value.bravo")],
          ["charlie", path("value.charlie")],
        ]),
      ),
    ),
    constant(
      "hugArrowObject",
      fn(
        "Effect.map",
        arrow(
          [param("value")],
          obj([
            ["alpha", path("value.alpha")],
            ["bravo", path("value.bravo")],
            ["charlie", path("value.charlie")],
          ]),
        ),
      ),
    ),
    ...range(66, 74).map((n) =>
      constant(`arrowHug${n}`, fn("f", arrow([param("x".repeat(n))], obj([["alpha", num(1)]])))),
    ),
    constant("arrowString", fn("Effect.map", arrow([param("value")], str("s".repeat(80))))),
    constant("plusFlat", fn("f", plus(str("a"), str("b")))),
    constant("plusBroken", fn("f", str("a".repeat(70)), plus(str("b".repeat(90)), path("suffix")))),
    constant("pattern", regExp("^(?:[a-z0-9]+(?:-[a-z0-9]+)*)$")),
    constant("longPattern", regExp(`^${"(?:[a-z0-9]+)".repeat(8)}$`)),
    constant("curried", call(fn("HttpClientRequest.make", str("PATCH")), [path("url")])),
    constant("noArgs", fn("Effect.void")),
    constant(
      "flags",
      obj([
        ["undefinedValue", undef],
        ["negative", num(-1)],
        ["positive", num(2)],
      ]),
    ),
    { _tag: "Const", asConst: true, exported: true, name: I("asConst"), value: strings("x", "y") },
    {
      _tag: "Const",
      asConst: true,
      exported: true,
      name: I("k".repeat(80)),
      value: num(1_234_567),
    },
    {
      _tag: "Interface",
      fields: [
        { key: "a-b", optional: false, type: typeLiteral("x") },
        { key: "__proto__", optional: true, type: typeLiteral(1) },
        { key: "A", optional: false, type: ref("ReadonlyArray", [typeKeyword("string")]) },
        { key: "constructor", optional: false, type: typeLiteral(true) },
      ],
      name: I("Keys"),
    },
    { _tag: "Interface", fields: [], name: I("Empty") },
    {
      _tag: "TypeAlias",
      doc: doc("A media type name."),
      name: I("Media"),
      type: typeUnion([typeLiteral("application/json"), typeLiteral("image/png")]),
    },
  ],
};

const hostile = [
  "*/ closes a comment",
  "@param line-leading at",
  "\n@internal after a newline",
  "lone \uD800 high and \uDC00 low",
  "line\u2028separator\u2029paragraph",
  "bidi \u202E reversed \u2066 isolate \u061C mark",
  "zero\u200Bwidth\uFEFFbom",
  "controls \u0000\u0007\u001B\u007F\u0085",
  "quote \" and ' and \\ backslash",
  "more \"double\" than 'single'",
  ["$", "{template} `backtick`"].join(""),
  "caf\u00E9 \u4E2D\u6587 \u{1F600}",
];

const hostileModule: Module = {
  imports: [],
  statements: [
    ...hostile.map((value, index) => constant(`value${index}`, str(value))),
    constant("keys", obj(hostile.map((value) => [value, num(1)] as const))),
    constant("pattern", regExp("[\\u2028]*/")),
  ],
};

// Evaluates a printed string literal: double-quoted output is JSON; single-quoted output differs
// only in its quote escaping.
const literalValue = (literal: string): string => {
  if (literal.startsWith('"')) {
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String))(literal);
  }

  const inner = literal.slice(1, -1).replaceAll("\\'", "'").replaceAll('"', '\\"');

  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String))(`"${inner}"`);
};

const typeAlias = (type: TypeExpr): Module => ({
  imports: [],
  statements: [{ _tag: "TypeAlias", name: I("Value"), type }],
});

describe("readonly array types", () => {
  test("prints readonly T[] and parenthesizes a union element", () => {
    expect(print(typeAlias(typeReadonlyArray(typeKeyword("string"))))).toContain(
      "type Value = readonly string[];",
    );
    expect(
      print(
        typeAlias(typeReadonlyArray(typeUnion([typeKeyword("string"), typeKeyword("number")]))),
      ),
    ).toContain("type Value = readonly (string | number)[];");
  });
});

describe("printModule", () => {
  test("prints the golden request module byte for byte", () => {
    expect(print(usersModule)).toBe(usersExpected);
  });

  test("prints the golden command shape byte for byte", () => {
    expect(print(commandModule)).toBe(commandExpected);
  });

  test("printed modules are vp fmt fixed points", () => {
    expectFixedPoint(print(usersModule), "ts");
    expectFixedPoint(print(commandModule), "ts");
  }, 30_000);

  test("the column 100 sweep is a vp fmt fixed point", () => {
    expectFixedPoint(print(sweepModule), "ts");
  }, 30_000);

  test("object keys sort by code unit, print bare when identifier-shaped, and guard __proto__", () => {
    const keys = ["a1", "a-b", "a", "_b", "__proto__", "A", "9", "10", "404", "200", "default"];
    const printed = print({
      imports: [],
      statements: [constant("keys", obj(keys.map((key) => [key, num(0)] as const)))],
    });
    expect(printed).toBe(
      'export const keys = {\n  "10": 0,\n  "200": 0,\n  "404": 0,\n  "9": 0,\n  A: 0,\n  ["__proto__"]: 0,\n  _b: 0,\n  a: 0,\n  "a-b": 0,\n  a1: 0,\n  default: 0,\n};\n',
    );
    expectFixedPoint(printed, "ts");
  }, 30_000);

  test("printing is deterministic", () => {
    expect(print(sweepModule)).toBe(print(sweepModule));
  });
});

const u = (hex: string): string => `${String.fromCodePoint(92)}u${hex}`;

describe("hostile strings", () => {
  const printed = print(hostileModule);

  test("stay inside literals that vp fmt keeps byte for byte", () => {
    expectFixedPoint(printed, "ts");
  }, 30_000);

  test("round-trip through the printed literal", () => {
    const literals = printed
      .split("\n")
      .filter((line) => line.startsWith("export const value"))
      .map((line) => line.slice(line.indexOf("= ") + 2, -1));
    expect(literals.map(literalValue)).toEqual(hostile);
  });

  test("leave no raw control, format, separator or lone surrogate code point", () => {
    expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(printed.replaceAll("\n", ""))).toBe(false);
    expect(printed).toContain("\\u2028");
    expect(printed).toContain("\\uD800");
    expect(printed).toContain("caf\u00E9 \u4E2D\u6587 \u{1F600}");
  });

  test("escape hex digits in upper case", () => {
    expect(stringLiteral(`${String.fromCodePoint(0x7f)}${String.fromCodePoint(0xd8_00)}`)).toBe(
      `"${u("007F")}${u("D800")}"`,
    );
    expect(stringLiteral(`${String.fromCodePoint(128_512)}${String.fromCodePoint(8203)}`)).toBe(
      `"${String.fromCodePoint(128_512)}${u("200B")}"`,
    );
    expect(asciiStringLiteral(String.fromCodePoint(128_512))).toBe(`"${u("D83D")}${u("DE00")}"`);
  });

  test("fence a statement that holds a template placeholder literal in a disable range", () => {
    const placeholder = ["a$", "{b}c"].join("");
    const guarded = print({
      imports: [],
      statements: [
        constant("plain", str("ok")),
        constant("holder", fn("f", str("x"), str(placeholder))),
      ],
    });
    expect(guarded).toBe(
      [
        'export const plain = "ok";',
        "",
        "/* oxlint-disable no-template-curly-in-string -- a spec string holds a template placeholder */",
        `export const holder = f("x", ${stringLiteral(placeholder)});`,
        "/* oxlint-enable no-template-curly-in-string */",
        "",
      ].join("\n"),
    );
    expectFixedPoint(guarded, "ts");
  }, 30_000);

  test("never reach JSDoc", () => {
    const rejected = [
      "Ends a comment */ early",
      "Has a tag\n@param x",
      "Has an @param tag",
      "Lone \uD800 surrogate",
      "lowercase start",
      "Double  space",
      "List - item",
      "Number 1. item",
      "Caf\u00E9 text",
      "Bidi \u202E text",
      "Has *emphasis*",
      "",
    ];
    expect(
      rejected.map((text) => Exit.isFailure(Schema.decodeUnknownExit(JsDocText)(text))),
    ).toEqual(rejected.map(() => true));
  });

  test("long JSDoc text fills to column 100", () => {
    const words = range(1, 40)
      .map(() => "Request builder words")
      .join(" ");
    const filled = print({
      imports: [],
      statements: [{ ...constant("documented", num(1)), doc: doc(`A ${words}.`) }],
    });
    expect(filled.split("\n").every((line) => line.length <= 100)).toBe(true);
    expectFixedPoint(filled, "ts");
  }, 30_000);
});

// `export const w = f("` is 20 columns and `", bb);` is 7, so the literal's text has 73 columns.
const line = (text: string) =>
  print({ imports: [], statements: [constant("w", fn("f", str(text), path("bb")))] });

describe("display width", () => {
  test("CJK and emoji count two columns, as vp fmt counts them", () => {
    // 68 UTF-16 code units, 74 columns: past column 100 only when wide characters count two.
    const wide = `${"a".repeat(58)}${"\u4E2D".repeat(6)}\u{1F600}\u{1F600}`;
    expect(wide.length + 27).toBeLessThanOrEqual(100);
    expect(line(wide)).toBe(`export const w = f(\n  ${stringLiteral(wide)},\n  bb,\n);\n`);
    expectFixedPoint(line(wide), "ts");
  }, 30_000);

  test("combining marks count zero columns", () => {
    // 75 UTF-16 code units, 72 columns: within column 100 only when combining marks count zero.
    const combining = `${"a".repeat(69)}${"e\u0301".repeat(3)}`;
    expect(combining.length + 27).toBeGreaterThan(100);
    expect(line(combining)).toBe(`export const w = f(${stringLiteral(combining)}, bb);\n`);
    expectFixedPoint(line(combining), "ts");
  }, 30_000);
});

const HostileCase = Schema.Struct({
  expected: Schema.Struct({
    kind: Schema.Literals(["object-key", "string-literal"]),
    source: Schema.String,
  }),
  id: Schema.String,
  input: Schema.Union([Schema.String, Schema.Struct({ codeUnits: Schema.Array(Schema.Number) })]),
});

const hostileCases = Schema.decodeUnknownSync(Schema.Struct({ cases: Schema.Array(HostileCase) }))(
  hostileSeeds,
).cases;

const seedText = (input: (typeof HostileCase.Type)["input"]): string =>
  Schema.is(Schema.String)(input) ? input : String.fromCodePoint(...input.codeUnits);

const byKind = (kind: string) =>
  hostileCases.filter((seed) => seed.expected.kind === kind).map((seed) => seedText(seed.input));

describe("hostile seeds", () => {
  test("string-literal seeds print as round-tripping literals vp fmt keeps", () => {
    const values = byKind("string-literal");
    const printed = print({
      imports: [],
      statements: values.map((value, index) => constant(`seed${index}`, str(value))),
    });
    const literals = printed
      .split("\n")
      .filter((text) => text.startsWith("export const seed"))
      .map((text) => text.slice(text.indexOf("= ") + 2, -1));
    expect(literals.map(literalValue)).toEqual(values);
    expect(literals.some((literal) => literal.startsWith("`"))).toBe(false);
    expectFixedPoint(printed, "ts");
  }, 30_000);

  test("JSDoc text rejects hostile seed input", () => {
    const unsafe = hostileCases
      .map((seed) => seedText(seed.input))
      .filter((text) => /[\p{Cc}\p{Zl}\p{Zp}]|\*\/|^\s*@/mu.test(text));
    expect(unsafe.length).toBeGreaterThan(0);
    expect(unsafe.every((text) => Exit.isFailure(Schema.decodeUnknownExit(JsDocText)(text)))).toBe(
      true,
    );
  });

  test("every hostile case prints exactly its expected source", () => {
    expect(hostileCases.length).toBeGreaterThan(0);
    for (const seed of hostileCases) {
      const text = seedText(seed.input);
      const printed =
        seed.expected.kind === "string-literal"
          ? print({ imports: [], statements: [constant("x", str(text))] })
          : print({ imports: [], statements: [constant("x", obj([[text, num(1)]]))] });
      const expected =
        seed.expected.kind === "string-literal"
          ? `${guardTemplateCurly(`export const x = ${seed.expected.source};`)}\n`
          : `export const x = { ${seed.expected.source}: 1 };\n`;
      expect({ id: seed.id, printed }).toEqual({ id: seed.id, printed: expected });
    }
  });

  test("object-key seeds print as own-property keys", () => {
    const keys = byKind("object-key");
    const printed = print({
      imports: [],
      statements: [constant("keys", obj(keys.map((key) => [key, num(1)] as const)))],
    });
    expect(printed).toBe(
      'export const keys = { ["__proto__"]: 1, constructor: 1, prototype: 1 };\n',
    );
    expectFixedPoint(printed, "ts");
  }, 30_000);
});

const a = (n: number) => str("a".repeat(n));

const b = (n: number) => str("b".repeat(n));

const statement = (value: Expr): Statement => ({ _tag: "Expression", value });

const entryModule: Module = {
  imports: [
    { _tag: "Named", from: S("@effect/platform-bun"), names: [I("BunRuntime")], typeOnly: false },
    { _tag: "Named", from: S("./program.ts"), names: [I("program")], typeOnly: false },
  ],
  shebang: shebang("/usr/bin/env bun"),
  statements: [
    statement(fn("BunRuntime.runMain", path("program"))),
    statement(
      fn(
        "BunRuntime.runMain",
        pipe(
          path("program"),
          fn(
            "Effect.provide",
            fn(
              "Layer.mergeAll",
              path("MainLayerOne"),
              path("MainLayerTwo"),
              path("MainLayerThree"),
            ),
          ),
        ),
      ),
    ),
    statement(
      fn(
        "BunRuntime.runMain",
        obj([
          ["disableErrorReporting", bool(true)],
          ["a".repeat(46), num(1)],
          ["b", num(2)],
        ]),
      ),
    ),
  ],
};

const entryExpected = `#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { program } from "./program.ts";

BunRuntime.runMain(program);

BunRuntime.runMain(
  program.pipe(Effect.provide(Layer.mergeAll(MainLayerOne, MainLayerTwo, MainLayerThree))),
);

BunRuntime.runMain({
  ${"a".repeat(46)}: 1,
  b: 2,
  disableErrorReporting: true,
});
`;

const conditionalModule: Module = {
  imports: [],
  statements: [
    constant("shortCond", conditional(path("flag"), str("yes"), str("no"))),
    constant("longCond", conditional(path("someCondition"), a(38), b(43))),
    constant(
      "longCallCond",
      conditional(path("someCondition"), fn("Effect.succeed", a(83)), fn("Effect.fail", str("b"))),
    ),
    constant("argCond", fn("f", conditional(path("someCondition"), a(38), b(43)))),
    constant("argCond2", fn("f", path("x"), conditional(path("someCondition"), a(91), b(43)))),
    constant(
      "propCond",
      obj([
        ["a", conditional(path("someCondition"), a(38), b(43))],
        ["longerKey", conditional(path(`c${"x".repeat(80)}`), str("a"), str("b"))],
      ]),
    ),
    constant("longTest", conditional(path(`c${"x".repeat(79)}`), str("a"), str("b"))),
    constant(
      "memberTest",
      conditional(
        path("process.env.NO_COLOR"),
        fn("Effect.succeed", a(24)),
        fn("Effect.fail", b(43)),
      ),
    ),
    constant(
      "callAsTest",
      conditional(fn("Option.isSome", path(`v${"x".repeat(55)}`)), a(5), b(10)),
    ),
    constant(
      "objBranch",
      conditional(
        path("cond"),
        obj([
          ["a".repeat(29), num(1)],
          ["b".repeat(34), num(2)],
          ["c".repeat(18), num(3)],
        ]),
        obj([]),
      ),
    ),
    constant(
      "arrBranch",
      conditional(path("cond"), arr([a(29), b(34), str("c".repeat(18))]), arr([])),
    ),
  ],
};

const conditionalExpected = `export const shortCond = flag ? "yes" : "no";

export const longCond = someCondition
  ? "${"a".repeat(38)}"
  : "${"b".repeat(43)}";

export const longCallCond = someCondition
  ? Effect.succeed(
      "${"a".repeat(83)}",
    )
  : Effect.fail("b");

export const argCond = f(
  someCondition
    ? "${"a".repeat(38)}"
    : "${"b".repeat(43)}",
);

export const argCond2 = f(
  x,
  someCondition
    ? "${"a".repeat(91)}"
    : "${"b".repeat(43)}",
);

export const propCond = {
  a: someCondition
    ? "${"a".repeat(38)}"
    : "${"b".repeat(43)}",
  longerKey: c${"x".repeat(80)}
    ? "a"
    : "b",
};

export const longTest =
  c${"x".repeat(79)} ? "a" : "b";

export const memberTest = process.env.NO_COLOR
  ? Effect.succeed("${"a".repeat(24)}")
  : Effect.fail("${"b".repeat(43)}");

export const callAsTest = Option.isSome(v${"x".repeat(55)})
  ? "aaaaa"
  : "bbbbbbbbbb";

export const objBranch = cond
  ? {
      ${"a".repeat(29)}: 1,
      ${"b".repeat(34)}: 2,
      ${"c".repeat(18)}: 3,
    }
  : {};

export const arrBranch = cond
  ? ["${"a".repeat(29)}", "${"b".repeat(34)}", "${"c".repeat(18)}"]
  : [];
`;

const newModule: Module = {
  imports: [],
  statements: [
    constant(
      "s",
      newExpr(path("Set"), [arr([a(16), b(23), str("c".repeat(22)), str("d".repeat(22))])]),
    ),
    constant("t", newExpr(path("Set"), [strings("a", "b")])),
    constant("u", newExpr(path("Map"), [])),
    constant("v", newExpr(path("Foo.Bar"), [path("a"), path("b")])),
    constant("newArgs", newExpr(path("Foo"), [a(53), b(39)])),
    constant(
      "nested",
      newExpr(path("Set"), [arr([newExpr(path("Foo"), [a(53)]), newExpr(path("Foo"), [b(39)])])]),
    ),
    constant("pattern", regExp("^[a-z]+$")),
  ],
};

const newExpected = `export const s = new Set([
  "${"a".repeat(16)}",
  "${"b".repeat(23)}",
  "${"c".repeat(22)}",
  "${"d".repeat(22)}",
]);

export const t = new Set(["a", "b"]);

export const u = new Map();

export const v = new Foo.Bar(a, b);

export const newArgs = new Foo(
  "${"a".repeat(53)}",
  "${"b".repeat(39)}",
);

export const nested = new Set([
  new Foo("${"a".repeat(53)}"),
  new Foo("${"b".repeat(39)}"),
]);

export const pattern = new RegExp("^[a-z]+$", "u");
`;

// The Resend witness shape (D1): request builders whose `(input: XInput): Serialize.Request =>`
// head runs past column 100 break their parameter list.
const request = (method: string, ...parts: readonly (readonly [string, Expr])[]) =>
  fn("request", str(method), obj(parts));

const simple = (wire: string, value: string) =>
  fn(
    "simple",
    str(wire),
    path(value),
    obj([
      ["allowReserved", bool(false)],
      ["explode", bool(false)],
    ]),
  );

const builder = (name: string, params: readonly Param[], body: Expr) =>
  constant(name, arrow(params, body, ref("Serialize.Request")));

const arrowModule: Module = {
  imports: [],
  statements: [
    builder(
      "emailsListReceivingAttachments",
      [param("input", ref("EmailsListReceivingAttachmentsInput"))],
      request(
        "GET",
        ["headers", arr([])],
        [
          "path",
          fn(
            "path",
            str("/emails/receiving/{email_id}/attachments"),
            arr([simple("email_id", "input.emailId")]),
          ),
        ],
        ["query", arr([])],
      ),
    ),
    builder(
      "emailsGetReceivingAttachment",
      [param("input", ref("EmailsGetReceivingAttachmentInput"))],
      request(
        "GET",
        ["headers", arr([])],
        [
          "path",
          fn(
            "path",
            str("/emails/receiving/{email_id}/attachments/{id}"),
            arr([simple("email_id", "input.emailId"), simple("id", "input.id")]),
          ),
        ],
        ["query", arr([])],
      ),
    ),
    builder(`x${"a".repeat(51)}`, [param("input", ref("T"))], fn("f", path("input"))),
    builder(`y${"a".repeat(52)}`, [param("input", ref("T"))], fn("f", path("input"))),
    builder(
      `p${"a".repeat(48)}`,
      [param("input", ref("T"))],
      obj([
        ["a", num(1)],
        ["b".repeat(75), num(2)],
      ]),
    ),
    builder(
      `q${"a".repeat(49)}`,
      [param("input", ref("T"))],
      obj([
        ["a", num(1)],
        ["b".repeat(75), num(2)],
      ]),
    ),
    builder(`s${"a".repeat(50)}`, [param("input", ref("T"))], arr([num(1), b(89)])),
    builder(
      "twoParams",
      [param("input", ref("A".repeat(38))), param("other", ref("B".repeat(29)))],
      fn("f", path("input")),
    ),
    constant(
      "argArrow",
      fn(
        "Effect.map",
        path("someValue"),
        arrow(
          [param("input", ref("A".repeat(70)))],
          fn("f", path("input")),
          ref("Serialize.Request"),
        ),
      ),
    ),
  ],
};

const arrowExpected = `export const emailsListReceivingAttachments = (
  input: EmailsListReceivingAttachmentsInput,
): Serialize.Request =>
  request("GET", {
    headers: [],
    path: path("/emails/receiving/{email_id}/attachments", [
      simple("email_id", input.emailId, { allowReserved: false, explode: false }),
    ]),
    query: [],
  });

export const emailsGetReceivingAttachment = (
  input: EmailsGetReceivingAttachmentInput,
): Serialize.Request =>
  request("GET", {
    headers: [],
    path: path("/emails/receiving/{email_id}/attachments/{id}", [
      simple("email_id", input.emailId, { allowReserved: false, explode: false }),
      simple("id", input.id, { allowReserved: false, explode: false }),
    ]),
    query: [],
  });

export const x${"a".repeat(51)} = (input: T): Serialize.Request =>
  f(input);

export const y${"a".repeat(52)} = (
  input: T,
): Serialize.Request => f(input);

export const p${"a".repeat(48)} = (input: T): Serialize.Request => ({
  a: 1,
  ${"b".repeat(75)}: 2,
});

export const q${"a".repeat(49)} = (
  input: T,
): Serialize.Request => ({
  a: 1,
  ${"b".repeat(75)}: 2,
});

export const s${"a".repeat(50)} = (
  input: T,
): Serialize.Request => [
  1,
  "${"b".repeat(89)}",
];

export const twoParams = (
  input: ${"A".repeat(38)},
  other: ${"B".repeat(29)},
): Serialize.Request => f(input);

export const argArrow = Effect.map(
  someValue,
  (
    input: ${"A".repeat(70)},
  ): Serialize.Request => f(input),
);
`;

describe("entry-module constructs", () => {
  test("arrow parameters break when the head runs past column 100", () => {
    const printed = print(arrowModule);
    expect(printed).toBe(arrowExpected);
    expectFixedPoint(printed, "ts");
  }, 30_000);

  test("a shebang line and top-level call statements print in the vp fmt layout", () => {
    const printed = print(entryModule);
    expect(printed).toBe(entryExpected);
    expectFixedPoint(printed, "ts");
  }, 30_000);

  test("a module with only a shebang ends with one newline", () => {
    expect(print({ imports: [], shebang: shebang("/usr/bin/env bun"), statements: [] })).toBe(
      "#!/usr/bin/env bun\n",
    );
  });

  test("conditionals print flat, broken past column 100, and moved below =", () => {
    const printed = print(conditionalModule);
    expect(printed).toBe(conditionalExpected);
    expectFixedPoint(printed, "ts");
  }, 30_000);

  test("new expressions take any constructor path and lay out arguments by the call rule", () => {
    const printed = print(newModule);
    expect(printed).toBe(newExpected);
    expectFixedPoint(printed, "ts");
  }, 30_000);

  test("a shebang is one line that starts with /", () => {
    expect(Schema.is(Shebang)("/usr/bin/env bun")).toBe(true);
    expect(Schema.is(Shebang)("usr/bin/env bun")).toBe(false);
    expect(Schema.is(Shebang)("/usr/bin/env\nbun")).toBe(false);
    expect(Schema.is(Shebang)("/usr/bin/env  bun")).toBe(false);
  });
});

const reason = (value: Expr) => failureOf({ imports: [], statements: [constant("x", value)] });

describe("unsupported constructs", () => {
  test("fail with a typed reason", () => {
    expect(
      reason(
        obj([
          ["a", num(1)],
          ["a", num(2)],
        ]),
      ),
    ).toMatchObject({
      _tag: "PrinterError",
      reason: "duplicate-key",
    });
    expect(reason(num(Number.NaN))).toMatchObject({ reason: "non-finite-number" });
    expect(reason(pipe(pipe(fn("Flag.String", str("a")), path("b")), path("c")))).toMatchObject({
      reason: "unsupported-chain",
    });
    expect(reason(pipe(fn("flag.make"), path("b")))).toMatchObject({ reason: "unsupported-chain" });
    expect(reason(member(fn("f"), M("x")))).toMatchObject({ reason: "unsupported-member" });
    expect(reason(plus(str("a"), str("b")))).toMatchObject({ reason: "unsupported-plus" });
    expect(reason(arrow([], arrow([], num(1))))).toMatchObject({
      reason: "unsupported-arrow-body",
    });
    expect(reason(arrow([], conditional(path("a"), num(1), num(2))))).toMatchObject({
      reason: "unsupported-arrow-body",
    });
    expect(
      reason(conditional(path("a"), conditional(path("b"), num(1), num(2)), num(3))),
    ).toMatchObject({ reason: "unsupported-conditional" });
    expect(reason(conditional(path("a"), arrow([], num(1)), num(2)))).toMatchObject({
      reason: "unsupported-conditional",
    });
    expect(reason(newExpr(fn("f"), []))).toMatchObject({ reason: "unsupported-new" });
    expect(
      failureOf({ imports: [], statements: [{ _tag: "Expression", value: path("a.b") }] }),
    ).toMatchObject({ reason: "unsupported-expression" });
  });
});

describe("printJson", () => {
  // Entries are built out of order on purpose: the printer sorts them.
  const value = json(
    Object.fromEntries([
      ["z", ["short", "array"]],
      [
        "a",
        Object.fromEntries([
          ["nested", { deep: ["x"], empty: {} }],
          ["list", []],
        ]),
      ],
      ["long", range(1, 12).map((n) => `element-${n}`)],
      ["numbers", range(1, 60).map((n) => n * 13)],
      [
        "pairs",
        [
          ["a", "b"],
          ["c", "d"],
        ],
      ],
      ["single", [["bearerAuth"]]],
      ["singles", [["a"], ["b"]]],
      [
        "objects",
        [
          Object.fromEntries([
            ["b", 1],
            ["a", 2],
          ]),
        ],
      ],
      ["unicode", range(1, 14).map(() => "\u4E2D\u6587")],
      ["scalars", [null, true, false, -1.5, "caf\u00E9"]],
    ]),
  );

  test("prints the fixed layout", () => {
    expect(
      printJson(
        json(
          Object.fromEntries([
            ["b", [1, 2]],
            ["a", { c: [] }],
          ]),
        ),
      ),
    ).toBe('{\n  "a": {\n    "c": []\n  },\n  "b": [1, 2]\n}\n');
    expect(printJson(json({}))).toBe("{}\n");
  });

  test("short arrays, long arrays and nested objects are vp fmt fixed points", () => {
    expectFixedPoint(printJson(value), "json");
  }, 30_000);

  test("package.json keeps the formatter's layout and key order", () => {
    const manifest = json(
      Object.fromEntries([
        [
          "dependencies",
          Object.fromEntries([
            ["effect", "4.1.2"],
            ["@effect/platform-bun", "4.1.2"],
          ]),
        ],
        ["bin", { tool: "dist/bin.js" }],
        ["type", "module"],
        ["name", "generated-cli"],
        ["files", ["dist"]],
        ["version", "0.0.0"],
      ]),
    );
    const printed = Effect.runSync(printPackageJson(manifest));
    expect(printed).toBe(
      '{\n  "name": "generated-cli",\n  "version": "0.0.0",\n  "bin": {\n    "tool": "dist/bin.js"\n  },\n  "files": [\n    "dist"\n  ],\n  "type": "module",\n  "dependencies": {\n    "@effect/platform-bun": "4.1.2",\n    "effect": "4.1.2"\n  }\n}\n',
    );

    const formatted = Bun.spawnSync([vp, "fmt", "--stdin-filepath=tests/emit/package.json"], {
      cwd: root,
      stdin: encoder.encode(printed),
    });
    expect(decoder.decode(formatted.stdout)).toBe(printed);
    expect(
      Effect.runSync(Effect.flip(printPackageJson(json({ extra: 1, scripts: {} })))),
    ).toMatchObject({ reason: "unsupported-package-json", subject: "extra" });
  }, 30_000);
});
