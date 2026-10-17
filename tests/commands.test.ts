import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { Schema } from "effect";
import { mapCommands, resolveName } from "../src/core/commands.js";

const groupKey = "x-fern-sdk-group-name";

const methodKey = "x-fern-sdk-method-name";

const aliasesKey = "x-forge-aliases";

const location = "/paths/~1reports/post";

const project = (operation: Schema.Json) =>
  Effect.runSync(mapCommands(operation, location, { method: "POST", path: "/reports" }));

const error = (operation: Schema.Json) =>
  Effect.runSync(
    Effect.flip(mapCommands(operation, location, { method: "POST", path: "/reports" })),
  );

describe("command metadata", () => {
  test("normalizes arbitrary depth and preserves input", () => {
    const operation = {
      method: "POST",
      operationId: "reports_get",
      [groupKey]: " CloudAPI.user_accounts.deep.Reports ",
      [methodKey]: "getReport",
    };
    const before = JSON.stringify(operation);
    expect(project(operation)).toEqual([
      { commandPath: ["cloud-api", "user-accounts", "deep", "reports", "get-report"] },
    ]);
    expect(JSON.stringify(operation)).toBe(before);
    expect(project({ operationId: "get", [groupKey]: ["CloudAPI", "deep", "Reports"] })).toEqual([
      { commandPath: ["cloud-api", "deep", "reports", "get"] },
    ]);
  });
  test("aliases replace primary including empty aliases", () => {
    expect(
      project({
        operationId: "report_get",
        [groupKey]: 42,
        [aliasesKey]: [{ [groupKey]: "one.two", [methodKey]: "fetch" }, { [groupKey]: ["other"] }],
      }),
    ).toEqual([{ commandPath: ["one", "two", "fetch"] }, { commandPath: ["other", "get"] }]);
    expect(project({ operationId: "get", [groupKey]: "reports", [aliasesKey]: [] })).toEqual([]);
  });
  test("absent naming metadata derives from operation identity or route", () => {
    expect(project({})).toEqual([{ commandPath: ["reports", "post"] }]);
    expect(project({ operationId: "get" })).toEqual([{ commandPath: ["get"] }]);
    expect(project({ operationId: "emails/send-batch" })).toEqual([
      { commandPath: ["emails", "send-batch"] },
    ]);
    expect(project({ operationId: "get user" })).toEqual([{ commandPath: ["get-user"] }]);
    expect(project({ operationId: "users.get" })).toEqual([{ commandPath: ["users-get"] }]);
    expect(error({ operationId: 5 }).location).toBe(`${location}/operationId`);
    expect(error({ operationId: "" }).location).toBe(`${location}/operationId`);
  });
  test("explicit groups retain the final-segment action fallback", () => {
    expect(project({ operationId: "reports_get", [groupKey]: "reports" })).toEqual([
      { commandPath: ["reports", "get"] },
    ]);
    expect(project({ operationId: "reports-fetch", [groupKey]: "reports" })).toEqual([
      { commandPath: ["reports", "fetch"] },
    ]);
    expect(project({ operationId: "help", [groupKey]: "reports", [methodKey]: "fetch" })).toEqual([
      { commandPath: ["reports", "fetch"] },
    ]);
    expect(
      project({ operationId: "operation:foo", [groupKey]: "reports", [methodKey]: "fetch" }),
    ).toEqual([{ commandPath: ["reports", "fetch"] }]);
  });
  test("rejects malformed supplied metadata at its pointer", () => {
    for (const value of [null, 1, {}, [], "", "a..b", ["ok", 3], ["ok", ""]]) {
      const failure = error({ operationId: "get", [groupKey]: value });
      expect(failure._tag).toBe("GenerationError");
      expect(failure.location.startsWith(`${location}/${groupKey}`)).toBe(true);
    }
    expect(error({ operationId: "get", [groupKey]: "reports", [methodKey]: 4 }).location).toBe(
      `${location}/${methodKey}`,
    );
    expect(error({ operationId: "get", [aliasesKey]: {} }).location).toBe(
      `${location}/${aliasesKey}`,
    );
    expect(error({ operationId: "get", [aliasesKey]: [null] }).location).toBe(
      `${location}/${aliasesKey}/0`,
    );
    expect(error({ operationId: "get", [aliasesKey]: [{}] }).location).toBe(
      `${location}/${aliasesKey}/0/${groupKey}`,
    );
  });
  test("unsafe tokens fail rather than being silently slugged", () => {
    for (const token of ["a/b", "a b", "--help", "__proto__", "1abc", "é", "a;exit", "a.b"]) {
      expect(error({ operationId: "get", [groupKey]: [token] }).code).toBe("invalid_input");
      expect(error({ operationId: "get", [groupKey]: "reports", [methodKey]: token }).code).toBe(
        "invalid_input",
      );
    }
  });
  test("only own metadata is considered", () => {
    const operation = {};
    Object.setPrototypeOf(operation, { operationId: "get", [groupKey]: "reports" });
    expect(project(operation)).toEqual([{ commandPath: ["reports", "post"] }]);
  });
});

describe("executable name", () => {
  test("slugs display titles and honors exact valid overrides", () => {
    expect(Effect.runSync(resolveName("CloudAPI User Accounts!"))).toBe("cloud-api-user-accounts");
    expect(Effect.runSync(resolveName("--- Hello World ---"))).toBe("hello-world");
    expect(Effect.runSync(resolveName("💥", { name: "my-api" }))).toBe("my-api");
  });
  test("invalid explicit names identify the option", () => {
    for (const name of [
      "",
      "MyApi",
      "my_api",
      "1api",
      "../api",
      "help",
      "h",
      "version",
      "v",
      "wizard",
      "completions",
      "log-level",
    ]) {
      const failure = Effect.runSync(Effect.flip(resolveName("Good Title", { name })));
      expect(failure.code).toBe("invalid_options");
      expect(failure.location).toBe("/options/name");
    }
  });
  test("unusable default title asks for an explicit name", () => {
    for (const title of ["💥", "123 API", "Help"]) {
      const failure = Effect.runSync(Effect.flip(resolveName(title)));
      expect(failure.location).toBe("/info/title");
      expect(failure.hint).toContain("--name");
    }
  });
});

const route = (path: string, operation: Schema.Json = {}) =>
  Effect.runSync(mapCommands(operation, location, { method: "GET", path }));

test("route defaults preserve placeholders and sanitize static names deterministically", () => {
  expect(route("/users/{id}")).toEqual([{ commandPath: ["users", "by-id", "get"] }]);
  expect(route("/archive.json/123")).toEqual([
    { commandPath: ["archive-json", "path-123", "get"] },
  ]);
  expect(route("/things", { operationId: "!!!" })).toEqual([{ commandPath: ["things", "get"] }]);
  expect(route("/things", { operationId: "123" })).toEqual([{ commandPath: ["operation-123"] }]);
  expect(route("/things", { operationId: "version" })).toEqual([{ commandPath: ["version"] }]);
});
