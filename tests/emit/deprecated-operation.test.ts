import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { emitApi } from "../../src/emit/api.ts";
import { operationHelp } from "../../src/emit/help.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Operation } from "../../src/model/entities.ts";
import type { Server } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { resolve } from "../../src/resolve/index.ts";
import { generateFixture, preparePackage } from "../support/generated-cli.ts";

// The golden operation `users-update` declares three responses (200, 404, default) and no response
// header. Each fixture swaps in the response headers it needs, as encoded data decoded again.

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

const update = base.plan.groups
  .flatMap((group) => group.commands)
  .find((command) => command.operation.operationId === "users-update")?.operation;

if (update === undefined) {
  throw new Error("the golden plan has no users-update operation");
}

const encodedUpdate = Schema.encodeSync(Operation)(update);

const withDeprecated = (deprecated: boolean) =>
  Schema.decodeUnknownSync(Operation)({ ...encodedUpdate, deprecated });

const emit = (operation: Operation) => {
  const plan = {
    ...base.plan,
    groups: base.plan.groups.map((group) => ({
      ...group,
      commands: group.commands.map((command) => ({
        ...command,
        operation: command.operation.operationId === "users-update" ? operation : command.operation,
      })),
    })),
  };

  return Effect.runPromise(emitApi({ api: base.api, boundOrigins: base.bound, plan })).then(
    (files) => files.find((file) => file.path === "src/api/users.ts")?.content ?? "",
  );
};

const metaOf = (content: string): string => {
  const start = content.indexOf("export const updateMeta");

  return content.slice(start, content.indexOf("};", start));
};

const helpOf = (operation: Operation) =>
  operationHelp({ credentials: [], diagnostics: [], flags: [], operation, schemes: [] });

describe("emitApi: a deprecated operation", () => {
  test("OPR-14: the meta carries deprecated: true", async () => {
    const content = await emit(withDeprecated(true));

    expect(metaOf(content)).toContain("  deprecated: true,\n");
  });

  test("OPR-14: a current operation prints no field, and the golden is unchanged", async () => {
    const content = await emit(withDeprecated(false));

    expect(metaOf(content)).not.toContain("deprecated");
    expect(content).toBe(read("expected/src/api/users.ts"));
  });
});

describe("operationHelp: a deprecated operation", () => {
  test("OPR-14: help carries a DEPRECATED section", () => {
    const { sections } = helpOf(withDeprecated(true));

    expect(sections.map(([title]) => title)).toContain("DEPRECATED");
  });

  test("OPR-14: a current operation has no DEPRECATED section", () => {
    const { sections } = helpOf(withDeprecated(false));

    expect(sections.map(([title]) => title)).not.toContain("DEPRECATED");
  });
});

// The golden author config names `./custom/commands.ts`, which the author owns: one `login` command.
const authorCommands = `import { Command } from "effect/cli";\n\nexport const login = Command.make("login");\n`;

const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// The golden spec with `users-update` marked deprecated, written to a scoped temp directory.
const deprecatedSpec = Effect.gen(function* writeSpec() {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "deprecated-operation-" });
  const marker = '"operationId": "users-update",';
  const spec = read("openapi.json").replace(marker, `${marker} "deprecated": true,`);
  if (!spec.includes('"deprecated": true')) {
    return yield* Effect.die("the golden spec has no users-update operation to mark");
  }

  const specPath = nodePath.join(dir, "openapi.json");
  yield* fs.writeFileString(specPath, spec);

  return specPath;
});

describe("generated package: a deprecated operation", () => {
  test("OPR-14: the package type-checks and builds", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* buildPackage() {
        const specPath = yield* deprecatedSpec;
        const generated = yield* generateFixture({
          authorFiles: [{ content: authorCommands, path: "custom/commands.ts" }],
          configPath: nodePath.join(fixture, "author-config.json"),
          specPath,
        });

        return yield* preparePackage(generated).pipe(
          Effect.as("passed"),
          Effect.catchTag("GeneratedCliStepFailed", (failure) =>
            Effect.succeed(
              `${failure.step} exited ${failure.exitCode}\n${utf8(failure.stdout)}${utf8(failure.stderr)}`,
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
    );

    expect(outcome).toBe("passed");
  }, 600_000);
});
