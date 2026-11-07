import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Array as Arr, Effect, Exit, Order, Schema } from "effect";
import { CliEmitError, emitCli } from "../../src/emit/cli.ts";
import type { CliEmitInput, CliEmitOutput } from "../../src/emit/cli.ts";
import { AuthorConfig, decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri, JsonLiteral } from "../../src/model/brands.ts";
import { Api, SchemaStore } from "../../src/model/entities.ts";
import { SafeFileSegment } from "../../src/names/fold.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import { schemeSlug } from "../../src/runtime-src/runtime/auth.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const vp = nodePath.join(root, "node_modules/.bin/vp");

const read = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

const decodeRecord = Schema.decodeUnknownSync(JsonRecord);

const spec = decodeRecord(JSON.parse(read("openapi.json")));

const configJson = decodeRecord(JSON.parse(read("author-config.json")));

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const prepared = (
  value: Schema.Json,
  configValue: Schema.Json = configJson,
  line: "3.1" | "3.2" = "3.1",
) =>
  Effect.gen(function* generate() {
    const config = yield* decodeAuthorConfig(configValue, { document: configDocument });
    const resolution = yield* resolve({ document, line, value });
    const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument });
    const plan = yield* planNames(api, { config, configDocument, strict: false });

    // Every spec here is 3.1 or 3.2, where no `default` is refused (S30-27 is 3.0 only).
    return { api, config, plan, validationEdits: [] };
  });

const emitted = (value: Schema.Json, configValue?: Schema.Json) =>
  prepared(value, configValue).pipe(Effect.flatMap(emitCli));

const emit = (value: Schema.Json, configValue?: Schema.Json) =>
  Effect.runPromise(emitted(value, configValue));

const input = (value: Schema.Json, configValue?: Schema.Json, line?: "3.1" | "3.2") =>
  Effect.runPromise(prepared(value, configValue, line));

const contentOf = (output: CliEmitOutput, path: string) =>
  output.files.find((file) => file.path === path)?.content;

const failureReason = (exit: Exit.Exit<unknown, unknown>): string => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
  const failure = reason?._tag === "Fail" ? reason.error : undefined;

  return failure instanceof CliEmitError ? failure.reason : "";
};

const refusalsOf = (output: CliEmitOutput) =>
  output.refusals.map((refusal) => ({
    path: String(refusal.operation.path),
    reason: refusal.reason,
    scope: refusal.scope,
  }));

const paths = decodeRecord(spec.paths);

const components = decodeRecord(spec.components);

const schemas = decodeRecord(components.schemas);

const withPaths = (replacement: Readonly<Record<string, Schema.Json>>): Schema.Json => ({
  ...spec,
  paths: replacement,
});

const ok = { "200": { description: "ok" } };

const jsonBody = (schema: Schema.Json): Schema.Json => ({
  content: { "application/json": { schema } },
});

const bodyOperation = (operationId: string, tag: string, schema: Schema.Json): Schema.Json => ({
  post: { operationId, requestBody: jsonBody(schema), responses: ok, tags: [tag] },
});

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const format = (text: string) => {
  const result = Bun.spawnSync([vp, "fmt", "--stdin-filepath=tests/emit/printed.ts"], {
    cwd: root,
    stdin: encoder.encode(text),
  });

  return { exitCode: result.exitCode, stdout: decoder.decode(result.stdout) };
};

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

const sorted = (names: readonly string[]) => Arr.sort(names, Order.String);

const counters = (properties: Readonly<Record<string, Schema.Json>>) =>
  input(
    withPaths({
      "/counters": bodyOperation("counters-create", "counters", { properties, type: "object" }),
    }),
  );

// The emitter input with the body schema of `operationId` and extra `$defs` replaced, so the
// field walk meets shapes earlier stages would not hand it.
const withBodyDefs = (
  base: CliEmitInput,
  operationId: string,
  body: Schema.Json,
  extra: Readonly<Record<string, Schema.Json>>,
): CliEmitInput => {
  const operation = base.api.operations.find((candidate) => candidate.operationId === operationId);
  const key = operation?.body?.alternatives[0]?.schema?.key ?? "";
  const { api } = base;
  const stored = decodeRecord(api.schemas.document);
  const defs = decodeRecord(stored.$defs);
  const store = new SchemaStore({
    document: Schema.decodeUnknownSync(JsonLiteral)({
      ...stored,
      $defs: { ...defs, ...extra, [key]: body },
    }),
    origin: api.schemas.origin,
    rows: api.schemas.rows,
  });
  const doctored = new Api({
    documents: api.documents,
    entry: api.entry,
    info: api.info,
    informational: api.informational,
    line: api.line,
    openapi: api.openapi,
    operations: api.operations,
    origin: api.origin,
    rows: api.rows,
    schemas: store,
    securitySchemes: api.securitySchemes,
    servers: api.servers,
    tags: api.tags,
  });

  return { ...base, api: doctored };
};

describe("emitCli: the golden users-update fixture", () => {
  test("cli/users.ts matches the expected module byte for byte", async () => {
    const output = await emit(spec);
    expect(contentOf(output, "src/cli/users.ts")).toBe(read("expected/src/cli/users.ts"));
    expect(output.refusals).toEqual([]);
  });

  test("cli/root.ts registers one credential setting per scheme and exports services", async () => {
    const content = contentOf(await emit(spec), "src/cli/root.ts") ?? "";
    expect(occurrences(content, "Auth.credentialFileSetting(")).toBe(1);
    expect(occurrences(content, 'Auth.credentialFileSetting("bearerAuth")')).toBe(1);
    expect(content).toContain("export const services = Layer.mergeAll(");
    expect(content).toContain('BaseUrl.layer(servers, "EXAMPLE")');
    expect(content).toContain('Auth.layer(security, "EXAMPLE")');
    expect(content).toContain('import { login } from "../../custom/commands.ts";');
    expect(content).toContain('{ load: () => import("./users.ts"), name: "users" }');
    expect(content).toContain("Command.withSubcommands(Arr.appendAll(groups, [login]))");
    for (const setting of [
      "BaseUrl.baseUrlSetting",
      "BaseUrl.serverSetting",
      "BaseUrl.serverVariableSetting",
      "Auth.allowCredentialsForBaseUrl",
      "Output.OutputPath",
      "Output.Force",
      "Output.MaxErrorBytes",
      "Describe.describeFlag",
    ]) {
      expect(occurrences(content, setting)).toBe(1);
    }
  });

  test("cli/root.ts is a vp fmt fixed point", async () => {
    const content = contentOf(await emit(spec), "src/cli/root.ts") ?? "";
    const first = format(content);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe(content);
  }, 30_000);

  test("emits only cli modules, sorted by path, deterministically", async () => {
    const output = await emit(spec);
    expect(output.files.map((file) => file.path)).toEqual(["src/cli/root.ts", "src/cli/users.ts"]);
    expect(await emit(spec)).toEqual(output);
  });
});

describe("emitCli: shapes beyond the fixture", () => {
  test("a single-media operation has no --content-type and no --accept", async () => {
    const output = await emit(withPaths({ "/users/{id}": paths["/users/{id}"] ?? {} }));
    const content = contentOf(output, "src/cli/users.ts") ?? "";
    expect(content).not.toContain("contentType");
    expect(content).not.toContain("Negotiate");
    expect(content).toContain("Effect.flatMap(Output.send(Users.updateMeta))");
  });

  test("a schema folding to Multipart or to its tag is renamed for a multipart body too", async () => {
    const body = {
      properties: { file: { format: "binary", type: "string" } },
      type: "object",
    };
    const outputs = await Promise.all(
      ["Imports", "Multipart"].map(async (name) => ({
        name,
        output: await emit({
          ...spec,
          components: { schemas: { [name]: body } },
          paths: {
            "/imports": {
              post: {
                operationId: "imports-create",
                requestBody: {
                  content: {
                    "multipart/form-data": { schema: { $ref: `#/components/schemas/${name}` } },
                  },
                },
                responses: ok,
                tags: ["imports"],
              },
            },
          },
        }),
      })),
    );
    for (const { name, output } of outputs) {
      expect(contentOf(output, "src/cli/imports.ts")).toContain("Multipart.");
      expect(contentOf(output, "src/cli/imports.ts")).toContain(`${name}2`);
    }
  });

  test("an operation without a body sends the builder's request", async () => {
    const output = await emit(
      withPaths({
        "/users": { get: { operationId: "users-list", responses: ok, tags: ["users"] } },
      }),
    );
    const content = contentOf(output, "src/cli/users.ts") ?? "";
    expect(content).toContain("Users.list().pipe(Effect.flatMap(Output.send(Users.listMeta)))");
    expect(content).not.toContain("Input");
  });

  test("an untagged operation is a root command beside the groups", async () => {
    const output = await emit(
      withPaths({ ...paths, "/health": { get: { operationId: "health", responses: ok } } }),
    );
    const content = contentOf(output, "src/cli/root.ts") ?? "";
    expect(content).toContain('import * as Root from "../api/root.ts";');
    expect(content).toContain('export const health = Command.make("health", {}, () =>');
    expect(content).toContain("Command.withSubcommands(Arr.appendAll(groups, [health, login]))");
  });

  test("a 3.2 child group is listed in its parent's module, not in root", async () => {
    const output = await Effect.runPromise(
      emitCli(
        await input(
          {
            ...spec,
            openapi: "3.2.0",
            paths: {
              ...paths,
              "/admins": { get: { operationId: "admins-list", responses: ok, tags: ["admins"] } },
            },
            tags: [{ name: "users" }, { name: "admins", parent: "users" }],
          },
          configJson,
          "3.2",
        ),
      ),
    );
    expect(output.files.map((file) => file.path)).toEqual([
      "src/cli/admins.ts",
      "src/cli/root.ts",
      "src/cli/users.ts",
    ]);

    const users = contentOf(output, "src/cli/users.ts") ?? "";
    expect(users).toContain('import * as AdminsCli from "./admins.ts";');
    expect(users).toContain("AdminsCli.group]");

    const rootModule = contentOf(output, "src/cli/root.ts") ?? "";
    expect(rootModule).toContain('{ load: () => import("./users.ts"), name: "users" }');
    expect(rootModule).not.toContain("./admins.ts");
    expect(rootModule).toContain("Command.withSubcommands(Arr.appendAll(groups, [login]))");
    expect(rootModule).not.toContain("AdminsCli");
  });

  test("help prose is sanitized before it reaches a string literal", async () => {
    const hostile = decodeRecord(paths["/users/{id}"]);
    const patch = decodeRecord(hostile.patch);
    const output = await emit(
      withPaths({
        "/users/{id}": { ...hostile, patch: { ...patch, description: "Update\u001B[31m a‮ user." } },
      }),
    );
    const content = contentOf(output, "src/cli/users.ts") ?? "";
    expect(content).toContain('Command.withDescription("Update[31m a user.")');
  });

  test("each credential flag is the runtime's <scheme slug>-file", async () => {
    const schemes = {
      "Bearer_Auth.v2": { scheme: "bearer", type: "http" },
      apiKeyHeader: { in: "header", name: "X-Key", type: "apiKey" },
      bearerAuth: { scheme: "bearer", type: "http" },
    };
    const value = {
      ...spec,
      components: { ...components, securitySchemes: schemes },
      paths: {
        ...paths,
        "/keys": {
          get: {
            operationId: "keys-list",
            responses: ok,
            security: [{ "Bearer_Auth.v2": [] }, { apiKeyHeader: [] }],
            tags: ["keys"],
          },
        },
      },
    };
    const base = await input(value);
    expect(sorted(base.plan.credentials.map((credential) => credential.scheme))).toEqual(
      sorted(Object.keys(schemes)),
    );
    for (const credential of base.plan.credentials) {
      expect(credential.flag).toBe(`${schemeSlug(credential.scheme)}-file`);
    }

    const content = contentOf(await Effect.runPromise(emitCli(base)), "src/cli/root.ts") ?? "";
    for (const scheme of Object.keys(schemes)) {
      expect(occurrences(content, `Auth.credentialFileSetting(${JSON.stringify(scheme)})`)).toBe(1);
    }
  });
});

describe("emitCli: operation-scope refusals", () => {
  test("an SSE request body refuses its operation and the rest of the package emits", async () => {
    const output = await emit(
      withPaths({
        ...paths,
        "/notes": {
          post: {
            operationId: "notes-create",
            requestBody: { content: { "text/event-stream": { schema: { type: "string" } } } },
            responses: ok,
            tags: ["notes"],
          },
        },
      }),
    );
    expect(refusalsOf(output)).toEqual([
      { path: "/notes", reason: "unsupported-body", scope: "operation" },
    ]);
    expect(output.files.map((file) => file.path)).toEqual(["src/cli/root.ts", "src/cli/users.ts"]);
    expect(contentOf(output, "src/cli/users.ts")).toBe(read("expected/src/cli/users.ts"));
    expect(contentOf(output, "src/cli/root.ts")).not.toContain("Notes");
  });

  test("a refused command leaves its group's other commands emitted", async () => {
    const output = await emit(
      withPaths({
        ...paths,
        "/users/{id}/note": {
          post: {
            operationId: "users-note",
            parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
            requestBody: { content: { "text/event-stream": { schema: { type: "string" } } } },
            responses: ok,
            tags: ["users"],
          },
        },
      }),
    );
    expect(refusalsOf(output)).toEqual([
      { path: "/users/{id}/note", reason: "unsupported-body", scope: "operation" },
    ]);
    expect(contentOf(output, "src/cli/users.ts")).toBe(read("expected/src/cli/users.ts"));
  });

  test("a boolean path parameter refuses its operation", async () => {
    const output = await emit(
      withPaths({
        ...paths,
        "/flags/{on}": {
          get: {
            operationId: "flags-get",
            parameters: [{ in: "path", name: "on", required: true, schema: { type: "boolean" } }],
            responses: ok,
            tags: ["flags"],
          },
        },
      }),
    );
    expect(refusalsOf(output)).toEqual([
      { path: "/flags/{on}", reason: "unsupported-parameter", scope: "operation" },
    ]);
    expect(output.files.map((file) => file.path)).toEqual(["src/cli/root.ts", "src/cli/users.ts"]);
  });

  test("a required boolean parameter refuses its operation", async () => {
    const output = await emit(
      withPaths({
        ...paths,
        "/toggles": {
          post: {
            operationId: "toggles-set",
            parameters: [
              { in: "query", name: "archived", required: true, schema: { type: "boolean" } },
            ],
            responses: ok,
            tags: ["toggles"],
          },
        },
      }),
    );
    expect(refusalsOf(output)).toEqual([
      { path: "/toggles", reason: "unsupported-flag", scope: "operation" },
    ]);
  });

  const int64Bodies: readonly (readonly [string, Schema.Json, string])[] = [
    ["a scalar int64", { format: "int64", type: "integer" }, 'Input.int64Flag("total").pipe('],
    ["a scalar unsafe bound", { maximum: 1e300, type: "integer" }, 'Input.int64Flag("total")'],
    [
      "an array of inline int64",
      { items: { format: "int64", type: "integer" }, type: "array" },
      'Input.int64Flag("total").pipe(Flag.atLeast(0)',
    ],
    [
      "an array of $ref int64",
      { items: { $ref: "#/components/schemas/Int64" }, type: "array" },
      'Input.int64Flag("total").pipe(Flag.atLeast(0)',
    ],
    [
      "an array with an unsafe bound",
      { items: { maximum: 1e300, type: "integer" }, type: "array" },
      'Input.int64Flag("total").pipe(Flag.atLeast(0)',
    ],
    [
      "an array with an unsafe exclusive bound",
      { items: { exclusiveMinimum: -1e300, type: "integer" }, type: "array" },
      'Input.int64Flag("total").pipe(Flag.atLeast(0)',
    ],
  ];

  for (const [label, property, expected] of int64Bodies) {
    test(`${label} body field is emitted with Input.int64Flag`, async () => {
      const output = await emit({
        ...spec,
        components: {
          ...components,
          schemas: { ...schemas, Int64: { format: "int64", type: "integer" } },
        },
        paths: {
          ...paths,
          "/counters": bodyOperation("counters-create", "counters", {
            properties: { total: property },
            type: "object",
          }),
        },
      });
      expect(output.refusals).toEqual([]);
      expect(contentOf(output, "src/cli/counters.ts")?.replaceAll(/\s+/gu, " ")).toContain(
        expected,
      );
      expect(contentOf(output, "src/cli/users.ts")).toBe(read("expected/src/cli/users.ts"));
    });
  }

  test("a JSON-valued body field is emitted with Input.jsonFlag", async () => {
    const output = await emit(
      withPaths({
        "/counters": bodyOperation("counters-create", "counters", {
          properties: { meta: { type: "object" } },
          type: "object",
        }),
      }),
    );
    expect(output.refusals).toEqual([]);

    const text = contentOf(output, "src/cli/counters.ts");
    expect(text).toContain('Input.jsonFlag("meta")');
    expect(text).not.toContain("Schema.fromJsonString");
  });

  test("an array of safe integers is a repeated integer numeric flag, each a JsonNumber", async () => {
    const output = await emit(
      withPaths({
        "/counters": bodyOperation("counters-create", "counters", {
          properties: { totals: { items: { maximum: 10, type: "integer" }, type: "array" } },
          type: "object",
        }),
      }),
    );
    expect(output.refusals).toEqual([]);
    expect(contentOf(output, "src/cli/counters.ts")?.replaceAll(/\s+/gu, " ")).toContain(
      'Input.numericFlag("totals", "integer").pipe( Flag.map((text) => new Input.JsonNumber(text)), Flag.atLeast(0), )',
    );
  });
});

const xmlOperation = (mediaType: string): Schema.Json => ({
  post: {
    operationId: "feeds-create",
    requestBody: { content: { [mediaType]: { schema: { type: "string" } } }, required: true },
    responses: ok,
    tags: ["feeds"],
  },
});

describe("emitCli: XML request bodies", () => {
  for (const mediaType of ["application/xml", "text/xml"]) {
    test(`a ${mediaType} body is opaque --body-file bytes through Input.binaryBody`, async () => {
      const output = await emit(withPaths({ ...paths, "/feeds": xmlOperation(mediaType) }));
      expect(output.refusals).toEqual([]);

      const text = contentOf(output, "src/cli/feeds.ts") ?? "";
      expect(text).toContain("Input.binaryBody(");
      expect(text).not.toContain("Input.mergeBody(");
      expect(contentOf(output, "src/cli/users.ts")).toBe(read("expected/src/cli/users.ts"));
    });
  }
});

describe("emitCli: the body field walk", () => {
  test("an integer field whose $ref chain is a cycle is refused, not emitted with a guessed width", async () => {
    const base = await counters({ total: { type: "integer" } });
    const doctored = withBodyDefs(
      base,
      "counters-create",
      { properties: { total: { $ref: "#/$defs/a" } }, type: "object" },
      { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } },
    );
    const output = await Effect.runPromise(emitCli(doctored));
    expect(refusalsOf(output)).toEqual([
      { path: "/counters", reason: "unsupported-flag", scope: "operation" },
    ]);
  });

  test("an integer field past the visit cap is refused, not emitted with a guessed width", async () => {
    const base = await counters({ total: { type: "integer" } });
    const hops = 10_050;
    const chain = Object.fromEntries<Schema.Json>([
      ...Array.from(
        { length: hops },
        (_, index) => [`c${index}`, { $ref: `#/$defs/c${index + 1}` }] as const,
      ),
      [`c${hops}`, { type: "integer" }] as const,
    ]);

    const doctored = withBodyDefs(
      base,
      "counters-create",
      { properties: { total: { $ref: "#/$defs/c0" } }, type: "object" },
      chain,
    );
    const output = await Effect.runPromise(emitCli(doctored));
    expect(refusalsOf(output)).toEqual([
      { path: "/counters", reason: "unsupported-flag", scope: "operation" },
    ]);
  });

  test("a string field under a cyclic allOf ends the walk and still emits", async () => {
    const base = await counters({ label: { description: "A label.", type: "string" } });
    const doctored = withBodyDefs(
      base,
      "counters-create",
      { allOf: [{ $ref: "#/$defs/self" }], type: "object" },
      { self: { allOf: [{ $ref: "#/$defs/self" }] } },
    );
    const output = await Effect.runPromise(emitCli(doctored));
    expect(output.refusals).toEqual([]);

    const content = contentOf(output, "src/cli/counters.ts") ?? "";
    expect(content).toContain('Flag.String("label").pipe(Flag.optional)');
    expect(content).not.toContain("A label.");
  });

  test("2,000 properties with 200-value enums emit in linear time", async () => {
    const values = Array.from({ length: 200 }, (_, index) => `value-${index}`);
    const properties: Record<string, Schema.Json> = {};
    for (let index = 0; index < 2000; index += 1) {
      properties[`p${index}`] = { description: `Field ${index}.`, enum: values, type: "string" };
    }

    const base = await counters(properties);
    const started = performance.now();
    const output = await Effect.runPromise(emitCli(base));
    const elapsed = performance.now() - started;
    expect(output.refusals).toEqual([]);
    expect(occurrences(contentOf(output, "src/cli/counters.ts") ?? "", 'Flag.String("p')).toBe(
      2000,
    );
    expect(elapsed).toBeLessThan(5000);
  }, 20_000);
});

describe("emitCli: package-scope refusals", () => {
  for (const module of ["../outside.ts", "/abs/commands.ts", "./a/../x.ts"]) {
    test(`an author commands module ${module} is refused`, async () => {
      // Config decoding refuses these first; this feeds emitCli an already-built config to keep
      // its own check as defense in depth.
      const exit = await Effect.runPromiseExit(
        prepared(spec).pipe(
          Effect.flatMap(({ config: { commands: _declared, ...rest }, ...built }) =>
            emitCli({
              ...built,
              config: new AuthorConfig(
                { ...rest, commands: { module, names: ["login"] } },
                { disableChecks: true },
              ),
            }),
          ),
        ),
      );
      expect(failureReason(exit)).toBe("unsafe-commands-module");
    });
  }

  test("an author command that clashes with a generated binding is refused", async () => {
    const exit = await Effect.runPromiseExit(
      emitted(spec, {
        ...configJson,
        commands: { module: "./custom/commands.ts", names: ["services"] },
      }),
    );
    expect(failureReason(exit)).toBe("name-clash");
  });

  test("a group on a reserved segment is refused", async () => {
    const base = await input(spec);
    const segment = Schema.decodeUnknownSync(SafeFileSegment)("servers");
    const exit = await Effect.runPromiseExit(
      emitCli({
        ...base,
        plan: { ...base.plan, groups: base.plan.groups.map((group) => ({ ...group, segment })) },
      }),
    );
    expect(failureReason(exit)).toBe("reserved-segment");
  });

  test("a group whose parent tag is not planned is refused", async () => {
    const base = await input(spec);
    const exit = await Effect.runPromiseExit(
      emitCli({
        ...base,
        plan: {
          ...base.plan,
          groups: base.plan.groups.map((group) => ({ ...group, parent: "missing" })),
        },
      }),
    );
    expect(failureReason(exit)).toBe("unknown-parent");
  });
});

const metricsOperation = (parameters: readonly Schema.Json[], path = "/emails/{ids}/metrics") =>
  withPaths({
    [path]: { get: { operationId: "metrics", parameters, responses: ok, tags: ["users"] } },
  });

describe("emitCli: array parameters", () => {
  const stringArray = { items: { type: "string" }, type: "array" };
  const ids = { in: "path", name: "ids", required: true, schema: stringArray };
  const queries: readonly Schema.Json[] = [
    {
      explode: false,
      in: "query",
      name: "metrics",
      schema: { items: { enum: ["sent", "opened"], type: "string" }, type: "array" },
      style: "form",
    },
    {
      in: "query",
      name: "tag",
      required: true,
      schema: { items: { type: "integer" }, type: "array" },
    },
    { in: "header", name: "X-Trace", schema: stringArray },
  ];

  test("a query or header array is a repeatable flag passed through as an array", async () => {
    const output = await emit(metricsOperation([ids, ...queries]));
    expect(output.refusals).toEqual([]);

    const text = contentOf(output, "src/cli/users.ts") ?? "";
    expect(text).toContain('metrics: Flag.String("metrics").pipe(Flag.atLeast(0))');
    expect(text).toContain('tag: Input.numericFlag("tag", "integer").pipe(Flag.atLeast(1))');
    expect(text).toContain('xTrace: Flag.String("x-trace").pipe(Flag.atLeast(0))');
    expect(text).toContain("metrics: flags.metrics,");
    expect(text).toContain("tag: flags.tag,");
    expect(text).toContain("xTrace: flags.xTrace,");
    expect(text).not.toContain("Option.getOrUndefined(flags.metrics)");
    expect(contentOf(output, "src/cli/users.ts")).not.toBe(read("expected/src/cli/users.ts"));
  });

  test("a final path array is a positional that takes one or more values", async () => {
    const output = await emit(metricsOperation([ids]));
    expect(output.refusals).toEqual([]);

    const text = contentOf(output, "src/cli/users.ts") ?? "";
    expect(text).toContain('ids: Argument.String("ids").pipe(Argument.atLeast(1))');
    expect(text).toContain("ids: flags.ids");
  });

  test("a path array before another positional refuses its operation", async () => {
    const output = await emit(
      metricsOperation(
        [ids, { in: "path", name: "kind", required: true, schema: { type: "string" } }],
        "/emails/{ids}/{kind}",
      ),
    );
    expect(refusalsOf(output)).toEqual([
      { path: "/emails/{ids}/{kind}", reason: "unsupported-parameter", scope: "operation" },
    ]);
  });
});

const importSchema = {
  properties: {
    count: { format: "int64", type: "integer" },
    file: { description: "The CSV.", format: "binary", type: "string" },
    tags: { items: { type: "string" }, type: "array" },
    title: { type: "string" },
  },
  required: ["file"],
  type: "object",
};

const importsOperation = (content: Readonly<Record<string, Schema.Json>>): Schema.Json => ({
  post: {
    operationId: "imports-create",
    requestBody: { content, required: true },
    responses: ok,
    tags: ["imports"],
  },
});

const multipart = (schema: Schema.Json, encoding?: Schema.Json) => ({
  "multipart/form-data": encoding === undefined ? { schema } : { encoding, schema },
});

const multipartRefusals = async (content: Readonly<Record<string, Schema.Json>>) => {
  const output = await emit(withPaths({ ...paths, "/imports": importsOperation(content) }));

  expect(contentOf(output, "src/cli/imports.ts")).toBeUndefined();
  expect(contentOf(output, "src/cli/users.ts")).toBe(read("expected/src/cli/users.ts"));

  return output.refusals.map((refusal) => ({ reason: refusal.reason, subject: refusal.subject }));
};

describe("emitCli: multipart request bodies", () => {
  test("part flags feed the builder: scalars as lists, file parts opened from a path or -", async () => {
    const output = await emit(
      withPaths({ ...paths, "/imports": importsOperation(multipart(importSchema)) }),
    );
    expect(output.refusals).toEqual([]);

    const text = contentOf(output, "src/cli/imports.ts") ?? "";
    expect(format(text)).toEqual({ exitCode: 0, stdout: text });
    expect(text).toContain('import * as Multipart from "../runtime/multipart.ts";');
    expect(text).toContain('count: Input.int64Flag("count").pipe(Flag.optional),');
    expect(text).toContain(
      'file: Flag.String("file").pipe(Flag.optional, Flag.withDescription("The CSV.")),',
    );
    expect(text).toContain('tags: Flag.String("tags").pipe(Flag.atLeast(0)),');
    expect(text).toContain('title: Flag.String("title").pipe(Flag.optional),');
    expect(text).toContain(
      [
        "    Effect.all({",
        "      count: Effect.succeed(Option.toArray(flags.count)),",
        "      file: Effect.forEach(Option.toArray(flags.file), (source) =>",
        '        Effect.map(Multipart.fileBody("file", source), (bytes) => ({',
        '          filename: Multipart.partFilename(source, "file"),',
        "          stream: bytes,",
        "        })),",
        "      ),",
        "      tags: Effect.succeed(flags.tags),",
        "      title: Effect.succeed(Option.toArray(flags.title)),",
        "    }).pipe(",
        "      Effect.flatMap(",
        "        Serialize.assertFormData({",
        '          flags: { count: "count", file: "file", tags: "tags", title: "title" },',
        '          repeated: ["tags"],',
        "          required: true,",
        "          schema: Paths1importsPostRequestBodyContentMultipart1formDataSchema,",
        "        }),",
        "      ),",
        "      Effect.flatMap((parts) => Imports.create({ body: parts })),",
        "      Effect.flatMap(Output.send(Imports.createMeta)),",
        "    ),",
      ].join("\n"),
    );
    expect(text).toContain(
      'import { Paths1importsPostRequestBodyContentMultipart1formDataSchema } from "../domain/schemas.ts";',
    );
    expect(text).toContain('import * as Serialize from "../runtime/serialize.ts";');
    expect(text).not.toContain("bodyFile");
    expect(text).not.toContain("Input.mergeBody(");
    expect(contentOf(output, "src/cli/users.ts")).toBe(read("expected/src/cli/users.ts"));
  });

  test("a multipart range alternative beside other request media refuses its operation", async () => {
    expect(
      await multipartRefusals({
        "application/json": { schema: { properties: { url: { type: "string" } }, type: "object" } },
        "multipart/*": { schema: importSchema },
      }),
    ).toEqual([{ reason: "unsupported-body", subject: "a multipart/* request body" }]);
  });

  test("a required part the names plan skipped refuses its operation", async () => {
    const schema = {
      properties: { meta: { oneOf: [{ type: "string" }, { type: "integer" }] } },
      required: ["meta"],
      type: "object",
    };

    expect(await multipartRefusals(multipart(schema))).toEqual([
      { reason: "unsupported-body", subject: "a flag for multipart part /meta" },
    ]);
  });

  test("an optional skipped part leaves the other parts emitted", async () => {
    const schema = {
      ...importSchema,
      properties: {
        ...importSchema.properties,
        meta: { oneOf: [{ type: "string" }, { type: "integer" }] },
      },
    };
    const output = await emit(
      withPaths({ ...paths, "/imports": importsOperation(multipart(schema)) }),
    );

    expect(output.refusals).toEqual([]);
    expect(contentOf(output, "src/cli/imports.ts")).not.toContain("meta");
  });

  test("part headers and several part content types are refused, not guessed", async () => {
    const headers = {
      file: { headers: { "X-Rate": { schema: { type: "integer" } } } },
    };
    const types = { file: { contentType: "text/csv, application/json" } };

    expect(await multipartRefusals(multipart(importSchema, headers))).toEqual([
      { reason: "unsupported-body", subject: "part headers for multipart part /file" },
    ]);
    expect(await multipartRefusals(multipart(importSchema, types))).toEqual([
      { reason: "unsupported-body", subject: "one content type for multipart part /file" },
    ]);
  });

  test("a multipart/mixed body is refused", async () => {
    expect(await multipartRefusals({ "multipart/mixed": { schema: importSchema } })).toEqual([
      { reason: "unsupported-body", subject: "a multipart/mixed request body" },
    ]);
  });
});
