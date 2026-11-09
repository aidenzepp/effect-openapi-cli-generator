import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import type { Credential } from "../../src/runtime-src/runtime/auth.ts";
import { sanitize } from "../../src/runtime-src/runtime/output.ts";
import type { Secret } from "../../src/runtime-src/runtime/redact.ts";
import {
  dropTrailingFragment,
  queryWireForm,
  scrub,
  scrubAround,
} from "../../src/runtime-src/runtime/redact.ts";

// Audit M F1 probe values: each is sent percent-encoded with no `+` for a space, and the URL parser
// encodes a `'` in a special-scheme query, so the wire form differs from the URLSearchParams form.
const queryProbes = [
  { raw: "k e y", searchParams: "k+e+y", wire: "k%20e%20y" },
  { raw: "a!b/c", searchParams: "a%21b%2Fc", wire: "a!b%2Fc" },
  { raw: "a~b c", searchParams: "a%7Eb+c", wire: "a~b%20c" },
  { raw: "x'y z", searchParams: "x%27y+z", wire: "x%27y%20z" },
] as const;

const queryCredential = (value: string): Credential => ({
  definition: { in: "query", kind: "apiKey", name: "api_key" },
  scheme: "apiKey",
  value: Redacted.make(value),
});

describe("every echoed form of a query credential is scrubbed (audit M F1)", () => {
  for (const probe of queryProbes) {
    test(`${JSON.stringify(probe.raw)} has the wire form the request target carries`, () => {
      expect(queryWireForm(probe.raw)).toBe(probe.wire);
    });

    for (const form of ["raw", "searchParams", "wire"] as const) {
      test(`${JSON.stringify(probe.raw)} echoed as its ${form} form`, () => {
        expect(scrub(`echo ${probe[form]} end`, [queryCredential(probe.raw)])).toBe(
          "echo <redacted:apiKey> end",
        );
      });
    }
  }
});

const bearerOf = (value: string): Credential => ({
  definition: { kind: "http", scheme: "bearer" },
  scheme: "bearer",
  value: Redacted.make(value),
});

const stripControls = (text: string): string =>
  text.replaceAll("\u00AD", "").replaceAll("\u0085", "").replaceAll("\u0001", "");

// Audit S2 residual: a read cut inside a credential that stripped characters also split.
describe("a trailing fragment split by stripped characters is dropped (audit S2)", () => {
  for (const split of ["\u00AD", "\u0085", "\u0001"]) {
    test(`split by ${JSON.stringify(split)}`, () => {
      const text = `kept SEC${split}RETTO${split}`;

      expect(dropTrailingFragment(text, [bearerOf("SECRETTOKEN")], stripControls)).toBe("kept ");
    });
  }

  test("a fragment as sent is still dropped", () => {
    expect(dropTrailingFragment("kept SECRET", [bearerOf("SECRETTOKEN")], stripControls)).toBe(
      "kept ",
    );
  });

  test("text with no fragment is unchanged", () => {
    expect(dropTrailingFragment("kept S\u00ADX", [bearerOf("SECRETTOKEN")], stripControls)).toBe(
      "kept S\u00ADX",
    );
  });
});

const secretOf = (label: string, value: string): Secret => ({
  kind: "secret",
  label,
  value: Redacted.make(value),
});

describe("a secret entry is scrubbed as given and JSON-escaped", () => {
  const entry = secretOf("password-file", 'pa55"word\n');

  test("echoed raw", () => {
    expect(scrub('got pa55"word\n end', [entry])).toBe("got <redacted:password-file> end");
  });

  test("echoed inside a JSON string, the kept LF as \\n", () => {
    expect(scrub('{"echo":"pa55\\"word\\n"}', [entry])).toBe('{"echo":"<redacted:password-file>"}');
  });

  test("beside a credential, each keeps its own label", () => {
    expect(scrub('a pa55"word\n b SECRETTOKEN', [entry, bearerOf("SECRETTOKEN")])).toBe(
      "a <redacted:password-file> b <redacted:bearer>",
    );
  });
});

// Security review of bd3128a: a server may strip the trailing newline or echo the value in a
// percent-encoded or form-encoded (`+` for a space) body, and a JSON echo may escape non-ASCII.
describe("a secret's echoed forms are scrubbed", () => {
  const entry = secretOf("password-file", "pa55 w0rd\n");

  for (const echo of ["pa55 w0rd", "pa55+w0rd", "pa55%20w0rd", "pa55%20w0rd%0A"]) {
    test(`echoed as ${JSON.stringify(echo)}`, () => {
      expect(scrub(`got ${echo} end`, [entry])).toBe("got <redacted:password-file> end");
    });
  }

  test("a CRLF-terminated value echoed without it", () => {
    expect(scrub("got pa55 end", [secretOf("password-file", "pa55\r\n")])).toBe(
      "got <redacted:password-file> end",
    );
  });

  for (const echo of ["p\\u00e4ss", "p\\u00E4ss"]) {
    test(`a non-ASCII value echoed as the escape ${echo}`, () => {
      expect(scrub(`{"echo":"${echo}"}`, [secretOf("password-file", "päss")])).toBe(
        '{"echo":"<redacted:password-file>"}',
      );
    });
  }

  test("a value above U+FFFF echoed as its escaped surrogate pair", () => {
    expect(scrub('{"echo":"k\\ud83d\\udd11"}', [secretOf("password-file", "k\u{1F511}")])).toBe(
      '{"echo":"<redacted:password-file>"}',
    );
  });

  test("a value that is only a newline scrubs no empty form", () => {
    expect(scrub("a b", [secretOf("password-file", "\n")])).toBe("a b");
  });
});

// Hater m3 HB1: a credential shorter than its placeholder, such as `a` inside `<redacted:...>`, is
// never rewritten inside a placeholder already in the text, from placeholder mode or a first pass.
describe("a placeholder already in the text is opaque (HB1)", () => {
  const short: Credential = {
    definition: { kind: "http", scheme: "bearer" },
    scheme: "bearerAuth",
    value: Redacted.make("a"),
  };
  const secret = secretOf("password-file", "e");

  test("a one-character credential is scrubbed around a placeholder, never inside it", () => {
    expect(scrubAround("Bearer <redacted:bearerAuth> a", [short], sanitize)).toBe(
      "Be<redacted:bearerAuth>rer <redacted:bearerAuth> <redacted:bearerAuth>",
    );
  });

  test("the bare <redacted> placeholder is opaque too", () => {
    expect(scrub("cookie: <redacted> a", [short])).toBe("cookie: <redacted> <redacted:bearerAuth>");
  });

  test("an occurrence that only overlaps a placeholder is still scrubbed", () => {
    const overlap: Credential = { ...short, value: Redacted.make(">x") };

    expect(scrub("<redacted:bearerAuth>x", [overlap])).toBe(
      "<redacted:bearerAuth<redacted:bearerAuth>",
    );
  });

  for (const [name, text, entries] of [
    ["a credential", "Bearer <redacted:bearerAuth> a", [short]],
    ["a secret entry", "password: <redacted:password-file> e", [secret]],
    ["both", "a <redacted:password-file> e <redacted:bearerAuth>", [short, secret]],
  ] as const) {
    test(`scrubAround is idempotent for ${name}`, () => {
      const once = scrubAround(text, entries, sanitize);

      expect(once).not.toContain("<red<");
      expect(scrubAround(once, entries, sanitize)).toBe(once);
    });
  }
});

// Security review of m3-hb1: only a placeholder the runtime emits is opaque. Text that only looks
// like one, such as a server echoing `<redacted:` + credential + `>`, is scrubbed as usual.
describe("only an exact runtime placeholder is opaque (HB1b)", () => {
  const token: Credential = {
    definition: { kind: "http", scheme: "bearer" },
    scheme: "bearerAuth",
    value: Redacted.make("s3cr3t-token"),
  };
  const short: Credential = { ...token, value: Redacted.make("a") };
  const secret = secretOf("password-file", "e");

  test("a credential echoed inside a placeholder-shaped token is scrubbed", () => {
    expect(scrub("echo <redacted:s3cr3t-token> end", [token])).toBe(
      "echo <redacted:<redacted:bearerAuth>> end",
    );
  });

  test("a credential after an unclosed placeholder prefix is scrubbed", () => {
    const text = "echo <redacted:s3cr3t-token and more> end";

    expect(scrub(text, [token])).not.toContain("s3cr3t-token");
    expect(scrubAround(text, [token], sanitize)).not.toContain("s3cr3t-token");
  });

  test("an unknown label is ordinary input, and the credential elsewhere is scrubbed", () => {
    const text = "<redacted:unknownlabel> <redacted:other-s3cr3t-token> s3cr3t-token";

    expect(scrub(text, [token])).toBe(
      "<redacted:unknownlabel> <redacted:other-<redacted:bearerAuth>> <redacted:bearerAuth>",
    );
    expect(scrub("<redacted:unknownlabel>", [short])).toBe(
      "<red<redacted:bearerAuth>cted:unknownl<redacted:bearerAuth>bel>",
    );
  });

  test("a one-character credential still nests in no placeholder the runtime emits", () => {
    const text = "<redacted:bearerAuth> <redacted:password-file> <redacted> a e";

    expect(scrub(text, [short, secret])).toBe(
      "<redacted:bearerAuth> <redacted:password-file> <redacted> <redacted:bearerAuth> <redacted:password-file>",
    );
    expect(scrubAround(text, [short, secret], sanitize)).toBe(scrub(text, [short, secret]));
  });
});
