import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Server } from "../../src/model/entities.ts";
import { normalize } from "../../src/normalize/index.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { planNames } from "../../src/names/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import { emitApi, inputKeys } from "../../src/emit/api.ts";
import { SafeFileSegment } from "../../src/names/fold.ts";

const fixture = nodePath.resolve(import.meta.dir, "../fixtures/golden/users-update");

const read = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

const decodeRecord = Schema.decodeUnknownSync(JsonRecord);

const spec = decodeRecord(JSON.parse(read("openapi.json")));

const configJson = decodeJson(JSON.parse(read("author-config.json")));

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const pipeline = (value: Schema.Json) =>
  Effect.gen(function* generate() {
    const config = yield* decodeAuthorConfig(configJson, { document: configDocument });
    const resolution = yield* resolve({ document, line: "3.1", value });
    const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument });
    const plan = yield* planNames(api, { config, configDocument, strict: false });
    const context = { config, configDocument, document, openapi: api.openapi };
    const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;

    return { api, bound, plan };
  });

const emit = (value: Schema.Json) =>
  Effect.runPromise(
    pipeline(value).pipe(
      Effect.flatMap(({ api, bound, plan }) => emitApi({ api, boundOrigins: bound, plan })),
    ),
  );

const planOf = (value: Schema.Json) => Effect.runPromise(pipeline(value)).then(({ plan }) => plan);

const contentOf =
  (files: readonly { readonly content: string; readonly path: string }[]) =>
  (path: string): string | undefined =>
    files.find((file) => file.path === path)?.content;

const paths = decodeRecord(spec.paths);

// The golden spec with its paths replaced, its other members kept.
const withPaths = (replacement: Readonly<Record<string, Schema.Json>>): Schema.Json => ({
  ...spec,
  paths: replacement,
});

const ok = { "200": { description: "ok" } };

describe("emitApi: the golden users-update fixture", () => {
  test("reproduces expected/src/api/users.ts and expected/src/api/servers.ts byte for byte", async () => {
    const content = contentOf(await emit(spec));

    expect(content("src/api/users.ts")).toBe(read("expected/src/api/users.ts"));
    expect(content("src/api/servers.ts")).toBe(read("expected/src/api/servers.ts"));
  });

  test("emits api/security.ts with every planned scheme and its environment name", async () => {
    const content = contentOf(await emit(spec));

    expect(content("src/api/security.ts")).toBe(
      [
        'import type { SecurityTable } from "../runtime/auth.ts";',
        "",
        "export const security: SecurityTable = {",
        '  schemes: { bearerAuth: { env: "EXAMPLE_BEARER_AUTH", kind: "http", scheme: "bearer" } },',
        "};",
        "",
      ].join("\n"),
    );
  });

  test("emits one module per group plus servers and security, sorted by path", async () => {
    const files = await emit(spec);

    expect(files.map((file) => file.path)).toEqual([
      "src/api/security.ts",
      "src/api/servers.ts",
      "src/api/users.ts",
    ]);
  });

  test("output is deterministic", async () => {
    expect(await emit(spec)).toEqual(await emit(spec));
  });
});

describe("emitApi: shapes beyond the fixture", () => {
  test("a group whose file segment is a fixed api/ module is refused by the names plan", async () => {
    const renamed = withPaths({
      "/users/{id}": {
        patch: {
          ...decodeRecord(decodeRecord(paths["/users/{id}"]).patch),
          tags: ["servers"],
        },
      },
    });
    const plan = await planOf(renamed);
    const refusals = plan.diagnostics.filter(
      (diagnostic) => diagnostic.code === "TAG-02/reserved-segment",
    );

    expect(refusals.map((diagnostic) => diagnostic.severity)).toEqual(["refusal"]);
    expect(plan.groups.map((group) => group.segment)).not.toContain("servers");

    const files = await emit(renamed);

    expect(files.map((file) => file.path)).toEqual(["src/api/security.ts", "src/api/servers.ts"]);
  });

  test("emitApi refuses a reserved group segment in a plan built by hand", async () => {
    const { api, bound, plan } = await Effect.runPromise(pipeline(spec));
    const reserved = Schema.decodeUnknownSync(SafeFileSegment)("servers");
    const forged = {
      ...plan,
      groups: plan.groups.map((group) => ({ ...group, segment: reserved })),
    };
    const error = await Effect.runPromise(
      Effect.flip(emitApi({ api, boundOrigins: bound, plan: forged })),
    );

    expect(error._tag).toBe("ApiEmitError");
    expect(error._tag === "ApiEmitError" ? error.reason : undefined).toBe("reserved-segment");
  });

  test("an operation without a body omits body, and an operation override adds servers", async () => {
    const content = contentOf(
      await emit(
        withPaths({
          "/ping": {
            get: {
              operationId: "ping",
              responses: ok,
              servers: [{ url: "https://ping.example.com" }],
              tags: ["users"],
            },
          },
        }),
      ),
    );
    const users = content("src/api/users.ts") ?? "";

    expect(users).toContain(
      'export const ping = (): Serialize.Request =>\n  Serialize.request("GET", { headers: [], path: Serialize.path("/ping", []), query: [] });',
    );
    expect(users).not.toContain("PingInput");
    expect(users).not.toContain("body");
    expect(users).toContain('servers: [{ url: "https://ping.example.com" }]');
  });

  test("a single range request key takes its concrete content type from the input", async () => {
    const content = contentOf(
      await emit(
        withPaths({
          "/upload": {
            post: {
              operationId: "upload",
              requestBody: {
                content: { "image/*": { schema: { format: "binary", type: "string" } } },
                required: true,
              },
              responses: ok,
              tags: ["users"],
            },
          },
        }),
      ),
    );
    const users = content("src/api/users.ts") ?? "";

    expect(users).toContain("readonly contentType: string;");
    expect(users).toContain("Serialize.body(input.contentType, input.body)");
  });

  test("an XML body is sent under its declared media type", async () => {
    const content = contentOf(
      await emit(
        withPaths({
          "/feeds": {
            post: {
              operationId: "feeds-create",
              requestBody: { content: { "text/xml": { schema: { type: "string" } } } },
              responses: ok,
              tags: ["feeds"],
            },
          },
        }),
      ),
    );

    expect(content("src/api/feeds.ts")).toContain('Serialize.body("text/xml", input.body)');
  });

  test("input keys fold wire names and rename a repeat by suffix, flag-unaware", async () => {
    const { api } = await Effect.runPromise(
      pipeline(
        withPaths({
          "/things/{id}": {
            get: {
              operationId: "things-get",
              parameters: [
                { in: "path", name: "id", required: true, schema: { type: "string" } },
                { in: "query", name: "id", schema: { type: "string" } },
                { in: "header", name: "X-Request-Id", schema: { type: "string" } },
                { in: "query", name: "body", schema: { type: "string" } },
              ],
              responses: ok,
            },
          },
        }),
      ),
    );
    const [operation] = api.operations;
    if (operation === undefined) {
      throw new Error("fixture operation is missing");
    }

    expect(inputKeys(operation).map(({ key }) => key)).toEqual([
      "id",
      "id2",
      "xRequestId",
      "body2",
    ]);
  });
});

// The golden API and plan with every operation's origin document replaced. The plan's commands
// hold the api's own operation objects, so replacing the origin's document in place reaches both.
const emitFrom = (uri: string) =>
  Effect.runPromise(
    pipeline(spec).pipe(
      Effect.flatMap(({ api, bound, plan }) => {
        for (const operation of api.operations) {
          Object.defineProperty(operation.origin, "document", { value: uri });
        }

        return emitApi({ api, boundOrigins: bound, plan });
      }),
    ),
  );

const emittedText = (files: readonly { readonly content: string }[]): string =>
  files.map((file) => file.content).join("\n");

describe("emitApi: document labels carry no credentials", () => {
  test("a cross-origin document keeps only its origin and path", async () => {
    const text = emittedText(await emitFrom("https://user:pw@other.example/spec.yaml?token=abc#x"));

    expect(text).toContain('document: "https://other.example/spec.yaml"');
    for (const secret of ["user:pw", "pw@", "token", "abc", "#x", "spec.yaml?"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("user:pw");
    expect(text).not.toContain("token=abc");
  });

  test("a same-origin relative path drops its query and fragment", async () => {
    const text = emittedText(await emitFrom("file:///golden/shared/types.json?token=abc#frag"));

    expect(text).toContain('document: "shared/types.json"');
    expect(text).not.toContain("token");
    expect(text).not.toContain("frag");
  });

  test("an unparseable document yields the fixed placeholder", async () => {
    const text = emittedText(await emitFrom("not a uri?token=abc"));

    expect(text).toContain('document: "<unparsed-document>"');
    expect(text).not.toContain("token");
  });
});

// An operation with array parameters of scalar items (design 6.1): a non-exploded form query
// array, an exploded required one, a header array, and a path array.
const arrayParameters = withPaths({
  "/emails/{ids}/metrics": {
    get: {
      operationId: "metrics",
      parameters: [
        {
          in: "path",
          name: "ids",
          required: true,
          schema: { items: { type: "string" }, type: "array" },
        },
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
        { in: "header", name: "X-Trace", schema: { items: { type: "string" }, type: "array" } },
      ],
      responses: ok,
      tags: ["users"],
    },
  },
});

describe("emitApi: array parameters", () => {
  test("an array of scalar items is a readonly string[] input, required or optional", async () => {
    const users = contentOf(await emit(arrayParameters))("src/api/users.ts") ?? "";

    expect(users).toContain(
      [
        "export interface MetricsInput {",
        "  readonly ids: readonly string[];",
        "  readonly metrics?: readonly string[] | undefined;",
        "  readonly tag: readonly string[];",
        "  readonly xTrace?: readonly string[] | undefined;",
        "}",
      ].join("\n"),
    );
  });

  test("each array is serialized by its location's style with its explode setting", async () => {
    const users = contentOf(await emit(arrayParameters))("src/api/users.ts") ?? "";

    expect(users).toContain(
      'Serialize.header("X-Trace", input.xTrace, { explode: false, required: false })',
    );
    expect(users).toContain(
      'Serialize.simple("ids", input.ids, { allowReserved: false, explode: false })',
    );
    expect(users).toContain(
      [
        '      Serialize.form("metrics", input.metrics, {',
        "        allowReserved: false,",
        "        explode: false,",
        "        required: false,",
        "      }),",
        '      Serialize.form("tag", input.tag, { allowReserved: false, explode: true, required: true }),',
      ].join("\n"),
    );
  });
});

const importsPath = (content: Schema.Json, required: boolean) => ({
  "/imports": {
    post: {
      operationId: "imports-create",
      requestBody: { content, required },
      responses: ok,
      tags: ["imports"],
    },
  },
});

// Declared out of name order, so the Encoding order is visible in the builder.
const importSchema = {
  properties: Object.fromEntries([
    ["title", { type: "string" }],
    ["file", { contentMediaType: "text/csv", type: "string" }],
    ["tags", { items: { type: "string" }, type: "array" }],
  ]),
  type: "object",
};

describe("emitApi: multipart request bodies", () => {
  test("the builder streams the part values through Serialize.formData in Encoding order", async () => {
    const content = contentOf(
      await emit(
        withPaths(
          importsPath(
            {
              "multipart/form-data": {
                encoding: { file: { contentType: "text/csv" } },
                schema: importSchema,
              },
            },
            true,
          ),
        ),
      ),
    );

    expect(content("src/api/imports.ts")).toContain(
      [
        "export interface CreateInput {",
        "  readonly body: Serialize.FormFields;",
        "}",
        "",
        "/**",
        " * Request builder for imports create, not an HttpApi definition.",
        " */",
        "export const create = (input: CreateInput): Serialize.Request =>",
        '  Serialize.request("POST", {',
        "    body: Serialize.formData(input.body, {",
        "      parts: [",
        '        ["title", "text/plain"],',
        '        ["file", "text/csv"],',
        '        ["tags", "text/plain"],',
        "      ],",
        "      required: true,",
        "    }),",
      ].join("\n"),
    );
  });

  test("an optional multipart body is marked optional", async () => {
    const content = contentOf(
      await emit(
        withPaths(importsPath({ "multipart/form-data": { schema: importSchema } }, false)),
      ),
    );

    expect(content("src/api/imports.ts")).toContain("required: false,");
  });

  test("a multipart range alternative is left out of the builder's table, never sent as raw bytes", async () => {
    const content = contentOf(
      await emit(
        withPaths(
          importsPath(
            {
              "application/json": { schema: { type: "object" } },
              "multipart/*": { schema: importSchema },
            },
            true,
          ),
        ),
      ),
    );

    expect(content("src/api/imports.ts")).toContain("Serialize.alternatives(input.body, {");
    expect(content("src/api/imports.ts")).not.toContain('multipart/*": (');
    expect(content("src/api/imports.ts")).not.toContain("formData");
    expect(content("src/api/imports.ts")).not.toContain("input.contentType");
  });

  test("a part listing several types travels with its chosen type in the alternative's form", async () => {
    const content = contentOf(
      await emit(
        withPaths(
          importsPath(
            {
              "application/json": { schema: { type: "object" } },
              "multipart/form-data": {
                encoding: { file: { contentType: "text/csv, application/json" } },
                schema: importSchema,
              },
            },
            true,
          ),
        ),
      ),
    );
    const api = content("src/api/imports.ts") ?? "";

    expect(api).toContain(
      ['export type CreateFormFileContentType = "text/csv" | "application/json";', "", "/**"].join(
        "\n",
      ),
    );
    expect(api).toContain(
      [
        "export interface CreateForm {",
        "  readonly fields: Serialize.FormFields;",
        "  readonly file?: Serialize.ChosenPart<CreateFormFileContentType> | undefined;",
        "}",
      ].join("\n"),
    );
    expect(api).toContain('  readonly "multipart/form-data": CreateForm;');
    expect(api).toContain(
      [
        "export interface CreateInput {",
        "  readonly body: Serialize.Chosen<CreateBodies>;",
        "}",
      ].join("\n"),
    );
    expect(api).toContain(
      [
        '      "multipart/form-data": (body: CreateForm) =>',
        "        Serialize.formData(body.fields, {",
        "          parts: [",
        '            ["title", "text/plain"],',
        '            ["file", body.file],',
        '            ["tags", "text/plain"],',
        "          ],",
      ].join("\n"),
    );
  });

  test("a part listing ten types prints its union as a broken alias, not one long field", async () => {
    const types = [
      "application/json",
      "application/pdf",
      "application/zip",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
      "text/csv",
      "text/html",
      "text/plain",
    ];
    const content = contentOf(
      await emit(
        withPaths(
          importsPath(
            {
              "multipart/form-data": {
                encoding: { file: { contentType: types.join(", ") } },
                schema: importSchema,
              },
            },
            true,
          ),
        ),
      ),
    );
    const api = content("src/api/imports.ts") ?? "";

    expect(api).toContain(
      ["export type CreateFormFileContentType =", ...types.map((type) => `  | "${type}"`)].join(
        "\n",
      ),
    );
    expect(api).toContain(
      "  readonly file?: Serialize.ChosenPart<CreateFormFileContentType> | undefined;",
    );
    expect(api.split("\n").every((line) => line.length <= 100)).toBe(true);
  });

  test("a part with a declared header travels keyed, typed by its one content type", async () => {
    const content = contentOf(
      await emit(
        withPaths(
          importsPath(
            {
              "multipart/form-data": {
                encoding: {
                  file: {
                    contentType: "text/csv",
                    headers: { "X-Checksum": { required: true, schema: { type: "string" } } },
                  },
                },
                schema: importSchema,
              },
            },
            true,
          ),
        ),
      ),
    );
    const api = content("src/api/imports.ts") ?? "";

    expect(api).toContain('  readonly file?: Serialize.ChosenPart<"text/csv"> | undefined;');
    expect(api).toContain('["file", input.body.file],');
    expect(api).not.toContain("ContentType =");
  });
});

const formMedia = "application/x-www-form-urlencoded";

const accountSchema = {
  properties: { metadata: { type: "object" }, name: { type: "string" } },
  type: "object",
};

const accounts = (content: Readonly<Record<string, Schema.Json>>) =>
  withPaths({
    "/accounts": {
      post: {
        operationId: "accounts-update",
        requestBody: { content },
        responses: ok,
        tags: ["accounts"],
      },
    },
  });

// The pipeline's API with `refusedFields` set on the form alternative, as normalize will set it
// (m3-fl6). The plan's commands hold the api's own operation objects, so the change reaches both.
const emitRefusing = (value: Schema.Json, refusedFields: readonly string[] | undefined) =>
  Effect.runPromise(
    pipeline(value).pipe(
      Effect.flatMap(({ api, bound, plan }) => {
        for (const operation of api.operations) {
          for (const alternative of operation.body?.alternatives ?? []) {
            if (alternative.mediaType === formMedia && refusedFields !== undefined) {
              Object.defineProperty(alternative, "refusedFields", { value: refusedFields });
            }
          }
        }

        return emitApi({ api, boundOrigins: bound, plan });
      }),
    ),
  ).then((files) => contentOf(files)("src/api/accounts.ts") ?? "");

describe("emitApi: refused body fields", () => {
  test("the media declaration lists the refused fields once and the serializer reads that list", async () => {
    const content = await emitRefusing(accounts({ [formMedia]: { schema: accountSchema } }), [
      "metadata",
    ]);

    expect(content).toContain(
      [
        "const updateMedia: MediaDeclaration = {",
        '  refused: { "application/x-www-form-urlencoded": ["metadata"] },',
        '  request: ["application/x-www-form-urlencoded"],',
      ].join("\n"),
    );
    expect(content).toContain("refused: updateMedia.refused,");
    expect(content.match(/"metadata"\]/gu)?.length).toBe(1);
  });

  test("a form alternative chosen among several passes the same list to its serializer", async () => {
    const content = await emitRefusing(
      accounts({
        "application/json": { schema: accountSchema },
        [formMedia]: { schema: accountSchema },
      }),
      ["metadata"],
    );

    expect(content).toContain("refused: updateMedia.refused,");
  });

  test.each([
    ["no refused fields", undefined],
    ["an empty refused list", []],
  ])("an operation with %s emits no refused list", async (_, refusedFields) => {
    const content = await emitRefusing(
      accounts({ [formMedia]: { schema: accountSchema } }),
      refusedFields,
    );

    expect(content).toContain("Serialize.urlEncoded(");
    expect(content).not.toContain("refused");
  });
});
