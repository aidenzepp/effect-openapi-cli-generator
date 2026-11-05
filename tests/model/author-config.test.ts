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
  assertPatterns: true,
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

  test("an unknown top-level key is refused", () => {
    expect(keys({ ...sample, bogus: true })).toEqual(["/bogus|CFG-1/unknown-key"]);
  });

  test("an unknown nested key is refused at its pointer", () => {
    expect(keys({ ...sample, package: { extra: 1, name: "x", version: "1" } })).toEqual([
      "/package/extra|CFG-1/unknown-key",
    ]);
  });

  test("a missing required key is refused", () => {
    expect(keys({ ...sample, package: { name: "x" } })).toEqual([
      "/package/version|CFG-1/missing-key",
    ]);
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

  test("pointers escape slash and tilde in keys", () => {
    expect(keys({ ...sample, "a/b~c": 1 })).toEqual(["/a~1b~0c|CFG-1/unknown-key"]);
  });
});
