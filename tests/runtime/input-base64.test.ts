import { describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option, Schema, Sink, Stdio, Stream } from "effect";
import type { HttpBody } from "effect/http";
import { layer as fileBodyLayer } from "../../src/runtime-src/runtime/file-body.ts";
import type { FileBody } from "../../src/runtime-src/runtime/file-body.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";

// Five bytes whose base64 text uses both '+' and '/', so base64 and base64url differ.
const five = Uint8Array.from([0xfb, 0xff, 0xbf, 0x01, 0x02]);

const decoder = new TextDecoder();

const decodeAvatar = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ avatar: Schema.String })),
);

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

const layer = (...chunks: readonly Uint8Array[]) =>
  Layer.mergeAll(
    fileBodyLayer.pipe(Layer.provide(BunFileSystem.layer)),
    BunFileSystem.layer,
    stdinOf(...chunks),
    Input.stdinClaimLayer,
  );

const withTempFile = <A, E, R>(
  content: Uint8Array,
  use: (path: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* temp() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* fs.makeTempFileScoped();

    yield* fs.writeFile(path, content);

    return yield* use(path);
  }).pipe(Effect.scoped);

const textOf = (body: HttpBody.HttpBody): string => {
  if (body._tag !== "Uint8Array") {
    throw new Error(`expected bytes, got ${body._tag}`);
  }

  return decoder.decode(body.body);
};

const file = (encoding: Input.FieldEncoding, path: string, flag = "avatar") =>
  Option.some(new Input.FileField({ encoding, flag, path }));

const merge = (options: {
  readonly body?: string;
  readonly bodyFile?: string;
  readonly fields: Input.Fields;
}) =>
  Input.mergeBody({
    body: Option.fromNullishOr(options.body),
    bodyFile: Option.fromNullishOr(options.bodyFile),
    fields: options.fields,
    required: false,
    schema: Schema.Unknown,
  });

const run = <A, E>(
  effect: Effect.Effect<A, E, FileBody | FileSystem.FileSystem | Stdio.Stdio | Input.StdinClaim>,
  stdin: Uint8Array = five,
) => Effect.runPromise(effect.pipe(Effect.provide(layer(stdin))));

describe("a base64 field flag", () => {
  test("a 5-byte file lands at its pointer as padded base64", async () => {
    const text = await run(
      withTempFile(five, (path) =>
        merge({ fields: { "/avatar": file("base64", path) } }).pipe(Effect.map(textOf)),
      ),
    );

    expect(JSON.parse(text)).toEqual({ avatar: "+/+/AQI=" });
  });

  test("the same file under base64url lands as padded base64url", async () => {
    const text = await run(
      withTempFile(five, (path) =>
        merge({ fields: { "/avatar": file("base64url", path) } }).pipe(Effect.map(textOf)),
      ),
    );

    expect(JSON.parse(text)).toEqual({ avatar: "-_-_AQI=" });
  });

  // Past one 32 KiB chunk, so an encoder that pads each chunk separately puts '=' mid-text.
  test.each([
    ["base64", 32_769],
    ["base64", 98_306],
    ["base64url", 32_769],
    ["base64url", 98_306],
  ] as const)("a %s file of %d bytes is encoded as one whole buffer", async (encoding, size) => {
    // A 256-cycle that shifts every 251 bytes, so no window of the file repeats a short period.
    const bytes = Uint8Array.from(
      { length: size },
      (_, index) => (index * 131 + Math.floor(index / 251) * 17) % 256,
    );
    const whole = Buffer.from(bytes).toString("base64");
    const expected =
      encoding === "base64url" ? whole.replaceAll("+", "-").replaceAll("/", "_") : whole;

    const text = await run(
      withTempFile(bytes, (path) =>
        merge({ fields: { "/avatar": file(encoding, path) } }).pipe(Effect.map(textOf)),
      ),
    );
    const { avatar } = decodeAvatar(text);

    expect(avatar).toBe(expected);
    expect(new Uint8Array(Buffer.from(avatar, encoding))).toEqual(bytes);
    expect(avatar.replace(/=+$/u, "")).not.toContain("=");
  });

  test("a nested pointer is written and the rest of --body is kept", async () => {
    const text = await run(
      withTempFile(five, (path) =>
        merge({
          body: '{"name":"x"}',
          fields: { "/user/avatar": file("base64", path) },
        }).pipe(Effect.map(textOf)),
      ),
    );

    expect(JSON.parse(text)).toEqual({ name: "x", user: { avatar: "+/+/AQI=" } });
  });

  test("- reads stdin", async () => {
    const text = await run(
      merge({ fields: { "/avatar": file("base64", "-") } }).pipe(Effect.map(textOf)),
    );

    expect(JSON.parse(text)).toEqual({ avatar: "+/+/AQI=" });
  });

  test("a body that already holds base64 text is sent as given when the flag is absent", async () => {
    const text = await run(
      merge({
        body: '{"avatar":"+/+/AQI="}',
        fields: { "/avatar": Option.none<Input.FieldValue>() },
      }).pipe(Effect.map(textOf)),
    );

    expect(text).toBe('{"avatar":"+/+/AQI="}');
  });

  test("a missing file is a UsageError naming the flag, never the path", async () => {
    const path = "/nonexistent/avatar-source-path";
    const error = await run(
      merge({ fields: { "/avatar": file("base64", path) } }).pipe(Effect.flip),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("avatar");
    expect(error.message).not.toContain(path);
  });

  test("two stdin consumers fail as before, naming the second flag", async () => {
    const error = await run(
      merge({
        bodyFile: "-",
        fields: { "/avatar": file("base64", "-") },
      }).pipe(Effect.flip),
      new TextEncoder().encode("{}"),
    );

    expect(error._tag).toBe("UsageError");
    expect(error.flag).toBe("avatar");
  });
});
