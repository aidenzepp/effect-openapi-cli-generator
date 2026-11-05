import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { manifest } from "../../src/validate/schemas/manifest.ts";
import { checkManifest, validateDocument } from "../../src/validate/index.ts";
import type { ReadSchema } from "../../src/validate/index.ts";
import valid30 from "../fixtures/validate/valid-3.0.json" with { type: "json" };
import invalid30 from "../fixtures/validate/invalid-3.0.json" with { type: "json" };
import valid31 from "../fixtures/validate/valid-3.1.json" with { type: "json" };
import invalid31 from "../fixtures/validate/invalid-3.1.json" with { type: "json" };
import valid32 from "../fixtures/validate/valid-3.2.json" with { type: "json" };
import invalid32 from "../fixtures/validate/invalid-3.2.json" with { type: "json" };

const fixtures = {
  "3.0": { invalid: invalid30, valid: valid30 },
  "3.1": { invalid: invalid31, valid: valid31 },
  "3.2": { invalid: invalid32, valid: valid32 },
};

const vendored: ReadSchema = (file) =>
  manifest.some((entry) => entry.file === file)
    ? Effect.succeed(readFileSync(new URL(`../../src/validate/schemas/${file}`, import.meta.url)))
    : Effect.fail("not vendored");

const tampered: ReadSchema = (file) =>
  file === "schema-base-3.1-2026-08-03.json"
    ? vendored(file).pipe(
        Effect.map((bytes) => new TextEncoder().encode(`${new TextDecoder().decode(bytes)} `)),
      )
    : vendored(file);

const missing: ReadSchema = (file) =>
  file === "meta-3.2-2026-02-26.json" ? Effect.fail("gone") : vendored(file);

const failureTag = <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E>,
): Promise<string> =>
  Effect.runPromise(
    effect.pipe(
      Effect.flip,
      Effect.map((error) => error._tag),
    ),
  );

describe("validateDocument", () => {
  test.each([
    ["3.0", "https://spec.openapis.org/oas/3.0/schema/2024-10-18", "/parameters/0/in"],
    [
      "3.1",
      "https://spec.openapis.org/oas/3.1/schema-base/2026-08-03",
      "#/components/schemas/Thing/type",
    ],
    [
      "3.2",
      "https://spec.openapis.org/oas/3.2/schema-base/2026-08-30",
      "#/components/schemas/Thing/type",
    ],
  ] as const)(
    "line %s: valid document passes and negative control fails",
    async (line, schema, pointer) => {
      const valid = await Effect.runPromise(validateDocument(fixtures[line].valid));
      const invalid = await Effect.runPromise(validateDocument(fixtures[line].invalid));

      expect(valid).toEqual({ errors: [], line, schema, valid: true });
      expect(invalid.line).toBe(line);
      expect(invalid.schema).toBe(schema);
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.some((unit) => unit.instanceLocation.endsWith(pointer))).toBe(true);
    },
  );

  test("validation never touches the network", async () => {
    const attempts: string[] = [];
    const original = globalThis.fetch;

    globalThis.fetch = Object.assign(
      () => {
        attempts.push("fetch");

        return Promise.reject(new Error("network blocked"));
      },
      { preconnect: original.preconnect },
    );
    await Effect.runPromise(validateDocument(valid31));
    globalThis.fetch = original;

    expect(attempts).toEqual([]);
  });

  test("an unsupported or missing openapi version is a typed refusal", async () => {
    expect(await failureTag(validateDocument({ openapi: "2.0.0" }))).toBe(
      "UnsupportedOpenApiVersion",
    );
    expect(await failureTag(validateDocument({ openapi: "3.3.0" }))).toBe(
      "UnsupportedOpenApiVersion",
    );
    expect(await failureTag(validateDocument({ swagger: "2.0" }))).toBe(
      "UnsupportedOpenApiVersion",
    );
  });
});

describe("checkManifest", () => {
  test("accepts the vendored bytes", async () => {
    const files = await Effect.runPromise(checkManifest(vendored));

    expect(files).toHaveLength(manifest.length);
  });

  test("a tampered vendored schema fails the sha256 check", async () => {
    expect(await failureTag(checkManifest(tampered))).toBe("SchemaManifestError");
  });

  test("a missing vendored schema fails the check", async () => {
    expect(await failureTag(checkManifest(missing))).toBe("SchemaManifestError");
  });
});
