import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { emitApi } from "../../src/emit/api.ts";
import { emitCli } from "../../src/emit/cli.ts";
import { emitDomainSchemas } from "../../src/emit/domain.ts";
import { emitPackageFiles } from "../../src/emit/package.ts";
import type { EmittedFile } from "../../src/emit/package.ts";
import { runtimeFiles } from "../../src/emit/runtime-files.generated.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Api, Operation } from "../../src/model/entities.ts";
import type { Server } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { normalizeSchemas } from "../../src/normalize/schemas.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { resolve } from "../../src/resolve/index.ts";

// Normalize refuses cookie and querystring parameters and form-urlencoded bodies until m2-nz7 and
// m2-nz8, so these fixtures start from normalized operations, swap the construct in, and plan the
// swapped `Api` so each construct gets its own flags.

const root = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const read = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

const golden = decodeRecord(JSON.parse(read("openapi.json")));

const configJson = decodeJson(JSON.parse(read("author-config.json")));

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const ok = { "200": { description: "ok" } };

const spec: Schema.Json = {
  ...golden,
  paths: {
    "/sessions": {
      get: {
        operationId: "sessions-read",
        parameters: [
          { in: "query", name: "session_id", schema: { type: "string" } },
          { in: "query", name: "filter", schema: { $ref: "#/components/schemas/UserUpdate" } },
        ],
        responses: ok,
        tags: ["users"],
      },
      post: {
        operationId: "sessions-create",
        requestBody: {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/UserUpdate" } },
          },
          required: true,
        },
        responses: ok,
        tags: ["users"],
      },
    },
  },
};

const config = await Effect.runPromise(
  decodeAuthorConfig(configJson, { document: configDocument }),
);

const resolution = await Effect.runPromise(resolve({ document, line: "3.1", value: spec }));

const { api: normalized } = await Effect.runPromise(
  normalize(resolution, { config, configDocument }),
);

const schemas = await Effect.runPromise(normalizeSchemas(resolution));

const encodedApi = Schema.encodeSync(Api)(normalized);

const encodeOperation = Schema.encodeUnknownSync(Operation);

const encodedOf = (operationId: string) =>
  encodeOperation(normalized.operations.find((operation) => operation.operationId === operationId));

const read0 = encodedOf("sessions-read");

const create0 = encodedOf("sessions-create");

const [sessionParameter, filterParameter] = read0.parameters;

const formAlternative = create0.body?.alternatives[0];

const objectKey = formAlternative?.schema?.key ?? "";

const cookie = (required: boolean) => ({
  ...sessionParameter,
  location: "cookie",
  required,
  serialization: {
    allowReserved: false,
    explode: true,
    kind: "style",
    origin: read0.origin,
    rows: [],
    rules: "fixture",
    style: "form",
  },
});

const querystring = (required: boolean) => ({
  ...filterParameter,
  location: "querystring",
  required,
  schema: { key: objectKey },
  serialization: {
    kind: "content",
    mediaType: "application/x-www-form-urlencoded",
    origin: read0.origin,
    rows: [],
    rules: "fixture",
    schema: { key: objectKey },
  },
});

const formBody = (required: boolean) => ({
  ...create0,
  body: {
    ...create0.body,
    alternatives: [
      { ...formAlternative, codec: "form", mediaType: "application/x-www-form-urlencoded" },
    ],
    required,
  },
});

interface Variant {
  readonly cookieRequired: boolean;
  readonly formRequired: boolean;
  readonly querystringRequired: boolean;
}

const decodeApi = Schema.decodeUnknownSync(Api);

// The swapped `Api`, planned and emitted through every layer the cli module imports.
const generate = (variant: Variant) =>
  Effect.gen(function* generated() {
    const readSwap = {
      ...read0,
      parameters: [cookie(variant.cookieRequired), querystring(variant.querystringRequired)],
    };
    const createSwap = formBody(variant.formRequired);
    const swap = (operation: (typeof encodedApi.operations)[number]) => {
      if (operation.operationId === "sessions-read") {
        return readSwap;
      }

      return operation.operationId === "sessions-create" ? createSwap : operation;
    };
    const api = decodeApi({ ...encodedApi, operations: encodedApi.operations.map(swap) });
    const plan = yield* planNames(api, { config, configDocument, strict: false });
    const context = { config, configDocument, document, openapi: api.openapi };
    const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;
    const domain = yield* emitDomainSchemas(
      schemas.validation.definitions,
      [objectKey],
      plan.domain,
    );
    const apiFiles = yield* emitApi({ api, boundOrigins: bound, plan });
    const cli = yield* emitCli({ api, config, plan, validationEdits: [] });

    return { apiFiles, cli, domain };
  });

const optional: Variant = { cookieRequired: false, formRequired: true, querystringRequired: false };

const required: Variant = { cookieRequired: true, formRequired: false, querystringRequired: true };

const run = (variant: Variant) => Effect.runPromise(generate(variant));

const contentOf = (files: readonly EmittedFile[], path: string): string =>
  files.find((file) => file.path === path)?.content ?? "";

// One exported command statement of the users cli module.
const statement = (content: string, name: string): string => {
  const start = content.indexOf(`export const ${name} =`);
  const end = content.indexOf("export const ", start + 1);

  return start === -1 ? "" : content.slice(start, end === -1 ? undefined : end);
};

const cliOf = async (variant: Variant) => {
  const { cli } = await run(variant);

  return { cli, users: contentOf(cli.files, "src/cli/users.ts") };
};

describe("emitCli: cookie and querystring parameters", () => {
  test("an optional cookie flag is passed to the builder, absent as undefined", async () => {
    const { cli, users } = await cliOf(optional);
    const readCommand = statement(users, "sessionsRead");

    expect(cli.refusals.filter((refusal) => refusal.operation.method === "GET")).toEqual([]);
    expect(readCommand).toContain('sessionId: Flag.String("session-id").pipe(Flag.optional');
    expect(readCommand).toContain("sessionId: Option.getOrUndefined(flags.sessionId)");
  });

  test("a required cookie flag is passed as given", async () => {
    const { users } = await cliOf(required);
    const readCommand = statement(users, "sessionsRead");

    expect(readCommand).toContain("sessionId: flags.sessionId");
    expect(readCommand).not.toContain("Option.getOrUndefined(flags.sessionId)");
  });

  test("a querystring flag is decoded as JSON, absent as undefined when optional", async () => {
    const { users } = await cliOf(optional);
    const readCommand = statement(users, "sessionsRead");

    expect(readCommand).toContain('filter: Input.jsonFlag("filter").pipe(Flag.optional');
    expect(readCommand).toContain("filter: Option.getOrUndefined(flags.filter)");
  });

  test("a required querystring flag is decoded as JSON and passed as given", async () => {
    const { users } = await cliOf(required);
    const readCommand = statement(users, "sessionsRead");

    expect(readCommand).toContain('filter: Input.jsonFlag("filter")');
    expect(readCommand).toContain("filter: flags.filter");
  });
});

// The builder takes the form body as `Serialize.Json | undefined`; `Input.structuredBody` merges
// `--body`, `--body-file` and the field flags into that value.
describe("emitCli: form-urlencoded bodies", () => {
  test("a form body is built from the JSON body sources and handed to the builder", async () => {
    const { cli, users } = await cliOf(optional);
    const create = statement(users, "sessionsCreate");

    expect(cli.refusals).toEqual([]);
    expect(create).toContain("body: Input.bodyFlag");
    expect(create).toContain("bodyFile: Input.bodyFileFlag");
    expect(create).toContain("Input.structuredBody(");
    expect(create).not.toContain("Input.mergeBody(");
    expect(create).toContain("Users.sessionsCreate({ body:");
  });
});

// The emitted domain, api and cli modules and the runtime, written under the worktree's
// git-ignored `work/` and type-checked together: the cli hand-off matches the api `Input` types.
const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "cli-request-inputs-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

const generator = {
  packageJson: decodeJson(generatorPackage),
  tsconfig: decodeJson(generatorTsconfig),
};

const typeCheck = async (variant: Variant, name: string) => {
  const { apiFiles, cli, domain } = await run(variant);
  const scaffold = await Effect.runPromise(emitPackageFiles(config, generator));
  const dir = nodePath.join(work, name);
  const files: readonly EmittedFile[] = [
    domain,
    ...apiFiles,
    ...cli.files.filter((file) => file.path !== "src/cli/root.ts"),
    ...Object.entries(runtimeFiles).map(([key, content]) => ({ content, path: `src/${key}` })),
    { content: contentOf(scaffold, "tsconfig.json"), path: "tsconfig.json" },
  ];
  for (const file of files) {
    const target = nodePath.join(dir, ...file.path.split("/"));
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true });
    nodeFs.writeFileSync(target, file.content);
  }

  nodeFs.symlinkSync(nodePath.join(root, "node_modules"), nodePath.join(dir, "node_modules"));

  const tsc = nodePath.join(root, "node_modules/.bin/tsc");

  return Bun.spawnSync([tsc, "--noEmit", "-p", nodePath.join(dir, "tsconfig.json")], {
    cwd: dir,
  });
};

// `Describe.Binding` takes the `querystring` location, and the `JsonNode` that `Input.jsonFlag`
// and `Input.structuredBody` yield is a `Serialize.Json`.
describe("emitCli: the emitted cli module against its api module and the runtime", () => {
  test("optional cookie and querystring, required form body: the hand-off type-checks", async () => {
    const result = await typeCheck(optional, "optional");

    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(result.exitCode).toBe(0);
  }, 120_000);

  test("required cookie and querystring, optional form body: the hand-off type-checks", async () => {
    const result = await typeCheck(required, "required");

    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
