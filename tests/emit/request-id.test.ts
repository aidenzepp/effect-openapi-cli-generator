import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { emitApi } from "../../src/emit/api.ts";
import { runtimeFiles } from "../../src/emit/runtime-files.generated.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Operation } from "../../src/model/entities.ts";
import type { Server } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { resolve } from "../../src/resolve/index.ts";

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

// One response per entry of `headers`, in the golden's response order (200, 404, default).
const withHeaders = (headers: readonly (readonly string[])[]) =>
  Schema.decodeUnknownSync(Operation)({
    ...encodedUpdate,
    responses: encodedUpdate.responses.map((response, index) => ({
      ...response,
      headers: (headers[index] ?? []).map((name) => ({ name })),
    })),
  });

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

const requestIdLines = (content: string): readonly string[] =>
  metaOf(content)
    .split("\n")
    .filter((line) => line.includes("requestIdHeader"));

describe("emitApi: the request-id header", () => {
  test("the earlier response key's candidate wins over a later one", async () => {
    const content = await emit(withHeaders([["X-Rate"], ["Request-Id"], ["X-Request-Id"]]));

    expect(requestIdLines(content)).toEqual(['  requestIdHeader: "Request-Id",']);
  });

  test("within one response the document order picks the first candidate", async () => {
    const content = await emit(withHeaders([["X-Request-Id", "Request-Id"]]));

    expect(requestIdLines(content)).toEqual(['  requestIdHeader: "X-Request-Id",']);
  });

  test("x-correlation-id matches in mixed case and keeps its declared spelling", async () => {
    const content = await emit(withHeaders([["X-Correlation-ID"]]));

    expect(requestIdLines(content)).toEqual(['  requestIdHeader: "X-Correlation-ID",']);
  });

  test("x-requestid is not a candidate", async () => {
    const content = await emit(withHeaders([["x-requestid"], ["X-Request-ID-Extra"]]));

    expect(requestIdLines(content)).toEqual([]);
  });

  test("no declared header prints no field, and the golden meta is unchanged", async () => {
    const content = await emit(withHeaders([]));

    expect(requestIdLines(content)).toEqual([]);
    expect(content).toBe(read("expected/src/api/users.ts"));
  });
});

const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "request-id-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

describe("emitApi: the emitted meta against the runtime type", () => {
  test("a meta with a request-id header satisfies OperationMeta", async () => {
    const content = await emit(withHeaders([["X-Request-Id"]]));
    const dir = nodePath.join(work, "package");
    for (const [path, text] of Object.entries(runtimeFiles)) {
      nodeFs.mkdirSync(nodePath.dirname(nodePath.join(dir, "src", path)), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(dir, "src", path), text);
    }

    nodeFs.mkdirSync(nodePath.join(dir, "src/api"), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, "src/api/users.ts"), content);
    nodeFs.writeFileSync(
      nodePath.join(dir, "src/check.ts"),
      [
        'import type { OperationMeta } from "./runtime/output.ts";',
        'import { updateMeta } from "./api/users.ts";',
        "export const checked: OperationMeta = updateMeta;",
        "",
      ].join("\n"),
    );
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
