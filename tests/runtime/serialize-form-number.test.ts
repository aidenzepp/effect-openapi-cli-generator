import { describe, expect, test } from "bun:test";
import { Effect, Runtime } from "effect";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import { JsonNumber } from "../../src/runtime-src/runtime/input.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";
import type { FormEncoding, Json } from "../../src/runtime-src/runtime/serialize.ts";

const media = "application/x-www-form-urlencoded";

// Digit texts a JS number would change: past 2^53, a trailing zero, an exponent.
const big = new JsonNumber("12345678901234567890");

const decimal = new JsonNumber("1.50");

const exponent = new JsonNumber("1e2");

const encode = (
  value: { readonly [property: string]: Json },
  encoding?: FormEncoding,
): Promise<string> =>
  Effect.runPromise(
    Serialize.urlEncode(value, {
      properties:
        encoding === undefined ? [] : Object.keys(value).map((name) => [name, encoding] as const),
    }),
  );

const refusal = (value: { readonly [property: string]: Json }, encoding?: FormEncoding) =>
  Effect.runPromise(
    Effect.flip(
      Serialize.urlEncode(value, {
        properties:
          encoding === undefined ? [] : Object.keys(value).map((name) => [name, encoding] as const),
      }),
    ),
  );

describe("form-urlencoded JsonNumber under the default contentType", () => {
  test("a property sends its digit text", async () => {
    expect(await encode({ extra: decimal, name: big })).toBe(
      "extra=1.50&name=12345678901234567890",
    );
  });

  test("an array item sends its digit text, one pair per item", async () => {
    expect(await encode({ n: [decimal, exponent, 2] })).toBe("n=1.50&n=1e2&n=2");
  });

  test("an object member is written into the compact JSON as its digit text", async () => {
    expect(await encode({ meta: { a: decimal, b: [big] } })).toBe(
      "meta=%7B%22a%22%3A1.50%2C%22b%22%3A%5B12345678901234567890%5D%7D",
    );
  });
});

describe("form-urlencoded JsonNumber under an Encoding style", () => {
  test("a form property sends its digit text", async () => {
    expect(await encode({ name: big }, { style: "form" })).toBe("name=12345678901234567890");
  });

  test("a non-exploded form array joins the digit texts", async () => {
    expect(await encode({ n: [decimal, exponent] }, { explode: false, style: "form" })).toBe(
      "n=1.50,1e2",
    );
  });

  test("an exploded form array repeats the name per digit text", async () => {
    expect(await encode({ n: [decimal, big] }, { style: "form" })).toBe(
      "n=1.50&n=12345678901234567890",
    );
  });

  test("a deepObject member sends its digit text", async () => {
    expect(await encode({ o: { a: decimal } }, { style: "deepObject" })).toBe("o%5Ba%5D=1.50");
  });

  test("a bracketed deepObject leaf sends its digit text", async () => {
    expect(
      await encode(
        { o: { a: { b: exponent }, c: [big] } },
        { brackets: true, style: "deepObject" },
      ),
    ).toBe("o%5Ba%5D%5Bb%5D=1e2&o%5Bc%5D%5B0%5D=12345678901234567890");
  });

  test("a deepObject property that is a JsonNumber is refused as not an object", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Serialize.urlEncode({ o: decimal }, { properties: [["o", { style: "deepObject" }]] }),
      ),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error[Runtime.errorExitCode]).toBe(2);
    expect(error.message).toContain("not an object");
    expect(error.message).not.toContain("1.50");
  });
});

describe("JsonNumber through the querystring form path and a JSON body", () => {
  test("form-urlencoded querystring content sends the digit text", async () => {
    const expanded = await Effect.runPromise(
      Serialize.querystring("q", media, { n: decimal }, { required: true }).expand,
    );

    expect(expanded).toBe("n=1.50");
  });

  test("JSON querystring content writes the digit text into the JSON", async () => {
    const expanded = await Effect.runPromise(
      Serialize.querystring("q", "application/json", { n: big }, { required: true }).expand,
    );

    expect(expanded).toBe("%7B%22n%22%3A12345678901234567890%7D");
  });
});

describe("form-urlencoded JsonNumber whose text is not a JSON number", () => {
  const malformed = new JsonNumber("1&x=2");

  test("a default-rule property is refused", async () => {
    const error = await refusal({ name: malformed });

    expect(error).toBeInstanceOf(UsageError);
    expect(error[Runtime.errorExitCode]).toBe(2);
    expect(error.message).toBe("parameter name holds a number with no JSON text form");
  });

  test("a default-rule object member is refused in its compact JSON", async () => {
    const error = await refusal({ meta: { a: new JsonNumber('1,"x":2') } });

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe("property meta holds a number with no JSON text form");
  });

  test("a styled form property is refused", async () => {
    const error = await refusal({ n: [decimal, malformed] }, { style: "form" });

    expect(error).toBeInstanceOf(UsageError);
    expect(error[Runtime.errorExitCode]).toBe(2);
    expect(error.message).toBe("parameter n holds a number with no JSON text form");
  });
});
