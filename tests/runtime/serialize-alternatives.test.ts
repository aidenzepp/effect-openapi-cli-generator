import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { HttpBody } from "effect/http";
import type { HttpClientRequest } from "effect/http";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

const decoder = new TextDecoder();

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const sent = (requestBody: Serialize.RequestBody) =>
  run(
    Serialize.request("POST", {
      body: requestBody,
      headers: [],
      path: Serialize.path("/upload", []),
      query: [],
    }),
  );

const textOf = async (request: HttpClientRequest.HttpClientRequest) => {
  const { body } = request;

  if (body._tag === "Uint8Array") {
    return decoder.decode(body.body);
  }

  if (body._tag === "Stream") {
    const chunks = await run(Stream.runCollect(body.stream).pipe(Effect.orDie));

    return decoder.decode(Buffer.concat(chunks));
  }

  return "";
};

interface Bodies {
  readonly "application/json": Serialize.Body;
  readonly "application/x-www-form-urlencoded": Serialize.Json | undefined;
  readonly "image/*": Serialize.Body;
  readonly "multipart/form-data": Serialize.FormFields;
}

const formOptions = {
  properties: [
    ["name", {}],
    ["tags", { explode: false }],
  ],
  required: true,
} as const;

const partOptions = {
  parts: [
    ["name", "text/plain"],
    ["file", "application/octet-stream"],
  ],
  required: true,
} as const;

// One entry per codec, each recording the content type it received.
const tableOf = (seen: string[]) => ({
  "application/json": (body: Serialize.Body, contentType: "application/json") => {
    seen.push(contentType);

    return Serialize.body(contentType, body);
  },
  "application/x-www-form-urlencoded": (
    body: Serialize.Json | undefined,
    contentType: "application/x-www-form-urlencoded",
  ) => {
    seen.push(contentType);

    return Serialize.urlEncoded(contentType, body, formOptions);
  },
  "image/*": (body: Serialize.Body, contentType: string) => {
    seen.push(contentType);

    return Serialize.body(contentType, body);
  },
  "multipart/form-data": (body: Serialize.FormFields, contentType: "multipart/form-data") => {
    seen.push(contentType);

    return Serialize.formData(body, partOptions);
  },
});

describe("Serialize.alternatives", () => {
  test("the entry for the chosen key encodes the body, and no other entry runs", async () => {
    const seen: string[] = [];
    const chosen: Serialize.Chosen<Bodies> = {
      body: { name: "ada" },
      contentType: "application/json",
      key: "application/json",
    };
    const request = await sent(Serialize.alternatives(chosen, tableOf(seen)));

    expect(seen).toEqual(["application/json"]);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(await textOf(request)).toBe('{"name":"ada"}');
  });

  test("a range key's entry receives the operator's concrete type, which is sent", async () => {
    const seen: string[] = [];
    const chosen: Serialize.Chosen<Bodies> = {
      body: HttpBody.uint8Array(Uint8Array.from([1, 2, 3])),
      contentType: "image/webp",
      key: "image/*",
    };
    const request = await sent(Serialize.alternatives(chosen, tableOf(seen)));

    expect(seen).toEqual(["image/webp"]);
    expect(request.headers["content-type"]).toBe("image/webp");
  });

  test("a multipart entry sends the writer's content type with its boundary", async () => {
    const seen: string[] = [];
    const chosen: Serialize.Chosen<Bodies> = {
      body: {
        file: [{ filename: "a.bin", stream: Stream.make(Uint8Array.from([0x41])) }],
        name: ["ada"],
      },
      contentType: "multipart/form-data",
      key: "multipart/form-data",
    };
    const request = await sent(Serialize.alternatives(chosen, tableOf(seen)));
    const type = request.headers["content-type"] ?? "";
    const boundary = /boundary=(?<b>.+)$/u.exec(type)?.groups?.b ?? "";
    const text = await textOf(request);

    expect(seen).toEqual(["multipart/form-data"]);
    expect(type.startsWith("multipart/form-data; boundary=")).toBe(true);
    expect(boundary).not.toBe("");
    expect(text).toContain(`--${boundary}\r\n`);
    expect(text).toContain('name="file"; filename="a.bin"');
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  test("the form entry sends the bytes urlEncoded sends alone", async () => {
    const value = { name: "a b", tags: ["x", "y"] };
    const chosen: Serialize.Chosen<Bodies> = {
      body: value,
      contentType: "application/x-www-form-urlencoded",
      key: "application/x-www-form-urlencoded",
    };
    const viaTable = await sent(Serialize.alternatives(chosen, tableOf([])));
    const alone = await sent(
      Serialize.urlEncoded("application/x-www-form-urlencoded", value, formOptions),
    );

    expect(await textOf(viaTable)).toBe(await textOf(alone));
    expect(await textOf(viaTable)).toBe("name=a+b&tags=x,y");
    expect(viaTable.headers["content-type"]).toBe(alone.headers["content-type"]);
  });
});
