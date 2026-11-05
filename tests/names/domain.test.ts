import { describe, expect, test } from "bun:test";
import { Array as Arr } from "effect";
import { domainIdentifiers, fixedNamespaces } from "../../src/names/domain.ts";

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
