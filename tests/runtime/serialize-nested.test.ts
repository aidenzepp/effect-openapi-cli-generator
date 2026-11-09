import { describe, expect, test } from "bun:test";
import { Effect, Schema, Stream } from "effect";
import type { HttpClientRequest } from "effect/http";
import { UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

// M3-MP2 (design 6.3, HT:B16): one nested level by name. A form-data part whose rule nests by name
// is one nested part of the kind its Encoding contentType names: each nested property its own part
// under its rule, in nested property order; under multipart/mixed no nested name is written. The
// assertion reads a nested value as its object.

const encoder = new TextEncoder();

const text = (chunks: readonly Uint8Array[]): string =>
  Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");

const build = (fields: Serialize.FormFields, options: Serialize.FormDataOptions) =>
  Effect.runPromise(
    Serialize.request("POST", {
      body: Serialize.formData(fields, options),
      headers: [],
      path: Serialize.path("/uploads", []),
      query: [],
    }),
  );

const streamed = async (built: HttpClientRequest.HttpClientRequest): Promise<string> => {
  if (built.body._tag !== "Stream") {
    throw new Error(`expected a stream body, got ${built.body._tag}`);
  }

  return text(await Effect.runPromise(Stream.runCollect(built.body.stream)));
};

const boundaryIn = (contentType: string): string =>
  /; boundary=(?<boundary>[^\r\n]+)/u.exec(contentType)?.groups?.boundary ?? "";

// The body with the outer boundary as `<outer>` and every nested one as `<nested>`.
const normalized = async (built: HttpClientRequest.HttpClientRequest): Promise<string> => {
  const outer = boundaryIn(built.headers["content-type"] ?? "");
  const body = await streamed(built);
  const nested = [
    ...body.matchAll(/Content-Type: multipart\/[a-z-]+; boundary=(?<boundary>[^\r\n]+)/gu),
  ].map((match) => match.groups?.boundary ?? "");

  expect(outer).not.toBe("");

  let current = body.replaceAll(outer, "<outer>");
  for (const boundary of nested) {
    current = current.replaceAll(boundary, "<nested>");
  }

  return current;
};

const scan: Serialize.FormFile = {
  filename: "scan.png",
  stream: Stream.succeed(encoder.encode("png")),
};

const envelope: Serialize.NestedForm = {
  kind: "mixed",
  parts: [
    ["meta", "application/json"],
    ["note", "text/plain"],
    ["scan", "image/png"],
  ],
};

describe("Serialize.formData: one nested level by name", () => {
  test("ENC-07: a multipart/mixed nested part sends each nested property under its rule, in nested property order, with no names", async () => {
    const built = await build(
      {
        envelope: Serialize.nestedValues({
          meta: [Serialize.jsonPart({ id: 1 })],
          note: ["n"],
          scan: [scan],
        }),
        title: ["t"],
      },
      {
        parts: [
          ["envelope", envelope],
          ["title", "text/plain"],
        ],
        required: true,
      },
    );

    expect(await normalized(built)).toBe(
      [
        "--<outer>",
        'Content-Disposition: form-data; name="envelope"',
        "Content-Type: multipart/mixed; boundary=<nested>",
        "",
        "--<nested>",
        "Content-Type: application/json",
        "",
        '{"id":1}',
        "--<nested>",
        "Content-Type: text/plain",
        "",
        "n",
        "--<nested>",
        "Content-Type: image/png",
        "",
        "png",
        "--<nested>--",
        "--<outer>",
        'Content-Disposition: form-data; name="title"',
        "Content-Type: text/plain",
        "",
        "t",
        "--<outer>--",
        "",
      ].join("\r\n"),
    );
  });

  test("ENC-16: a multipart/form-data nested part writes each nested name, and a file's filename", async () => {
    const built = await build(
      { form: Serialize.nestedValues({ scan: [scan], x: ["a"] }) },
      {
        parts: [
          [
            "form",
            {
              kind: "form-data",
              parts: [
                ["x", "text/plain"],
                ["scan", "image/png"],
              ],
            },
          ],
        ],
        required: true,
      },
    );

    expect(await normalized(built)).toBe(
      [
        "--<outer>",
        'Content-Disposition: form-data; name="form"',
        "Content-Type: multipart/form-data; boundary=<nested>",
        "",
        "--<nested>",
        'Content-Disposition: form-data; name="x"',
        "Content-Type: text/plain",
        "",
        "a",
        "--<nested>",
        'Content-Disposition: form-data; name="scan"; filename="scan.png"',
        "Content-Type: image/png",
        "",
        "png",
        "--<nested>--",
        "--<outer>--",
        "",
      ].join("\r\n"),
    );
  });

  test("a nested part with no member value is not a value, so the part is not sent", () => {
    expect(Serialize.nestedValues({ note: [], scan: [] })).toEqual([]);
    expect(Serialize.nestedValues({ note: ["n"], scan: [] })).toEqual([
      { nested: { note: ["n"], scan: [] } },
    ]);
  });
});

const formBody = Schema.Struct({
  form: Schema.optionalKey(
    Schema.Struct({
      scan: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
      tags: Schema.optionalKey(Schema.Array(Schema.String)),
      x: Schema.optionalKey(Schema.String),
      y: Schema.Int,
    }),
  ),
  title: Schema.optionalKey(Schema.String),
});

const formOptions: Serialize.FormSchemaOptions = {
  flags: { form: "form.scan", title: "title" },
  nested: {
    form: {
      flags: { scan: "form.scan", tags: "form.tags", x: "form.x", y: "form.y" },
      repeated: ["tags"],
    },
  },
  repeated: [],
  required: true,
  schema: formBody,
};

const usageOf = (fields: Serialize.FormFields) =>
  Effect.runPromise(Effect.flip(Serialize.assertFormData(formOptions)(fields)));

describe("Serialize.assertFormData: a by-name nested value is asserted as its object", () => {
  test("ENC-16: a valid nested value, a repeated member and a file member pass unchanged", async () => {
    const fields: Serialize.FormFields = {
      form: Serialize.nestedValues({ scan: [scan], tags: ["a"], x: ["a"], y: [2] }),
    };

    expect(await Effect.runPromise(Serialize.assertFormData(formOptions)(fields))).toBe(fields);
  });

  test("ENC-16: a missing required nested member is a UsageError naming its dotted flag", async () => {
    const error = await usageOf({ form: Serialize.nestedValues({ x: ["a"] }) });

    expect(error).toBeInstanceOf(UsageError);
    expect([error._tag, error.flag]).toEqual(["UsageError", "form.y"]);
  });

  test("ENC-16: a nested member that does not match its schema is a UsageError naming its dotted flag", async () => {
    const error = await usageOf({ form: Serialize.nestedValues({ y: ["two"] }) });

    expect([error._tag, error.flag]).toEqual(["UsageError", "form.y"]);
  });
});
