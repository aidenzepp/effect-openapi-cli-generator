import { describe, expect, test } from "bun:test";
import { Effect, Runtime } from "effect";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";
import type { Value } from "../../src/runtime-src/runtime/serialize.ts";

const plain = { allowReserved: false, explode: false };

const exploded = { allowReserved: false, explode: true };

const reserved = { allowReserved: true, explode: false };

const reservedExploded = { allowReserved: true, explode: true };

const array: Value = ["red", "green", "blue"];

const object: Value = { B: 150, G: 200, R: 100 };

const expand = (parameter: Serialize.PathParameter) => Effect.runPromise(parameter.expand);

const expectUsage = async (effect: Effect.Effect<unknown, UsageError>) => {
  const error = await Effect.runPromise(Effect.flip(effect));

  expect(error).toBeInstanceOf(UsageError);
  expect(error).toMatchObject({ _tag: "UsageError" });
  expect(error[Runtime.errorExitCode]).toBe(2);
};

const pathOf = (template: string, ...parameters: Serialize.PathParameter[]) =>
  Effect.runPromise(Serialize.path(template, parameters).expand);

const text = (value: Value) => Effect.runPromise(Serialize.toText("p", value, false));

describe("type to text", () => {
  test("scalars use their JSON text", async () => {
    expect(await text("abc")).toEqual({ kind: "primitive", text: "abc" });
    expect(await text("")).toEqual({ kind: "primitive", text: "" });
    expect(await text(true)).toEqual({ kind: "primitive", text: "true" });
    expect(await text(false)).toEqual({ kind: "primitive", text: "false" });
    expect(await text(0)).toEqual({ kind: "primitive", text: "0" });
    expect(await text(-0)).toEqual({ kind: "primitive", text: "0" });
    expect(await text(1.5)).toEqual({ kind: "primitive", text: "1.5" });
    expect(await text(0.1 + 0.2)).toEqual({ kind: "primitive", text: "0.30000000000000004" });
    expect(await text(1e21)).toEqual({ kind: "primitive", text: "1e+21" });
    expect(await text(1e-7)).toEqual({ kind: "primitive", text: "1e-7" });
  });

  test("a digit string passes unchanged", async () => {
    expect(await text("9007199254740993")).toEqual({
      kind: "primitive",
      text: "9007199254740993",
    });
  });

  test("null, undefined, empty arrays and empty objects are undefined", async () => {
    expect(await text(null)).toBeUndefined();
    // oxlint-disable-next-line unicorn/no-useless-undefined -- the value under test
    expect(await text(undefined)).toBeUndefined();
    expect(await text([])).toBeUndefined();
    expect(await text({})).toBeUndefined();
    expect(await text({ a: undefined })).toBeUndefined();
  });

  test("an array holding one empty string is one empty item", async () => {
    expect(await text([""])).toEqual({ items: [""], kind: "array" });
  });

  test("arrays and objects keep document order", async () => {
    expect(await text(array)).toEqual({ items: ["red", "green", "blue"], kind: "array" });
    expect(await text(object)).toEqual({
      kind: "object",
      members: [
        ["B", "150"],
        ["G", "200"],
        ["R", "100"],
      ],
    });
  });

  test("an undefined member is omitted", async () => {
    expect(await text({ a: 1, b: undefined })).toEqual({
      kind: "object",
      members: [["a", "1"]],
    });
  });

  test("a required undefined is a usage error", async () => {
    const values: readonly Value[] = [null, undefined, [], {}];

    await Promise.all(values.map((value) => expectUsage(Serialize.toText("p", value, true))));
  });

  test("non-finite numbers are refused", async () => {
    const values = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

    await Promise.all(values.map((value) => expectUsage(Serialize.toText("p", value, false))));
  });

  test("null array items, undefined array items and null members are refused", async () => {
    await expectUsage(Serialize.toText("p", ["a", null], false));
    await expectUsage(Serialize.toText("p", ["a", undefined], false));
    await expectUsage(Serialize.toText("p", { a: null }, false));
  });

  test("a nested value is refused", async () => {
    // A runtime value outside the declared type, as a content-based parameter could carry.
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- parsed JSON is any
    const nested: Value = JSON.parse('[["a"]]');

    await expectUsage(Serialize.toText("p", nested, false));
  });

  test("lone surrogates are refused in values, items, keys and members", async () => {
    const high = "a\uD800b";
    const low = "\uDC00";

    await expectUsage(Serialize.toText("p", high, false));
    await expectUsage(Serialize.toText("p", [low], false));
    await expectUsage(Serialize.toText("p", { [high]: "a" }, false));
    await expectUsage(Serialize.toText("p", { a: low }, false));
  });

  test("a surrogate pair is one code point and passes", async () => {
    expect(await text("\u{1F600}")).toEqual({ kind: "primitive", text: "\u{1F600}" });
  });
});

describe("simple", () => {
  test("a primitive", async () => {
    expect(await expand(Serialize.simple("id", "abc", plain))).toBe("abc");
    expect(await expand(Serialize.simple("id", 5, exploded))).toBe("5");
    expect(await expand(Serialize.simple("id", true, plain))).toBe("true");
    expect(await expand(Serialize.simple("id", "", plain))).toBe("");
  });

  test("an array", async () => {
    expect(await expand(Serialize.simple("id", array, plain))).toBe("red,green,blue");
    expect(await expand(Serialize.simple("id", array, exploded))).toBe("red,green,blue");
  });

  test("an object", async () => {
    expect(await expand(Serialize.simple("id", object, plain))).toBe("B,150,G,200,R,100");
    expect(await expand(Serialize.simple("id", object, exploded))).toBe("B=150,G=200,R=100");
  });

  test("everything outside unreserved is percent-encoded", async () => {
    expect(await expand(Serialize.simple("id", "a b/c?d#e%f&g=h,i", plain))).toBe(
      "a%20b%2Fc%3Fd%23e%25f%26g%3Dh%2Ci",
    );
    expect(await expand(Serialize.simple("id", "-_.~AZaz09", plain))).toBe("-_.~AZaz09");
    expect(await expand(Serialize.simple("id", "!'()*", plain))).toBe("%21%27%28%29%2A");
    expect(await expand(Serialize.simple("id", "é\u{1F600}", plain))).toBe("%C3%A9%F0%9F%98%80");
  });

  test("array items and object members are encoded, delimiters in them too", async () => {
    expect(await expand(Serialize.simple("id", ["a,b", "c d"], plain))).toBe("a%2Cb,c%20d");
    expect(await expand(Serialize.simple("id", { "k=": "v,w" }, exploded))).toBe("k%3D=v%2Cw");
  });

  test("an empty array and an empty object are refused: a path parameter is required", async () => {
    await expectUsage(Serialize.simple("id", [], plain).expand);
    await expectUsage(Serialize.simple("id", {}, plain).expand);
    await expectUsage(Serialize.simple("id", null, plain).expand);
    await expectUsage(Serialize.simple("id", undefined, plain).expand);
  });

  test("a one-item array holding an empty string expands to nothing", async () => {
    expect(await expand(Serialize.simple("id", [""], plain))).toBe("");
  });

  test("allowReserved lets reserved characters and percent triplets through", async () => {
    expect(await expand(Serialize.simple("id", ":[]@!$&'()*+;=", reserved))).toBe(":[]@!$&'()*+;=");
    expect(await expand(Serialize.simple("id", "a%2Fb%2fc", reserved))).toBe("a%2Fb%2fc");
  });

  test("allowReserved still encodes slash, question mark and hash", async () => {
    expect(await expand(Serialize.simple("id", "a/b?c#d", reserved))).toBe("a%2Fb%3Fc%23d");
  });

  test("allowReserved encodes a stray percent, spaces and other non-reserved characters", async () => {
    expect(await expand(Serialize.simple("id", "50% 100%2 %zz%", reserved))).toBe(
      "50%25%20100%252%20%25zz%25",
    );
    expect(await expand(Serialize.simple("id", 'a\\b"c<d>e^f`g{h|i}', reserved))).toBe(
      "a%5Cb%22c%3Cd%3Ee%5Ef%60g%7Bh%7Ci%7D",
    );
  });

  test("allowReserved with a comma inside an array item or object member is refused", async () => {
    await expectUsage(Serialize.simple("id", ["a,b"], reserved).expand);
    await expectUsage(Serialize.simple("id", ["a,b"], reservedExploded).expand);
    await expectUsage(Serialize.simple("id", { k: "a,b" }, reserved).expand);
    await expectUsage(Serialize.simple("id", { "a,b": "v" }, reserved).expand);
  });

  test("allowReserved with an equals sign is refused only in an exploded object", async () => {
    await expectUsage(Serialize.simple("id", { k: "a=b" }, reservedExploded).expand);
    await expectUsage(Serialize.simple("id", { "a=b": "v" }, reservedExploded).expand);
    expect(await expand(Serialize.simple("id", { k: "a=b" }, reserved))).toBe("k,a=b");
    expect(await expand(Serialize.simple("id", ["a=b"], reservedExploded))).toBe("a=b");
  });

  test("allowReserved with a comma in a primitive is not split, so it passes", async () => {
    expect(await expand(Serialize.simple("id", "a,b", reserved))).toBe("a,b");
  });

  test("lone surrogates are refused", async () => {
    await expectUsage(Serialize.simple("id", "\uD800", plain).expand);
    await expectUsage(Serialize.simple("id", "\uD800", reserved).expand);
  });
});

describe("label", () => {
  test("a primitive", async () => {
    expect(await expand(Serialize.label("id", "abc", plain))).toBe(".abc");
    expect(await expand(Serialize.label("id", 5, exploded))).toBe(".5");
    expect(await expand(Serialize.label("id", "", plain))).toBe(".");
  });

  test("an array", async () => {
    expect(await expand(Serialize.label("id", array, plain))).toBe(".red,green,blue");
    expect(await expand(Serialize.label("id", array, exploded))).toBe(".red.green.blue");
  });

  test("an object", async () => {
    expect(await expand(Serialize.label("id", object, plain))).toBe(".B,150,G,200,R,100");
    expect(await expand(Serialize.label("id", object, exploded))).toBe(".B=150.G=200.R=100");
  });

  test("empty items follow RFC 6570", async () => {
    expect(await expand(Serialize.label("id", [""], plain))).toBe(".");
    expect(await expand(Serialize.label("id", ["", ""], exploded))).toBe("..");
  });

  test("a dot inside an exploded item or member is refused in every mode", async () => {
    await expectUsage(Serialize.label("id", ["a.b"], exploded).expand);
    await expectUsage(Serialize.label("id", { k: "a.b" }, exploded).expand);
    await expectUsage(Serialize.label("id", { "a.b": "v" }, exploded).expand);
    await expectUsage(Serialize.label("id", ["a.b"], reservedExploded).expand);
  });

  test("a dot is fine where it is not a delimiter", async () => {
    expect(await expand(Serialize.label("id", ["a.b"], plain))).toBe(".a.b");
    expect(await expand(Serialize.label("id", "a.b", exploded))).toBe(".a.b");
  });

  test("allowReserved with a comma or equals sign inside an item or member is refused", async () => {
    await expectUsage(Serialize.label("id", ["a,b"], reserved).expand);
    await expectUsage(Serialize.label("id", { k: "a=b" }, reserved).expand);
    await expectUsage(Serialize.label("id", ["a=b"], reservedExploded).expand);
  });

  test("without allowReserved the same delimiters are encoded", async () => {
    expect(await expand(Serialize.label("id", ["a,b", "c=d"], plain))).toBe(".a%2Cb,c%3Dd");
  });

  test("allowReserved passes other reserved characters", async () => {
    expect(await expand(Serialize.label("id", "a:b;c@d", reserved))).toBe(".a:b;c@d");
  });
});

describe("matrix", () => {
  test("a primitive", async () => {
    expect(await expand(Serialize.matrix("id", "abc", plain))).toBe(";id=abc");
    expect(await expand(Serialize.matrix("id", 5, exploded))).toBe(";id=5");
    expect(await expand(Serialize.matrix("id", "", plain))).toBe(";id");
  });

  test("an array", async () => {
    expect(await expand(Serialize.matrix("id", array, plain))).toBe(";id=red,green,blue");
    expect(await expand(Serialize.matrix("id", array, exploded))).toBe(";id=red;id=green;id=blue");
  });

  test("an object", async () => {
    expect(await expand(Serialize.matrix("id", object, plain))).toBe(";id=B,150,G,200,R,100");
    expect(await expand(Serialize.matrix("id", object, exploded))).toBe(";B=150;G=200;R=100");
  });

  test("empty values drop the equals sign", async () => {
    expect(await expand(Serialize.matrix("id", [""], plain))).toBe(";id");
    expect(await expand(Serialize.matrix("id", ["a", ""], exploded))).toBe(";id=a;id");
    expect(await expand(Serialize.matrix("id", { k: "" }, exploded))).toBe(";k");
  });

  test("allowReserved with a semicolon, comma or equals sign inside an item or member is refused", async () => {
    await expectUsage(Serialize.matrix("id", ["a;b"], reserved).expand);
    await expectUsage(Serialize.matrix("id", ["a,b"], reservedExploded).expand);
    await expectUsage(Serialize.matrix("id", { k: "a=b" }, reserved).expand);
    await expectUsage(Serialize.matrix("id", { "a;b": "v" }, reservedExploded).expand);
  });

  test("without allowReserved the same delimiters are encoded", async () => {
    expect(await expand(Serialize.matrix("id", ["a;b", "c=d", "e,f"], exploded))).toBe(
      ";id=a%3Bb;id=c%3Dd;id=e%2Cf",
    );
  });

  test("allowReserved passes other reserved characters", async () => {
    expect(await expand(Serialize.matrix("id", "a:b@c", reserved))).toBe(";id=a:b@c");
  });
});

describe("path", () => {
  test("substitutes each placeholder with its expansion", async () => {
    expect(
      await pathOf(
        "/users/{id}/files/{name}",
        Serialize.simple("id", 42, plain),
        Serialize.simple("name", "a b", plain),
      ),
    ).toBe("/users/42/files/a%20b");
  });

  test("a label and a matrix keep their prefix", async () => {
    expect(
      await pathOf(
        "/a{id}/b{tag}",
        Serialize.label("id", "x", plain),
        Serialize.matrix("tag", array, exploded),
      ),
    ).toBe("/a.x/b;tag=red;tag=green;tag=blue");
  });

  test("a template with no placeholder passes unchanged", async () => {
    expect(await pathOf("/health")).toBe("/health");
  });

  test("a parameter used twice expands twice", async () => {
    expect(await pathOf("/{id}/x/{id}", Serialize.simple("id", 1, plain))).toBe("/1/x/1");
  });

  test("a parameter error surfaces from the path", async () => {
    await expectUsage(Serialize.path("/{id}", [Serialize.simple("id", [], plain)]).expand);
    await expectUsage(Serialize.path("/{id}", [Serialize.simple("id", "\uD800", plain)]).expand);
  });

  test("a placeholder without a parameter is refused", async () => {
    await expectUsage(Serialize.path("/{id}/{other}", [Serialize.simple("id", 1, plain)]).expand);
  });

  test("a parameter without a placeholder is refused", async () => {
    await expectUsage(
      Serialize.path("/{id}", [
        Serialize.simple("id", 1, plain),
        Serialize.simple("extra", 2, plain),
      ]).expand,
    );
  });

  test("two parameters with one name are refused", async () => {
    await expectUsage(
      Serialize.path("/{id}", [Serialize.simple("id", 1, plain), Serialize.simple("id", 2, plain)])
        .expand,
    );
  });

  test("a dot segment after expansion is refused", async () => {
    const values = [".", "..", "%2e", "%2E", "%2e%2E", ".%2e", "%2E."];

    await Promise.all(
      values.map((value) =>
        expectUsage(
          Serialize.path("/files/{name}/x", [Serialize.simple("name", value, reserved)]).expand,
        ),
      ),
    );
  });

  test("a dot segment is refused when it is the first, middle or last segment", async () => {
    await expectUsage(Serialize.path("/{a}", [Serialize.simple("a", "..", plain)]).expand);
    await expectUsage(Serialize.path("/x/{a}/y", [Serialize.simple("a", "..", plain)]).expand);
    await expectUsage(Serialize.path("/x/{a}", [Serialize.simple("a", ".", plain)]).expand);
  });

  test("a label that expands to a dot segment is refused", async () => {
    await expectUsage(Serialize.path("/x/{a}", [Serialize.label("a", ".", plain)]).expand);
  });

  test("a dot inside a longer segment is fine", async () => {
    expect(await pathOf("/f/{a}", Serialize.simple("a", "..a", plain))).toBe("/f/..a");
    expect(await pathOf("/f/{a}", Serialize.simple("a", "a.", plain))).toBe("/f/a.");
    expect(await pathOf("/f/{a}", Serialize.simple("a", "%2e%2ea", reserved))).toBe("/f/%2e%2ea");
  });

  test("an encoded slash does not split a segment", async () => {
    expect(await pathOf("/f/{a}", Serialize.simple("a", "../x", plain))).toBe("/f/..%2Fx");
  });

  test("a stray percent in a template parameter is encoded under allowReserved", async () => {
    expect(await pathOf("/f/{a}", Serialize.simple("a", "100%", reserved))).toBe("/f/100%25");
  });
});
