import { describe, expect, test } from "bun:test";
import { Effect, Option, Redacted, Runtime } from "effect";
import { Headers, HttpClientRequest } from "effect/http";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";
import type { Value } from "../../src/runtime-src/runtime/serialize.ts";

const form = {
  allowReserved: false,
  explode: true,
  line: "3.1",
  required: false,
  style: "form",
} as const;

const cookie = (name: string, value: Value) => Serialize.cookie(name, value, form);

// A cookie parameter the caller gave no value.
const absent = (name: string, required = false) =>
  Serialize.cookie(name, undefined, { ...form, required });

const build = (parts: Partial<Serialize.RequestParts>) =>
  Serialize.request("GET", { headers: [], path: Serialize.path("/v1", []), query: [], ...parts });

const cookieHeader = (request: HttpClientRequest.HttpClientRequest) =>
  Option.getOrUndefined(Headers.get(request.headers, "cookie"));

const sentCookie = async (parts: Partial<Serialize.RequestParts>) =>
  cookieHeader(await Effect.runPromise(build(parts)));

const expectUsage = async (effect: Effect.Effect<unknown, UsageError>) => {
  const error = await Effect.runPromise(Effect.flip(effect));

  expect(error).toBeInstanceOf(UsageError);
  expect(error).toMatchObject({ _tag: "UsageError" });
  expect(error[Runtime.errorExitCode]).toBe(2);
};

describe("request cookies", () => {
  test("cookie parameters join into one Cookie header in the order given", async () => {
    const built = await Effect.runPromise(
      build({ cookies: [cookie("theme", "dark"), cookie("lang", "en"), cookie("ids", "a b")] }),
    );

    expect(cookieHeader(built)).toBe("theme=dark; lang=en; ids=a%20b");
    expect(Object.keys(built.headers).filter((name) => name === "cookie")).toHaveLength(1);
  });

  test("an absent optional cookie contributes nothing", async () => {
    expect(await sentCookie({ cookies: [absent("theme"), cookie("lang", "en")] })).toBe("lang=en");
  });

  test("no Cookie header when no cookie parameter produced a pair", async () => {
    expect(await sentCookie({ cookies: [absent("theme")] })).toBeUndefined();
    expect(await sentCookie({ cookies: [] })).toBeUndefined();
    expect(await sentCookie({})).toBeUndefined();
  });

  test("an exploded 3.2 cookie-style object joins with the other parameters", async () => {
    const exploded = Serialize.cookie(
      "prefs",
      { a: "1", b: "2" },
      { ...form, line: "3.2", style: "cookie" },
    );

    expect(await sentCookie({ cookies: [cookie("theme", "dark"), exploded] })).toBe(
      "theme=dark; a=1; b=2",
    );
  });

  test("a required cookie without a value is refused", async () => {
    await expectUsage(build({ cookies: [absent("theme", true)] }));
  });

  test("cookie parameters beside a header parameter named Cookie are refused", async () => {
    const options = { explode: false, required: false };

    await expectUsage(
      build({
        cookies: [cookie("theme", "dark")],
        headers: [Serialize.header("Cookie", "x=1", options)],
      }),
    );
    await expectUsage(
      build({
        cookies: [cookie("theme", "dark")],
        headers: [Serialize.header("cOOKIE", "x=1", options)],
      }),
    );
  });

  test("auth strips a cookie parameter named like an apiKey cookie and appends the credential", async () => {
    const definition = { in: "cookie", kind: "apiKey", name: "sid" } as const;
    const table: Auth.SecurityTable = { schemes: { session: definition } };
    const origin = "https://api.example.test";
    const built = await Effect.runPromise(
      build({ cookies: [cookie("theme", "dark"), cookie("sid", "stale"), cookie("lang", "en")] }),
    );
    const located = HttpClientRequest.setUrl(built, `${origin}${built.url}`);
    const credentials = [{ definition, scheme: "session", value: Redacted.make("tok") }];
    const attached = await Effect.runPromise(
      Auth.attach(table, { credentials, origins: [origin] })(located),
    );

    expect(cookieHeader(attached)).toBe("theme=dark; lang=en; sid=tok");
  });
});
