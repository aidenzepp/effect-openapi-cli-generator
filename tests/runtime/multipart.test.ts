import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Stdio, Stream } from "effect";
import type { HttpBody } from "effect/http";
import { stdinClaimLayer, StdinClaim } from "../../src/runtime-src/runtime/input.ts";
import {
  fileBody,
  formData,
  mixed,
  partFilename,
  positionalParts,
} from "../../src/runtime-src/runtime/multipart.ts";
import type { Part } from "../../src/runtime-src/runtime/multipart.ts";

const boundary = "testboundary";

const encoder = new TextEncoder();

const bytes = (text: string) => encoder.encode(text);

const empty = bytes("");

const chunksOf = (body: HttpBody.Stream) => Effect.runPromise(Stream.runCollect(body.stream));

const readBoundary = (type: string) => /boundary=(?<b>.+)$/u.exec(type)?.groups?.b ?? "";

const textOf = async (body: HttpBody.Stream) => {
  const decoder = new TextDecoder();
  const chunks = await chunksOf(body);

  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("");
};

const formText = async (parts: readonly Part[]) =>
  await textOf(await Effect.runPromise(formData(parts, { boundary })));

const refusal = async (build: Effect.Effect<HttpBody.Stream, unknown>) =>
  await Effect.runPromise(Effect.flip(build));

const dispositionOf = async (part: Part) => {
  const text = await formText([part]);

  return text.split("\r\n")[1];
};

describe("formData bytes", () => {
  test("text, JSON header part, streamed file, repeated array parts", async () => {
    const file = Stream.make(encoder.encode("abc"), encoder.encode("def"));
    const text = await formText([
      { body: bytes("Ada"), name: "title" },
      {
        body: bytes('{"k":1}'),
        contentType: "application/json",
        headers: [["X-Part-Id", "meta-1"]],
        name: "meta",
      },
      { body: file, contentType: "text/plain", filename: "a.txt", name: "file" },
      { body: bytes("one"), name: "tag" },
      { body: bytes("two"), name: "tag" },
    ]);

    expect(text).toBe(
      [
        "--testboundary",
        'Content-Disposition: form-data; name="title"',
        "",
        "Ada",
        "--testboundary",
        'Content-Disposition: form-data; name="meta"',
        "X-Part-Id: meta-1",
        "Content-Type: application/json",
        "",
        '{"k":1}',
        "--testboundary",
        'Content-Disposition: form-data; name="file"; filename="a.txt"',
        "Content-Type: text/plain",
        "",
        "abcdef",
        "--testboundary",
        'Content-Disposition: form-data; name="tag"',
        "",
        "one",
        "--testboundary",
        'Content-Disposition: form-data; name="tag"',
        "",
        "two",
        "--testboundary--",
        "",
      ].join("\r\n"),
    );
  });

  test("Content-Type is the encoding value verbatim and contentEncoding adds the transfer header", async () => {
    const text = await formText([
      {
        body: bytes("x"),
        contentEncoding: "base64",
        contentType: "image/png, image/jpeg",
        name: "p",
      },
    ]);

    expect(text).toBe(
      [
        "--testboundary",
        'Content-Disposition: form-data; name="p"',
        "Content-Transfer-Encoding: base64",
        "Content-Type: image/png, image/jpeg",
        "",
        "x",
        "--testboundary--",
        "",
      ].join("\r\n"),
    );
  });

  test("an empty body is the close delimiter alone", async () => {
    expect(await formText([])).toBe("--testboundary--\r\n");
  });

  test("file chunks pass through unbuffered", async () => {
    const body = await Effect.runPromise(
      formData(
        [
          {
            body: Stream.make(encoder.encode("1"), encoder.encode("2")),
            filename: "f",
            name: "f",
          },
        ],
        { boundary },
      ),
    );
    const chunks = await chunksOf(body);
    const decoder = new TextDecoder();
    const decoded = chunks.map((chunk) => decoder.decode(chunk));

    expect(decoded).toContain("1");
    expect(decoded).toContain("2");
  });

  test("running the stream twice yields the same bytes, for retries", async () => {
    const body = await Effect.runPromise(
      formData([{ body: Stream.make(encoder.encode("again")), name: "f" }], { boundary }),
    );

    expect(await textOf(body)).toBe(await textOf(body));
  });

  test("the body carries the form-data content type with its boundary", async () => {
    const body = await Effect.runPromise(formData([], { boundary }));

    expect(body.contentType).toBe("multipart/form-data; boundary=testboundary");
  });
});

describe("name and filename escaping", () => {
  test("quote, LF and CR are percent-encoded", async () => {
    expect(await dispositionOf({ body: empty, name: 'a"b' })).toBe(
      'Content-Disposition: form-data; name="a%22b"',
    );
    expect(await dispositionOf({ body: empty, name: "a\r\nb" })).toBe(
      'Content-Disposition: form-data; name="a%0D%0Ab"',
    );
  });

  test("a lone CR or LF in a name becomes CRLF first", async () => {
    expect(await dispositionOf({ body: empty, name: "a\rb" })).toBe(
      'Content-Disposition: form-data; name="a%0D%0Ab"',
    );
    expect(await dispositionOf({ body: empty, name: "a\nb" })).toBe(
      'Content-Disposition: form-data; name="a%0D%0Ab"',
    );
  });

  test("a filename is not normalized", async () => {
    expect(await dispositionOf({ body: empty, filename: "a\rb", name: "n" })).toBe(
      'Content-Disposition: form-data; name="n"; filename="a%0Db"',
    );
    expect(await dispositionOf({ body: empty, filename: 'a\nb"', name: "n" })).toBe(
      'Content-Disposition: form-data; name="n"; filename="a%0Ab%22"',
    );
  });

  test("backslash, percent and non-ASCII pass through as UTF-8", async () => {
    expect(await dispositionOf({ body: empty, filename: "d\\%22é.txt", name: "n" })).toBe(
      'Content-Disposition: form-data; name="n"; filename="d\\%22é.txt"',
    );
  });
});

describe("refusals", () => {
  const bad = ["a\rb", "a\nb", "a\u0000b"];

  for (const value of bad) {
    test(`a header value with ${JSON.stringify(value)} is a UsageError`, async () => {
      const error = await refusal(
        formData([{ body: empty, headers: [["X-A", value]], name: "p" }], { boundary }),
      );

      expect(error).toMatchObject({ _tag: "UsageError" });
      expect(JSON.stringify(error)).not.toContain("a\\u0000b");
    });
  }

  test("a header name, content type or content encoding with CR, LF or NUL is refused", async () => {
    const parts: readonly Part[] = [
      { body: empty, headers: [["X-A\nB", "v"]], name: "p" },
      { body: empty, contentType: "text/plain\r\nX: y", name: "p" },
      { body: empty, contentEncoding: "b\u0000", name: "p" },
    ];

    const errors = await Promise.all(parts.map((part) => refusal(formData([part], { boundary }))));

    for (const error of errors) {
      expect(error).toMatchObject({ _tag: "UsageError" });
    }
  });

  test("a refused header inside a nested part is refused", async () => {
    const error = await refusal(
      mixed([{ kind: "mixed", parts: [{ body: empty, headers: [["X", "a\nb"]] }] }], { boundary }),
    );

    expect(error).toMatchObject({ _tag: "UsageError" });
  });

  test("a form-data part without a name is refused", async () => {
    expect(await refusal(formData([{ body: empty }], { boundary }))).toMatchObject({
      _tag: "UsageError",
    });
  });
});

describe("boundary", () => {
  test("a default boundary is long, safe and different each time", async () => {
    const first = await Effect.runPromise(formData([]));
    const second = await Effect.runPromise(formData([]));

    expect(readBoundary(first.contentType).length).toBeGreaterThanOrEqual(40);
    expect(readBoundary(first.contentType).length).toBeLessThanOrEqual(70);
    expect(readBoundary(first.contentType)).toMatch(/^[\w-]+$/u);
    expect(readBoundary(first.contentType)).not.toBe(readBoundary(second.contentType));
    expect(await textOf(first)).toContain(`--${readBoundary(first.contentType)}--`);
  });
});

describe("multipart/mixed, positional and nested", () => {
  test("positional parts take prefixEncoding then itemEncoding, with no disposition", async () => {
    const parts = positionalParts([bytes("m"), bytes("n"), bytes("o")], {
      itemEncoding: { contentType: "text/plain; charset=utf-8" },
      prefixEncoding: [
        { contentType: "application/json", headers: [["X-Part-Index", "0"]] },
        { contentType: "application/octet-stream" },
      ],
    });
    const body = await Effect.runPromise(mixed(parts, { boundary }));

    expect(body.contentType).toBe("multipart/mixed; boundary=testboundary");
    expect(await textOf(body)).toBe(
      [
        "--testboundary",
        "X-Part-Index: 0",
        "Content-Type: application/json",
        "",
        "m",
        "--testboundary",
        "Content-Type: application/octet-stream",
        "",
        "n",
        "--testboundary",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "o",
        "--testboundary--",
        "",
      ].join("\r\n"),
    );
  });

  test("one nested level with its own boundary", async () => {
    const text = await formText([
      {
        kind: "mixed",
        name: "docs",
        parts: [
          { body: bytes("a"), contentType: "text/plain" },
          { body: bytes("b"), contentType: "text/plain" },
        ],
      },
    ]);

    expect(text).toBe(
      [
        "--testboundary",
        'Content-Disposition: form-data; name="docs"',
        "Content-Type: multipart/mixed; boundary=testboundary-0",
        "",
        "--testboundary-0",
        "Content-Type: text/plain",
        "",
        "a",
        "--testboundary-0",
        "Content-Type: text/plain",
        "",
        "b",
        "--testboundary-0--",
        "--testboundary--",
        "",
      ].join("\r\n"),
    );
  });
});

describe("helpers", () => {
  test("partFilename is the basename, or the part name for stdin", () => {
    expect(partFilename("/home/u/secret/report.pdf", "file")).toBe("report.pdf");
    expect(partFilename("C:\\u\\report.pdf", "file")).toBe("report.pdf");
    expect(partFilename("report.pdf", "file")).toBe("report.pdf");
    expect(partFilename("-", "file")).toBe("file");
  });
});

const read = (body: Stream.Stream<Uint8Array, unknown>) =>
  Effect.map(Stream.runCollect(body), (chunks) =>
    chunks.map((chunk) => new TextDecoder().decode(chunk)).join(""),
  );

describe("fileBody", () => {
  const layers = Layer.mergeAll(
    stdinClaimLayer,
    FileSystem.layerNoop({ stream: () => Stream.make(bytes("from-file")) }),
    Stdio.layerTest({ stdin: Stream.make(bytes("from-stdin")) }),
  );

  test("a path reads the file and does not claim stdin", async () => {
    const text = await Effect.runPromise(
      Effect.gen(function* file() {
        const claim = yield* StdinClaim;
        const content = yield* Effect.flatMap(fileBody("x-file", "report.pdf"), read);

        yield* claim.claim("body-file");

        return content;
      }).pipe(Effect.provide(layers)),
    );

    expect(text).toBe("from-file");
  });

  test("- claims stdin and reads it", async () => {
    const text = await Effect.runPromise(
      Effect.flatMap(fileBody("x-file", "-"), read).pipe(Effect.provide(layers)),
    );

    expect(text).toBe("from-stdin");
  });

  test("- after --body-file - is a UsageError naming both flags", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* second() {
        const claim = yield* StdinClaim;

        yield* claim.claim("body-file");

        return yield* Effect.flip(fileBody("x-file", "-"));
      }).pipe(Effect.provide(layers)),
    );

    expect(error).toMatchObject({ _tag: "UsageError", flag: "x-file" });
    expect(error.message).toContain("--body-file");
    expect(error.message).toContain("--x-file");
  });

  test("two - parts: the second is refused", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* twice() {
        yield* fileBody("a-file", "-");

        return yield* Effect.flip(fileBody("b-file", "-"));
      }).pipe(Effect.provide(layers)),
    );

    expect(error).toMatchObject({ _tag: "UsageError", flag: "b-file" });
  });
});
