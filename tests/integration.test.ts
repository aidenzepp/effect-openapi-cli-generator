import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
let temporary = "";
let application = "";
const requests: { method: string; url: string; body: string; contentType: string | null }[] = [];
const lastRequest = () => {
  const request = requests.at(-1);
  if (request === undefined) {
    throw new Error("Expected a captured HTTP request");
  }
  return request;
};
const server = Bun.serve({
  async fetch(request) {
    requests.push({
      body: await request.text(),
      contentType: request.headers.get("content-type"),
      method: request.method,
      url: request.url,
    });
    if (request.url.includes("/empty")) {
      return new Response(null, { status: 204 });
    }
    if (request.url.includes("/failure")) {
      return new Response("denied", { status: 409 });
    }
    return new Response("exact response");
  },
  port: 0,
});
const interpolation = "globalThis.injected = true";
const hostile = `quote" \` \${${interpolation}} */\n@tag`;
const parameter = (name: string, location: string, type: string, required = false) => ({
  description: hostile,
  in: location,
  name,
  required,
  schema: { type },
});
const operation = (action: string) => ({
  operationId: `items-${action}`,
  parameters: [
    parameter("parent", "path", "string", true),
    parameter("id", "path", "string", true),
    parameter("enabled", "query", "boolean"),
    parameter("count", "query", "integer"),
    parameter("wire_name", "query", "string"),
  ],
  responses: { "200": { description: "OK" } },
  summary: hostile,
  "x-fern-sdk-group-name": "account.deep.items",
  "x-fern-sdk-method-name": action,
});
const document = {
  info: { description: hostile, title: "Sample API", version: "not-semver" },
  openapi: "3.1.0",
  paths: {
    "/alias": {
      post: {
        operationId: "alias-get",
        responses: { "200": { description: "OK" } },
        "x-forge-aliases": [
          { "x-fern-sdk-group-name": "alternate.deep", "x-fern-sdk-method-name": "read" },
        ],
      },
    },
    "/bulk/{parent}/{id}": { post: operation("bulk-update") },
    "/empty": {
      get: {
        operationId: "empty-get",
        responses: { "200": { description: "OK" } },
        "x-fern-sdk-group-name": "empty",
      },
    },
    "/failure": {
      get: {
        operationId: "failure-get",
        responses: { "200": { description: "OK" } },
        "x-fern-sdk-group-name": "failure",
      },
    },
    "/list/{parent}/{id}": { get: operation("list") },
    "/parents/{parent}/items/{id}": {
      post: {
        ...operation("get"),
        requestBody: {
          content: {
            "application/json": {
              schema: {
                properties: {
                  ["__proto__"]: { type: "object" },
                  enabled: {
                    deprecated: true,
                    description: hostile,
                    externalDocs: { url: "https://example.test" },
                    type: "boolean",
                  },
                  [hostile]: { description: hostile, enum: [hostile], type: "string" },
                  nested: {
                    additionalProperties: false,
                    properties: { value: { type: "integer" } },
                    type: "object",
                  },
                  nullable: { enum: ["yes", null], type: ["string", "null"] },
                },
                type: "object",
              },
            },
          },
        },
      },
    },
    "/required": {
      post: {
        operationId: "required-send",
        parameters: [parameter("confirm", "query", "boolean", true)],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                additionalProperties: false,
                properties: { value: { type: "integer" } },
                required: ["value"],
                type: "object",
              },
            },
          },
          required: true,
        },
        responses: { "200": { description: "OK" } },
        "x-fern-sdk-group-name": "required",
      },
    },
  },
};
const run = async (command: string[], cwd = application) => {
  const child = Bun.spawn(command, { cwd, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr, stdout };
};
const success = async (command: string[], cwd = application) => {
  const result = await run(command, cwd);
  expect(result, command.join(" ")).toMatchObject({ code: 0 });
  return result;
};
const cli = (...args: string[]) => run(["node", "dist/main.js", ...args]);
const base = () => `http://127.0.0.1:${server.port}/api`;
const get = (...args: string[]) =>
  cli("account", "deep", "items", "get", "a/b雪", "--parent", "p/q", "--base-url", base(), ...args);
beforeAll(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), "effect-cli-integration-"));
  application = path.join(temporary, "application");
  await writeFile(path.join(temporary, "input.json"), JSON.stringify(document));
  await success(
    ["node", "dist/cli.js", "--input", path.join(temporary, "input.json"), "--output", application],
    root,
  );
  await success(["bun", "install"], application);
  await success(["bun", "run", "build"], application);
}, 120_000);
afterAll(async () => {
  await server.stop(true);
  if (temporary !== "") {
    await rm(temporary, { force: true, recursive: true });
  }
});
test("native help, title, version and completions need no base URL", async () => {
  const help = await cli("--help");
  expect(help.stdout).toContain("Sample API");
  expect(await cli("account", "deep", "items", "--help")).toMatchObject({ code: 0 });
  const version = await cli("--version");
  expect(version.stdout).toContain("0.0.0");
  expect(await cli("--completions", "bash")).toMatchObject({ code: 0 });
  expect(await readFile(path.join(application, "package.json"), "utf-8")).toContain('"sample-api"');
});
test("actual POST preserves base path, encoded values, optional false zero empty and original body", async () => {
  const body =
    '{"enabled":false,"unknown":0,"empty":"","nested":{"value":0},"__proto__":{"safe":true}}';
  expect(
    await get("--enabled", "false", "--count", "0", "--wire-name", "", "--body", body),
  ).toMatchObject({ code: 0, stdout: "exact response" });
  const request = lastRequest();
  expect(request.method).toBe("POST");
  const url = new URL(request.url);
  expect(url.pathname).toBe("/api/parents/p%2Fq/items/a%2Fb%E9%9B%AA");
  expect(url.searchParams.get("enabled")).toBe("false");
  expect(url.searchParams.get("count")).toBe("0");
  expect(url.searchParams.get("wire_name")).toBe("");
  expect(request.body).toBe(body);
  expect(request.contentType).toContain("application/json");
  expect(await get()).toMatchObject({ code: 0 });
  expect(lastRequest().body).toBe("");
  expect(new URL(lastRequest().url).search).toBe("");
  expect(lastRequest().contentType).toBeNull();
});
test.each(["list", "bulk-update"])("%s binds both path values as flags", async (action) => {
  expect(
    await cli(
      "account",
      "deep",
      "items",
      action,
      "--parent",
      "p",
      "--id",
      "i",
      "--base-url",
      base(),
    ),
  ).toMatchObject({ code: 0 });
});
test("aliases preserve HTTP method", async () => {
  expect(await cli("alternate", "deep", "read", "--base-url", base())).toMatchObject({ code: 0 });
  expect(lastRequest().method).toBe("POST");
});
test.each(
  [
    ["--body", "{"],
    ["--body", "@file"],
    ["--body", '{"enabled":"false"}'],
    ["--body", '{"nested":{"extra":1}}'],
    ["--body", "{}", "--body-file", "/missing-body-file"],
    ["--body-file", "/missing-body-file"],
    ["--enabled", "wrong"],
  ].map((args) => ({ args })),
)("invalid input %j sends no request", async ({ args }) => {
  const count = requests.length;
  const result = await get(...args);
  expect(result.code).not.toBe(0);
  expect(requests.length).toBe(count);
});
test("empty success, HTTP failure and refused connection are truthful", async () => {
  expect(await cli("empty", "get", "--base-url", base())).toMatchObject({ code: 0, stdout: "" });
  const failure = await cli("failure", "get", "--base-url", base());
  expect(failure.code).not.toBe(0);
  expect(failure.stderr).toContain("409");
  expect(failure.stderr).toContain("denied");
  const refused = await cli("empty", "get", "--base-url", "http://127.0.0.1:1");
  expect(refused.code).not.toBe(0);
});
test("generated source meets actual repository lint and formatter configuration", async () => {
  const verification = await mkdtemp(path.join(root, ".generated-proof-"));
  await cp(path.join(application, "src"), path.join(verification, "src"), { recursive: true });
  await writeFile(
    path.join(verification, "tsconfig.json"),
    JSON.stringify({ extends: "../tsconfig.json", include: ["src/**/*.ts"] }),
  );
  await writeFile(
    path.join(verification, ".oxfmtrc.json"),
    JSON.stringify({ jsdoc: { commentLineStrategy: "multiline", lineWrappingStyle: "balance" } }),
  );
  const lint = await run(
    ["bunx", "vp", "lint", "--type-aware", path.join(verification, "src")],
    root,
  );
  const format = await run(
    [
      "bunx",
      "oxfmt",
      "--check",
      "--config",
      path.join(verification, ".oxfmtrc.json"),
      path.join(verification, "src"),
    ],
    root,
  );
  await rm(verification, { force: true, recursive: true });
  expect(format).toMatchObject({ code: 0 });
  expect(lint).toMatchObject({ code: 0 });
}, 30_000);

test("required explicit false and body-file preserve values", async () => {
  const file = path.join(temporary, "body.json");
  await writeFile(file, '{"value":0}');
  const before = requests.length;
  const missingFlag = await cli("required", "send", "--base-url", base(), "--body-file", file);
  const missingBody = await cli("required", "send", "--base-url", base(), "--confirm", "false");
  expect(missingFlag.code).not.toBe(0);
  expect(missingBody.code).not.toBe(0);
  expect(requests.length).toBe(before);
  expect(
    await cli("required", "send", "--base-url", base(), "--confirm", "false", "--body-file", file),
  ).toMatchObject({ code: 0 });
  expect(new URL(lastRequest().url).searchParams.get("confirm")).toBe("false");
  expect(lastRequest().body).toBe('{"value":0}');
});
test("malformed JSON file fails without a request", async () => {
  const file = path.join(temporary, "malformed.json");
  await writeFile(file, "{");
  const count = requests.length;
  const result = await get("--body-file", file);
  expect(result.code).not.toBe(0);
  expect(requests.length).toBe(count);
});
test("nullable scalar enum accepts null and its declared string", async () => {
  expect(await get("--body", '{"nullable":null}')).toMatchObject({ code: 0 });
  expect(lastRequest().body).toBe('{"nullable":null}');
  expect(await get("--body", '{"nullable":"yes"}')).toMatchObject({ code: 0 });
  const count = requests.length;
  const invalid = await get("--body", '{"nullable":"no"}');
  expect(invalid.code).not.toBe(0);
  expect(requests.length).toBe(count);
});
test("invalid base URL and dot subject cannot send requests", async () => {
  const count = requests.length;
  const badBase = await cli("empty", "get", "--base-url", "file:///tmp");
  const dot = await cli(
    "account",
    "deep",
    "items",
    "get",
    "..",
    "--parent",
    "p",
    "--base-url",
    base(),
  );
  expect(badBase.code).not.toBe(0);
  expect(dot.code).not.toBe(0);
  expect(requests.length).toBe(count);
});
test("generator explicit name overrides title", async () => {
  const target = path.join(temporary, "renamed");
  await success(
    [
      "node",
      "dist/cli.js",
      "--input",
      path.join(temporary, "input.json"),
      "--output",
      target,
      "--name",
      "explicit-api",
    ],
    root,
  );
  expect(await readFile(path.join(target, "package.json"), "utf-8")).toContain('"explicit-api"');
});
test("SIGINT closes the in-flight HTTP request", async () => {
  const received = Promise.withResolvers<boolean>();
  const aborted = Promise.withResolvers<boolean>();
  const response = Promise.withResolvers<Response>();
  const delayed = Bun.serve({
    fetch(request) {
      request.signal.addEventListener(
        "abort",
        () => {
          aborted.resolve(true);
          response.resolve(new Response(null, { status: 204 }));
        },
        { once: true },
      );
      received.resolve(true);
      return response.promise;
    },
    port: 0,
  });
  const child = Bun.spawn(
    ["node", "dist/main.js", "empty", "get", "--base-url", `http://127.0.0.1:${delayed.port}`],
    { cwd: application, stderr: "pipe", stdout: "pipe" },
  );
  const arrived = await Promise.race([
    received.promise.then(() => true),
    Bun.sleep(4000).then(() => false),
  ]);
  child.kill("SIGINT");
  const closed = await Promise.race([
    aborted.promise.then(() => true),
    Bun.sleep(4000).then(() => false),
  ]);
  const exit = await child.exited;
  await delayed.stop(true);
  expect(arrived).toBe(true);
  expect(closed).toBe(true);
  expect(exit).not.toBe(0);
}, 12_000);

test("hostile declared property strings remain executable data", async () => {
  const body = JSON.stringify({ [hostile]: hostile });
  expect(await get("--body", body)).toMatchObject({ code: 0 });
  expect(lastRequest().body).toBe(body);
  const source = await readFile(path.join(application, "src/main.ts"), "utf-8");
  expect(source).toContain("@deprecated");
  expect(source).toContain("@see");
  expect(source).toContain("\\@tag");
});

test("query values encode reserved characters and Unicode", async () => {
  expect(await get("--wire-name", "a /雪")).toMatchObject({ code: 0 });
  const url = new URL(lastRequest().url);
  expect(url.searchParams.get("wire_name")).toBe("a /雪");
  expect(url.search).toContain("%2F%E9%9B%AA");
});
