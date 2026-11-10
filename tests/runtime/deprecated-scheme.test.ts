/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Layer, Redacted, Schema, Sink, Stdio } from "effect";
import { operationHelp } from "../../src/emit/help.ts";
import type { HelpInput } from "../../src/emit/help.ts";
import { Operation, SecurityScheme } from "../../src/model/entities.ts";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";

const canary = "canary-credential-value";

const table: Auth.SecurityTable = {
  schemes: {
    legacyKey: { deprecated: true, in: "header", kind: "apiKey", name: "X-Legacy" },
    modernKey: { in: "header", kind: "apiKey", name: "X-Modern" },
  },
};

const capture = (into: Buffer[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(Buffer.from(chunk));
    }),
  );

const run = (requirement: Auth.SecurityRequirement, env: Record<string, string>) => {
  const stderr: Buffer[] = [];
  const stdout: Buffer[] = [];
  const stdio = Stdio.layerTest({ stderr: capture(stderr), stdout: capture(stdout) });

  return Effect.runPromise(
    Auth.evaluate("users-update", requirement).pipe(
      Effect.provide(
        Layer.mergeAll(
          Auth.layer(table, "EXAMPLE"),
          FileSystem.layerNoop({}),
          stdio,
          Input.stdinClaimLayer,
        ),
      ),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.map((credentials) => ({
        credentials: credentials.map((credential) => Redacted.value(credential.value)),
        stderr: Buffer.concat(stderr).toString(),
        stdout: Buffer.concat(stdout).toString(),
      })),
    ),
  );
};

describe("deprecated scheme notice", () => {
  test("SSC-11: the chosen deprecated scheme writes one notice naming it", async () => {
    const result = await run([["legacyKey"]], { EXAMPLE_LEGACY_KEY: canary });

    expect(result.credentials).toEqual([canary]);
    expect(result.stderr).toBe("Notice: the security scheme legacyKey is deprecated\n");
    expect(result.stderr.match(/legacyKey/gu)?.length).toBe(1);
    expect(result.stderr.split("\n").filter((text) => text !== "")).toHaveLength(1);
    expect(result.stdout).toBe("");
  });

  test("SSC-11: a non-deprecated alternative writes no notice", async () => {
    const result = await run([["legacyKey"], ["modernKey"]], { EXAMPLE_MODERN_KEY: canary });

    expect(result.credentials).toEqual([canary]);
    expect(result.stderr).toBe("");
  });

  test("SSC-11: the first satisfiable alternative decides", async () => {
    const result = await run([["modernKey"], ["legacyKey"]], {
      EXAMPLE_LEGACY_KEY: canary,
      EXAMPLE_MODERN_KEY: canary,
    });

    expect(result.stderr).toBe("");
  });

  test("SSC-11: the credential value is absent from stderr", async () => {
    const result = await run([["legacyKey"]], { EXAMPLE_LEGACY_KEY: canary });

    expect(result.stderr).not.toContain(canary);
    expect(result.stderr).not.toBe("");
  });
});

const origin = { document: "file:///spec.json", pointer: "/paths/~1x/get" };

const scheme = (name: string, deprecated: boolean) =>
  Schema.decodeUnknownSync(SecurityScheme)({
    credentialSources: ["flag", "env"],
    deprecated,
    kind: { in: "header", name: "X-Key", type: "apiKey" },
    name,
    origin,
    rows: ["SSC-11"],
    source: "spec",
  });

const operation = (names: readonly string[]) =>
  Schema.decodeUnknownSync(Operation)({
    deprecated: false,
    docs: {},
    key: { method: "GET", path: "/x" },
    origin,
    parameters: [],
    responses: [],
    rows: ["OPR-01"],
    security: {
      alternatives: [{ uses: names.map((name) => ({ scheme: name, scopes: [] })) }],
      declared: true,
      origin,
      rows: ["SSC-11"],
    },
    servers: [],
    tags: [],
  });

const auth = (names: readonly string[], schemes: readonly SecurityScheme[]) => {
  const input: HelpInput = {
    credentials: [],
    diagnostics: [],
    flags: [],
    operation: operation(names),
    schemes,
  };

  return operationHelp(input).sections.find(([title]) => title === "AUTH")?.[1] ?? "";
};

describe("deprecated scheme in AUTH help", () => {
  test("SSC-11: a deprecated scheme carries the marker", () => {
    expect(auth(["old"], [scheme("old", true)])).toContain("deprecated");
  });

  test("SSC-11: a current scheme has no marker", () => {
    expect(auth(["new"], [scheme("new", false)])).not.toContain("deprecated");
  });
});
