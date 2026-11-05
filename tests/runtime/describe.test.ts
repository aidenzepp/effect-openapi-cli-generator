import { describe, expect, test } from "bun:test";
import { Console, Effect, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as Describe from "../../src/runtime-src/runtime/describe.ts";

const operation = (method: string, pathTemplate: string, pointer: string) => ({
  method,
  origin: { document: "openapi.json", pointer },
  pathTemplate,
});

const update = Command.make("update", {
  id: Argument.String("id"),
  ifMatch: Flag.String("if-match").pipe(Flag.optional),
  name: Flag.String("name").pipe(Flag.optional),
}).pipe(
  Command.annotate(Describe.Binding, {
    operation: operation("PATCH", "/users/{id}", "/paths/~1users~1{id}/patch"),
    parameters: {
      id: { location: "path", pointer: "/paths/~1users~1{id}/patch/parameters/0", wireName: "id" },
      "if-match": {
        location: "header",
        pointer: "/paths/~1users~1{id}/patch/parameters/2",
        wireName: "If-Match",
      },
      name: {
        location: "body",
        pointer: "/components/schemas/UserUpdate/properties/name",
        wireName: "/name",
      },
    },
  }),
);

const list = Command.make("list").pipe(
  Command.annotate(Describe.Binding, {
    operation: operation("GET", "/users", "/paths/~1users/get"),
    parameters: {},
  }),
);

const root = Command.make("example").pipe(
  Command.withSubcommands([Command.make("users").pipe(Command.withSubcommands([update, list]))]),
);

const capture = Effect.suspend(() => {
  const lines: string[] = [];
  // Object.assign keeps the host console methods; spreading a Console instance drops its prototype.
  // oxlint-disable-next-line prefer-object-spread
  const console: Console.Console = Object.assign({}, globalThis.console, {
    log: (...args: readonly unknown[]) => {
      lines.push(args.join(" "));
    },
  });

  return Describe.describeFlag
    .run(true, { builtIns: [], command: root, commandPath: ["example"], version: "0.0.0" })
    .pipe(Effect.provideService(Console.Console, console), Effect.as(lines));
});

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Describe.Description));

describe("--describe", () => {
  test("a two-command tree prints the expected document, which the codec decodes", async () => {
    const lines = await Effect.runPromise(capture);

    expect(lines).toHaveLength(1);

    const decoded = decode(lines[0] ?? "");

    expect(decoded.describeVersion).toBe(1);
    expect(decoded.commands.map((c) => c.path.join(" "))).toEqual(["users update", "users list"]);
    expect(decoded.commands[0]).toEqual({
      document: "openapi.json",
      flags: [
        {
          location: "path",
          name: "id",
          pointer: "/paths/~1users~1{id}/patch/parameters/0",
          wireName: "id",
        },
        {
          location: "header",
          name: "if-match",
          pointer: "/paths/~1users~1{id}/patch/parameters/2",
          wireName: "If-Match",
        },
        {
          location: "body",
          name: "name",
          pointer: "/components/schemas/UserUpdate/properties/name",
          wireName: "/name",
        },
      ],
      method: "PATCH",
      path: ["users", "update"],
      pathTemplate: "/users/{id}",
      pointer: "/paths/~1users~1{id}/patch",
    });
    expect(decoded.commands[1]?.flags).toEqual([]);
  });

  test("the output is byte-stable and fields are alphabetical", async () => {
    const first = await Effect.runPromise(capture);
    const second = await Effect.runPromise(capture);
    const text = first[0] ?? "";

    expect(first).toEqual(second);
    expect(text.indexOf('"commands"')).toBeLessThan(text.indexOf('"describeVersion"'));
    expect(text.indexOf('"location"')).toBeLessThan(text.indexOf('"name"'));
    expect(text.indexOf('"name"')).toBeLessThan(text.indexOf('"wireName"'));
  });

  test("a command without a binding is a group and is not listed", async () => {
    const lines = await Effect.runPromise(capture);

    expect(decode(lines[0] ?? "").commands.some((c) => c.path.join(" ") === "users")).toBe(false);
  });
});
