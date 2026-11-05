import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Array as Arr, Effect, Exit, Order, Schema } from "effect";
import { CliEmitError, emitCli } from "../../src/emit/cli.ts";
import type { CliEmitInput, CliEmitOutput } from "../../src/emit/cli.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
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
    const { api } = yield* normalize(resolution, { config, configDocument });
    const plan = yield* planNames(api, { config, configDocument, strict: false });

    return { api, config, plan };
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
    expect(content).toContain("Command.withSubcommands([UsersCli.group, login])");
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
    expect(content).toContain("Command.withSubcommands([UsersCli.group, health, login])");
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
    expect(rootModule).toContain("Command.withSubcommands([UsersCli.group, login])");
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
  test("a text request body refuses its operation and the rest of the package emits", async () => {
    const output = await emit(
      withPaths({
        ...paths,
        "/notes": {
          post: {
            operationId: "notes-create",
            requestBody: { content: { "text/plain": { schema: { type: "string" } } } },
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
            requestBody: { content: { "text/plain": { schema: { type: "string" } } } },
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

  const int64Bodies: readonly (readonly [string, Schema.Json])[] = [
    ["a scalar int64", { format: "int64", type: "integer" }],
    ["a scalar unsafe bound", { maximum: 1e300, type: "integer" }],
    ["an array of inline int64", { items: { format: "int64", type: "integer" }, type: "array" }],
    ["an array of $ref int64", { items: { $ref: "#/components/schemas/Int64" }, type: "array" }],
    [
      "an array with an unsafe bound",
      { items: { maximum: 1e300, type: "integer" }, type: "array" },
    ],
    [
      "an array with an unsafe exclusive bound",
      { items: { exclusiveMinimum: -1e300, type: "integer" }, type: "array" },
    ],
  ];

  for (const [label, property] of int64Bodies) {
    test(`${label} body field refuses its operation until it has a flag form`, async () => {
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
      expect(refusalsOf(output)).toEqual([
        { path: "/counters", reason: "unsupported-flag", scope: "operation" },
      ]);
      expect(contentOf(output, "src/cli/users.ts")).toBe(read("expected/src/cli/users.ts"));
    });
  }

  test("an array of safe integers is a repeated Flag.Int", async () => {
    const output = await emit(
      withPaths({
        "/counters": bodyOperation("counters-create", "counters", {
          properties: { totals: { items: { maximum: 10, type: "integer" }, type: "array" } },
          type: "object",
        }),
      }),
    );
    expect(output.refusals).toEqual([]);
    expect(contentOf(output, "src/cli/counters.ts")).toContain(
      'Flag.Int("totals").pipe(Flag.atLeast(0))',
    );
  });
});

describe("emitCli: the body field walk", () => {
  test("an integer field whose $ref chain is a cycle is refused, not emitted as Flag.Int", async () => {
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

  test("an integer field past the visit cap is refused, not emitted as Flag.Int", async () => {
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
      const exit = await Effect.runPromiseExit(
        emitted(spec, { ...configJson, commands: { module, names: ["login"] } }),
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
