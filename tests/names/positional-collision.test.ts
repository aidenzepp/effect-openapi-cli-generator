import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Layer, Path, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import type { GenerateResult } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";

const document = Schema.decodeUnknownSync(DocumentUri)("file:///fx-cfdk/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///fx-cfdk/author-config.json");

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const pathName = { in: "path", name: "name", required: true, schema: { type: "string" } };

// Cloudflare's shape (want 34ff5250): a path `{name}` beside a JSON body property `name`, plus two
// operations that must still generate, one whose query flag only shares a leading word.
const spec: Schema.Json = {
  info: { title: "FX-CFDK", version: "1.0.0" },
  openapi: "3.1.1",
  paths: {
    "/items/{name}": {
      get: {
        operationId: "items-get",
        parameters: [pathName, { in: "query", name: "name-prefix", schema: { type: "string" } }],
        responses: { "204": { description: "Found." } },
        tags: ["items"],
      },
    },
    "/repos/{name}": {
      get: {
        operationId: "repos-get",
        parameters: [pathName],
        responses: { "204": { description: "Found." } },
        tags: ["repos"],
      },
    },
    "/repos/{name}/fork": {
      post: {
        operationId: "repos-fork",
        parameters: [pathName],
        requestBody: {
          content: {
            "application/json": {
              schema: { properties: { name: { type: "string" } }, type: "object" },
            },
          },
          required: true,
        },
        responses: { "204": { description: "Forked." } },
        tags: ["repos"],
      },
    },
  },
  servers: [{ url: "https://api.example.com" }],
};

const baseConfig = {
  binName: "example",
  envPrefix: "EXAMPLE",
  package: { name: "example-cli", version: "1.0.0" },
  servers: { accepted: ["https://api.example.com"] },
};

const renamedConfig = {
  ...baseConfig,
  naming: {
    byPointer: {},
    operations: { "repos-fork": { parameters: { "path:name": { flag: "repo-name" } } } },
  },
};

const forkPathPointer = "/paths/~1repos~1{name}~1fork/post/parameters/0";

interface Written {
  readonly cliItems: string | undefined;
  readonly cliRepos: string | undefined;
  readonly result: GenerateResult;
}

const generateWith = (config: Schema.Json): Promise<Written> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* prepare() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "fx-cfdk-" });
        const specPath = path.join(dir, "openapi.json");
        const configPath = path.join(dir, "author-config.json");
        const out = path.join(dir, "out");
        yield* fs.writeFileString(specPath, JSON.stringify(spec));
        yield* fs.writeFileString(configPath, JSON.stringify(config));

        const exit = yield* Effect.exit(
          generate(
            {
              document,
              generator,
              outDir: out,
              source: { _tag: "File", path: specPath },
              strict: false,
            },
            { document: configDocument, path: configPath },
          ),
        );
        if (Exit.isFailure(exit)) {
          const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;

          return yield* Effect.die(new Error(`generate failed: ${JSON.stringify(failure)}`));
        }

        const read = (relative: string) =>
          Effect.gen(function* readFile() {
            const target = path.join(out, ...relative.split("/"));

            return (yield* fs.exists(target)) ? yield* fs.readFileString(target) : undefined;
          });

        return {
          cliItems: yield* read("src/cli/items.ts"),
          cliRepos: yield* read("src/cli/repos.ts"),
          result: exit.value,
        };
      }),
    ).pipe(Effect.provide(layer)),
  );

describe("positional and flag collision (FX-CFDK)", () => {
  test("PRM-02: a path positional beside a body flag of the same name refuses that operation", async () => {
    const written = await generateWith(baseConfig);
    const collisions = written.result.report.refusals.filter(
      (entry) => entry.code === "PRM-02/flag-collision",
    );

    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      hint: 'naming.operations["repos-fork"].parameters["path:name"].flag',
      operation: { method: "POST", operationId: "repos-fork", path: "/repos/{name}/fork" },
      pointer: forkPathPointer,
      row: "PRM-02",
      scope: "operation",
      severity: "refusal",
    });
    expect(written.result.report.refusals).toHaveLength(1);
    expect(written.cliRepos).toBeDefined();
    expect(written.cliItems).toBeDefined();
  });

  test("PRM-02: renaming the positional through path:name clears the collision", async () => {
    const written = await generateWith(renamedConfig);

    expect(written.result.report.refusals).toEqual([]);
    expect(written.cliRepos).toBeDefined();
  });

  test("PRM-02: a positional and a flag that share only leading words do not collide", async () => {
    const written = await generateWith(baseConfig);
    const itemsRefusals = written.result.report.refusals.filter(
      (entry) => entry.operation?.operationId === "items-get",
    );

    expect(itemsRefusals).toEqual([]);
    expect(written.cliItems).toBeDefined();
  });
});
