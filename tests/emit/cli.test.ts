import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Exit, Schema } from "effect";
import { CliEmitError, emitCli } from "../../src/emit/cli.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";

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

const emitted = (value: Schema.Json, configValue: Schema.Json = configJson) =>
  Effect.gen(function* generate() {
    const config = yield* decodeAuthorConfig(configValue, { document: configDocument });
    const resolution = yield* resolve({ document, line: "3.1", value });
    const { api } = yield* normalize(resolution, { config, configDocument });
    const plan = yield* planNames(api, { config, configDocument, strict: false });

    return yield* emitCli({ api, config, plan });
  });

const emit = (value: Schema.Json, configValue?: Schema.Json) =>
  Effect.runPromise(emitted(value, configValue));

const contentOf = (
  files: readonly { readonly content: string; readonly path: string }[],
  path: string,
) => files.find((file) => file.path === path)?.content;

const paths = decodeRecord(spec.paths);

const withPaths = (replacement: Readonly<Record<string, Schema.Json>>): Schema.Json => ({
  ...spec,
  paths: replacement,
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

describe("emitCli: the golden users-update fixture", () => {
  test("cli/users.ts matches the expected module byte for byte", async () => {
    const files = await emit(spec);
    expect(contentOf(files, "src/cli/users.ts")).toBe(read("expected/src/cli/users.ts"));
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
    const files = await emit(spec);
    expect(files.map((file) => file.path)).toEqual(["src/cli/root.ts", "src/cli/users.ts"]);
    expect(await emit(spec)).toEqual(files);
  });
});

describe("emitCli: shapes beyond the fixture", () => {
  test("a single-media operation has no --content-type and no --accept", async () => {
    const files = await emit(withPaths({ "/users/{id}": paths["/users/{id}"] ?? {} }));
    const content = contentOf(files, "src/cli/users.ts") ?? "";
    expect(content).not.toContain("contentType");
    expect(content).not.toContain("Negotiate");
    expect(content).toContain("Effect.flatMap(Output.send(Users.updateMeta))");
  });

  test("an operation without a body sends the builder's request", async () => {
    const files = await emit(
      withPaths({
        "/users": {
          get: {
            operationId: "users-list",
            responses: { "200": { description: "ok" } },
            tags: ["users"],
          },
        },
      }),
    );
    const content = contentOf(files, "src/cli/users.ts") ?? "";
    expect(content).toContain("Users.list().pipe(Effect.flatMap(Output.send(Users.listMeta)))");
    expect(content).not.toContain("Input");
  });

  test("an untagged operation is a root command beside the groups", async () => {
    const files = await emit(
      withPaths({
        ...paths,
        "/health": { get: { operationId: "health", responses: { "200": { description: "ok" } } } },
      }),
    );
    const content = contentOf(files, "src/cli/root.ts") ?? "";
    expect(content).toContain('import * as Root from "../api/root.ts";');
    expect(content).toContain('export const health = Command.make("health", {}, () =>');
    expect(content).toContain("Command.withSubcommands([UsersCli.group, health, login])");
  });

  test("a text request body is refused with a coded error", async () => {
    const exit = await Effect.runPromiseExit(
      emitted(
        withPaths({
          "/notes": {
            post: {
              operationId: "notes-create",
              requestBody: { content: { "text/plain": { schema: { type: "string" } } } },
              responses: { "200": { description: "ok" } },
              tags: ["notes"],
            },
          },
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);

    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
    const failure = error?._tag === "Fail" ? error.error : undefined;
    expect(failure).toBeInstanceOf(CliEmitError);
    expect(failure instanceof CliEmitError ? failure.reason : "").toBe("unsupported-body");
  });

  test("an int64 body field is refused until it has a flag form", async () => {
    const exit = await Effect.runPromiseExit(
      emitted(
        withPaths({
          "/counters": {
            post: {
              operationId: "counters-create",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      properties: { total: { format: "int64", type: "integer" } },
                      type: "object",
                    },
                  },
                },
              },
              responses: { "200": { description: "ok" } },
              tags: ["counters"],
            },
          },
        }),
      ),
    );
    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
    const failure = error?._tag === "Fail" ? error.error : undefined;
    expect(failure instanceof CliEmitError ? failure.reason : "").toBe("unsupported-flag");
  });

  test("an author commands module outside the package is refused", async () => {
    const exit = await Effect.runPromiseExit(
      emitted(spec, { ...configJson, commands: { module: "../outside.ts", names: ["login"] } }),
    );
    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
    const failure = error?._tag === "Fail" ? error.error : undefined;
    expect(failure instanceof CliEmitError ? failure.reason : "").toBe("unsafe-commands-module");
  });

  test("help prose is sanitized before it reaches a string literal", async () => {
    const hostile = decodeRecord(paths["/users/{id}"]);
    const patch = decodeRecord(hostile.patch);
    const files = await emit(
      withPaths({
        "/users/{id}": {
          ...hostile,
          patch: { ...patch, description: "Update\u001B[31m a‮ user." },
        },
      }),
    );
    const content = contentOf(files, "src/cli/users.ts") ?? "";
    expect(content).toContain('Command.withDescription("Update[31m a user.")');
  });
});
