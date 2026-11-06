import { describe, expect, test } from "bun:test";
import { Array as Arr, Order, Result, Schema } from "effect";
import hostile from "../fixtures/seeds/hostile.json" with { type: "json" };
import {
  foldFileSegment,
  foldIdentifier,
  foldKebab,
  SafeFileSegment,
  SafeIdentifier,
  words,
} from "../../src/names/fold.ts";
import {
  reservedCliNames,
  reservedEnvSuffixes,
  reservedIdentifiers,
  windowsDeviceNames,
} from "../../src/names/reserved.ts";

const HostileCases = Schema.Struct({
  cases: Schema.Array(
    Schema.Struct({
      input: Schema.Union([
        Schema.String,
        Schema.Struct({ codeUnits: Schema.Array(Schema.Number) }),
      ]),
    }),
  ),
});

const hostileStrings: readonly string[] = Schema.decodeUnknownSync(HostileCases)(hostile).cases.map(
  ({ input }) =>
    Schema.is(Schema.String)(input) ? input : String.fromCodePoint(...input.codeUnits),
);

const extras: readonly string[] = [
  "",
  "   ",
  "---",
  "日本語",
  "ｆｕｌｌｗｉｄｔｈ",
  "Crème Brûlée",
  "ﬁne ﬂow",
  "2fa",
  "class",
  "con",
  "NUL.txt",
  "a".repeat(200),
  "\u0000‮",
];

const corpus: readonly string[] = [...hostileStrings, ...extras];

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

const asciiOnly = /^\p{ASCII}*$/u;

const okName = (result: Result.Result<{ readonly name: string }, unknown>): string | undefined =>
  Result.isSuccess(result) ? result.success.name : undefined;

const failTag = (result: Result.Result<unknown, { readonly _tag: string }>): string | undefined =>
  Result.isFailure(result) ? result.failure._tag : undefined;

describe("words", () => {
  test("splits on non-alphanumerics, lower-to-upper boundaries and drops marks", () => {
    expect(words("users-list")).toEqual(["users", "list"]);
    expect(words("listUsers")).toEqual(["list", "Users"]);
    expect(words("Crème Brûlée")).toEqual(["Creme", "Brulee"]);
    expect(words("a__b..c")).toEqual(["a", "b", "c"]);
    expect(words("ﬁne")).toEqual(["fine"]);
    expect(words("日本")).toEqual([]);
  });
});

describe("foldKebab", () => {
  test("folds to lowercase kebab", () => {
    expect(okName(foldKebab("List Users"))).toBe("list-users");
    expect(okName(foldKebab("listUsers"))).toBe("list-users");
    expect(okName(foldKebab("X_Request.Id"))).toBe("x-request-id");
  });

  test("an empty result is refused", () => {
    for (const input of ["", "---", "日本語", "\u{1F600}"]) {
      expect(failTag(foldKebab(input))).toBe("EmptyFold");
    }
  });

  test("a leading digit gets the fixed prefix and a note", () => {
    const result = foldKebab("2fa");
    expect(okName(result)).toBe("n-2fa");
    expect(Result.isSuccess(result) ? result.success.notes : []).toEqual([
      { _tag: "DigitPrefix", prefix: "n" },
    ]);
  });
});

describe("foldIdentifier", () => {
  test("applies the target casing", () => {
    expect(okName(foldIdentifier("users-list", "camel"))).toBe("usersList");
    expect(okName(foldIdentifier("users-list", "pascal"))).toBe("UsersList");
    expect(okName(foldIdentifier("listUsers", "camel"))).toBe("listUsers");
    expect(okName(foldIdentifier("LIST_USERS", "pascal"))).toBe("ListUsers");
  });

  test("a reserved word gets the fixed suffix and a note", () => {
    const result = foldIdentifier("class", "camel");
    expect(okName(result)).toBe("class_");
    expect(Result.isSuccess(result) ? result.success.notes : []).toEqual([
      { _tag: "ReservedSuffix", suffix: "_" },
    ]);
    expect(okName(foldIdentifier("delete", "camel"))).toBe("delete_");
    expect(okName(foldIdentifier("delete", "pascal"))).toBe("Delete");
  });

  test("a leading digit gets the fixed prefix and a note", () => {
    const result = foldIdentifier("2fa", "camel");
    expect(okName(result)).toBe("n2fa");
    expect(Result.isSuccess(result) ? result.success.notes : []).toEqual([
      { _tag: "DigitPrefix", prefix: "n" },
    ]);
  });

  test("an empty result is refused", () => {
    expect(failTag(foldIdentifier("", "camel"))).toBe("EmptyFold");
  });
});

describe("foldFileSegment", () => {
  test("folds group names to a segment", () => {
    expect(okName(Result.map(foldFileSegment("Users API"), (name) => ({ name })))).toBe(
      "users-api",
    );
    expect(okName(Result.map(foldFileSegment("2fa"), (name) => ({ name })))).toBe("2fa");
  });

  test("Windows device names are refused in any case", () => {
    for (const input of ["CON", "con", "Nul", "COM1", "lpt9", "aux", "prn"]) {
      expect(failTag(foldFileSegment(input))).toBe("UnsafeFileSegment");
    }
  });

  test("an over-long segment is refused and an empty one is refused", () => {
    expect(failTag(foldFileSegment("a".repeat(65)))).toBe("UnsafeFileSegment");
    expect(failTag(foldFileSegment("---"))).toBe("EmptyFold");
  });
});

describe("brands", () => {
  test("SafeIdentifier rejects invalid and reserved values", () => {
    const is = Schema.is(SafeIdentifier);
    expect(is("usersList")).toBe(true);
    expect(is("$_a1")).toBe(true);
    expect(is("1a")).toBe(false);
    expect(is("a-b")).toBe(false);
    expect(is("class")).toBe(false);
    expect(is("")).toBe(false);
  });

  test("SafeFileSegment rejects device names, upper case, dots and long values", () => {
    const is = Schema.is(SafeFileSegment);
    expect(is("users")).toBe(true);
    expect(is("0-a")).toBe(true);
    expect(is("con")).toBe(false);
    expect(is("CON")).toBe(false);
    expect(is("con.ts")).toBe(false);
    expect(is("com1")).toBe(false);
    expect(is("-a")).toBe(false);
    expect(is("a".repeat(65))).toBe(false);
  });
});

describe("fold properties over hostile strings", () => {
  test("every output is ASCII and a valid identifier or a refusal", () => {
    for (const input of corpus) {
      for (const casing of ["camel", "pascal"] as const) {
        const result = foldIdentifier(input, casing);
        if (Result.isSuccess(result)) {
          const { name } = result.success;
          expect(asciiOnly.test(name)).toBe(true);
          expect(identifierPattern.test(name)).toBe(true);
          expect(reservedIdentifiers.has(name)).toBe(false);
          expect(Schema.is(SafeIdentifier)(name)).toBe(true);
        } else {
          expect(result.failure._tag).toBe("EmptyFold");
        }
      }
    }
  });

  test("every kebab output matches the flag shape or is a refusal", () => {
    for (const input of corpus) {
      const result = foldKebab(input);
      if (Result.isSuccess(result)) {
        expect(/^[a-z][a-z0-9-]*$/u.test(result.success.name)).toBe(true);
        expect(result.success.name.includes("--")).toBe(false);
      } else {
        expect(result.failure._tag).toBe("EmptyFold");
      }
    }
  });

  test("every file segment is a SafeFileSegment or a refusal", () => {
    for (const input of corpus) {
      const result = foldFileSegment(input);
      if (Result.isSuccess(result)) {
        expect(Schema.is(SafeFileSegment)(result.success)).toBe(true);
      } else {
        expect(["EmptyFold", "UnsafeFileSegment"]).toContain(result.failure._tag);
      }
    }
  });

  test("the fold is idempotent on its kebab output", () => {
    for (const input of corpus) {
      const first = okName(foldKebab(input));
      if (first !== undefined) {
        expect(okName(foldKebab(first))).toBe(first);
      }
    }
  });
});

describe("reserved sets", () => {
  const runtimeFlags = [
    "base-url",
    "server",
    "server-variable",
    "timeout",
    "retries",
    "retry-unsafe",
    "output",
    "force",
    "raw",
    "dry-run",
    "verbose",
    "error-format",
    "describe",
    "body",
    "body-file",
    "content-type",
    "accept",
    "allow-credentials-for-base-url",
    "max-record-bytes",
    "max-error-bytes",
  ];
  const builtIns = ["help", "h", "version", "v", "completions", "log-level"];
  const negations = [
    "help",
    "version",
    "force",
    "raw",
    "dry-run",
    "verbose",
    "retry-unsafe",
    "allow-credentials-for-base-url",
    "describe",
  ];

  test.each([...builtIns, ...runtimeFlags, ...negations.map((name) => `no-${name}`)])(
    "%s is reserved",
    (name) => {
      expect(reservedCliNames.has(name)).toBe(true);
    },
  );

  test("the set is exactly the design's names", () => {
    expect(reservedCliNames.size).toBe(builtIns.length + runtimeFlags.length + negations.length);
  });

  test("an ordinary name is not reserved", () => {
    expect(reservedCliNames.has("limit")).toBe(false);
  });

  test("reserved environment suffixes are held", () => {
    expect(Arr.sort(reservedEnvSuffixes, Order.String)).toEqual([
      "BASE_URL",
      "ERROR_FORMAT",
      "IDLE_TIMEOUT",
      "RETRIES",
      "TIMEOUT",
    ]);
  });

  test("Windows device names are held in upper case", () => {
    expect(windowsDeviceNames.has("CON")).toBe(true);
    expect(windowsDeviceNames.has("COM9")).toBe(true);
    expect(windowsDeviceNames.has("LPT0")).toBe(true);
  });
});
