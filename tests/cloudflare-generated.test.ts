import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { Array, Effect, Order, Schema } from "effect";
import { generate } from "../src/index.js";
import {
  cloudflarePaths,
  cloudflareRevision,
  cloudflareSha256,
  cloudflareUrl,
  decodeCloudflareSnapshot,
  extractCloudflare,
  sha256,
} from "../tools/cloudflare-source.js";

const root = "examples/cloudflare-generated";

const readInput = async () =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(
    await readFile(`${root}/openapi.json`, "utf-8"),
  );

test("Cloudflare fixture pins original provenance and preserves its complete reference closure", async () => {
  const input = await readInput();
  const provenance = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        operations: Schema.Array(Schema.Struct({ method: Schema.String, path: Schema.String })),
        revision: Schema.String,
        sha256: Schema.String,
        sliceSha256: Schema.String,
        url: Schema.String,
      }),
    ),
  )(await readFile(`${root}/provenance.json`, "utf-8"));
  expect(provenance).toEqual({
    operations: cloudflarePaths.map((path) => ({ method: "get", path })),
    revision: cloudflareRevision,
    sha256: cloudflareSha256,
    sliceSha256: sha256(JSON.stringify(input)),
    url: cloudflareUrl,
  });

  const paths = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.JsonObject))(
    input.paths,
  );
  const components = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.JsonObject))(
    input.components,
  );
  expect(Object.keys(paths)).toEqual([...cloudflarePaths]);
  expect(Object.keys(components.schemas ?? {})).toHaveLength(33);
  expect(Object.keys(components.parameters ?? {})).toHaveLength(1);
  expect(Object.keys(components.securitySchemes ?? {})).toHaveLength(4);

  const augmented = {
    ...Object.fromEntries(Object.entries(input)),
    components: { ...components, schemas: { ...components.schemas, Unused: { type: "boolean" } } },
    paths: {
      ...paths,
      "/unselected": {
        post: {
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Unused" } } },
          },
        },
      },
    },
  };
  const extracted: Schema.JsonObject = await Effect.runPromise(extractCloudflare(augmented));
  expect(extracted).toEqual(input);
});

test("Cloudflare extraction rejects altered snapshot bytes before generation", async () => {
  const failure = await Effect.runPromise(Effect.flip(decodeCloudflareSnapshot("{}")));
  expect(failure._tag).toBe("CloudflareSourceError");
  expect(failure.message).toContain("checksum");
});

test("Cloudflare example matches current output, builds and exposes all three help routes", async () => {
  const input = await readInput();
  const application = await Effect.runPromise(generate(input));
  await Promise.all(
    application.files.map(async (file) => {
      expect(await readFile(`${root}/${file.path}`, "utf-8"), file.path).toBe(file.content);
    }),
  );
  const files = await readdir(`${root}/src`, { recursive: true });
  expect(
    Array.sort(
      files.filter((file) => file.endsWith(".ts")),
      Order.String,
    ),
  ).toEqual(
    Array.sort(
      application.files
        .filter((file) => file.path.startsWith("src/"))
        .map((file) => file.path.slice(4)),
      Order.String,
    ),
  );

  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: root });
  expect({ code: build.exitCode, error: build.stderr.toString() }).toMatchObject({ code: 0 });
  for (const args of [
    ["user", "tokens", "list"],
    ["user", "tokens", "verify"],
    ["user", "tokens", "permission-groups", "list"],
  ]) {
    const help = Bun.spawnSync(["node", `${root}/dist/main.js`, ...args, "--help"]);
    expect({ code: help.exitCode, error: help.stderr.toString() }).toMatchObject({ code: 0 });
    expect(help.stdout.toString()).toContain(`cloudflare-api ${args.join(" ")} [flags]`);
    expect(help.stdout.toString()).not.toContain("EXAMPLES");
  }
}, 30_000);
