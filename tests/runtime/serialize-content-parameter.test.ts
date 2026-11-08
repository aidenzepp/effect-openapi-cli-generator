import { describe, expect, test } from "bun:test";
import { Effect, Runtime } from "effect";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

const json = "application/json";

const text = "text/plain";

const optional = { required: false };

const required = { required: true };

const expectUsage = async (expansion: Effect.Effect<string | undefined, UsageError>) => {
  const error = await Effect.runPromise(Effect.flip(expansion));

  expect(error).toBeInstanceOf(UsageError);
  expect(error[Runtime.errorExitCode]).toBe(2);

  return error.message;
};

const build = (parts: Partial<Serialize.RequestParts>) =>
  Effect.runPromise(
    Serialize.request("GET", {
      headers: [],
      path: Serialize.path("/places", []),
      query: [],
      ...parts,
    }),
  );

describe("query content parameters", () => {
  test("PRM-23: JSON content is compact JSON text, percent-encoded after name=", async () => {
    const parameter = Serialize.queryContent("coordinates", json, { lat: 1 }, optional);

    expect(parameter.style).toBe("content");
    expect(await Effect.runPromise(parameter.expand)).toBe("coordinates=%7B%22lat%22%3A1%7D");

    const built = await build({ query: [parameter] });

    expect(built.url).toBe("/places?coordinates=%7B%22lat%22%3A1%7D");
  });

  test("non-JSON content is the text as given, percent-encoded, with the name strictly encoded", async () => {
    const parameter = Serialize.queryContent("a b", text, "x&y=z!", optional);

    expect(await Effect.runPromise(parameter.expand)).toBe("a%20b=x%26y%3Dz%21");
  });

  test("non-JSON content that is not text is refused", async () => {
    expect(
      await expectUsage(Serialize.queryContent("q", text, { a: 1 }, optional).expand),
    ).toContain("parameter q");
  });

  test("an absent optional value sends nothing and an absent required one is refused", async () => {
    expect(
      await Effect.runPromise(Serialize.queryContent("q", json, undefined, optional).expand),
    ).toBeUndefined();

    const built = await build({ query: [Serialize.queryContent("q", json, undefined, optional)] });

    expect(built.url).toBe("/places");
    expect(
      await expectUsage(Serialize.queryContent("q", json, undefined, required).expand),
    ).toContain("parameter q is required");
  });
});

describe("header content parameters", () => {
  test("PRM-24: the text is sent as is", async () => {
    const parameter = Serialize.headerContent("X-Filter", json, { a: [1, 2] }, optional);

    expect(parameter.style).toBe("content");
    expect(await Effect.runPromise(parameter.expand)).toBe('{"a":[1,2]}');

    const built = await build({ headers: [parameter] });

    expect(built.headers["x-filter"]).toBe('{"a":[1,2]}');
  });

  test("a value with LF is refused", async () => {
    expect(
      await expectUsage(Serialize.headerContent("X-Note", text, "a\nb", optional).expand),
    ).toContain("header X-Note");
  });

  test("a name that is not a token is refused", async () => {
    await expectUsage(Serialize.headerContent("X Note", text, "a", optional).expand);
  });

  test("an absent optional value sends nothing and an absent required one is refused", async () => {
    const built = await build({
      headers: [Serialize.headerContent("X-Note", text, undefined, optional)],
    });

    expect(built.headers["x-note"]).toBeUndefined();
    await expectUsage(Serialize.headerContent("X-Note", text, undefined, required).expand);
  });
});

describe("cookie content parameters", () => {
  test("PRM-24: text content is name=text, sent as is", async () => {
    const parameter = Serialize.cookieContent("c", text, "v", optional);

    expect(parameter.style).toBe("content");
    expect(await Effect.runPromise(parameter.expand)).toBe("c=v");

    const built = await build({
      cookies: [parameter, Serialize.cookieContent("d", text, "a/b=c%20", optional)],
    });

    expect(built.headers.cookie).toBe("c=v; d=a/b=c%20");
  });

  test("JSON content is refused: its quotes and commas fall outside cookie-octet", async () => {
    expect(
      await expectUsage(Serialize.cookieContent("c", json, { a: 1, b: 2 }, optional).expand),
    ).toContain("cookie-octet");
  });

  test("an absent optional value sends nothing and an absent required one is refused", async () => {
    const built = await build({
      cookies: [Serialize.cookieContent("c", text, undefined, optional)],
    });

    expect(built.headers.cookie).toBeUndefined();
    await expectUsage(Serialize.cookieContent("c", text, undefined, required).expand);
  });
});

describe("querystring through the shared content codec", () => {
  test("querystring bytes are unchanged", async () => {
    expect(
      await Effect.runPromise(Serialize.querystring("q", json, { lat: 1 }, optional).expand),
    ).toBe("%7B%22lat%22%3A1%7D");
    expect(await Effect.runPromise(Serialize.querystring("q", text, "a b", optional).expand)).toBe(
      "a%20b",
    );
  });
});
