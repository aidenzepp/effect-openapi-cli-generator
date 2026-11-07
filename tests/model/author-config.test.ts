import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { AuthorConfig, decodeAuthorConfig } from "../../src/model/author-config.ts";
import type { AuthorConfigContext } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";

const document = Schema.decodeUnknownSync(DocumentUri)("file:///work/author.json");

const context: AuthorConfigContext = { document, foldedTitle: "example-api" };

const encode = (input: Schema.Json) =>
  Schema.encodeSync(AuthorConfig)(Effect.runSync(decodeAuthorConfig(input, context)));

const sample = {
  binName: "example",
  commands: { module: "./custom/commands.ts", names: ["login"] },
  envPrefix: "EXAMPLE",
  naming: {
    byPointer: {},
    operations: {
      "users-update": {
        command: "update",
        parameters: { "header:If-Match": { flag: "if-match" } },
      },
    },
  },
  package: { name: "example-cli", version: "1.0.0" },
  servers: { accepted: ["https://api.example.com"] },
};

const full = {
  ...sample,
  acceptedOrigins: ["https://eu.example.com", "https://us.example.com"],
  allowInsecure: false,
  naming: {
    byPointer: { "/paths/~1health/get": { group: "ops", skip: true } },
    operations: sample.naming.operations,
  },
  retrievalUri: "https://example.com/openapi.json",
  runtime: { idleTimeoutSeconds: 300, retries: 2, timeoutSeconds: 30 },
  security: { bearerAuth: { env: "EXAMPLE_TOKEN" } },
};

const refusals = (input: Schema.Json, ctx = context) => {
  const exit = Effect.runSyncExit(decodeAuthorConfig(input, ctx));
  if (Exit.isSuccess(exit)) {
    throw new Error("expected a refusal");
  }

  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (failure === undefined) {
    throw new Error("expected a typed failure");
  }

  expect(failure.error._tag).toBe("AuthorConfigRefused");

  return failure.error.diagnostics;
};

const keys = (input: Schema.Json) => refusals(input).map((d) => `${d.pointer}|${d.code}`);

const without = (key: string) =>
  Object.fromEntries(Object.entries(sample).filter(([name]) => name !== key));

describe("decodeAuthorConfig", () => {
  test("a config shaped like the design 4.8 sample decodes", () => {
    expect(encode(sample)).toEqual(sample);
  });

  test("every documented key decodes", () => {
    expect(encode(full)).toEqual(full);
  });

  test("a missing binName is a document refusal whose hint suggests the folded title", () => {
    const [only, ...rest] = refusals(without("binName"));
    expect(rest).toEqual([]);
    expect(only?.code).toBe("CFG-1/missing-bin-name");
    expect(only?.row).toBe("CFG-1");
    expect(only?.scope).toBe("document");
    expect(only?.severity).toBe("refusal");
    expect(only?.document).toBe(document);
    expect(String(only?.pointer)).toBe("/binName");
    expect(only?.hint?.includes("example-api")).toBe(true);
  });

  test("a missing binName without a title still refuses", () => {
    const [only] = refusals(without("binName"), { document });
    expect(only?.code).toBe("CFG-1/missing-bin-name");
  });

  test("a binName with an uppercase letter is refused", () => {
    expect(keys({ ...sample, binName: "Example" })).toEqual(["/binName|CFG-1/invalid-bin-name"]);
  });

  test("binNames outside the pattern are refused", () => {
    for (const binName of ["", "1abc", "-abc", "ab_c", "ab c", "abc\n"]) {
      expect(keys({ ...sample, binName })).toEqual(["/binName|CFG-1/invalid-bin-name"]);
    }
  });

  test("a binName that is not a string is refused", () => {
    expect(keys({ ...sample, binName: 3 })).toEqual(["/binName|CFG-1/invalid-bin-name"]);
  });

  test("a commands module outside the package is a value-free document refusal", () => {
    for (const module of [
      "/abs/commands.ts",
      "../outside.ts",
      "./a/../x.ts",
      ".\\x.ts",
      "./a//x.ts",
      "./",
      ".",
    ]) {
      const found = refusals({ ...sample, commands: { module, names: ["login"] } });
      expect(found.map((d) => `${d.pointer}|${d.code}|${d.scope}`)).toEqual([
        "/commands/module|CFG-1/unsafe-commands-module|document",
      ]);
      if (module.length > 3) {
        expect(JSON.stringify(found)).not.toContain(module);
      }
    }
  });

  test("refuses assertPatterns, true or false, naming the key and not the value", () => {
    for (const value of [true, false]) {
      const found = refusals({ ...sample, assertPatterns: value });

      expect(found.map((d) => `${d.pointer}|${d.code}`)).toEqual([
        "/assertPatterns|CFG-1/unsupported-key",
      ]);
      expect(found[0]?.message).toContain("assertPatterns");
      expect(found[0]?.message).not.toContain(String(value));
    }
  });

  test("an unknown top-level key is refused", () => {
    expect(keys({ ...sample, bogus: true })).toEqual(["/bogus|CFG-1/unknown-key"]);
  });

  test("an unknown nested key is refused at its pointer", () => {
    expect(keys({ ...sample, package: { extra: 1, name: "x", version: "1.0.0" } })).toEqual([
      "/package/extra|CFG-1/unknown-key",
    ]);
  });

  test("a missing required key is refused", () => {
    expect(keys({ ...sample, package: { name: "x" } })).toEqual([
      "/package/version|CFG-1/missing-key",
    ]);
  });

  test("a package version that is not semver 2.0.0 is refused without echoing the value", () => {
    const bad = [
      "1",
      "1.0",
      "01.0.0",
      "1.0.0-",
      "1.0.0 ",
      " 1.0.0",
      "1.0.0-'rc'\u2028",
      "v1.0.0",
      "1.0.0\n",
      "",
    ];
    for (const version of bad) {
      const found = refusals({ ...sample, package: { name: "x", version } }, { document });
      expect(found.map((d) => `${d.pointer}|${d.code}`)).toEqual([
        "/package/version|CFG-1/invalid-version",
      ]);
      expect(found[0]?.message).not.toContain("rc");
    }
  });

  test("semver 2.0.0 versions with prerelease and build metadata are accepted", () => {
    for (const version of [
      "0.0.0",
      "1.2.3",
      "1.0.0-rc.1",
      "1.0.0+build.5",
      "1.0.0-alpha-1+sha.abc",
    ]) {
      const exit = Effect.runSyncExit(
        decodeAuthorConfig({ ...sample, package: { name: "x", version } }, { document }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    }
  });

  test("a wrongly typed value is refused", () => {
    expect(keys({ ...sample, allowInsecure: "yes" })).toEqual([
      "/allowInsecure|CFG-1/invalid-value",
    ]);
    expect(keys({ ...sample, envPrefix: "lower" })).toEqual(["/envPrefix|CFG-1/invalid-value"]);
  });

  test("a non-object config is refused at the root", () => {
    expect(keys([])).toEqual(["|CFG-1/invalid-value"]);
    expect(keys(null)).toEqual(["|CFG-1/invalid-value"]);
  });

  test("every problem is reported, ordered by pointer", () => {
    expect(keys({ ...without("binName"), aaa: 2, zzz: 1 })).toEqual([
      "/aaa|CFG-1/unknown-key",
      "/binName|CFG-1/missing-bin-name",
      "/zzz|CFG-1/unknown-key",
    ]);
  });

  test("a body field flag rename keyed by its body pointer decodes", () => {
    const fields = { "/foo_bar": { flag: "foo-bar-raw" }, "/meta/name": { flag: "meta.label" } };
    const input = { ...sample, naming: { operations: { "things-make": { fields } } } };

    expect(encode(input)).toEqual(input);
  });

  test("a body field key that is not a pointer is refused at its config pointer", () => {
    for (const key of ["foo_bar", "", "/a~2b"]) {
      const naming = { operations: { make: { fields: { [key]: { flag: "foo" } } } } };
      const found = refusals({ ...sample, naming });

      expect(found.map((d) => `${d.pointer}|${d.code}|${d.scope}`)).toEqual([
        `/naming/operations/make/fields/${key.replaceAll("~", "~0").replaceAll("/", "~1")}|CFG-1/invalid-field-pointer|document`,
      ]);
      expect(found[0]?.message).toContain("RFC 6901");
    }
  });

  test("a body field flag that is not a flag name is refused at its config pointer", () => {
    for (const flag of ["", "Foo", "foo bar", "--foo", "foo-", "1foo", "foo..bar", "foo_bar"]) {
      const naming = { byPointer: { "/paths/~1x/post": { fields: { "/x": { flag } } } } };

      expect(keys({ ...sample, naming })).toEqual([
        "/naming/byPointer/~1paths~1~01x~1post/fields/~1x/flag|CFG-1/invalid-field-flag",
      ]);
    }
  });

  test("pointers escape slash and tilde in keys", () => {
    expect(keys({ ...sample, "a/b~c": 1 })).toEqual(["/a~1b~0c|CFG-1/unknown-key"]);
  });
});
