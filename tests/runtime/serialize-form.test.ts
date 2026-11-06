import { describe, expect, test } from "bun:test";
import { Effect, Runtime } from "effect";
import type { HttpClientRequest } from "effect/http";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";
import type { FormEncoding, Json } from "../../src/runtime-src/runtime/serialize.ts";

const media = "application/x-www-form-urlencoded";

type Properties = Serialize.UrlEncodedOptions["properties"];

// Every name in `value` declared with no Encoding fields, in the value's own order.
const declared = (value: { readonly [property: string]: Json }, encoding: FormEncoding = {}) =>
  Object.keys(value).map((name) => [name, encoding] as const);

const encode = (
  value: { readonly [property: string]: Json },
  properties: Properties = declared(value),
) => Effect.runPromise(Serialize.urlEncode(value, { properties }));

const expectUsage = async (effect: Effect.Effect<unknown, UsageError>) => {
  const error = await Effect.runPromise(Effect.flip(effect));

  expect(error).toBeInstanceOf(UsageError);
  expect(error[Runtime.errorExitCode]).toBe(2);
};

const send = (value: Json, properties: Properties, required = true) =>
  Effect.runPromise(
    Serialize.request("POST", {
      body: Serialize.urlEncoded(media, value, { properties, required }),
      headers: [],
      path: Serialize.path("/", []),
      query: [],
    }),
  );

const bytes = (built: HttpClientRequest.HttpClientRequest) =>
  built.body._tag === "Uint8Array" ? new TextDecoder().decode(built.body.body) : built.body._tag;

describe("form-urlencoded value text", () => {
  test.each([
    ["a space", "a b", "v=a+b"],
    ["a plus", "a+b", "v=a%2Bb"],
    ["a percent", "100%", "v=100%25"],
    ["an ampersand", "a&b", "v=a%26b"],
    ["an equals sign", "a=b", "v=a%3Db"],
    ["non-ASCII text", "é ☃", "v=%C3%A9+%E2%98%83"],
    ["a percent triplet", "%20", "v=%2520"],
    ["the WHATWG safe set and the rest", "*-._~!'()", "v=*-._%7E%21%27%28%29"],
  ])("%s is encoded once by the WHATWG serializer", async (_, text, expected) => {
    expect(await encode({ v: text })).toBe(expected);
  });

  test("names are encoded as values are", async () => {
    expect(await encode({ "a b&c": "x" })).toBe("a+b%26c=x");
  });

  test("numbers and booleans are sent as their JSON text", async () => {
    expect(await encode({ n: 1.5, ok: true })).toBe("n=1.5&ok=true");
  });

  test("base64 padding is percent-encoded", async () => {
    expect(await encode({ data: "AQI=" })).toBe("data=AQI%3D");
  });
});

describe("form-urlencoded default contentType", () => {
  test("an object property is sent as compact JSON, then encoded", async () => {
    expect(await encode({ meta: { a: 1, b: "x y" } })).toBe(
      "meta=%7B%22a%22%3A1%2C%22b%22%3A%22x+y%22%7D",
    );
  });

  test("an array repeats its name, one pair per item", async () => {
    expect(await encode({ tag: ["a", "b c"] })).toBe("tag=a&tag=b+c");
  });

  test("an object item of an array is sent as compact JSON", async () => {
    expect(await encode({ tag: [{ a: 1 }] })).toBe("tag=%7B%22a%22%3A1%7D");
  });

  test("a null property is omitted", async () => {
    expect(await encode({ a: null, b: "x" })).toBe("b=x");
  });

  test("an empty array sends no pair", async () => {
    expect(await encode({ a: [], b: "x" })).toBe("b=x");
  });

  test("a non-finite number is refused", async () => {
    await expectUsage(Serialize.urlEncode({ n: Number.NaN }, { properties: [["n", {}]] }));
  });
});

describe("form-urlencoded Encoding style", () => {
  test("style form with explode false joins items with an unencoded comma", async () => {
    expect(await encode({ tag: ["a b", "c,d"] }, [["tag", { explode: false }]])).toBe(
      "tag=a+b,c%2Cd",
    );
  });

  test("style form explodes an array to repeated names and an object to its members", async () => {
    expect(await encode({ tag: ["a", "b"] }, [["tag", { style: "form" }]])).toBe("tag=a&tag=b");
    expect(await encode({ color: { G: 200, R: 100 } }, [["color", { explode: true }]])).toBe(
      "G=200&R=100",
    );
  });

  test("a non-exploded object joins keys and values with commas", async () => {
    expect(await encode({ color: { G: 200, R: 100 } }, [["color", { explode: false }]])).toBe(
      "color=G,200,R,100",
    );
  });

  test("an explicit style sends an object as members, not as JSON", async () => {
    expect(await encode({ color: { R: 1 } }, [["color", { style: "form" }]])).toBe("R=1");
  });

  test("spaceDelimited joins with an encoded space and pipeDelimited with an encoded pipe", async () => {
    expect(await encode({ tag: ["a", "b"] }, [["tag", { style: "spaceDelimited" }]])).toBe(
      "tag=a+b",
    );
    expect(await encode({ tag: ["a", "b"] }, [["tag", { style: "pipeDelimited" }]])).toBe(
      "tag=a%7Cb",
    );
  });

  test("deepObject sends each member under a bracketed, encoded name", async () => {
    expect(
      await encode({ color: { "G B": "x y", R: 100 } }, [["color", { style: "deepObject" }]]),
    ).toBe("color%5BG+B%5D=x+y&color%5BR%5D=100");
  });

  test("allowReserved leaves / and ? but encodes &, =, + and #", async () => {
    expect(await encode({ p: "/a?b&c=d+e#f g" }, [["p", { allowReserved: true }]])).toBe(
      "p=/a?b%26c%3Dd%2Be%23f+g",
    );
  });

  test("a null property is omitted under an explicit style", async () => {
    expect(
      await encode({ a: null, b: "x" }, [
        ["a", { style: "form" }],
        ["b", {}],
      ]),
    ).toBe("b=x");
  });

  test("a value nested deeper than one level is refused", async () => {
    await expectUsage(
      Serialize.urlEncode({ c: { d: { e: 1 } } }, { properties: [["c", { style: "form" }]] }),
    );
  });

  test("a delimiter inside an item that the expansion leaves unencoded is refused", async () => {
    await expectUsage(
      Serialize.urlEncode(
        { tag: ["a,b", "c"] },
        { properties: [["tag", { allowReserved: true, explode: false }]] },
      ),
    );
  });
});

describe("form-urlencoded pairs", () => {
  test("pair order is the declared order, not the input order", async () => {
    expect(
      await encode({ a: "1", b: "2", c: "3" }, [
        ["c", {}],
        ["a", {}],
        ["b", {}],
      ]),
    ).toBe("c=3&a=1&b=2");
  });

  test("a declared property with no value sends nothing", async () => {
    expect(
      await encode({ b: "2" }, [
        ["a", {}],
        ["b", {}],
      ]),
    ).toBe("b=2");
  });

  test("a property the form does not declare is refused", async () => {
    await expectUsage(Serialize.urlEncode({ a: "1", z: "2" }, { properties: [["a", {}]] }));
  });
});

describe("form-urlencoded body", () => {
  test("the body is the encoded text under the declared media type", async () => {
    const built = await send({ a: "x y", b: ["1", "2"] }, [
      ["a", {}],
      ["b", {}],
    ]);

    expect(built.headers["content-type"]).toBe(media);
    expect(bytes(built)).toBe("a=x+y&b=1&b=2");
  });

  test("a required body with no pairs is empty text, an optional one is no body", async () => {
    const required = await send({}, [["a", {}]]);
    const optional = await send({}, [["a", {}]], false);

    expect(bytes(required)).toBe("");
    expect(required.headers["content-type"]).toBe(media);
    expect(bytes(optional)).toBe("Empty");
    expect(optional.headers["content-type"]).toBeUndefined();
  });

  test("a body that is not an object is refused", async () => {
    await expectUsage(
      Serialize.urlEncoded(media, ["a"], { properties: [], required: true }).expand,
    );
    await expectUsage(
      Serialize.urlEncoded(media, "a=b", { properties: [], required: true }).expand,
    );
  });
});
