import { describe, expect, test } from "bun:test";
import { Array as Arr, Effect, Exit, Order, Schema } from "effect";
import { emitDomainSchemas } from "../../src/emit/domain.ts";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Api } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import type { NamePlan, PlannedCommand } from "../../src/names/index.ts";
import { fixedNamespaces } from "../../src/names/domain.ts";

type Json = Schema.Json;

const document = "file:///spec/openapi.json";

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///spec/author-config.json");

const escape = (token: string): string => token.replaceAll("~", "~0").replaceAll("/", "~1");

interface ParameterInput {
  readonly in: "cookie" | "header" | "path" | "query";
  readonly name: string;
  readonly schema?: string;
}

interface OperationInput {
  readonly body?: readonly {
    readonly codec?: string;
    readonly media: string;
    readonly schema?: string;
  }[];
  readonly method?: string;
  readonly operationId?: string;
  readonly parameters?: readonly ParameterInput[];
  readonly path: string;
  readonly security?: readonly (readonly string[])[];
  readonly tags?: readonly string[];
}

interface ApiInput {
  readonly defs?: Readonly<Record<string, Json>>;
  readonly operations: readonly OperationInput[];
  readonly schemes?: readonly { readonly kind: Json; readonly name: string }[];
  readonly tags?: readonly { readonly name: string; readonly parent?: string }[];
}

const origin = (pointer: string) => ({ document, pointer });

const operationPointer = (input: OperationInput): string =>
  `/paths/${escape(input.path)}/${(input.method ?? "get").toLowerCase()}`;

const parameterJson = (home: string, parameter: ParameterInput, index: number): Json => ({
  deprecated: false,
  docs: {},
  location: parameter.in,
  origin: origin(`${home}/parameters/${index}`),
  required: parameter.in === "path",
  rows: [],
  schema: { key: parameter.schema ?? "string" },
  serialization: {
    allowReserved: false,
    explode: parameter.in === "query",
    kind: "style",
    origin: origin(`${home}/parameters/${index}`),
    rows: [],
    rules: "3.1",
    style: parameter.in === "query" ? "form" : "simple",
  },
  wireName: parameter.name,
});

const operationJson = (input: OperationInput): Json => {
  const home = operationPointer(input);
  const base = {
    deprecated: false,
    docs: {},
    key: { method: input.method ?? "GET", path: input.path },
    origin: origin(home),
    parameters: (input.parameters ?? []).map((parameter, index) =>
      parameterJson(home, parameter, index),
    ),
    responses: [],
    rows: [],
    security: {
      alternatives: (input.security ?? []).map((uses) => ({
        uses: uses.map((scheme) => ({ scheme, scopes: [] })),
      })),
      declared: input.security !== undefined,
      origin: origin(home),
      rows: [],
    },
    servers: [],
    tags: input.tags ?? [],
  };
  const withId =
    input.operationId === undefined ? base : { ...base, operationId: input.operationId };

  return input.body === undefined
    ? withId
    : {
        ...withId,
        body: {
          alternatives: input.body.map((alternative) => {
            const media = {
              codec: alternative.codec ?? "json",
              encoding: [],
              mediaType: alternative.media,
              origin: origin(`${home}/requestBody/content/${escape(alternative.media)}`),
              prefixEncoding: [],
              rows: [],
            };

            return alternative.schema === undefined
              ? media
              : { ...media, schema: { key: alternative.schema } };
          }),
          docs: {},
          origin: origin(`${home}/requestBody`),
          required: true,
          rows: [],
        },
      };
};

const baseDefs = {
  boolean: { type: "boolean" },
  string: { type: "string" },
} satisfies Readonly<Record<string, Json>>;

const makeApi = (input: ApiInput): Api =>
  Schema.decodeUnknownSync(Api)({
    documents: [document],
    entry: document,
    info: {},
    informational: [],
    line: "3.1",
    openapi: "3.1.0",
    operations: input.operations.map(operationJson),
    origin: origin(""),
    rows: [],
    schemas: {
      document: { $defs: { ...baseDefs, ...input.defs } },
      origin: origin("/components/schemas"),
      rows: [],
    },
    securitySchemes: (input.schemes ?? []).map((scheme) => ({
      credentialSources: [],
      deprecated: false,
      kind: scheme.kind,
      name: scheme.name,
      origin: origin(`/components/securitySchemes/${escape(scheme.name)}`),
      rows: [],
    })),
    servers: [],
    tags: input.tags ?? [],
  });

const makeConfig = (extra: Readonly<Record<string, Json>> = {}): AuthorConfig =>
  Schema.decodeUnknownSync(AuthorConfig)({
    binName: "example",
    package: { name: "example-cli", version: "1.0.0" },
    ...extra,
  });

const plan = (input: ApiInput, config: AuthorConfig = makeConfig(), strict = false): NamePlan =>
  Effect.runSync(
    planNames(makeApi(input), {
      config,
      configDocument,
      strict,
    }),
  );

const object = (properties: Record<string, Json>): Json => ({ properties, type: "object" });

const diamond = (depth: number) => {
  const levels = Array.from({ length: depth }, (_, level): [string, Json] => [
    `D${level}`,
    { allOf: [{ $ref: `#/$defs/D${level + 1}` }, { $ref: `#/$defs/D${level + 1}` }] },
  ]);

  return {
    ...Object.fromEntries(levels),
    [`D${depth}`]: object({ leaf: { type: "string" } }),
    Root: object({ nested: { $ref: "#/$defs/D0" } }),
  };
};

const allCommands = (result: NamePlan): readonly PlannedCommand[] => [
  ...result.root,
  ...result.groups.flatMap((group) => group.commands),
];

const commandOf = (result: NamePlan, operationId: string): PlannedCommand | undefined =>
  allCommands(result).find((command) => command.operation.operationId === operationId);

const codes = (result: NamePlan) =>
  result.diagnostics.map(({ code, scope, severity }) => ({ code, scope, severity }));

const flagNames = (command: PlannedCommand | undefined) =>
  command?.flags.map((flag) => flag.name) ?? [];

describe("planNames: groups and commands", () => {
  test("the first tag names the group and the group words are dropped from the command", () => {
    const result = plan({
      operations: [
        {
          method: "PATCH",
          operationId: "users-update",
          parameters: [{ in: "path", name: "id" }],
          path: "/users/{id}",
          tags: ["users", "admin"],
        },
        { method: "GET", path: "/plain" },
      ],
    });

    expect(
      result.groups.map((group) => [group.tag, group.name, group.segment, group.namespace]),
    ).toEqual([["users", "users", "users", "Users"]]);
    expect(result.groups[0]?.commands.map((command) => [command.name, command.identifier])).toEqual(
      [["update", "update"]],
    );
    expect(result.root.map((command) => command.name)).toEqual(["get-plain"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("3.2 parent chains nest groups; route-derived names use by-<param> in template order", () => {
    const result = plan({
      operations: [
        {
          method: "PUT",
          parameters: [{ in: "path", name: "id" }],
          path: "/users/{id}/avatar",
          tags: ["avatars"],
        },
      ],
      tags: [{ name: "users" }, { name: "avatars", parent: "users" }],
    });

    expect(result.groups.map((group) => [group.name, group.parent])).toEqual([
      ["users", undefined],
      ["avatars", "users"],
    ]);
    expect(result.groups[1]?.commands.map((command) => command.name)).toEqual([
      "put-users-by-id-avatar",
    ]);
  });

  test("a command sharing only leading words with a sibling is no collision", () => {
    const result = plan({
      operations: [
        { method: "GET", operationId: "things-get", path: "/a", tags: ["things"] },
        { method: "GET", operationId: "things-get-child", path: "/b", tags: ["things"] },
      ],
    });

    expect(result.groups[0]?.commands.map((command) => command.name)).toEqual(["get", "get-child"]);
    expect(codes(result)).toEqual([
      { code: "OPR-06/folded", scope: "element", severity: "notice" },
    ]);
    expect(result.diagnostics[0]?.operation?.operationId).toBe("things-get");
  });

  test("two commands folding equal in one group refuse both operations", () => {
    const result = plan({
      operations: [
        { method: "POST", operationId: "things_get", path: "/a" },
        { method: "POST", operationId: "things/get", path: "/b" },
      ],
    });

    expect(allCommands(result)).toEqual([]);
    expect(codes(result)).toEqual([
      { code: "OPR-06/command-collision", scope: "operation", severity: "refusal" },
      { code: "OPR-06/command-collision", scope: "operation", severity: "refusal" },
    ]);
    expect(result.diagnostics[0]?.related?.map((site) => String(site.pointer))).toEqual([
      "/paths/~1b/post",
    ]);
    expect(result.diagnostics[0]?.hint).toContain('naming.operations["things_get"].command');
  });

  test("a command equal to a sibling group's name is refused, the group stays", () => {
    const result = plan({
      operations: [
        { method: "GET", operationId: "things", path: "/things" },
        { method: "GET", operationId: "things-list", path: "/things/all", tags: ["things"] },
      ],
    });

    expect(result.root).toEqual([]);
    expect(commandOf(result, "things-list")?.name).toBe("list");
    expect(codes(result)).toEqual([
      { code: "OPR-06/group-collision", scope: "operation", severity: "refusal" },
    ]);
    expect(result.diagnostics[0]?.operation?.operationId).toBe("things");
  });

  test("a group whose file segment is root, servers or security is refused with its tag and key", () => {
    const result = plan({
      operations: [
        { method: "GET", operationId: "a", path: "/a", tags: ["Root"] },
        { method: "GET", operationId: "b", path: "/b", tags: ["servers"] },
        { method: "GET", operationId: "c", path: "/c", tags: ["SECURITY"] },
        { method: "GET", operationId: "d", path: "/d", tags: ["roots"] },
      ],
    });

    expect(result.groups.map((group) => String(group.segment))).toEqual(["roots"]);
    expect(
      result.diagnostics.map(({ code, hint, message, scope, severity }) => ({
        code,
        hint,
        message,
        scope,
        severity,
      })),
    ).toEqual(
      [
        ["a", "Root", "root"],
        ["b", "servers", "servers"],
        ["c", "SECURITY", "security"],
      ].map(([id, tag, segment]) => ({
        code: "TAG-02/reserved-segment",
        hint: `naming.operations[${JSON.stringify(id)}].group`,
        message: `The group ${JSON.stringify(tag)} folds to the file segment ${JSON.stringify(segment)}, which api/${segment}.ts reserves.`,
        scope: "operation",
        severity: "refusal",
      })),
    );
  });

  test("an all-punctuation operationId is OPR-06/empty-name with no route fallback", () => {
    const result = plan({ operations: [{ method: "GET", operationId: "!!!", path: "/plain" }] });

    expect(allCommands(result)).toEqual([]);
    expect(codes(result)).toEqual([
      { code: "OPR-06/empty-name", scope: "operation", severity: "refusal" },
    ]);
    expect(result.diagnostics[0]?.hint).toContain('naming.operations["!!!"].command');
  });
});

describe("planNames: positionals and flags", () => {
  test("positionals follow template order, not parameter order", () => {
    const result = plan({
      operations: [
        {
          operationId: "get-pair",
          parameters: [
            { in: "path", name: "itemId" },
            { in: "path", name: "parentId" },
            { in: "query", name: "isReady", schema: "boolean" },
          ],
          path: "/parents/{parentId}/things/{itemId}",
        },
      ],
    });
    const command = commandOf(result, "get-pair");

    expect(
      command?.positionals.map((positional) => [positional.name, positional.identifier]),
    ).toEqual([
      ["parent-id", "parentId"],
      ["item-id", "itemId"],
    ]);
    expect(command?.flags.map((flag) => [flag.name, flag.boolean])).toEqual([["is-ready", true]]);
  });

  test("a parameter flag and a body flag with one name refuse the operation", () => {
    const result = plan({
      defs: { Body: object({ name: { type: "string" } }) },
      operations: [
        {
          body: [{ media: "application/json", schema: "Body" }],
          method: "POST",
          operationId: "make",
          parameters: [{ in: "query", name: "name" }],
          path: "/things",
        },
      ],
    });

    expect(allCommands(result)).toEqual([]);
    expect(codes(result)).toEqual([
      { code: "PRM-02/flag-collision", scope: "operation", severity: "refusal" },
    ]);
    expect(String(result.diagnostics[0]?.pointer)).toBe("/paths/~1things/post/parameters/0");
    expect(result.diagnostics[0]?.related?.map((site) => String(site.pointer))).toEqual([
      "/paths/~1things/post/requestBody/content/application~1json",
    ]);
    expect(result.diagnostics[0]?.hint).toContain(
      'naming.operations["make"].parameters["query:name"].flag',
    );
  });

  test("a parameter override resolves the collision", () => {
    const result = plan(
      {
        defs: { Body: object({ name: { type: "string" } }) },
        operations: [
          {
            body: [{ media: "application/json", schema: "Body" }],
            method: "POST",
            operationId: "make",
            parameters: [{ in: "query", name: "name" }],
            path: "/things",
          },
        ],
      },
      makeConfig({
        naming: { operations: { make: { parameters: { "query:name": { flag: "name-filter" } } } } },
      }),
    );

    expect(flagNames(commandOf(result, "make"))).toEqual([
      "body",
      "body-file",
      "name",
      "name-filter",
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test("header overrides match case-insensitively", () => {
    const result = plan(
      {
        operations: [
          { operationId: "read", parameters: [{ in: "header", name: "If-Match" }], path: "/r" },
        ],
      },
      makeConfig({
        naming: { operations: { read: { parameters: { "header:if-match": { flag: "etag" } } } } },
      }),
    );
    const flag = commandOf(result, "read")?.flags[0];

    expect([flag?.name, flag?.identifier, flag?.source._tag]).toEqual([
      "etag",
      "etag",
      "Parameter",
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test("a boolean's no- negation collides with a body field of that name", () => {
    const result = plan({
      defs: { Body: object({ "no-notify": { type: "string" } }) },
      operations: [
        {
          body: [{ media: "application/json", schema: "Body" }],
          method: "POST",
          operationId: "send",
          parameters: [{ in: "query", name: "notify", schema: "boolean" }],
          path: "/send",
        },
      ],
    });

    expect(allCommands(result)).toEqual([]);
    expect(codes(result)).toEqual([
      { code: "PRM-02/flag-collision", scope: "operation", severity: "refusal" },
    ]);
  });

  test("an operation the author config skips is an element-scope notice", () => {
    const result = plan(
      { operations: [{ method: "GET", operationId: "talk", path: "/talk" }] },
      makeConfig({ naming: { operations: { talk: { skip: true } } } }),
    );

    expect(allCommands(result)).toEqual([]);
    expect(codes(result)).toEqual([
      { code: "OPR-06/skipped", scope: "element", severity: "notice" },
    ]);
  });

  test("a body field equal to a reserved name is refused at operation scope", () => {
    const result = plan({
      defs: { Body: object({ verbose: { type: "string" } }) },
      operations: [
        {
          body: [{ media: "application/json", schema: "Body" }],
          method: "POST",
          operationId: "talk",
          path: "/talk",
        },
      ],
    });

    expect(allCommands(result)).toEqual([]);
    expect(codes(result)).toEqual([
      { code: "RQB-03/flag-collision", scope: "operation", severity: "refusal" },
    ]);
    expect(result.diagnostics[0]?.hint).toContain('naming.operations["talk"].skip');
  });

  test("two properties of one alternative folding to one flag are refused naming both", () => {
    const result = plan({
      defs: { Body: object({ fooBar: { type: "string" }, foo_bar: { type: "string" } }) },
      operations: [
        {
          body: [{ media: "application/json", schema: "Body" }],
          method: "POST",
          operationId: "make",
          path: "/things",
        },
      ],
    });

    expect(allCommands(result)).toEqual([]);
    expect(codes(result)).toEqual([
      { code: "RQB-03/flag-collision", scope: "operation", severity: "refusal" },
    ]);
    expect(result.diagnostics[0]?.message).toContain("/fooBar");
    expect(result.diagnostics[0]?.message).toContain("/foo_bar");
  });

  test("a property whose name folds to nothing gives one notice and no flag", () => {
    const result = plan({
      defs: { Body: object({ "!!!": { type: "string" }, ok: { type: "string" } }) },
      operations: [
        {
          body: [{ media: "application/json", schema: "Body" }],
          method: "POST",
          operationId: "post",
          path: "/p",
        },
      ],
    });

    expect(flagNames(commandOf(result, "post"))).toEqual(["body", "body-file", "ok"]);
    expect(codes(result)).toEqual([
      { code: "RQB-03/unnamed-property", scope: "element", severity: "notice" },
    ]);
  });
});

describe("planNames: multipart parts", () => {
  test("part flags, no whole-body flags, and a notice for an unsupported part", () => {
    const result = plan({
      defs: {
        Body: object({
          file: { format: "binary", type: "string" },
          meta: object({ a: { type: "string" } }),
          name: { type: "string" },
        }),
      },
      operations: [
        {
          body: [{ codec: "multipart", media: "multipart/form-data", schema: "Body" }],
          method: "POST",
          operationId: "upload",
          path: "/u",
        },
      ],
    });

    expect(flagNames(commandOf(result, "upload"))).toEqual(["file", "name"]);
    expect(codes(result)).toEqual([
      { code: "RQB-03/unnamed-property", scope: "element", severity: "notice" },
    ]);
  });

  test("a part whose name folds to nothing is unreachable: multipart has no whole-body flags", () => {
    const result = plan({
      defs: { Body: object({ "!!!": { type: "string" }, ok: { type: "string" } }) },
      operations: [
        {
          body: [{ codec: "multipart", media: "multipart/form-data", schema: "Body" }],
          method: "POST",
          operationId: "upload",
          path: "/u",
        },
      ],
    });

    expect(flagNames(commandOf(result, "upload"))).toEqual(["ok"]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "The multipart part at /!!! has no flag and is not reachable; a multipart body has no --body or --body-file.",
    ]);
  });
});

describe("planNames: overrides", () => {
  const input: ApiInput = {
    operations: [{ method: "GET", operationId: "list", path: "/l" }],
  };
  const config = makeConfig({ naming: { operations: { missing: { command: "x" } } } });

  test("an unmatched override is a notice", () => {
    const result = plan(input, config);

    expect(codes(result)).toEqual([
      { code: "CFG-1/unmatched-override", scope: "document", severity: "notice" },
    ]);
    expect(result.diagnostics[0]?.document).toBe(configDocument);
    expect(String(result.diagnostics[0]?.pointer)).toBe("/naming/operations/missing");
    expect(commandOf(result, "list")?.name).toBe("list");
  });

  test("an unmatched override is a document refusal under --strict", () => {
    const result = plan(input, config, true);

    expect(codes(result)).toEqual([
      { code: "CFG-1/unmatched-override", scope: "document", severity: "refusal" },
    ]);
  });

  test("byPointer applies only to operations without an operationId", () => {
    const result = plan(
      {
        operations: [
          { method: "GET", path: "/plain" },
          { method: "GET", operationId: "named", path: "/named" },
        ],
      },
      makeConfig({
        naming: {
          byPointer: {
            "/paths/~1named/get": { command: "y" },
            "/paths/~1plain/get": { command: "fetch" },
          },
        },
      }),
    );

    expect(result.root.map((command) => command.name)).toEqual(["fetch", "named"]);
    expect(codes(result)).toEqual([
      { code: "CFG-1/unmatched-override", scope: "document", severity: "notice" },
    ]);
    expect(String(result.diagnostics[0]?.pointer)).toBe("/naming/byPointer/~1paths~1~01named~1get");
  });
});

describe("planNames: module identifier reservations", () => {
  test("commands group and update-meta rename by suffix; set-avatar-input does not", () => {
    const result = plan({
      defs: { Users: object({ url: { type: "string" } }) },
      operations: [
        { method: "PATCH", operationId: "users-update", path: "/u1", tags: ["users"] },
        { method: "GET", operationId: "users-update-meta", path: "/u2", tags: ["users"] },
        { method: "GET", operationId: "users-group", path: "/u3", tags: ["users"] },
        { method: "PUT", operationId: "users-set-avatar", path: "/u4", tags: ["users"] },
        { method: "GET", operationId: "users-set-avatar-input", path: "/u5", tags: ["users"] },
        {
          body: [{ media: "application/json", schema: "Users" }],
          method: "POST",
          operationId: "users-create",
          path: "/u6",
          tags: ["users"],
        },
      ],
    });
    const [group] = result.groups;

    expect(String(group?.namespace)).toBe("Users2");
    expect(group?.commands.map((command) => [command.name, command.identifier])).toEqual([
      ["update", "update"],
      ["update-meta", "updateMeta2"],
      ["group", "group2"],
      ["set-avatar", "setAvatar"],
      ["set-avatar-input", "setAvatarInput"],
      ["create", "create"],
    ]);
    expect(codes(result)).toEqual([
      { code: "TAG-02/renamed", scope: "element", severity: "notice" },
      { code: "OPR-06/renamed", scope: "element", severity: "notice" },
      { code: "OPR-06/renamed", scope: "element", severity: "notice" },
    ]);
  });
});

describe("planNames: multipart body schema reservations", () => {
  test("a multipart body schema folding to its tag's namespace is imported, so the namespace renames", () => {
    const result = plan({
      defs: { Imports: object({ file: { format: "binary", type: "string" } }) },
      operations: [
        {
          body: [{ codec: "multipart", media: "multipart/form-data", schema: "Imports" }],
          method: "POST",
          operationId: "imports-create",
          path: "/imports",
          tags: ["imports"],
        },
      ],
    });

    expect(String(result.domain.get("Imports"))).toBe("Imports");
    expect(String(result.groups[0]?.namespace)).toBe("Imports2");
  });
});

describe("planNames: root module reservations", () => {
  test("root commands named after cli/root.ts's fixed names rename by suffix", () => {
    const result = plan({
      operations: ["services", "servers", "security", "status"].map((operationId) => ({
        method: "GET",
        operationId,
        path: `/${operationId}`,
      })),
    });

    expect(result.root.map((command) => [command.name, String(command.identifier)])).toEqual([
      ["services", "services2"],
      ["servers", "servers2"],
      ["security", "security2"],
      ["status", "status"],
    ]);
    expect(codes(result)).toEqual(
      Array.from({ length: 3 }, () => ({
        code: "OPR-06/renamed",
        scope: "element",
        severity: "notice",
      })),
    );
  });
});

const imports = (commands: readonly PlannedCommand[], domain: NamePlan["domain"]) =>
  commands.flatMap((command) =>
    (command.operation.body?.alternatives ?? []).flatMap((alternative) => {
      const name =
        alternative.schema === undefined ? undefined : domain.get(alternative.schema.key);

      return name === undefined ? [] : [String(name)];
    }),
  );

describe("planNames: domain names", () => {
  const inline = "/paths/~1inline/post/requestBody/content/application~1json/schema";
  const bodyKeys = ["user_update", "my-schema", "Schema", "Command", "User", "user", inline];
  const defs = Object.fromEntries(
    bodyKeys.map((key, index): [string, Json] => [
      key,
      object({ [`f${index}`]: { type: "string" } }),
    ]),
  );
  const operations = bodyKeys.map((key, index) => ({
    body: [{ media: "application/json", schema: key }],
    method: "POST",
    operationId: `op-${index}`,
    path: `/op${index}`,
    tags: index % 2 === 0 ? ["command"] : [],
  }));

  test("every imported domain name is exported by domain/schemas.ts and clears the fixed imports", async () => {
    const result = plan({ defs, operations });
    const modules = [result.root, ...result.groups.map((group) => group.commands)];
    const imported = modules.flatMap((commands) => imports(commands, result.domain));
    const file = await Effect.runPromise(
      emitDomainSchemas(new Map(Object.entries({ ...defs })), bodyKeys, result.domain),
    );

    expect(Arr.sort(imported, Order.String)).toEqual([
      "Command2",
      "MySchema",
      "Paths1inlinePostRequestBodyContentApplication1jsonSchema",
      "Schema2",
      "User",
      "User2",
      "UserUpdate",
    ]);
    for (const name of imported) {
      expect(file.content).toContain(`export const ${name} =`);
      expect(fixedNamespaces.has(name)).toBe(false);
    }

    for (const group of result.groups) {
      expect(imports(group.commands, result.domain)).not.toContain(String(group.namespace));
    }

    expect(new Set(imported).size).toBe(imported.length);
  });
});

describe("planNames: credentials", () => {
  const bearer = { scheme: "bearer", type: "http" };

  test("each used scheme gets <scheme>-file and <PREFIX>_<SCHEME>; config env overrides", () => {
    const result = plan(
      {
        operations: [{ operationId: "me", path: "/me", security: [["bearerAuth"], ["apiKey"]] }],
        schemes: [
          { kind: bearer, name: "bearerAuth" },
          { kind: { in: "header", name: "X-Key", type: "apiKey" }, name: "apiKey" },
        ],
      },
      makeConfig({ envPrefix: "EXAMPLE", security: { apiKey: { env: "EXAMPLE_TOKEN" } } }),
    );

    expect(result.credentials).toEqual([
      { env: "EXAMPLE_TOKEN", flag: "api-key-file", scheme: "apiKey" },
      { env: "EXAMPLE_BEARER_AUTH", flag: "bearer-auth-file", scheme: "bearerAuth" },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test("two schemes folding to one env name refuse every operation using either", () => {
    const result = plan({
      operations: [
        { operationId: "a", path: "/a", security: [["bearerAuth"]] },
        { operationId: "b", path: "/b", security: [["bearer_auth"]] },
        { operationId: "c", path: "/c" },
      ],
      schemes: [
        { kind: bearer, name: "bearerAuth" },
        { kind: bearer, name: "bearer_auth" },
      ],
    });

    expect(allCommands(result).map((command) => command.name)).toEqual(["c"]);
    expect(codes(result).map((entry) => entry.code)).toEqual([
      "SSC-01/credential-collision",
      "SSC-01/credential-collision",
    ]);
  });

  test("a scheme env equal to a reserved environment name is a collision", () => {
    const result = plan({
      operations: [{ operationId: "a", path: "/a", security: [["baseUrl"]] }],
      schemes: [{ kind: bearer, name: "baseUrl" }],
    });

    expect(allCommands(result)).toEqual([]);
    expect(codes(result)).toEqual([
      { code: "SSC-01/credential-collision", scope: "operation", severity: "refusal" },
    ]);
  });
});

describe("planNames: bounded schema walks", () => {
  test("a 30-level diamond (2^30 paths) plans in bounded work", () => {
    const result = plan({
      defs: diamond(30),
      operations: [
        {
          body: [{ media: "application/json", schema: "Root" }],
          method: "POST",
          operationId: "deep",
          path: "/d",
        },
      ],
    });

    expect(flagNames(commandOf(result, "deep"))).toEqual(["body", "body-file", "nested.leaf"]);
  });

  test("a body over the node budget is REF-18/node-budget at operation scope", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`p${index}`, { type: "string" }]),
    );
    const result = plan({
      defs: { Wide: object(wide) },
      operations: [
        {
          body: [{ media: "application/json", schema: "Wide" }],
          method: "POST",
          operationId: "wide",
          path: "/w",
        },
      ],
    });

    expect(allCommands(result)).toEqual([]);
    expect(codes(result)).toEqual([
      { code: "REF-18/node-budget", scope: "operation", severity: "refusal" },
    ]);
  });

  test("an unresolved body reference is a defect", () => {
    const api = makeApi({
      operations: [
        {
          body: [{ media: "application/json", schema: "Gone" }],
          method: "POST",
          operationId: "x",
          path: "/x",
        },
      ],
    });
    const exit = Effect.runSyncExit(
      planNames(api, {
        config: makeConfig(),
        configDocument,
        strict: false,
      }),
    );

    expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
  });
});

const chainTags = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    index === 0 ? { name: "t0" } : { name: `t${index}`, parent: `t${index - 1}` },
  );

// A chain of `count` tags with one operation on the deepest.
const deep = (count: number) =>
  plan({
    operations: [{ operationId: "leaf-get", path: "/leaf", tags: [`t${count - 1}`] }],
    tags: chainTags(count),
  });

// Plans a prepared Api and times the planner alone.
const timed = (input: ApiInput) => {
  const api = makeApi(input);
  const start = performance.now();
  const result = Effect.runSync(
    planNames(api, {
      config: makeConfig(),
      configDocument,
      strict: false,
    }),
  );

  return { ms: performance.now() - start, result };
};

describe("planNames: bounded plan work", () => {
  test("a parent chain of 64 hops nests; one more hop is TAG-06/parent-depth", () => {
    expect(deep(65).groups).toHaveLength(65);
    expect(codes(deep(66))).toEqual([
      { code: "TAG-06/parent-depth", scope: "operation", severity: "refusal" },
    ]);
  });

  test("a 10,000-tag parent chain used by 1,000 operations is refused in bounded work", () => {
    const { ms, result } = timed({
      operations: Array.from({ length: 1000 }, (_, index) => ({
        operationId: `op${index}`,
        path: `/p${index}`,
        tags: ["t9999"],
      })),
      tags: chainTags(10_000),
    });

    expect(allCommands(result)).toEqual([]);
    expect(result.diagnostics).toHaveLength(1000);
    expect(new Set(codes(result).map((entry) => entry.code))).toEqual(
      new Set(["TAG-06/parent-depth"]),
    );
    expect(ms).toBeLessThan(2000);
  }, 10_000);

  test("50,000 operations over distinct and shared tags and 500 schemes plan in bounded work", () => {
    const { ms, result } = timed({
      operations: Array.from({ length: 50_000 }, (_, index) => ({
        operationId: `op${index}`,
        path: `/r${index}`,
        security: [[`s${index % 500}`]],
        tags: [index % 2 === 0 ? `tag${index}` : "shared"],
      })),
      schemes: Array.from({ length: 500 }, (_, index) => ({
        kind: { scheme: "bearer", type: "http" },
        name: `s${index}`,
      })),
    });

    expect(allCommands(result)).toHaveLength(50_000);
    expect(result.groups).toHaveLength(25_001);
    expect(result.credentials).toHaveLength(500);
    expect(result.diagnostics).toEqual([]);
    expect(ms).toBeLessThan(10_000);
  }, 60_000);
});

describe("planNames: the golden users-update fixture", () => {
  test("names match expected/src/cli/users.ts", () => {
    const result = plan(
      {
        defs: {
          Avatar: object({ url: { type: "string" } }),
          UserUpdate: object({
            address: object({ city: { type: "string" } }),
            name: { type: "string" },
          }),
          binary: { format: "binary", type: "string" },
        },
        operations: [
          {
            body: [{ media: "application/json", schema: "UserUpdate" }],
            method: "PATCH",
            operationId: "users-update",
            parameters: [
              { in: "path", name: "id" },
              { in: "query", name: "notify", schema: "boolean" },
              { in: "header", name: "If-Match" },
            ],
            path: "/users/{id}",
            security: [["bearerAuth"]],
            tags: ["users"],
          },
          {
            body: [
              { media: "application/json", schema: "Avatar" },
              { codec: "binary", media: "image/png", schema: "binary" },
            ],
            method: "PUT",
            operationId: "users-set-avatar",
            parameters: [{ in: "path", name: "id" }],
            path: "/users/{id}/avatar",
            security: [["bearerAuth"]],
            tags: ["users"],
          },
        ],
        schemes: [{ kind: { scheme: "bearer", type: "http" }, name: "bearerAuth" }],
      },
      makeConfig({
        commands: { module: "./custom/commands.ts", names: ["login"] },
        envPrefix: "EXAMPLE",
        naming: {
          byPointer: {},
          operations: {
            "users-update": {
              command: "update",
              parameters: { "header:If-Match": { flag: "if-match" } },
            },
          },
        },
      }),
    );
    const [update, setAvatar] = result.groups[0]?.commands ?? [];

    expect([update?.identifier, setAvatar?.identifier].map(String)).toEqual([
      "update",
      "setAvatar",
    ]);
    expect(update?.flags.map((flag) => [flag.name, flag.identifier])).toEqual([
      ["address.city", "addressCity"],
      ["body", "body"],
      ["body-file", "bodyFile"],
      ["if-match", "ifMatch"],
      ["name", "name"],
      ["notify", "notify"],
    ]);
    expect(update?.flags.find((flag) => flag.name === "address.city")?.source).toEqual({
      _tag: "Body",
      kind: "string",
      media: ["application/json"],
      pointer: "/components/schemas/UserUpdate/properties/address/properties/city",
      repeated: false,
      wireName: "/address/city",
    });
    expect(
      setAvatar?.flags.map((flag) => [
        flag.name,
        flag.source._tag === "Body" && flag.source.pointer,
      ]),
    ).toEqual([
      ["body", "/paths/~1users~1{id}~1avatar/put/requestBody"],
      ["body-file", "/paths/~1users~1{id}~1avatar/put/requestBody"],
      ["url", "/components/schemas/Avatar/properties/url"],
    ]);
    expect(update?.positionals.map((positional) => positional.name)).toEqual(["id"]);
    expect(
      setAvatar?.flags.map((flag) => [
        flag.name,
        flag.source._tag === "Body" ? flag.source.media : [],
      ]),
    ).toEqual([
      ["body", ["application/json"]],
      ["body-file", ["application/json", "image/png"]],
      ["url", ["application/json"]],
    ]);
    expect(result.credentials).toEqual([
      { env: "EXAMPLE_BEARER_AUTH", flag: "bearer-auth-file", scheme: "bearerAuth" },
    ]);
    expect(result.diagnostics).toEqual([]);
  });
});
