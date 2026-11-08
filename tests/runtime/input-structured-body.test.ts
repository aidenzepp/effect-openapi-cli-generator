import { describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, Option, Schema, Sink, Stdio, Stream } from "effect";
import { HttpBody } from "effect/http";
import * as FileBodyModule from "../../src/runtime-src/runtime/file-body.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const stdinOf = (...chunks: readonly Uint8Array[]): Layer.Layer<Stdio.Stdio> =>
  Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stderr: () => Sink.drain,
      stdin: Stream.fromIterable(chunks),
      stdout: () => Sink.drain,
    }),
  );

const inputLayer = (...chunks: readonly Uint8Array[]) =>
  Layer.mergeAll(
    FileBodyModule.layer.pipe(Layer.provide(BunFileSystem.layer)),
    BunFileSystem.layer,
    stdinOf(...chunks),
    Input.stdinClaimLayer,
  );

const Person = Schema.Struct({
  count: Schema.optionalKey(Schema.Number),
  name: Schema.String,
});

interface Given {
  readonly body?: string;
  readonly bodyFile?: string;
  readonly fields?: Input.Fields;
  readonly required?: boolean;
  readonly schema?: Schema.Top;
  readonly stdin?: string;
}

const optionsOf = (given: Given) => ({
  body: Option.fromNullishOr(given.body),
  bodyFile: Option.fromNullishOr(given.bodyFile),
  fields: given.fields ?? {},
  required: given.required ?? true,
  schema: given.schema ?? Schema.Unknown,
});

const layerOf = (given: Given) =>
  inputLayer(...(given.stdin === undefined ? [] : [encoder.encode(given.stdin)]));

const structured = (given: Given) =>
  Effect.runPromise(Input.structuredBody(optionsOf(given)).pipe(Effect.provide(layerOf(given))));

const structuredFailure = (given: Given) =>
  Effect.runPromise(
    Input.structuredBody(optionsOf(given)).pipe(Effect.flip, Effect.provide(layerOf(given))),
  );

const mergedFailure = (given: Given) =>
  Effect.runPromise(
    Input.mergeBody(optionsOf(given)).pipe(Effect.flip, Effect.provide(layerOf(given))),
  );

const mergedText = (given: Given) =>
  Effect.runPromise(
    Input.mergeBody(optionsOf(given)).pipe(
      Effect.map((body) => (body._tag === "Uint8Array" ? decoder.decode(body.body) : body._tag)),
      Effect.provide(layerOf(given)),
    ),
  );

// The value as `mergeBody` would send it: a `JsonNumber` written as its text.
const asText = (value: Input.JsonNode | undefined): string =>
  JSON.stringify(value, (_key: string, node: Input.JsonNode) =>
    node instanceof Input.JsonNumber ? Input.rawJson(node.text) : node,
  );

const formText = async (value: Serialize.Json | undefined): Promise<string> => {
  const built = await Effect.runPromise(
    Serialize.urlEncoded("application/x-www-form-urlencoded", value, {
      properties: [],
      required: true,
    }).expand,
  );

  return HttpBody.isHttpBody(built) && built._tag === "Uint8Array"
    ? decoder.decode(built.body)
    : "";
};

describe("Input.structuredBody", () => {
  test("no input: an optional body is undefined, a required one is {} asserted", async () => {
    expect(await structured({ required: false })).toBeUndefined();
    expect(await structured({ required: true })).toEqual({});

    const refused = await structuredFailure({ required: true, schema: Person });

    expect(refused).toEqual(await mergedFailure({ required: true, schema: Person }));
    expect(refused.message).toBe("--body: the request body does not match its schema");
  });

  test("--body is the parsed value; a number JSON.parse would change stays a JsonNumber", async () => {
    const value = await structured({
      body: '{"name":"Ada","count":12345678901234567890,"price":1.50}',
    });

    expect(value).toEqual({
      count: new Input.JsonNumber("12345678901234567890"),
      name: "Ada",
      price: new Input.JsonNumber("1.50"),
    });
  });

  test("field flags override the body at their pointers, as mergeBody merges them", async () => {
    const given: Given = {
      body: '{"name":"body","nested":{"keep":true,"over":1}}',
      fields: {
        "/count": Option.some(new Input.JsonNumber("9007199254740993")),
        "/name": Option.some("flag"),
        "/nested/over": Option.some(2),
      },
    };
    const value = await structured(given);

    expect(asText(value)).toBe(await mergedText(given));
    expect(asText(value)).toBe(
      '{"name":"flag","nested":{"keep":true,"over":2},"count":9007199254740993}',
    );
  });

  test("--body-file - reads stdin, as mergeBody does", async () => {
    const value = await structured({ bodyFile: "-", stdin: '{"name":"piped"}' });

    expect(value).toEqual({ name: "piped" });
  });

  test("the merged value's objects have no prototype; __proto__ is an own key", async () => {
    const value = await structured({ fields: { "/__proto__/x": Option.some("1") } });

    expect(asText(value)).toBe('{"__proto__":{"x":"1"}}');
    expect(Object.hasOwn(Object.prototype, "x")).toBe(false);
  });

  test("each refusal is mergeBody's, naming a flag and never a value", async () => {
    const cases: readonly Given[] = [
      { body: "{}", bodyFile: "x" },
      { body: "{not json" },
      { body: "[1]", fields: { "/name": Option.some("x") } },
      { body: '{"name":1}', schema: Person },
      { fields: { "/count": Option.some(new Input.JsonNumber("1.5x")) } },
    ];

    const structuredRefusals = await Promise.all(cases.map(structuredFailure));
    const mergedRefusals = await Promise.all(cases.map(mergedFailure));

    expect(structuredRefusals.map((refused) => refused._tag)).toEqual(
      cases.map(() => "UsageError"),
    );
    expect(structuredRefusals).toEqual(mergedRefusals);
  });

  test("the value hands to Serialize.urlEncoded, a JsonNumber sent as its text", async () => {
    const value = await structured({
      body: '{"name":"Ada Lovelace","count":12345678901234567890}',
    });

    expect(await formText(value)).toBe("name=Ada+Lovelace&count=12345678901234567890");
  });
});
