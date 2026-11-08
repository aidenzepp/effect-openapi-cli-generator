import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";

// A `format: password` string property of a flattened request body is read from a file: its flag
// is --<prop>-file of kind secret-file, never --<prop> (design 13.1 R4), and the new name joins
// the operation's collision set (design 4.4).

const document = Schema.decodeUnknownSync(DocumentUri)("file:///pw/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///pw/author-config.json");

const config: Schema.Json = {
  binName: "pw",
  envPrefix: "PW",
  package: { name: "pw-cli", version: "1.0.0" },
  servers: { accepted: ["https://api.example.com"] },
};

const password: Schema.Json = { format: "password", type: "string" };

const spec = (properties: Readonly<Record<string, Schema.Json>>): Schema.Json => ({
  components: { schemas: { Plain: { type: "string" }, Secret: password } },
  info: { title: "Pw", version: "1.0.0" },
  openapi: "3.1.1",
  paths: {
    "/logins": {
      post: {
        operationId: "logins-create",
        requestBody: {
          content: { "application/json": { schema: { properties, type: "object" } } },
          required: true,
        },
        responses: { "204": { description: "Created." } },
        tags: ["logins"],
      },
    },
  },
});

const planned = (properties: Readonly<Record<string, Schema.Json>>) =>
  Effect.runPromise(
    Effect.gen(function* generate() {
      const author = yield* decodeAuthorConfig(config, { document: configDocument });
      const resolution = yield* resolve({ document, line: "3.1", value: spec(properties) });
      const { api } = yield* normalize(resolution, {
        checkFindings: [],
        config: author,
        configDocument,
      });
      const plan = yield* planNames(api, { config: author, configDocument, strict: false });
      const flags = plan.groups
        .flatMap((group) => group.commands)
        .flatMap((command) => command.flags);
      const codes = plan.diagnostics.map(({ code, scope, severity }) => ({
        code,
        scope,
        severity,
      }));

      return { codes, flags: new Map(flags.map((flag) => [flag.name, flag] as const)) };
    }),
  );

describe("a format password body property is a secret-file flag", () => {
  test("password plans --password-file of kind secret-file and no --password", async () => {
    const { codes, flags } = await planned({ password, user: { type: "string" } });

    expect(codes).toEqual([]);
    expect(flags.get("password-file")?.source).toMatchObject({
      _tag: "Body",
      kind: "secret-file",
      repeated: false,
      wireName: "/password",
    });
    expect(flags.has("password")).toBe(false);
    expect(flags.get("user")?.source).toMatchObject({ kind: "string" });
  });

  test("a property without the format keeps its own flag", async () => {
    const { flags } = await planned({ token: { type: "string" } });

    expect(flags.get("token")?.source).toMatchObject({ kind: "string" });
    expect(flags.has("token-file")).toBe(false);
  });

  test("a property whose schema is a format password component is a secret-file flag", async () => {
    const { flags } = await planned({ pin: { $ref: "#/components/schemas/Secret" } });

    expect(flags.get("pin-file")?.source).toMatchObject({ kind: "secret-file", wireName: "/pin" });
    expect(flags.has("pin")).toBe(false);
  });

  // A password format reached through a composition the flattener follows, or through any anyOf or
  // oneOf branch, fails closed: the flag is a secret-file flag (design invariant I4).
  const composed: readonly (readonly [string, Schema.Json])[] = [
    ["an allOf member", { allOf: [{ type: "string" }, { format: "password" }] }],
    ["a $ref sibling", { $ref: "#/components/schemas/Plain", format: "password" }],
    ["an anyOf branch", { anyOf: [password, { type: "integer" }] }],
    ["a oneOf branch", { oneOf: [{ type: "integer" }, { $ref: "#/components/schemas/Secret" }] }],
  ];

  for (const [through, schema] of composed) {
    test(`a password format through ${through} is a secret-file flag`, async () => {
      const { codes, flags } = await planned({ secret: schema });

      expect(codes).toEqual([]);
      expect(flags.get("secret-file")?.source).toMatchObject({
        kind: "secret-file",
        repeated: false,
        wireName: "/secret",
      });
      expect(flags.has("secret")).toBe(false);
    });
  }

  test("a nested flattened property is a secret-file flag at its dotted name", async () => {
    const { flags } = await planned({ auth: { properties: { password }, type: "object" } });

    expect(flags.get("auth.password-file")?.source).toMatchObject({
      kind: "secret-file",
      wireName: "/auth/password",
    });
    expect(flags.has("auth.password")).toBe(false);
  });

  test("a sibling property named password-file collides and the operation is refused", async () => {
    const { codes, flags } = await planned({ password, "password-file": { type: "string" } });

    expect(codes).toEqual([
      { code: "RQB-03/flag-collision", scope: "operation", severity: "refusal" },
    ]);
    expect(flags.size).toBe(0);
  });

  test("a format password property inside a JSON-valued flag gets no file flag", async () => {
    const { flags } = await planned({
      deep: {
        properties: { inner: { properties: { password }, type: "object" } },
        type: "object",
      },
    });

    expect(flags.get("deep.inner")?.source).toMatchObject({ kind: "json" });
    expect([...flags.keys()].some((name) => name.endsWith("-file") && name !== "body-file")).toBe(
      false,
    );
  });
});
