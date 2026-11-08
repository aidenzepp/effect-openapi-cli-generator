import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { emitApi } from "../../src/emit/api.ts";
import { runtimeFiles } from "../../src/emit/runtime-files.generated.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Api, SecurityScheme } from "../../src/model/entities.ts";
import type { Server } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { resolve } from "../../src/resolve/index.ts";

// The golden declares one scheme, `bearerAuth`. Each case decodes it again with the `deprecated`
// flag the 3.2.1 document would have given it.

const root = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const read = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const golden = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
  JSON.parse(read("openapi.json")),
);

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const pipeline = Effect.gen(function* generate() {
  const config = yield* decodeAuthorConfig(decodeJson(JSON.parse(read("author-config.json"))), {
    document: configDocument,
  });
  const resolution = yield* resolve({ document, line: "3.1", value: golden });
  const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument });
  const plan = yield* planNames(api, { config, configDocument, strict: false });
  const context = { config, configDocument, document, openapi: api.openapi };
  const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;

  return { api, bound, plan };
});

const base = await Effect.runPromise(pipeline);

const withDeprecated = (deprecated: boolean): Api =>
  Schema.decodeUnknownSync(Api)({
    ...Schema.encodeSync(Api)(base.api),
    securitySchemes: base.api.securitySchemes.map((scheme) => ({
      ...Schema.encodeSync(SecurityScheme)(scheme),
      deprecated,
    })),
  });

const securityOf = (api: Api) =>
  Effect.runPromise(emitApi({ api, boundOrigins: base.bound, plan: base.plan })).then(
    (files) => files.find((file) => file.path === "src/api/security.ts")?.content ?? "",
  );

describe("emitApi: a deprecated security scheme", () => {
  test("the golden scheme is not deprecated and the table prints no field", async () => {
    expect(base.api.securitySchemes.map((scheme) => scheme.deprecated)).toEqual([false]);

    const content = await securityOf(base.api);

    expect(content).not.toContain("deprecated");
    expect(content).toContain(
      'bearerAuth: { env: "EXAMPLE_BEARER_AUTH", kind: "http", scheme: "bearer" }',
    );
  });

  test("an explicit false prints no field", async () => {
    expect(await securityOf(withDeprecated(false))).not.toContain("deprecated");
  });

  test("a deprecated scheme prints deprecated: true in its entry", async () => {
    const content = await securityOf(withDeprecated(true));

    expect(content).toContain(
      'bearerAuth: { deprecated: true, env: "EXAMPLE_BEARER_AUTH", kind: "http", scheme: "bearer" }',
    );
  });
});

const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "deprecated-scheme-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

describe("emitApi: the emitted security table against the runtime type", () => {
  test("a table with a deprecated scheme satisfies SecurityTable", async () => {
    const content = await securityOf(withDeprecated(true));
    const dir = nodePath.join(work, "package");
    for (const [path, text] of Object.entries(runtimeFiles)) {
      nodeFs.mkdirSync(nodePath.dirname(nodePath.join(dir, "src", path)), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(dir, "src", path), text);
    }

    nodeFs.mkdirSync(nodePath.join(dir, "src/api"), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, "src/api/security.ts"), content);
    nodeFs.writeFileSync(
      nodePath.join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: generatorTsconfig.compilerOptions, include: ["src"] }),
    );
    nodeFs.symlinkSync(nodePath.join(root, "node_modules"), nodePath.join(dir, "node_modules"));

    const result = Bun.spawnSync(
      [nodePath.join(root, "node_modules/.bin/tsc"), "--noEmit", "-p", "tsconfig.json"],
      { cwd: dir },
    );

    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
