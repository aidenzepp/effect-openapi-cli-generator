import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import type { HttpBody } from "effect/http";
import { formData } from "../../src/runtime-src/runtime/multipart.ts";
import type { Part, PartEncoding } from "../../src/runtime-src/runtime/multipart.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

const boundary = "testboundary";

const encoder = new TextEncoder();

const chunksOf = (body: HttpBody.Stream) => Effect.runPromise(Stream.runCollect(body.stream));

const textOf = async (parts: readonly Part[]) => {
  const body = await Effect.runPromise(formData(parts, { boundary }));
  const decoder = new TextDecoder();

  const chunks = await chunksOf(body);

  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("");
};

// Bytes whose base64 uses the alphabet's last two characters: 0xfb 0xff 0xfe is "+//+" in base64
// and would be "-__-" in base64url.
const alphabetBytes = Uint8Array.from([0xfb, 0xff, 0xfe, 0x01]);

// A content encoding the type does not admit, as an untyped caller could pass it.
const encodedAs = (contentEncoding: string): PartEncoding =>
  // SAFETY: deliberately unsound; the writer must refuse what the type would reject.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the refusal under test is for values outside the type
  ({ contentEncoding }) as PartEncoding;

describe("multipart base64 transfer encoding", () => {
  test("a base64 part and a plain binary part sit side by side, byte for byte", async () => {
    const text = await textOf([
      { body: Stream.make(alphabetBytes), contentEncoding: "base64", name: "a" },
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

  test.each(["base64url", "quoted-printable", "BASE64", "b\u0000"])(
    "a part with contentEncoding %p is refused before any bytes (R34, ENC-37)",
    async (contentEncoding) => {
      const parts: readonly Part[] = [
        { body: Stream.make(alphabetBytes), name: "b", ...encodedAs(contentEncoding) },
      ];
      const error = await Effect.runPromise(Effect.flip(formData(parts, { boundary })));

      expect(error).toMatchObject({ _tag: "UsageError" });
      expect(error.message).not.toContain(contentEncoding);
    },
  );

  test("a part without contentEncoding gets no Content-Transfer-Encoding header", async () => {
    const text = await textOf([{ body: encoder.encode("x"), name: "a" }]);

    expect(text).not.toContain("Content-Transfer-Encoding");
  });
});

// The bytes `Serialize.formData` streams, with its random boundary read back from `Content-Type`.
const formDataText = async (fields: Serialize.FormFields, options: Serialize.FormDataOptions) => {
  const body = await Effect.runPromise(Serialize.formData(fields, options).expand);
  if (body._tag !== "Stream") {
    throw new Error(`expected a stream body, got ${body._tag}`);
  }

  const random = /boundary=(?<boundary>.+)$/u.exec(body.contentType)?.groups?.boundary ?? "";
  const decoder = new TextDecoder();
  const chunks = await chunksOf(body);
  const text = chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("");

  return text.replaceAll(random, boundary);
};

describe("Serialize.formData: a part entry's contentEncoding", () => {
  test("a base64 part entry writes one Content-Transfer-Encoding line and a base64 body", async () => {
    const text = await formDataText(
      {
        doc: [{ filename: "doc.bin", stream: Stream.make(alphabetBytes) }],
        title: ["plain"],
      },
      {
        parts: [
          ["doc", "application/octet-stream", "base64"],
          ["title", "text/plain"],
        ],
        required: true,
      },
    );

    expect(text).toBe(
      [
        "--testboundary",
        'Content-Disposition: form-data; name="doc"; filename="doc.bin"',
        "Content-Transfer-Encoding: base64",
        "Content-Type: application/octet-stream",
        "",
        "+//+AQ==",
        "--testboundary",
        'Content-Disposition: form-data; name="title"',
        "Content-Type: text/plain",
        "",
        "plain",
        "--testboundary--",
        "",
      ].join("\r\n"),
    );
    expect(text.split("Content-Transfer-Encoding")).toHaveLength(2);
  });

  test("a base64 part entry encodes a text value's UTF-8 bytes", async () => {
    const text = await formDataText(
      { note: ["Café"] },
      { parts: [["note", "text/plain", "base64"]], required: true },
    );

    expect(text.split("\r\n").slice(1, 5)).toEqual([
      'Content-Disposition: form-data; name="note"',
      "Content-Transfer-Encoding: base64",
      "Content-Type: text/plain",
      "",
    ]);
    expect(text.split("\r\n")[5]).toBe(encoder.encode("Café").toBase64());
  });
});
