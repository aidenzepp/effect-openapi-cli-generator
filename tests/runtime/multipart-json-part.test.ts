import { describe, expect, test } from "bun:test";
import { Effect, Runtime, Schema, Stream } from "effect";
import type { HttpClientRequest } from "effect/http";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import { JsonNumber } from "../../src/runtime-src/runtime/input.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

// ENC-22: an object multipart part is one part, its value written as compact JSON under the part's
// contentType (`application/json` by default, the declared Encoding contentType when there is one).

const text = (chunks: readonly Uint8Array[]): string =>
  Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");

const requestOf = (fields: Serialize.FormFields, parts: readonly Serialize.FormPartEntry[]) =>
  Serialize.request("POST", {
    body: Serialize.formData(fields, { parts, required: true }),
    headers: [],
    path: Serialize.path("/uploads", []),
    query: [],
  });

const build = (fields: Serialize.FormFields, parts: readonly Serialize.FormPartEntry[]) =>
  Effect.runPromise(requestOf(fields, parts));

const streamed = async (built: HttpClientRequest.HttpClientRequest): Promise<string> => {
  if (built.body._tag !== "Stream") {
    throw new Error(`expected a stream body, got ${built.body._tag}`);
  }

  return text(await Effect.runPromise(Stream.runCollect(built.body.stream)));
};

const boundaryOf = (built: HttpClientRequest.HttpClientRequest): string =>
  /boundary=(?<boundary>.+)$/u.exec(built.headers["content-type"] ?? "")?.groups?.boundary ?? "";

const meta = Serialize.jsonPart({
  big: new JsonNumber("9007199254740993"),
  name: "Ada",
  tags: ["a", 1, null, true],
});

describe("ENC-22: a JSON multipart part", () => {
  test("is one part with Content-Type application/json and the compact JSON body", async () => {
    const built = await build({ meta: [meta], title: ["T"] }, [
      ["title", "text/plain"],
      ["meta", "application/json"],
    ]);
    const boundary = boundaryOf(built);

    expect(await streamed(built)).toBe(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="title"',
        "Content-Type: text/plain",
        "",
        "T",
        `--${boundary}`,
        'Content-Disposition: form-data; name="meta"',
        "Content-Type: application/json",
        "",
        '{"big":9007199254740993,"name":"Ada","tags":["a",1,null,true]}',
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
  });

  test("the declared Encoding contentType is the part's Content-Type", async () => {
    const built = await build({ meta: [meta] }, [["meta", "application/vnd.meta+json"]]);

    expect(await streamed(built)).toContain("Content-Type: application/vnd.meta+json\r\n\r\n{");
  });

  test("a number with no JSON text form is refused, naming no value", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        requestOf({ meta: [Serialize.jsonPart({ n: new JsonNumber("1x") })] }, [
          ["meta", "application/json"],
        ]),
      ),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error[Runtime.errorExitCode]).toBe(2);
    expect(error.message).not.toContain("1x");
  });
});

const body = Schema.Struct({
  meta: Schema.Struct({
    big: Schema.Number,
    name: Schema.String,
    tags: Schema.Array(Schema.Unknown),
  }),
});

const options: Serialize.FormSchemaOptions = {
  flags: { meta: "meta" },
  repeated: [],
  required: true,
  schema: body,
};

describe("assertFormData: a JSON part", () => {
  test("is asserted as its parsed value, a JsonNumber as its number", async () => {
    const fields: Serialize.FormFields = { meta: [meta] };

    expect(await Effect.runPromise(Serialize.assertFormData(options)(fields))).toBe(fields);
  });

  test("a value that does not match names the part's flag, never the value", async () => {
    const fields: Serialize.FormFields = {
      meta: [Serialize.jsonPart({ big: "secret", name: "Ada", tags: [] })],
    };
    const error = await Effect.runPromise(Effect.flip(Serialize.assertFormData(options)(fields)));

    expect(error.flag).toBe("meta");
    expect(error.message).toBe("--meta: does not match the request body schema");
    expect(error.message).not.toContain("secret");
  });
});
