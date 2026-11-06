import { describe, expect, test } from "bun:test";
import { Effect, Runtime } from "effect";
import { HttpBody } from "effect/http";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import { JsonNumber } from "../../src/runtime-src/runtime/input.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";
import type { Json } from "../../src/runtime-src/runtime/serialize.ts";

const bodyText = async (value: Json): Promise<string> => {
  const built = await Effect.runPromise(Serialize.body("application/json", value).expand);

  expect(HttpBody.isHttpBody(built) && built._tag === "Uint8Array").toBe(true);

  return built._tag === "Uint8Array" ? new TextDecoder().decode(built.body) : "";
};

const bodyRefusal = (value: Json) =>
  Effect.runPromise(Effect.flip(Serialize.body("application/json", value).expand));

describe("JSON body with a JsonNumber", () => {
  test("the text is JSON.stringify's, with the JsonNumber written as its digit text", async () => {
    const strings = {
      control: "tab\tnul\u0000bell\u0007",
      lone: "a\uD800b\uDFFFc",
      quoted: 'say "hi" \\ there',
      unicode: "héllo 日本 🎉",
    };
    const marker = "@@number@@";

    const text = await bodyText({
      ...strings,
      list: [new JsonNumber("1.50"), strings.lone],
      n: new JsonNumber("12345678901234567890"),
    });

    const expected = JSON.stringify({
      ...strings,
      list: [marker, strings.lone],
      n: marker,
    })
      .replace(`"${marker}"`, "1.50")
      .replace(`"${marker}"`, "12345678901234567890");

    expect(text).toBe(expected);
  });

  for (const malformed of ['1,"x":2', "1}", '"x"', "true", " 1", "01", ""]) {
    test(`a JsonNumber with text ${JSON.stringify(malformed)} is refused`, async () => {
      const error = await bodyRefusal({ a: [{ n: new JsonNumber(malformed) }] });

      expect(error).toBeInstanceOf(UsageError);
      expect(error[Runtime.errorExitCode]).toBe(2);
      expect(error.message).toBe("the body holds a number with no JSON text form");
    });
  }

  test("JSON querystring content names the parameter", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Serialize.querystring(
          "q",
          "application/json",
          { n: new JsonNumber("1}") },
          { required: true },
        ).expand,
      ),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe("parameter q holds a number with no JSON text form");
  });
});
