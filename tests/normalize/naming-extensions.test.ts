import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Operation } from "../../src/model/entities.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";

// The subjects are entities with branded fields; `expect`'s own parameter would reject the plain
// literals they are compared with.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- test helper, the value is only compared
const see = (value: unknown) => expect(value);

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const configUri = Schema.decodeUnknownSync(DocumentUri)("file:///spec/author.json");

const config = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "example",
  package: { name: "example-cli", version: "1.0.0" },
});

type Line = "3.0" | "3.1";

const lines: readonly (readonly [Line, string])[] = [
  ["3.0", "3.0.3"],
  ["3.1", "3.1.1"],
];

interface Members {
  readonly [key: string]: Json;
}

const run = (line: Line, openapi: string, paths: Json) =>
  Effect.runSync(
    resolve({
      document: entry,
      line,
      value: { info: { title: "t", version: "1" }, openapi, paths },
    }).pipe(
      Effect.flatMap((resolution) =>
        normalize(resolution, { checkFindings: [], config, configDocument: configUri }),
      ),
    ),
  );

const ok: Members = { responses: { "200": { description: "ok" } } };

const get = (path: string, extensions: Members): Members => ({
  [path]: { get: { ...ok, ...extensions } },
});

const at = (operations: readonly Operation[], path: string): Operation | undefined =>
  operations.find((found) => found.key.path === path);

const hasNaming = (operations: readonly Operation[], path: string): boolean => {
  const found = at(operations, path);

  return found !== undefined && "naming" in found;
};

const pointerOf = (path: string, ...tokens: readonly string[]): string =>
  [`/paths/${path.replaceAll("~", "~0").replaceAll("/", "~1")}/get`, ...tokens].join("/");

// The naming notices only: code, row, scope, severity and pointer, never message text (C5).
const notices = (diagnostics: readonly Diagnostic[]) =>
  diagnostics
    .filter((diagnostic) => diagnostic.row === "EXT-01")
    .map(({ code, pointer, row, scope, severity }) => ({ code, pointer, row, scope, severity }));

const notice = (code: string, pointer: string) => ({
  code,
  pointer,
  row: "EXT-01",
  scope: "element",
  severity: "notice",
});

describe.each(lines)("naming extensions (%s)", (line, openapi) => {
  test("a dotted forge group splits at `.`, top level first", () => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", { "x-forge-group-name": "accounts.members", "x-forge-method-name": "list" }),
    );

    see(at(api.operations, "/a")?.naming).toEqual({
      forge: { group: ["accounts", "members"], method: "list", pointer: pointerOf("/a") },
    });
    see(notices(diagnostics)).toEqual([]);
  });

  test("an array forge group keeps its elements whole", () => {
    const { api } = run(
      line,
      openapi,
      get("/a", { "x-forge-group-name": ["accounts", "members.v2"], "x-forge-method-name": "get" }),
    );

    see(at(api.operations, "/a")?.naming).toEqual({
      forge: { group: ["accounts", "members.v2"], method: "get", pointer: pointerOf("/a") },
    });
  });

  test("a fern group and method are read beside the forge names", () => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", {
        "x-fern-sdk-group-name": "zones.settings",
        "x-fern-sdk-method-name": "getHeartbeat",
        "x-forge-method-name": "heartbeat",
      }),
    );

    see(at(api.operations, "/a")?.naming).toEqual({
      fern: { group: ["zones", "settings"], method: "getHeartbeat", pointer: pointerOf("/a") },
      forge: { method: "heartbeat", pointer: pointerOf("/a") },
    });
    see(notices(diagnostics)).toEqual([]);
  });

  test("a group alone or a method alone is a hint", () => {
    const { api } = run(line, openapi, {
      ...get("/g", { "x-fern-sdk-group-name": ["billing"] }),
      ...get("/m", { "x-forge-method-name": "purge" }),
    });

    see(at(api.operations, "/g")?.naming).toEqual({
      fern: { group: ["billing"], pointer: pointerOf("/g") },
    });
    see(at(api.operations, "/m")?.naming).toEqual({
      forge: { method: "purge", pointer: pointerOf("/m") },
    });
  });

  test("aliases keep their index; an unnamed alias is dropped with alias-unnamed", () => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", {
        "x-forge-aliases": [
          { "x-fern-availability": "beta", "x-forge-method-name": "orphan" },
          {
            "x-fern-sdk-group-name": "hyperdrive.integration.planetscale",
            "x-fern-sdk-method-name": "signature",
          },
        ],
        "x-forge-group-name": "hyperdrive",
        "x-forge-method-name": "signature",
      }),
    );

    // The operation keeps its own names: each alias is one more name for it (Mind ruling).
    see(at(api.operations, "/a")?.naming).toEqual({
      aliases: [
        {
          fern: {
            group: ["hyperdrive", "integration", "planetscale"],
            method: "signature",
            pointer: pointerOf("/a", "x-forge-aliases", "1"),
          },
          index: 1,
        },
      ],
      forge: { group: ["hyperdrive"], method: "signature", pointer: pointerOf("/a") },
    });
    see(notices(diagnostics)).toEqual([
      notice("EXT-01/alias-unnamed", pointerOf("/a", "x-forge-aliases", "0")),
    ]);
  });

  test("an alias is named by its own keys and inherits none from the operation", () => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", {
        "x-forge-aliases": [
          { "x-forge-group-name": ["dns"], "x-forge-method-name": "records-list" },
          { "x-forge-method-name": "only-a-method" },
        ],
        "x-forge-group-name": "zones",
      }),
    );

    see(at(api.operations, "/a")?.naming).toEqual({
      aliases: [
        {
          forge: {
            group: ["dns"],
            method: "records-list",
            pointer: pointerOf("/a", "x-forge-aliases", "0"),
          },
          index: 0,
        },
      ],
      forge: { group: ["zones"], pointer: pointerOf("/a") },
    });
    see(notices(diagnostics)).toEqual([
      notice("EXT-01/alias-unnamed", pointerOf("/a", "x-forge-aliases", "1")),
    ]);
  });

  test("an alias with only its own operationId is usable", () => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", { "x-forge-aliases": [{ operationId: "listZones" }] }),
    );

    see(at(api.operations, "/a")?.naming).toEqual({
      aliases: [{ index: 0, operationId: "listZones" }],
    });
    see(notices(diagnostics)).toEqual([]);
  });

  test("an alias with a group only is usable through its own operationId", () => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", {
        "x-forge-aliases": [{ operationId: "listRecords", "x-forge-group-name": "dns" }],
      }),
    );

    see(at(api.operations, "/a")?.naming).toEqual({
      aliases: [
        {
          forge: { group: ["dns"], pointer: pointerOf("/a", "x-forge-aliases", "0") },
          index: 0,
          operationId: "listRecords",
        },
      ],
    });
    see(notices(diagnostics)).toEqual([]);
  });

  test("an alias with neither keys nor an operationId is alias-unnamed", () => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", {
        "x-forge-aliases": [{ "x-forge-method-name": "only-a-method" }],
        "x-forge-method-name": "list",
      }),
    );

    see(at(api.operations, "/a")?.naming).toEqual({
      forge: { method: "list", pointer: pointerOf("/a") },
    });
    see(notices(diagnostics)).toEqual([
      notice("EXT-01/naming-invalid", pointerOf("/a", "x-forge-aliases")),
      notice("EXT-01/alias-unnamed", pointerOf("/a", "x-forge-aliases", "0")),
    ]);
  });

  test("an alias never inherits the operation's operationId", () => {
    const { api, diagnostics } = run(line, openapi, {
      "/a": {
        get: {
          ...ok,
          operationId: "parentId",
          "x-forge-aliases": [{ "x-forge-group-name": "dns" }],
        },
      },
    });

    see(hasNaming(api.operations, "/a")).toBe(false);
    see(notices(diagnostics)).toEqual([
      notice("EXT-01/naming-invalid", pointerOf("/a", "x-forge-aliases")),
      notice("EXT-01/alias-unnamed", pointerOf("/a", "x-forge-aliases", "0")),
    ]);
  });

  test("an x-forge-aliases inside an alias is ignored without a notice", () => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", {
        "x-forge-aliases": [
          {
            "x-forge-aliases": "not read",
            "x-forge-group-name": "g",
            "x-forge-method-name": "m",
          },
        ],
      }),
    );

    see(at(api.operations, "/a")?.naming).toEqual({
      aliases: [
        {
          forge: { group: ["g"], method: "m", pointer: pointerOf("/a", "x-forge-aliases", "0") },
          index: 0,
        },
      ],
    });
    see(notices(diagnostics)).toEqual([]);
  });

  const malformedGroups: readonly (readonly [string, Json])[] = [
    ["a number", 7],
    ["an object", { name: "accounts" }],
    ["null", null],
    ["an empty string", ""],
    ["an empty array", []],
    ["an array with a number", ["accounts", 1]],
    ["an array with an empty string", ["accounts", ""]],
    ["a dotted string with an empty segment", "a..b"],
  ];

  test.each(malformedGroups)(
    "a group that is %s is dropped with naming-invalid",
    (_label, value) => {
      const { api, diagnostics } = run(
        line,
        openapi,
        get("/a", { "x-forge-group-name": value, "x-forge-method-name": "list" }),
      );

      see(at(api.operations, "/a")?.naming).toEqual({
        forge: { method: "list", pointer: pointerOf("/a") },
      });
      see(notices(diagnostics)).toEqual([
        notice("EXT-01/naming-invalid", pointerOf("/a", "x-forge-group-name")),
      ]);
    },
  );

  const groupOf = (value: Json) => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", { "x-forge-group-name": value, "x-forge-method-name": "list" }),
    );

    return {
      group: at(api.operations, "/a")?.naming?.forge?.group,
      notices: notices(diagnostics),
    };
  };

  test("group segments refuse an empty segment", () => {
    const unusable = {
      group: undefined,
      notices: [notice("EXT-01/naming-invalid", pointerOf("/a", "x-forge-group-name"))],
    };

    for (const value of ["", "a..b", "a.", ".a", ["a", ""]]) {
      see(groupOf(value)).toEqual(unusable);
    }

    for (const value of ["a.b", ["a", "b"]]) {
      see(groupOf(value)).toEqual({ group: ["a", "b"], notices: [] });
    }
  });

  const malformedMethods: readonly (readonly [string, Json])[] = [
    ["a number", 7],
    ["an object", { name: "list" }],
    ["null", null],
    ["an empty string", ""],
    ["an array", ["list"]],
  ];

  test.each(malformedMethods)(
    "a method that is %s is dropped with naming-invalid",
    (_label, value) => {
      const { api, diagnostics } = run(
        line,
        openapi,
        get("/a", { "x-fern-sdk-group-name": "users", "x-fern-sdk-method-name": value }),
      );

      see(at(api.operations, "/a")?.naming).toEqual({
        fern: { group: ["users"], pointer: pointerOf("/a") },
      });
      see(notices(diagnostics)).toEqual([
        notice("EXT-01/naming-invalid", pointerOf("/a", "x-fern-sdk-method-name")),
      ]);
    },
  );

  test("an operation whose every naming value is unusable has no naming", () => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", { "x-fern-sdk-method-name": 3, "x-forge-group-name": "" }),
    );

    see(at(api.operations, "/a")).toBeDefined();
    see(hasNaming(api.operations, "/a")).toBe(false);
    see(notices(diagnostics)).toEqual([
      notice("EXT-01/naming-invalid", pointerOf("/a", "x-fern-sdk-method-name")),
      notice("EXT-01/naming-invalid", pointerOf("/a", "x-forge-group-name")),
    ]);
  });

  test("an empty x-forge-aliases is treated as absent with naming-invalid", () => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", { "x-forge-aliases": [], "x-forge-method-name": "list" }),
    );

    see(at(api.operations, "/a")?.naming).toEqual({
      forge: { method: "list", pointer: pointerOf("/a") },
    });
    see(notices(diagnostics)).toEqual([
      notice("EXT-01/naming-invalid", pointerOf("/a", "x-forge-aliases")),
    ]);
  });

  test("an x-forge-aliases with no usable alias is treated as absent", () => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", { "x-forge-aliases": [{ "x-forge-group-name": "g" }, 5] }),
    );

    see(hasNaming(api.operations, "/a")).toBe(false);
    see(notices(diagnostics)).toEqual([
      notice("EXT-01/naming-invalid", pointerOf("/a", "x-forge-aliases")),
      notice("EXT-01/alias-unnamed", pointerOf("/a", "x-forge-aliases", "0")),
      notice("EXT-01/naming-invalid", pointerOf("/a", "x-forge-aliases", "1")),
    ]);
  });

  test("an x-forge-aliases that is not an array is dropped with naming-invalid", () => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", { "x-forge-aliases": { "x-forge-method-name": "m" } }),
    );

    see(hasNaming(api.operations, "/a")).toBe(false);
    see(notices(diagnostics)).toEqual([
      notice("EXT-01/naming-invalid", pointerOf("/a", "x-forge-aliases")),
    ]);
  });

  test("a malformed value inside an alias is reported at its own pointer", () => {
    const { api, diagnostics } = run(
      line,
      openapi,
      get("/a", {
        "x-forge-aliases": [
          {
            "x-fern-sdk-group-name": "a",
            "x-fern-sdk-method-name": "b",
            "x-forge-group-name": "a..b",
          },
        ],
      }),
    );

    see(at(api.operations, "/a")?.naming).toEqual({
      aliases: [
        {
          fern: { group: ["a"], method: "b", pointer: pointerOf("/a", "x-forge-aliases", "0") },
          index: 0,
        },
      ],
    });
    see(notices(diagnostics)).toEqual([
      notice(
        "EXT-01/naming-invalid",
        pointerOf("/a", "x-forge-aliases", "0", "x-forge-group-name"),
      ),
    ]);
  });

  test("a spec without naming extensions normalizes as Milestone 1 did", () => {
    const paths: Json = {
      "/a": {
        get: { ...ok, operationId: "listA", tags: ["things"] },
        post: { ...ok, "x-forge-hidden": true, "x-speakeasy-retries": { strategy: "backoff" } },
      },
    };
    const { api, diagnostics } = run(line, openapi, paths);

    see(api.operations.map((found) => "naming" in found)).toEqual([false, false]);
    see(notices(diagnostics)).toEqual([]);
    // Behaviour extensions stay informational: recorded as EXT-01, never read.
    see(
      api.informational
        .filter((element) => element.row === "EXT-01")
        .map((element) => element.origin.pointer),
    ).toEqual(["/paths/~1a/post/x-forge-hidden", "/paths/~1a/post/x-speakeasy-retries"]);
  });
});
