import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import type { HttpBody } from "effect/http";
import { formData } from "../../src/runtime-src/runtime/multipart.ts";
import type { Part } from "../../src/runtime-src/runtime/multipart.ts";

const boundary = "testboundary";

const encoder = new TextEncoder();

const chunksOf = (body: HttpBody.Stream) => Effect.runPromise(Stream.runCollect(body.stream));

const textOf = async (parts: readonly Part[]) => {
  const body = await Effect.runPromise(formData(parts, { boundary }));
  const decoder = new TextDecoder();

  const chunks = await chunksOf(body);

  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("");
};

// Bytes that separate the two alphabets: 0xfb 0xff 0xfe is "+//+" in base64 and "-__-" in base64url.
const alphabetBytes = Uint8Array.from([0xfb, 0xff, 0xfe, 0x01]);

describe("multipart base64 transfer encoding", () => {
  test("base64, base64url and a plain binary part sit side by side, byte for byte", async () => {
    const text = await textOf([
      { body: Stream.make(alphabetBytes), contentEncoding: "base64", name: "a" },
      { body: Stream.make(alphabetBytes), contentEncoding: "base64url", name: "b" },
      { body: encoder.encode("plain"), contentType: "application/octet-stream", name: "c" },
    ]);

    expect(text).toBe(
      [
        "--testboundary",
        'Content-Disposition: form-data; name="a"',
        "Content-Transfer-Encoding: base64",
        "",
        "+//+AQ==",
        "--testboundary",
        'Content-Disposition: form-data; name="b"',
        "Content-Transfer-Encoding: base64url",
        "",
        "-__-AQ==",
        "--testboundary",
        'Content-Disposition: form-data; name="c"',
        "Content-Type: application/octet-stream",
        "",
        "plain",
        "--testboundary--",
        "",
      ].join("\r\n"),
    );
  });

  test("an empty base64 part has an empty body", async () => {
    const text = await textOf([{ body: new Uint8Array(0), contentEncoding: "base64", name: "a" }]);

    expect(text).toBe(
      [
        "--testboundary",
        'Content-Disposition: form-data; name="a"',
        "Content-Transfer-Encoding: base64",
        "",
        "",
        "--testboundary--",
        "",
      ].join("\r\n"),
    );
  });

  test("a file larger than one chunk encodes with no break at a chunk boundary", async () => {
    const source = Uint8Array.from({ length: 70_001 }, (_, index) => (index * 31 + 7) % 256);
    const sizes = [1, 2, 65_537, 3, 4458];
    const chunks: Uint8Array[] = [];
    let offset = 0;

    for (const size of sizes) {
      chunks.push(source.slice(offset, offset + size));
      offset += size;
    }

    expect(offset).toBe(source.length);

    const text = await textOf([
      { body: Stream.fromIterable(chunks), contentEncoding: "base64", name: "f" },
    ]);
    const encoded = text.split("\r\n")[4] ?? "";

    expect(encoded).toBe(source.toBase64());
    expect(encoded).not.toContain("\n");
    expect(text.split("\r\n")).toHaveLength(7);
  });

  test("a base64url file in uneven chunks matches the one-shot encoding", async () => {
    const source = Uint8Array.from({ length: 1000 }, (_, index) => (index * 97 + 3) % 256);
    const chunks = [
      source.slice(0, 1),
      source.slice(1, 5),
      source.slice(5, 998),
      source.slice(998),
    ];
    const text = await textOf([
      { body: Stream.fromIterable(chunks), contentEncoding: "base64url", name: "f" },
    ]);

    expect(text.split("\r\n")[4]).toBe(source.toBase64({ alphabet: "base64url" }));
  });

  test("a part without contentEncoding gets no Content-Transfer-Encoding header", async () => {
    const text = await textOf([{ body: encoder.encode("x"), name: "a" }]);

    expect(text).not.toContain("Content-Transfer-Encoding");
  });
});
