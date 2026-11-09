import { describe, expect, test } from "bun:test";
import { Effect, Result } from "effect";
import {
  escapeToken,
  evaluateFragment,
  evaluateFragmentResult,
  evaluatePointer,
  evaluatePointerResult,
  evaluateTokens,
  evaluateTokensResult,
  formatPointer,
  parseFragment,
  parseFragmentResult,
  parsePointer,
  parsePointerResult,
  unescapeToken,
  unescapeTokenResult,
} from "../../src/model/pointer.ts";
import type { Json } from "../../src/model/pointer.ts";

// RFC 6901 section 5 document.
const doc: Json = {
  "": 0,
  " ": 7,
  "a/b": 1,
  "c%d": 2,
  "e^f": 3,
  foo: ["bar", "baz"],
  "g|h": 4,
  "i\\j": 5,
  'k"l': 6,
  "m~n": 8,
};

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runSync(e);

const tagOf = <A, E extends { readonly _tag: string }>(e: Effect.Effect<A, E>): string =>
  run(Effect.flip(e))._tag;

describe("RFC 6901 section 5 evaluation", () => {
  const cases: readonly (readonly [string, Json])[] = [
    ["", doc],
    ["/foo", ["bar", "baz"]],
    ["/foo/0", "bar"],
    ["/", 0],
    ["/a~1b", 1],
    ["/c%d", 2],
    ["/e^f", 3],
    ["/g|h", 4],
    ["/i\\j", 5],
    ['/k"l', 6],
    ["/ ", 7],
    ["/m~0n", 8],
  ];
  for (const [pointer, expected] of cases) {
    test(`pointer ${JSON.stringify(pointer)}`, () => {
      expect(run(evaluatePointer(doc, pointer))).toEqual(expected);
    });
  }
});

describe("RFC 6901 section 6 fragment form", () => {
  const cases: readonly (readonly [string, Json])[] = [
    ["#", doc],
    ["#/foo", ["bar", "baz"]],
    ["#/foo/0", "bar"],
    ["#/", 0],
    ["#/a~1b", 1],
    ["#/c%25d", 2],
    ["#/e%5Ef", 3],
    ["#/g%7Ch", 4],
    ["#/i%5Cj", 5],
    ["#/k%22l", 6],
    ["#/%20", 7],
    ["#/m~0n", 8],
  ];
  for (const [fragment, expected] of cases) {
    test(`fragment ${fragment}`, () => {
      expect(run(evaluateFragment(doc, fragment))).toEqual(expected);
    });
  }

  test("percent-decodes before pointer parsing", () => {
    expect(run(parseFragment("#/c%25d"))).toEqual(["c%d"]);
    expect(run(parseFragment("#/a%2Fb"))).toEqual(["a", "b"]);
  });

  test("rejects a bad percent escape and a missing hash", () => {
    expect(tagOf(parseFragment("#/%E0%A4%A"))).toBe("PointerSyntaxError");
    expect(tagOf(parseFragment("/foo"))).toBe("PointerSyntaxError");
  });
});

describe("parse, format and escape", () => {
  test("parse tokens", () => {
    expect(run(parsePointer(""))).toEqual([]);
    expect(run(parsePointer("/"))).toEqual([""]);
    expect(run(parsePointer("/a~1b/m~0n"))).toEqual(["a/b", "m~n"]);
    expect(run(parsePointer("//"))).toEqual(["", ""]);
  });

  test("format round-trips parse", () => {
    for (const p of ["", "/", "//", "/a~1b", "/m~0n", "/foo/0", "/~01"]) {
      expect(formatPointer(run(parsePointer(p)))).toBe(p);
    }
  });

  test("escape order keeps ~01 unambiguous", () => {
    expect(escapeToken("~1")).toBe("~01");
    expect(run(unescapeToken("~01"))).toBe("~1");
    expect(escapeToken("a/b~c")).toBe("a~1b~0c");
  });

  test("syntax failures", () => {
    expect(tagOf(parsePointer("a"))).toBe("PointerSyntaxError");
    expect(tagOf(parsePointer("/a~2"))).toBe("PointerSyntaxError");
    expect(tagOf(parsePointer("/a~"))).toBe("PointerSyntaxError");
    expect(tagOf(unescapeToken("~"))).toBe("PointerSyntaxError");
  });
});

describe("evaluation failures", () => {
  test("missing member", () => {
    expect(tagOf(evaluatePointer(doc, "/nope"))).toBe("PointerMemberNotFound");
  });

  test("inherited members are not members", () => {
    expect(tagOf(evaluatePointer(doc, "/constructor"))).toBe("PointerMemberNotFound");
    expect(tagOf(evaluatePointer(doc, "/__proto__"))).toBe("PointerMemberNotFound");
  });

  test("out-of-range, dash and non-canonical array indexes", () => {
    expect(tagOf(evaluatePointer(doc, "/foo/2"))).toBe("PointerIndexOutOfRange");
    expect(tagOf(evaluatePointer(doc, "/foo/-"))).toBe("PointerIndexOutOfRange");
    expect(tagOf(evaluatePointer(doc, "/foo/01"))).toBe("PointerIndexOutOfRange");
    expect(tagOf(evaluatePointer(doc, "/foo/x"))).toBe("PointerIndexOutOfRange");
  });

  test("descending into a scalar", () => {
    expect(tagOf(evaluatePointer(doc, "/foo/0/x"))).toBe("PointerNotContainer");
  });

  test("syntax errors surface from evaluation", () => {
    expect(tagOf(evaluatePointer(doc, "foo"))).toBe("PointerSyntaxError");
    expect(tagOf(evaluateFragment(doc, "#/foo~"))).toBe("PointerSyntaxError");
  });

  test("failures carry the prefix pointer that failed", () => {
    const e = run(Effect.flip(evaluatePointer(doc, "/foo/9")));
    expect("pointer" in e && e.pointer).toBe("/foo/9");
  });
});

describe("Result functions agree with their Effect forms", () => {
  const agree = <A, E extends { readonly _tag: string }>(
    result: Result.Result<A, E>,
    effect: Effect.Effect<A, E>,
  ) => {
    const exit = Effect.runSyncExit(effect);
    if (Result.isSuccess(result)) {
      expect(exit._tag).toBe("Success");
      expect(exit._tag === "Success" && exit.value).toEqual(result.success);
    } else {
      expect(exit._tag).toBe("Failure");
      expect(Effect.runSync(Effect.flip(effect))).toEqual(result.failure);
    }
  };

  const pointers = ["", "/", "a", "/foo/0", "/a~1b", "/m~0n", "/~", "/~2", "/foo/9", "/foo/0/x"];
  for (const pointer of pointers) {
    test(`pointer ${JSON.stringify(pointer)}`, () => {
      agree(parsePointerResult(pointer), parsePointer(pointer));
      agree(evaluatePointerResult(doc, pointer), evaluatePointer(doc, pointer));
    });
  }

  const fragments = ["#", "#/foo/0", "#/a%25b", "#/%zz", "foo", "#/foo~", "#a"];
  for (const fragment of fragments) {
    test(`fragment ${JSON.stringify(fragment)}`, () => {
      agree(parseFragmentResult(fragment), parseFragment(fragment));
      agree(evaluateFragmentResult(doc, fragment), evaluateFragment(doc, fragment));
    });
  }

  for (const token of ["a", "a~1b", "~", "~2", "a~"]) {
    test(`token ${JSON.stringify(token)}`, () => {
      agree(unescapeTokenResult(token), unescapeToken(token));
    });
  }

  test("tokens", () => {
    for (const tokens of [[], ["foo", "1"], ["foo", "x"], ["constructor"], ["foo", "0", "x"]]) {
      agree(evaluateTokensResult(doc, tokens), evaluateTokens(doc, tokens));
    }
  });
});
