import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mapCommands, resolveName } from "../src/commands.js";

const groupKey = "x-fern-sdk-group-name";
const methodKey = "x-fern-sdk-method-name";
const aliasesKey = "x-forge-aliases";
const location = "/paths/~1reports/post";
const project = (operation: unknown) => Effect.runSync(mapCommands(operation, location));
const error = (operation: unknown) => Effect.runSync(Effect.flip(mapCommands(operation, location)));

describe("command metadata", () => {
  test("normalizes arbitrary depth and preserves input", () => {
    const operation = {
      operationId: "reports_get",
      [groupKey]: " CloudAPI.user_accounts.deep.Reports ",
      [methodKey]: "getReport",
      method: "POST",
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
  test("missing or nonstring operation IDs and missing groups skip", () => {
    for (const operation of [{}, { operationId: 5, [groupKey]: null }, { operationId: "get" }]) {
      expect(project(operation)).toEqual([]);
    }
  });
  test("method fallback follows final hyphen or underscore segment", () => {
    for (const [id, action] of [
      ["reports_get", "get"],
      ["reports-fetch", "fetch"],
      ["reports_", "get"],
      ["", "get"],
    ] as const) {
      expect(project({ operationId: id, [groupKey]: "reports", [methodKey]: "" })).toEqual([
        { commandPath: ["reports", action] },
      ]);
    }
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
    expect(project(Object.create({ operationId: "get", [groupKey]: "reports" }))).toEqual([]);
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
