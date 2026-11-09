import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import type { HttpClientRequest } from "effect/http";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

// M3-MP1 (design 6.3, HT:B15): a 3.2 positional multipart/mixed body. Part i is sent under
// prefixEncoding[i] and every later part under itemEncoding, with no Content-Disposition; extra
// prefixEncoding entries are unused (MED-15). More parts than rules, or a count outside the
// schema's bounds, is a UsageError naming --part before any request.

const encoder = new TextEncoder();

const text = (chunks: readonly Uint8Array[]): string =>
  Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");

const requestOf = (parts: Serialize.MixedParts, options: Serialize.MixedOptions) =>
  Serialize.request("POST", {
    body: Serialize.mixed(parts, options),
    headers: [],
    path: Serialize.path("/uploads", []),
    query: [],
  });

const build = (parts: Serialize.MixedParts, options: Serialize.MixedOptions) =>
  Effect.runPromise(requestOf(parts, options));

const refusal = (parts: Serialize.MixedParts, options: Serialize.MixedOptions) =>
  Effect.runPromise(Effect.flip(requestOf(parts, options)));

const streamed = async (built: HttpClientRequest.HttpClientRequest): Promise<string> => {
  if (built.body._tag !== "Stream") {
    throw new Error(`expected a stream body, got ${built.body._tag}`);
  }

  return text(await Effect.runPromise(Stream.runCollect(built.body.stream)));
};

const boundaryOf = (built: HttpClientRequest.HttpClientRequest): string =>
  /^multipart\/mixed; boundary=(?<boundary>.+)$/u.exec(built.headers["content-type"] ?? "")?.groups
    ?.boundary ?? "";

const bytes = (value: string): Uint8Array => encoder.encode(value);

const positional: Serialize.MixedOptions = {
  itemEncoding: { contentType: "image/png" },
  prefixEncoding: [{ contentType: "application/json" }, { contentType: "text/csv" }],
  required: true,
};

describe("Serialize.mixed: a positional multipart/mixed body", () => {
  test("MED-07 MED-08: part i takes prefixEncoding[i], later parts take itemEncoding, none has a Content-Disposition", async () => {
    const built = await build(
      [bytes('{"id":1}'), Stream.succeed(bytes("a,b")), bytes("p1"), bytes("p2")],
      positional,
    );
    const boundary = boundaryOf(built);

    expect(boundary).not.toBe("");
    expect(await streamed(built)).toBe(
      [
        `--${boundary}`,
        "Content-Type: application/json",
        "",
        '{"id":1}',
        `--${boundary}`,
        "Content-Type: text/csv",
        "",
        "a,b",
        `--${boundary}`,
        "Content-Type: image/png",
        "",
        "p1",
        `--${boundary}`,
        "Content-Type: image/png",
        "",
        "p2",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
  });

  test("a position's base64 transfer encoding is written and applied", async () => {
    const built = await build([bytes("ab")], {
      prefixEncoding: [{ contentEncoding: "base64", contentType: "application/octet-stream" }],
      required: true,
    });

    expect(await streamed(built)).toContain(
      "Content-Transfer-Encoding: base64\r\nContent-Type: application/octet-stream\r\n\r\nYWI=\r\n",
    );
  });

  test("MED-15: prefixEncoding entries beyond the parts given are unused", async () => {
    const built = await build([bytes("a")], positional);

    const sent = await streamed(built);

    expect(sent.match(/Content-Type: /gu)).toHaveLength(1);
  });

  test("more parts than rules with no item rule is a UsageError naming --part", async () => {
    const error = await refusal([bytes("a"), bytes("b"), bytes("c")], {
      prefixEncoding: [{ contentType: "text/plain" }, { contentType: "text/plain" }],
      required: true,
    });

    expect(error).toBeInstanceOf(UsageError);
    expect(error.flag).toBe("part");
  });

  test("maxParts and minParts bound the parts with a UsageError naming --part", async () => {
    const bounded = { ...positional, maxParts: 2, minParts: 2 };
    const many = await refusal([bytes("a"), bytes("b"), bytes("c")], bounded);
    const few = await refusal([bytes("a")], bounded);
    const fits = await build([bytes("a"), bytes("b")], bounded);

    expect([many.flag, few.flag]).toEqual(["part", "part"]);
    expect(fits.body._tag).toBe("Stream");
  });

  test("with no part a required body is the close delimiter alone and an optional body is none", async () => {
    const required = await build([], positional);
    const optional = await build([], { ...positional, minParts: 1, required: false });

    expect(await streamed(required)).toBe(`--${boundaryOf(required)}--\r\n`);
    expect(optional.body._tag).toBe("Empty");
  });
});
