import { describe, expect, test } from "bun:test";
import { Array as Arr } from "effect";
import {
  domainIdentifiers,
  fixedNamespaces,
  rootModuleNames,
  runtimeNamespaces,
} from "../../src/names/domain.ts";
import { reservedIdentifiers } from "../../src/names/reserved.ts";

const inline = "/paths/~1users/post/requestBody/content/application~1json/schema";

const names = (keys: readonly string[]): Readonly<Record<string, string>> =>
  Object.fromEntries([...domainIdentifiers(keys)].map(([key, name]) => [key, String(name)]));

describe("domainIdentifiers", () => {
  test("keys fold to Pascal case", () => {
    expect(names(["user_update", "my-schema", "Avatar", inline])).toEqual({
      Avatar: "Avatar",
      "my-schema": "MySchema",
      [inline]: "Paths1usersPostRequestBodyContentApplication1jsonSchema",
      user_update: "UserUpdate",
    });
  });

  test("Schema and the fixed cli imports are never a domain name", () => {
    const result = names(["Schema", ...fixedNamespaces]);

    expect(result).toMatchObject({ Command: "Command2", Option: "Option2", Schema: "Schema2" });
    for (const name of Object.values(result)) {
      expect(name === "Schema" || fixedNamespaces.has(name)).toBe(false);
    }
  });

  test("every runtime namespace the cli emitter imports is never a domain name", () => {
    const result = names(runtimeNamespaces.map(([name]) => name));

    expect(result.Multipart).toBe("Multipart2");
    for (const [name] of runtimeNamespaces) {
      expect(Object.values(result)).not.toContain(name);
    }
  });

  test("TypeScript keywords, predefined types and globals are never a domain name", () => {
    const result = names([
      "Error",
      "string",
      "Date",
      "Map",
      "Array",
      "Boolean",
      "record",
      "Error_",
    ]);

    expect(result).toEqual({
      Array: "Array_",
      Boolean: "Boolean_",
      Date: "Date_",
      Error: "Error_",
      Error_: "Error_2",
      Map: "Map_",
      record: "Record_",
      string: "String_",
    });
    for (const name of Object.values(result)) {
      expect(reservedIdentifiers.has(name)).toBe(false);
    }
  });

  test("the names cli/root.ts imports are never a domain name", () => {
    const result = names([...rootModuleNames]);

    for (const name of Object.values(result)) {
      expect(rootModuleNames.has(name)).toBe(false);
    }
  });

  test("keys that fold alike take suffixes in code-point order, whatever the input order", () => {
    const keys = ["user", "User", "User2", "USER"];
    const forward = names(keys);

    expect(forward).toEqual({ USER: "User", User: "User2", User2: "User22", user: "User3" });
    expect(names(Arr.reverse(keys))).toEqual(forward);
  });

  test("a key with nothing to fold is named Definition", () => {
    expect(names(["_", "$", "Definition"])).toEqual({
      $: "Definition",
      Definition: "Definition2",
      _: "Definition3",
    });
  });

  test("every name is distinct", () => {
    const keys = ["a-b", "a_b", "AB", "Ab", "a b", "ab"];
    const result = domainIdentifiers(keys);

    expect(new Set(result.values()).size).toBe(keys.length);
  });
});
