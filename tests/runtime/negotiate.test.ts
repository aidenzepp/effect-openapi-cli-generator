import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import * as Negotiate from "../../src/runtime-src/runtime/negotiate.ts";

const media = (
  request: readonly string[],
  responses: Record<string, readonly string[]> = {},
): Negotiate.MediaDeclaration => ({ request, responses });

const select = (declaration: Negotiate.MediaDeclaration, chosen?: string) =>
  Effect.runSync(
    Effect.result(Negotiate.selectRequestMedia(declaration, Option.fromNullishOr(chosen))),
  );

const acceptOf = (declaration: Negotiate.MediaDeclaration, chosen?: string) =>
  Effect.runSync(Effect.result(Negotiate.accept(declaration, Option.fromNullishOr(chosen))));

const failure = (result: ReturnType<typeof select> | ReturnType<typeof acceptOf>) =>
  result._tag === "Failure" ? result.failure : undefined;

const success = <A>(result: { readonly _tag: string; readonly success?: A }) =>
  result._tag === "Success" ? result.success : undefined;

describe("selectRequestMedia", () => {
  test("a single alternative is used as declared", () => {
    expect(success(select(media(["application/xml"])))).toEqual({
      contentType: "application/xml",
      key: "application/xml",
    });
  });

  test("several alternatives default to the first JSON-family key", () => {
    expect(success(select(media(["image/png", "application/json"])))?.key).toBe("application/json");
    expect(
      success(select(media(["image/png", "application/vnd.api+json", "application/json"])))?.key,
    ).toBe("application/vnd.api+json");
  });

  test("with no JSON-family key the default is the first key", () => {
    expect(success(select(media(["image/png", "application/xml"])))?.key).toBe("image/png");
  });

  test("--content-type chooses among declared keys", () => {
    expect(success(select(media(["application/json", "image/png"]), "image/png"))).toEqual({
      contentType: "image/png",
      key: "image/png",
    });
  });

  test("an undeclared --content-type is a UsageError naming the flag, never the value", () => {
    const error = failure(select(media(["application/json", "image/png"]), "text/secret-value"));

    expect(error?._tag).toBe("UsageError");
    expect(error?.flag).toBe("--content-type");
    expect(error?.message).not.toContain("secret-value");
  });

  test("--content-type outside a single declared key is a UsageError", () => {
    expect(failure(select(media(["application/json"]), "image/png"))?.flag).toBe("--content-type");
  });

  test("a range key needs --content-type naming a concrete type inside it", () => {
    const declared = media(["application/json", "image/*"]);

    expect(success(select(declared, "image/png"))).toEqual({
      contentType: "image/png",
      key: "image/*",
    });
    expect(failure(select(declared, "text/plain"))?._tag).toBe("UsageError");
    expect(failure(select(declared, "image/*"))?._tag).toBe("UsageError");
  });

  test("a lone range key without --content-type is a UsageError", () => {
    expect(failure(select(media(["*/*"])))?.flag).toBe("--content-type");
    expect(success(select(media(["application/xml", "image/*"])))?.key).toBe("application/xml");
    expect(failure(select(media(["image/*", "application/xml"])))?.flag).toBe("--content-type");
  });

  test("an exact key wins over a range that also contains it", () => {
    expect(success(select(media(["image/*", "image/png"]), "image/png"))?.key).toBe("image/png");
    expect(success(select(media(["*/*", "image/*"]), "image/png"))?.key).toBe("image/*");
  });

  test("a non-concrete or malformed --content-type is refused", () => {
    expect(failure(select(media(["*/*"]), "a/b\r\nx: y"))?._tag).toBe("UsageError");
    expect(failure(select(media(["*/*"]), "nonsense"))?._tag).toBe("UsageError");
  });

  test("an operation with no request media cannot select", () => {
    expect(failure(select(media([])))?._tag).toBe("UsageError");
    expect(failure(select(media([]), "application/json"))?.flag).toBe("--content-type");
  });
});

describe("accept", () => {
  test("lists the declared response media in document order, once each", () => {
    const declared = media([], { "200": ["application/xml", "text/csv"], default: ["text/csv"] });

    expect(success(acceptOf(declared))).toEqual(Option.some("application/xml, text/csv"));
  });

  test("JSON is the default where JSON and other alternatives coexist", () => {
    const declared = media([], { "200": ["image/png", "application/json"] });

    expect(success(acceptOf(declared))).toEqual(Option.some("application/json"));
  });

  test("--accept naming a declared type is sent as named", () => {
    const declared = media([], { "200": ["application/json", "image/png"] });

    expect(success(acceptOf(declared, "image/png"))).toEqual(Option.some("image/png"));
  });

  test("--accept outside the declared set is a UsageError naming the flag, never the value", () => {
    const error = failure(
      acceptOf(media([], { "200": ["application/json"] }), "text/secret-value"),
    );

    expect(error?._tag).toBe("UsageError");
    expect(error?.flag).toBe("--accept");
    expect(error?.message).not.toContain("secret-value");
  });

  test("no Accept when no response declares content", () => {
    expect(success(acceptOf(media([], { "204": [], "404": [] })))).toEqual(Option.none());
    expect(success(acceptOf(media([], {})))).toEqual(Option.none());
  });

  test("--accept with no declared response media is a UsageError", () => {
    expect(failure(acceptOf(media([], { "204": [] }), "application/json"))?.flag).toBe("--accept");
  });
});

describe("dispatchResponse", () => {
  test("picks the most specific declared key: exact, then type/*, then */*", () => {
    const declared = ["*/*", "image/*", "image/png"];

    expect(Negotiate.dispatchResponse(declared, "image/png")).toBe("image/png");
    expect(Negotiate.dispatchResponse(declared, "image/gif")).toBe("image/*");
    expect(Negotiate.dispatchResponse(declared, "text/plain")).toBe("*/*");
  });

  test("ignores parameters and case on the response media type", () => {
    expect(
      Negotiate.dispatchResponse(["application/json"], "Application/JSON; charset=utf-8"),
    ).toBe("application/json");
  });

  test("an undeclared or missing media type matches nothing (raw bytes)", () => {
    expect(Negotiate.dispatchResponse(["application/json"], "text/plain")).toBeUndefined();
    expect(Negotiate.dispatchResponse(["application/json"])).toBeUndefined();
    expect(Negotiate.dispatchResponse([], "application/json")).toBeUndefined();
  });
});

describe("flags", () => {
  test("both flags are plain optional strings", () => {
    expect(Negotiate.contentTypeFlag).toBeDefined();
    expect(Negotiate.acceptFlag).toBeDefined();
  });
});
