import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Predicate, Schema } from "effect";
import type { HttpBody } from "effect/http";
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { emitApi } from "../../src/emit/api.ts";
import { runtimeFiles } from "../../src/emit/runtime-files.generated.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Api, Operation } from "../../src/model/entities.ts";
import type { Server } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { JsonNumber } from "../../src/runtime-src/runtime/input.ts";

// Normalize refuses cookie and querystring parameters and form-urlencoded bodies until m2-nz7 and
// m2-nz8, so these fixtures start from a normalized operation and swap the construct in directly.

const root = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const read = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

const golden = decodeRecord(JSON.parse(read("openapi.json")));

const configJson = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(read("author-config.json")));

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const ok = { "200": { description: "ok" } };

const spec: Schema.Json = {
  ...golden,
  paths: {
    "/sessions": {
      get: {
        operationId: "sessions-read",
        parameters: [{ in: "query", name: "session_id", schema: { type: "string" } }],
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

const pipeline = Effect.gen(function* generate() {
  const config = yield* decodeAuthorConfig(configJson, { document: configDocument });
  const resolution = yield* resolve({ document, line: "3.1", value: spec });
  const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument });
  const plan = yield* planNames(api, { config, configDocument, strict: false });
  const context = { config, configDocument, document, openapi: api.openapi };
  const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;

  return { api, bound, plan };
});

const base = await Effect.runPromise(pipeline);

const encodeOperation = Schema.encodeUnknownSync(Operation);

const decodeOperation = Schema.decodeUnknownSync(Operation);

const decodeApi = Schema.decodeUnknownSync(Api);

const encodedApi = Schema.encodeSync(Api)(base.api);

// The planned operation of `operationId`, encoded, so each fixture is plain data decoded again.
const encodedOf = (operationId: string) =>
  encodeOperation(
    base.plan.groups
      .flatMap((group) => group.commands)
      .find((command) => command.operation.operationId === operationId)?.operation,
  );

const read0 = encodedOf("sessions-read");

const create0 = encodedOf("sessions-create");

const [queryParameter] = read0.parameters;

const formAlternative = create0.body?.alternatives[0];

// The `$defs` key of `UserUpdate`, the object schema the querystring and form fixtures reuse.
const objectKey = formAlternative?.schema?.key ?? "";

interface Style {
  readonly allowReserved: boolean;
  readonly explode: boolean;
  readonly style: string;
}

const cookieParameter = (style: Style) => ({
  ...queryParameter,
  location: "cookie",
  serialization: { ...style, kind: "style", origin: read0.origin, rows: [], rules: "fixture" },
});

const querystringParameter = (mediaType: string, required: boolean) => ({
  ...queryParameter,
  location: "querystring",
  required,
  schema: { key: objectKey },
  serialization: {
    kind: "content",
    mediaType,
    origin: read0.origin,
    rows: [],
    rules: "fixture",
    schema: { key: objectKey },
  },
  wireName: "filter",
});

const withParameters = (...parameters: readonly unknown[]) =>
  decodeOperation({ ...read0, parameters });

const rule = (name: string, serialization: Readonly<Record<string, boolean | string>>) => ({
  contentType: [],
  headers: [],
  origin: read0.origin,
  rows: [],
  serialization,
  target: { kind: "property", name },
});

// `UserUpdate` declares `name` then `address`; the rules are listed the other way round.
const formBody = (required: boolean) =>
  decodeOperation({
    ...create0,
    body: {
      ...create0.body,
      alternatives: [
        {
          ...formAlternative,
          codec: "form",
          encoding: [
            rule("address", { explode: true, style: "deepObject" }),
            rule("name", { allowReserved: true }),
          ],
          mediaType: "application/x-www-form-urlencoded",
        },
      ],
      required,
    },
  });

interface Swap {
  readonly line?: Api["line"];
  readonly operations: readonly Operation[];
}

// The golden plan with each command's operation replaced by the fixture of its operationId.
const emit = (swap: Swap) => {
  const byId = new Map(swap.operations.map((operation) => [operation.operationId, operation]));
  const plan = {
    ...base.plan,
    groups: base.plan.groups.map((group) => ({
      ...group,
      commands: group.commands.map((command) => ({
        ...command,
        operation: byId.get(command.operation.operationId) ?? command.operation,
      })),
    })),
  };
  const api = decodeApi({ ...encodedApi, line: swap.line ?? base.api.line });

  return Effect.runPromise(emitApi({ api, boundOrigins: base.bound, plan })).then(
    (files) => files.find((file) => file.path === "src/api/users.ts")?.content ?? "",
  );
};

const lines = (...text: readonly string[]) => text.join("\n");

describe("emitApi: cookie parameters", () => {
  test("a form cookie becomes Serialize.cookie in the builder's one cookies list", async () => {
    const operation = withParameters(
      cookieParameter({ allowReserved: false, explode: true, style: "form" }),
    );
    const content = await emit({ line: "3.1", operations: [operation] });

    expect(content).toContain(
      lines(
        "export interface SessionsReadInput {",
        "  readonly sessionId?: string | undefined;",
        "}",
      ),
    );
    expect(content).toContain(
      lines(
        "export const sessionsRead = (input: SessionsReadInput): Serialize.Request =>",
        '  Serialize.request("GET", {',
        "    cookies: [",
        '      Serialize.cookie("session_id", input.sessionId, {',
        "        allowReserved: false,",
        "        explode: true,",
        '        line: "3.1",',
        "        required: false,",
        '        style: "form",',
        "      }),",
        "    ],",
        "    headers: [],",
        '    path: Serialize.path("/sessions", []),',
        "    query: [],",
        "  });",
      ),
    );
  });

  test("a 3.2 cookie-style cookie carries its line and style", async () => {
    const operation = withParameters(
      cookieParameter({ allowReserved: false, explode: true, style: "cookie" }),
    );
    const content = await emit({ line: "3.2", operations: [operation] });

    expect(content).toContain('        line: "3.2",');
    expect(content).toContain('        style: "cookie",');
  });

  test("an operation with no cookie parameter emits no cookies entry (C16)", async () => {
    expect(await emit({ operations: [] })).not.toContain("cookies:");
  });
});

describe("emitApi: querystring parameters", () => {
  test("form content passes the object's declared properties to Serialize.querystring", async () => {
    const content = await emit({
      operations: [withParameters(querystringParameter("application/x-www-form-urlencoded", true))],
    });

    expect(content).toContain(
      lines("export interface SessionsReadInput {", "  readonly filter: Serialize.Json;", "}"),
    );
    expect(content).toContain(
      lines(
        "    query: [",
        '      Serialize.querystring("filter", "application/x-www-form-urlencoded", input.filter, {',
        "        properties: [",
        '          ["name", {}],',
        '          ["address", {}],',
        "        ],",
        "        required: true,",
        "      }),",
        "    ],",
      ),
    );
  });

  test("JSON content passes no properties and an optional value", async () => {
    const content = await emit({
      operations: [withParameters(querystringParameter("application/json", false))],
    });

    expect(content).toContain("  readonly filter?: Serialize.Json | undefined;");
    expect(content).toContain(
      '    query: [Serialize.querystring("filter", "application/json", input.filter, { required: false })],',
    );
  });
});

describe("emitApi: form-urlencoded bodies", () => {
  test("a form alternative becomes Serialize.urlEncoded with its Encoding rules in property order", async () => {
    const content = await emit({ operations: [formBody(true)] });

    expect(content).toContain(
      lines(
        "export interface SessionsCreateInput {",
        "  readonly body: Serialize.Json | undefined;",
        "}",
      ),
    );
    expect(content).toContain(
      lines(
        '  Serialize.request("POST", {',
        '    body: Serialize.urlEncoded("application/x-www-form-urlencoded", input.body, {',
        "      properties: [",
        '        ["name", { allowReserved: true }],',
        '        ["address", { explode: true, style: "deepObject" }],',
        "      ],",
        "      required: true,",
        "    }),",
      ),
    );
    expect(content).toContain('  request: ["application/x-www-form-urlencoded"],');
  });

  test("an optional form body passes required false", async () => {
    expect(await emit({ operations: [formBody(false)] })).toContain(
      lines(
        '        ["address", { explode: true, style: "deepObject" }],',
        "      ],",
        "      required: false,",
        "    }),",
      ),
    );
  });
});

// One emitted module with every construct, written beside the runtime and type-checked, under the
// worktree's git-ignored `work/`.
const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "api-locations-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

const everyConstruct = async (): Promise<string> => {
  const withCookieAndQuerystring = withParameters(
    cookieParameter({ allowReserved: false, explode: true, style: "form" }),
    querystringParameter("application/x-www-form-urlencoded", false),
  );
  const content = await emit({ operations: [withCookieAndQuerystring, formBody(true)] });
  const dir = nodePath.join(work, "package");
  for (const [path, text] of Object.entries(runtimeFiles)) {
    nodeFs.mkdirSync(nodePath.dirname(nodePath.join(dir, "src", path)), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, "src", path), text);
  }

  nodeFs.mkdirSync(nodePath.join(dir, "src/api"), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "src/api/users.ts"), content);
  nodeFs.writeFileSync(
    nodePath.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: generatorTsconfig.compilerOptions, include: ["src"] }),
  );
  nodeFs.symlinkSync(nodePath.join(root, "node_modules"), nodePath.join(dir, "node_modules"));

  return dir;
};

let built: Promise<string> | undefined;

const packaged = () => {
  built ??= everyConstruct();

  return built;
};

type Builder = (input: {
  readonly body: unknown;
}) => Effect.Effect<{ readonly body: HttpBody.HttpBody }, unknown>;

const isBuilder = (value: unknown): value is Builder => Predicate.isFunction(value);

const isJsonNumberClass = (value: unknown): value is typeof JsonNumber =>
  Predicate.isFunction(value);

describe("emitApi: the emitted module against the runtime types", () => {
  test("a module with a cookie, a querystring and a form body type-checks", async () => {
    const packageDir = await packaged();
    const tsc = nodePath.join(root, "node_modules/.bin/tsc");
    const result = Bun.spawnSync(
      [tsc, "--noEmit", "-p", nodePath.join(packageDir, "tsconfig.json")],
      { cwd: packageDir },
    );

    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(result.exitCode).toBe(0);
  }, 120_000);

  test("a JsonNumber form property keeps its digit text", async () => {
    const packageDir = await packaged();
    const emitted: unknown = await import(nodePath.join(packageDir, "src/api/users.ts"));
    // The emitted module's own runtime copy: its encoder recognizes only that copy's class.
    const input: unknown = await import(nodePath.join(packageDir, "src/runtime/input.ts"));
    const Digits =
      Predicate.isObject(input) && "JsonNumber" in input ? input.JsonNumber : undefined;
    expect(isJsonNumberClass(Digits)).toBe(true);
    if (!isJsonNumberClass(Digits)) {
      return;
    }

    const builder =
      Predicate.isObject(emitted) && "sessionsCreate" in emitted
        ? emitted.sessionsCreate
        : undefined;
    expect(isBuilder(builder)).toBe(true);
    if (!isBuilder(builder)) {
      return;
    }

    const request = await Effect.runPromise(
      builder({
        body: { extra: new Digits("1.50"), name: new Digits("12345678901234567890") },
      }),
    );
    const text =
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";

    expect(text).toBe("name=12345678901234567890&extra=1.50");
  });
});
