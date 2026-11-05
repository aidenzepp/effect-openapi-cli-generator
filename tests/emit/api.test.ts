import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
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
    const { api } = yield* normalize(resolution, { config, configDocument });
    const plan = yield* planNames(api, { config, configDocument, strict: false });
    const bound = boundOrigins(
      [...api.servers, ...api.operations.flatMap((operation) => operation.servers)],
      { config, configDocument, document, openapi: api.openapi },
    );

    return { api, bound, plan };
  });

const emit = (value: Schema.Json) =>
  Effect.runPromise(
    pipeline(value).pipe(
      Effect.flatMap(({ api, bound, plan }) => emitApi({ api, boundOrigins: bound.origins, plan })),
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
      Effect.flip(emitApi({ api, boundOrigins: bound.origins, plan: forged })),
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

        return emitApi({ api, boundOrigins: bound.origins, plan });
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
