import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Api } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import type { NamePlan, PlannedGroup } from "../../src/names/index.ts";

type Json = Schema.Json;

const document = "file:///spec/openapi.json";

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///spec/author-config.json");

const escape = (token: string): string => token.replaceAll("~", "~0").replaceAll("/", "~1");

interface HintInput {
  readonly group?: readonly string[];
  readonly method?: string;
}

interface AliasInput {
  readonly fern?: HintInput;
  readonly forge?: HintInput;
  readonly operationId?: string;
}

interface OperationInput {
  readonly aliases?: readonly AliasInput[];
  readonly fern?: HintInput;
  readonly forge?: HintInput;
  readonly method?: string;
  readonly operationId?: string;
  readonly path: string;
  readonly tags?: readonly string[];
}

const origin = (pointer: string) => ({ document, pointer });

const home = (input: OperationInput): string =>
  `/paths/${escape(input.path)}/${(input.method ?? "get").toLowerCase()}`;

interface HintJson extends HintInput {
  readonly pointer: string;
}

// The model `naming` field as m2-nmx1 normalizes it: a group is its segments, top level first.
interface HintsJson {
  fern?: HintJson;
  forge?: HintJson;
}

interface AliasJson extends HintsJson {
  readonly index: number;
  operationId?: string;
}

interface NamingJson extends HintsJson {
  aliases?: AliasJson[];
}

interface OperationJson {
  readonly deprecated: false;
  readonly docs: Json;
  readonly key: { readonly method: string; readonly path: string };
  naming?: NamingJson;
  operationId?: string;
  readonly origin: Json;
  readonly parameters: readonly Json[];
  readonly responses: readonly Json[];
  readonly rows: readonly Json[];
  readonly security: Json;
  readonly servers: readonly Json[];
  readonly tags: readonly string[];
}

// Copies the present hints of `input` onto `target`, each with `pointer`.
const addHints = (
  target: HintsJson,
  input: { readonly fern?: HintInput; readonly forge?: HintInput },
  pointer: string,
): void => {
  if (input.forge !== undefined) {
    target.forge = { ...input.forge, pointer };
  }

  if (input.fern !== undefined) {
    target.fern = { ...input.fern, pointer };
  }
};

const namingJson = (input: OperationInput): NamingJson => {
  const pointer = home(input);
  const naming: NamingJson = {};
  addHints(naming, input, pointer);
  if (input.aliases !== undefined) {
    naming.aliases = input.aliases.map((alias, index) => {
      const entry: AliasJson = { index };
      addHints(entry, alias, `${pointer}/x-forge-aliases/${index}`);
      if (alias.operationId !== undefined) {
        entry.operationId = alias.operationId;
      }

      return entry;
    });
  }

  return naming;
};

const operationJson = (input: OperationInput): OperationJson => {
  const pointer = home(input);
  const operation: OperationJson = {
    deprecated: false,
    docs: {},
    key: { method: input.method ?? "GET", path: input.path },
    origin: origin(pointer),
    parameters: [],
    responses: [],
    rows: [],
    security: { alternatives: [], declared: false, origin: origin(pointer), rows: [] },
    servers: [],
    tags: input.tags ?? [],
  };
  const naming = namingJson(input);
  if (Object.keys(naming).length > 0) {
    operation.naming = naming;
  }

  if (input.operationId !== undefined) {
    operation.operationId = input.operationId;
  }

  return operation;
};

const makeApi = (operations: readonly OperationInput[]): Api =>
  Schema.decodeUnknownSync(Api)({
    documents: [document],
    entry: document,
    info: {},
    informational: [],
    line: "3.1",
    openapi: "3.1.0",
    operations: operations.map(operationJson),
    origin: origin(""),
    rows: [],
    schemas: { document: { $defs: {} }, origin: origin("/components/schemas"), rows: [] },
    securitySchemes: [],
    servers: [],
    tags: [],
  });

const makeConfig = (operations: Readonly<Record<string, Json>> = {}): AuthorConfig =>
  Schema.decodeUnknownSync(AuthorConfig)({
    binName: "example",
    naming: { operations },
    package: { name: "example-cli", version: "1.0.0" },
  });

const plan = (operations: readonly OperationInput[], config = makeConfig()): NamePlan =>
  Effect.runSync(planNames(makeApi(operations), { config, configDocument, strict: false }));

// Every planned command as its visible path, in plan order (root first, then groups).
const pathOf = (group: PlannedGroup, groups: readonly PlannedGroup[]): readonly string[] => {
  const parent = groups.find((other) => other.tag === group.parent);

  return parent === undefined ? [group.name] : [...pathOf(parent, groups), group.name];
};

const commands = (result: NamePlan) => [
  ...result.root.map((command) => ({ command, path: [command.name] })),
  ...result.groups.flatMap((group) =>
    group.commands.map((command) => ({
      command,
      path: [...pathOf(group, result.groups), command.name],
    })),
  ),
];

const paths = (result: NamePlan): readonly string[] =>
  commands(result).map(({ path }) => path.join(" "));

const named = (result: NamePlan) =>
  commands(result).map(({ command, path }) => ({
    alias: command.alias,
    path: path.join(" "),
    sources: command.sources,
  }));

const codes = (result: NamePlan) =>
  result.diagnostics.map(({ code, pointer, scope, severity }) => ({
    code,
    pointer: String(pointer),
    scope,
    severity,
  }));

const refusals = (result: NamePlan) =>
  codes(result).filter((diagnostic) => diagnostic.severity === "refusal");

describe("naming precedence: group", () => {
  const base: OperationInput = {
    fern: { group: ["fern-group"] },
    forge: { group: ["forge-group"] },
    method: "GET",
    operationId: "fetch",
    path: "/a",
    tags: ["tagged"],
  };

  test("the author config group wins over x-forge-group-name", () => {
    const result = plan([base], makeConfig({ fetch: { group: "configured" } }));

    expect(named(result)).toEqual([
      {
        alias: undefined,
        path: "configured fetch",
        sources: { command: "operationId", group: "config" },
      },
    ]);
  });

  test("x-forge-group-name wins over x-fern-sdk-group-name", () => {
    expect(named(plan([base]))).toEqual([
      {
        alias: undefined,
        path: "forge-group fetch",
        sources: { command: "operationId", group: "x-forge" },
      },
    ]);
  });

  test("x-fern-sdk-group-name wins over the first tag", () => {
    const { forge: _forge, ...withoutForge } = base;

    expect(named(plan([withoutForge]))).toEqual([
      {
        alias: undefined,
        path: "fern-group fetch",
        sources: { command: "operationId", group: "x-fern" },
      },
    ]);
  });

  test("without extensions the first tag names the group; untagged sits at the root", () => {
    const result = plan([
      { method: "GET", operationId: "fetch", path: "/a", tags: ["tagged"] },
      { method: "GET", path: "/b" },
    ]);

    expect(named(result)).toEqual([
      { alias: undefined, path: "get-b", sources: { command: "route", group: "none" } },
      {
        alias: undefined,
        path: "tagged fetch",
        sources: { command: "operationId", group: "tag" },
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("naming precedence: command", () => {
  const base: OperationInput = {
    fern: { method: "fernMethod" },
    forge: { method: "forgeMethod" },
    method: "GET",
    operationId: "fetch",
    path: "/a",
  };

  test("the author config command wins over x-forge-method-name", () => {
    const result = plan([base], makeConfig({ fetch: { command: "configured" } }));

    expect(named(result)).toEqual([
      { alias: undefined, path: "configured", sources: { command: "config", group: "none" } },
    ]);
  });

  test("x-forge-method-name wins over x-fern-sdk-method-name", () => {
    expect(named(plan([base]))).toEqual([
      { alias: undefined, path: "forge-method", sources: { command: "x-forge", group: "none" } },
    ]);
  });

  test("x-fern-sdk-method-name wins over the operationId fold", () => {
    const { forge: _forge, ...withoutForge } = base;

    expect(named(plan([withoutForge]))).toEqual([
      { alias: undefined, path: "fern-method", sources: { command: "x-fern", group: "none" } },
    ]);
  });

  test("the group and the command resolve separately", () => {
    const result = plan([
      { fern: { method: "listAll" }, forge: { group: ["things"] }, operationId: "x", path: "/a" },
    ]);

    expect(named(result)).toEqual([
      {
        alias: undefined,
        path: "things list-all",
        sources: { command: "x-fern", group: "x-forge" },
      },
    ]);
  });

  test("an extension group still drops its words from the operationId fold", () => {
    const result = plan([{ fern: { group: ["things"] }, operationId: "things_get", path: "/a" }]);

    expect(paths(result)).toEqual(["things get"]);
  });

  test("an extension method name folds without the group-word drop", () => {
    const result = plan([
      { fern: { group: ["get"], method: "getHeartbeat" }, operationId: "x", path: "/a" },
    ]);

    expect(paths(result)).toEqual(["get get-heartbeat"]);
  });
});

describe("naming extensions: groups", () => {
  test("a dotted and an array forge group both nest two levels", () => {
    const result = plan([
      { forge: { group: ["accounts", "members"], method: "list" }, path: "/a" },
      { forge: { group: ["accounts", "members.v2"], method: "list" }, path: "/b" },
    ]);

    expect(paths(result)).toEqual(["accounts members list", "accounts members-v2 list"]);
    expect(result.groups.map((group) => [group.name, group.parent === undefined])).toEqual([
      ["accounts", true],
      ["members", false],
      ["members-v2", false],
    ]);
    expect(new Set(result.groups.map((group) => group.segment)).size).toBe(3);
    expect(result.diagnostics).toEqual([]);
  });

  test("an extension segment that folds to nothing is TAG-02/empty-name at its key", () => {
    const result = plan([
      { forge: { group: ["accounts", "!!!"], method: "list" }, operationId: "a", path: "/a" },
    ]);

    expect(commands(result)).toEqual([]);
    expect(refusals(result)).toEqual([
      {
        code: "TAG-02/empty-name",
        pointer: "/paths/~1a/get/x-forge-group-name",
        scope: "operation",
        severity: "refusal",
      },
    ]);
  });
});

describe("naming extensions: aliases", () => {
  const aliased: OperationInput = {
    aliases: [
      { forge: { group: ["zones", "settings"], method: "pause" } },
      { fern: { group: ["zones"], method: "halt" } },
    ],
    fern: { group: ["zones"], method: "suspendZone" },
    method: "PATCH",
    operationId: "zones_status_edit",
    path: "/zones/{id}/status",
  };

  test("fern names and two aliases plan three commands, the primary first", () => {
    const result = plan([aliased]);

    expect(named(result)).toEqual([
      {
        alias: undefined,
        path: "zones suspend-zone",
        sources: { command: "x-fern", group: "x-fern" },
      },
      { alias: 1, path: "zones halt", sources: { command: "x-fern", group: "x-fern" } },
      { alias: 0, path: "zones settings pause", sources: { command: "x-forge", group: "x-forge" } },
    ]);
    expect(new Set(commands(result).map(({ command }) => command.operation)).size).toBe(1);
    expect(result.diagnostics).toEqual([]);
  });

  test("the primary comes before its aliases inside one group, aliases in array order", () => {
    const result = plan([
      {
        aliases: [
          { forge: { group: ["zones"], method: "pause" } },
          { forge: { group: ["zones"], method: "halt" } },
        ],
        forge: { group: ["zones"], method: "suspend" },
        path: "/a",
      },
    ]);

    expect(named(result)).toEqual([
      {
        alias: undefined,
        path: "zones suspend",
        sources: { command: "x-forge", group: "x-forge" },
      },
      { alias: 0, path: "zones pause", sources: { command: "x-forge", group: "x-forge" } },
      { alias: 1, path: "zones halt", sources: { command: "x-forge", group: "x-forge" } },
    ]);
  });

  test("a config command names the primary and both aliases still plan", () => {
    const result = plan([aliased], makeConfig({ zones_status_edit: { command: "freeze" } }));

    expect(named(result)).toEqual([
      { alias: undefined, path: "zones freeze", sources: { command: "config", group: "x-fern" } },
      { alias: 1, path: "zones halt", sources: { command: "x-fern", group: "x-fern" } },
      { alias: 0, path: "zones settings pause", sources: { command: "x-forge", group: "x-forge" } },
    ]);
  });

  test("an alias is named by its own operationId, never the operation's or its tag", () => {
    const result = plan([
      {
        aliases: [{ operationId: "pauseZone" }],
        method: "PATCH",
        operationId: "zones_status_edit",
        path: "/a",
        tags: ["zones"],
      },
    ]);

    expect(named(result)).toEqual([
      { alias: 0, path: "pause-zone", sources: { command: "operationId", group: "none" } },
      {
        alias: undefined,
        path: "zones status-edit",
        sources: { command: "operationId", group: "tag" },
      },
    ]);
  });

  test("skip in the author config drops the operation and its aliases", () => {
    const result = plan([aliased], makeConfig({ zones_status_edit: { skip: true } }));

    expect(commands(result)).toEqual([]);
  });

  test("an alias equal to another operation's command refuses both", () => {
    const result = plan([
      { forge: { group: ["zones"], method: "pause" }, operationId: "other", path: "/b" },
      { ...aliased, aliases: [{ forge: { group: ["zones"], method: "pause" } }] },
    ]);

    expect(commands(result)).toEqual([]);
    expect(refusals(result)).toEqual([
      {
        code: "OPR-06/command-collision",
        pointer: "/paths/~1b/get",
        scope: "operation",
        severity: "refusal",
      },
      {
        code: "OPR-06/command-collision",
        pointer: "/paths/~1zones~1{id}~1status/patch/x-forge-aliases/0",
        scope: "operation",
        severity: "refusal",
      },
    ]);
  });

  test("an alias equal to its own operation's primary refuses that operation", () => {
    const result = plan([
      { forge: { group: ["zones"], method: "keep" }, operationId: "keep", path: "/keep" },
      { ...aliased, aliases: [{ fern: { group: ["zones"], method: "suspendZone" } }] },
    ]);

    expect(paths(result)).toEqual(["zones keep"]);
    expect(refusals(result).map((diagnostic) => diagnostic.code)).toContain(
      "OPR-06/command-collision",
    );
  });

  test("two aliases of one operation folding equal refuse that operation", () => {
    const result = plan([
      { forge: { group: ["zones"], method: "keep" }, operationId: "keep", path: "/keep" },
      {
        ...aliased,
        aliases: [
          { forge: { group: ["zones"], method: "pause_it" } },
          { forge: { group: ["zones"], method: "pauseIt" } },
        ],
      },
    ]);

    expect(paths(result)).toEqual(["zones keep"]);
    expect(new Set(refusals(result).map((diagnostic) => diagnostic.code))).toEqual(
      new Set(["OPR-06/command-collision"]),
    );
  });
});

describe("naming extensions: a tag and an extension group of one folded name merge", () => {
  test("a tag group and an x-forge group folding equal are one group with the tag's key", () => {
    const result = plan([
      { method: "GET", operationId: "zones_list", path: "/zones", tags: ["Zones"] },
      { forge: { group: ["zones"], method: "pause" }, operationId: "x", path: "/pause" },
    ]);

    expect(named(result)).toEqual([
      { alias: undefined, path: "zones list", sources: { command: "operationId", group: "tag" } },
      { alias: undefined, path: "zones pause", sources: { command: "x-forge", group: "x-forge" } },
    ]);
    expect(result.groups.map((group) => [group.name, group.tag, group.segment])).toEqual([
      ["zones", "Zones", "zones"],
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test("an extension chain nests under the merged tag group", () => {
    const result = plan([
      { forge: { group: ["zones", "settings"], method: "pause" }, path: "/pause" },
      { method: "GET", operationId: "zones_list", path: "/zones", tags: ["Zones"] },
    ]);

    expect(paths(result)).toEqual(["zones list", "zones settings pause"]);
    expect(result.groups.map((group) => [group.name, group.tag, group.parent])).toEqual([
      ["zones", "Zones", undefined],
      ["settings", "zones.settings", "Zones"],
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test("command names inside the merged group follow the collision rules", () => {
    const result = plan([
      { method: "GET", operationId: "zones_pause", path: "/zones", tags: ["Zones"] },
      { forge: { group: ["zones"], method: "pause" }, operationId: "x", path: "/pause" },
    ]);

    expect(commands(result)).toEqual([]);
    expect(refusals(result).map((diagnostic) => diagnostic.code)).toEqual([
      "OPR-06/command-collision",
      "OPR-06/command-collision",
    ]);
  });

  test("two tags folding equal still collide", () => {
    const result = plan([
      { operationId: "a", path: "/a", tags: ["Zones"] },
      { operationId: "b", path: "/b", tags: ["zones"] },
    ]);

    expect(new Set(refusals(result).map((diagnostic) => diagnostic.code))).toEqual(
      new Set(["TAG-02/segment-collision"]),
    );
  });
});

describe("author config aliases", () => {
  const aliased: OperationInput = {
    aliases: [{ forge: { group: ["zones"], method: "pause" } }],
    method: "PATCH",
    operationId: "zones_status_edit",
    path: "/zones/{id}/status",
    tags: ["zones"],
  };

  test("config aliases replace x-forge-aliases, named with source config", () => {
    const result = plan(
      [aliased],
      makeConfig({
        zones_status_edit: { aliases: [{ group: "zones.settings", method: "freeze" }] },
      }),
    );

    expect(named(result)).toEqual([
      {
        alias: undefined,
        path: "zones status-edit",
        sources: { command: "operationId", group: "tag" },
      },
      { alias: 0, path: "zones settings freeze", sources: { command: "config", group: "config" } },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test("an empty config list drops the extension aliases", () => {
    const result = plan([aliased], makeConfig({ zones_status_edit: { aliases: [] } }));

    expect(paths(result)).toEqual(["zones status-edit"]);
  });

  test("absent config aliases, the extension aliases add", () => {
    const result = plan([aliased], makeConfig({ zones_status_edit: { command: "edit" } }));

    expect(paths(result)).toEqual(["zones edit", "zones pause"]);
  });

  test("a method-only alias sits at the root; a group-only alias takes the operationId fold", () => {
    const result = plan(
      [aliased],
      makeConfig({
        zones_status_edit: { aliases: [{ method: "freeze" }, { group: ["regions"] }] },
      }),
    );

    expect(named(result)).toEqual([
      { alias: 0, path: "freeze", sources: { command: "config", group: "none" } },
      {
        alias: undefined,
        path: "zones status-edit",
        sources: { command: "operationId", group: "tag" },
      },
      {
        alias: 1,
        path: "regions zones-status-edit",
        sources: { command: "operationId", group: "config" },
      },
    ]);
  });

  test("a config alias colliding with its own primary refuses the operation", () => {
    const result = plan(
      [aliased],
      makeConfig({ zones_status_edit: { aliases: [{ group: "zones", method: "status-edit" }] } }),
    );

    expect(commands(result)).toEqual([]);
    expect(refusals(result).map((diagnostic) => diagnostic.code)).toContain(
      "OPR-06/command-collision",
    );
  });
});
