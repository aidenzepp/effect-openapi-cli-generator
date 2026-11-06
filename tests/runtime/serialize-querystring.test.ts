import { describe, expect, test } from "bun:test";
import { Effect, Runtime } from "effect";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";
import type { Json } from "../../src/runtime-src/runtime/serialize.ts";

const form = "application/x-www-form-urlencoded";

const ofValue = (
  mediaType: string,
  value?: Json,
  options: Partial<Serialize.QuerystringOptions> = {},
) => Serialize.querystring("q", mediaType, value, { required: false, ...options });

// The URL `request` builds for a lone querystring parameter, as the URL builder appends it.
const urlOf = async (parameter: Serialize.QueryParameter) => {
  const built = await Effect.runPromise(
    Serialize.request("GET", {
      headers: [],
      path: Serialize.path("/search", []),
      query: [parameter],
    }),
  );

  return built.url;
};

const expectUsage = async (parameter: Serialize.QueryParameter) => {
  const error = await Effect.runPromise(Effect.flip(parameter.expand));

  expect(error).toBeInstanceOf(UsageError);
  expect(error).toMatchObject({ _tag: "UsageError" });
  expect(error[Runtime.errorExitCode]).toBe(2);

  return error.message;
};

describe("querystring under form-urlencoded content", () => {
  test("STY-43: an object is encoded by the form encoder and not again", async () => {
    const parameter = ofValue(
      form,
      { a: 1, b: "x y" },
      {
        properties: [
          ["a", {}],
          ["b", {}],
        ],
      },
    );

    expect(await Effect.runPromise(parameter.expand)).toBe("a=1&b=x+y");
    expect(await urlOf(parameter)).toBe("/search?a=1&b=x+y");
  });

  test("STY-43: Encoding Object fields apply as they do for a body", async () => {
    const parameter = ofValue(
      form,
      { tags: ["a", "b"] },
      { properties: [["tags", { explode: false, style: "form" }]] },
    );

    expect(await urlOf(parameter)).toBe("/search?tags=a,b");
  });

  test("STY-43: a character the form encoder escapes is escaped once", async () => {
    const parameter = ofValue(form, { v: "a&b%" }, { properties: [["v", {}]] });

    expect(await urlOf(parameter)).toBe("/search?v=a%26b%25");
  });

  test("STY-43: an undeclared key follows the declared ones", async () => {
    const parameter = ofValue(
      form,
      Object.fromEntries([
        ["z", "1"],
        ["a", "2"],
      ]),
      { properties: [["a", {}]] },
    );

    expect(await urlOf(parameter)).toBe("/search?a=2&z=1");
  });

  test("STY-42: a value that is not an object is refused", async () => {
    await expectUsage(ofValue(form, ["a"]));
    await expectUsage(ofValue(form, "a=b"));
  });

  test("STY-42: a refusal of the encoder surfaces as a usage error", async () => {
    await expectUsage(
      ofValue(form, { v: { a: { b: 1 } } }, { properties: [["v", { style: "form" }]] }),
    );
  });
});

describe("querystring under any other media type", () => {
  test("STY-43: application/json gives the percent-encoded compact JSON", async () => {
    const parameter = ofValue("application/json", { a: 1, b: ["x y", null] });

    expect(await urlOf(parameter)).toBe(
      "/search?%7B%22a%22%3A1%2C%22b%22%3A%5B%22x%20y%22%2Cnull%5D%7D",
    );
  });

  test("STY-43: a +json media type is JSON", async () => {
    expect(await urlOf(ofValue("application/vnd.api+json; charset=utf-8", [1, 2]))).toBe(
      "/search?%5B1%2C2%5D",
    );
  });

  test("STY-43: text/plain is percent-encoded once", async () => {
    expect(await urlOf(ofValue("text/plain", "a b&c=100%"))).toBe("/search?a%20b%26c%3D100%25");
  });

  test("STY-43: a media type matches by essence, not case or parameters", async () => {
    expect(
      await urlOf(
        ofValue(
          "Application/X-WWW-Form-Urlencoded;charset=utf-8",
          { a: "1" },
          { properties: [["a", {}]] },
        ),
      ),
    ).toBe("/search?a=1");
  });

  test("STY-42: a non-text value under a non-JSON media type is refused", async () => {
    await expectUsage(ofValue("text/plain", { a: 1 }));
    await expectUsage(ofValue("text/plain", 7));
  });

  test("STY-42: a lone surrogate and a non-finite number are refused", async () => {
    await expectUsage(ofValue("text/plain", "\uD800"));
    await expectUsage(ofValue("application/json", { a: Number.NaN }));
  });
});

describe("querystring presence", () => {
  test("STY-42: an absent optional parameter adds no question mark", async () => {
    const parameter = ofValue(form);

    expect(await Effect.runPromise(parameter.expand)).toBeUndefined();
    expect(await urlOf(parameter)).toBe("/search");
  });

  test("STY-42: an absent required parameter is refused", async () => {
    await expectUsage(ofValue("application/json", undefined, { required: true }));
  });

  test("STY-42: a present value that yields no pair adds no question mark", async () => {
    expect(await urlOf(ofValue(form, {}))).toBe("/search");
  });

  test("STY-42: an empty string under text/plain adds no question mark", async () => {
    expect(await urlOf(ofValue("text/plain", ""))).toBe("/search");
  });
});
