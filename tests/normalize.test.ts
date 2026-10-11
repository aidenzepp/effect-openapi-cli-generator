import { expect, test } from "bun:test";
import { Effect } from "effect";
import { normalize } from "../src/normalize.js";

const operation = (extra: Record<string, unknown> = {}) => ({
  operationId: "things_get",
  "x-fern-sdk-group-name": "things",
  responses: { "200": { description: "OK" } },
  ...extra,
});
const document = (
  op: Record<string, unknown> = {},
  path = "/things",
  extra: Record<string, unknown> = {},
) => ({
  openapi: "3.1.0",
  info: { title: "Things", version: "today" },
  paths: { [path]: { post: operation(op) } },
  ...extra,
});
const run = (value: unknown) => Effect.runSync(normalize(value));
const fail = (value: unknown) => Effect.runSync(Effect.flip(normalize(value)));
const parameter = (name: string, location = "query", type = "string") => ({
  name,
  in: location,
  required: location === "path",
  schema: { type },
});

test("preserves HTTP method, docs, parameter order, values and input", () => {
  const input = document(
    {
      summary: "Get things",
      description: "Details",
      deprecated: true,
      externalDocs: { url: "https://example.com" },
      parameters: [
        parameter("itemId", "path"),
        parameter("parentId", "path"),
        parameter("isReady", "query", "boolean"),
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: { type: "object", properties: { value: { type: "boolean", default: false } } },
          },
        },
      },
    },
    "/parents/{parentId}/things/{itemId}",
  );
  const before = JSON.stringify(input);
  const result = run(input).operations[0]!;
  expect(result.method).toBe("POST");
  expect(result.commandPath).toEqual(["things", "get"]);
  expect(result.parameters.map((p) => [p.wireName, p.flagName, p.binding])).toEqual([
    ["parentId", "parent-id", "flag"],
    ["itemId", "item-id", "argument"],
    ["isReady", "is-ready", "flag"],
  ]);
  expect(result.docs.description).toBe("Get things\nDetails");
  expect(result.docs.deprecated).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
});

test("list and bulk actions keep all path parameters as flags", () => {
  for (const action of ["list", "bulk", "bulk-delete"])
    expect(
      run(
        document(
          { "x-fern-sdk-method-name": action, parameters: [parameter("id", "path")] },
          "/things/{id}",
        ),
      ).operations[0]!.parameters[0]!.binding,
    ).toBe("flag");
});

test("operation parameters override path-item parameters", () => {
  const input = document({}, "/things");
  const result = run({
    ...input,
    paths: {
      "/things": {
        parameters: [{ ...parameter("q"), content: { "text/plain": {} } }],
        post: operation({ parameters: [parameter("q", "query", "integer")] }),
      },
    },
  });
  expect(result.operations[0]!.parameters[0]!.schema.kind).toBe("integer");
});

test("checks only selected requests and permits operation security override", () => {
  const input = document({ security: [] }, "/things", { security: [{ token: [] }] });
  expect(run(input).operations).toHaveLength(1);
  expect(
    run({
      ...input,
      paths: {
        ...input.paths,
        "/unused": {
          get: { operationId: "unused", parameters: [{ in: "header" }], callbacks: {} },
        },
      },
    }).operations,
  ).toHaveLength(1);
  expect(fail(document({ parameters: [parameter("x", "header")] })).code).toBe("unsupported");
});

test("rejects command duplicates and prefix conflicts", () => {
  for (const other of [
    operation(),
    operation({ "x-fern-sdk-group-name": "things.get", "x-fern-sdk-method-name": "child" }),
  ])
    expect(
      fail(
        document({}, "/things", { paths: { "/a": { post: operation() }, "/b": { post: other } } }),
      ).message,
    ).toContain("command");
});

test("rejects effective flag collisions including native negations", () => {
  for (const name of [
    "baseUrl",
    "body",
    "bodyFile",
    "help",
    "h",
    "version",
    "v",
    "wizard",
    "completions",
    "logLevel",
    "noHelp",
    "noVersion",
    "noWizard",
  ])
    expect(fail(document({ parameters: [parameter(name)] })).location).toContain("parameters");
  expect(
    fail(document({ parameters: [parameter("fooBar"), parameter("foo_bar")] })).message,
  ).toContain("flag");
  expect(
    run(document({ parameters: [parameter("active", "query", "boolean"), parameter("no-active")] }))
      .operations,
  ).toHaveLength(1);
});

test("rejects unsupported request boundaries", () => {
  for (const op of [
    { security: [{ token: [] }] },
    { callbacks: {} },
    { parameters: [parameter("q", "query", "object")] },
    { parameters: [{ ...parameter("q"), schema: { type: ["string", "null"] } }] },
    { parameters: [{ ...parameter("q"), style: "deepObject" }] },
    { parameters: [{ ...parameter("q"), allowReserved: true }] },
    { requestBody: { content: { "text/plain": { schema: { type: "string" } } } } },
    { responses: { "200": { description: "ok", links: {} } } },
  ])
    expect(fail(document(op)).code).toBe("unsupported");
});

test("rejects malformed paths, missing parameters, duplicate templates, and GET bodies", () => {
  for (const path of [
    "/a/../b",
    "/a/%2E./b",
    "/a\\b",
    "/a?x",
    "/a#x",
    "/a b",
    "/a/{bad",
    "//host/a",
  ])
    expect(fail(document({}, path)).location).toContain("paths");
  expect(fail(document({}, "/a/{id}")).message).toContain("parameter");
  const body = { content: { "application/json": { schema: { type: "string" } } } };
  expect(
    fail(document({}, "/a", { paths: { "/a": { get: operation({ requestBody: body }) } } })).code,
  ).toBe("unsupported");
  expect(
    fail(
      document({}, "/a", {
        paths: {
          "/a/{id}": { post: operation({ parameters: [parameter("id", "path")] }) },
          "/a/{other}": {
            post: operation({
              parameters: [parameter("other", "path")],
              "x-fern-sdk-method-name": "other",
            }),
          },
        },
      }),
    ).message,
  ).toContain("template");
});

test("resolves reusable parameters and bodies and rejects ref siblings", () => {
  const input = document(
    {
      parameters: [{ $ref: "#/components/parameters/Q" }],
      requestBody: { $ref: "#/components/requestBodies/B" },
    },
    "/things",
    {
      components: {
        parameters: { Q: parameter("q") },
        requestBodies: {
          B: { required: true, content: { "application/json": { schema: { type: "string" } } } },
        },
      },
    },
  );
  expect(run(input).operations[0]!.body!.required).toBe(true);
  expect(fail(document({ parameters: [{ $ref: "#/x", required: false }] })).code).toBe(
    "unsupported",
  );
});

test("rejects empty selection and malformed root", () => {
  expect(fail(document({ "x-forge-aliases": [] })).message).toContain("selected");
  for (const value of [
    null,
    {},
    document({}, "/a", { openapi: "2.0" }),
    document({}, "/a", { info: { title: "x" } }),
  ])
    expect(fail(value)._tag).toBe("GenerationError");
});
