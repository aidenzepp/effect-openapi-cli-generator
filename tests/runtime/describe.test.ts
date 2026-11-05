import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import * as Describe from "../../src/runtime-src/runtime/describe.ts";

const euServers: BaseUrl.ServersTable = {
  boundOrigins: [],
  servers: [{ url: "https://eu.example.com" }],
};

const update = Command.make("update", {
  id: Argument.String("id"),
  ifMatch: Flag.String("if-match").pipe(Flag.optional),
  name: Flag.String("name").pipe(Flag.optional),
}).pipe(
  Command.annotate(Describe.Binding, {
    operation: {
      media: {
        request: ["application/json", "application/merge-patch+json"],
        responses: { "200": ["application/json"], "4XX": [], default: ["application/json"] },
      },
      method: "PATCH",
      origin: { document: "openapi.json", pointer: "/paths/~1users~1{id}/patch" },
      pathTemplate: "/users/{id}",
      // The operation's own requirement.
      security: [["bearerAuth"], ["apiKey", "session"]],
      // An operation-level override, as the generated meta carries it.
      servers: euServers,
    },
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
    operation: {
      media: { request: [], responses: { "200": ["application/json"] } },
      method: "GET",
      origin: { document: "openapi.json", pointer: "/paths/~1users/get" },
      pathTemplate: "/users",
      // Root-inherited: the operation declares none, so the meta carries the root requirement.
      security: [["rootAuth"]],
    },
    parameters: {},
  }),
);

const root = Command.make("example").pipe(
  Command.withSubcommands([Command.make("users").pipe(Command.withSubcommands([update, list]))]),
  Command.withGlobalFlags([Describe.describeFlag]),
);

const declaredRoot = BaseUrl.layer(
  {
    boundOrigins: ["https://api.example.com"],
    defaultServer: 0,
    servers: [
      { url: "https://api.example.com/{version}", variables: { version: { default: "v1" } } },
    ],
  },
  "EXAMPLE",
);

// What the generator emits for a document whose levels declare no servers: the single server `/`.
const undeclaredRoot = BaseUrl.layer({ boundOrigins: [], servers: [{ url: "/" }] }, "EXAMPLE");

// `--describe` through `Command.runWith`, with the root's services provided around the run as
// `main.ts` provides them.
const run = <A>(services: Layer.Layer<A>) =>
  Effect.runPromise(
    Effect.suspend(() => {
      const lines: string[] = [];
      // Object.assign keeps the host console methods; spreading a Console instance drops its prototype.
      // oxlint-disable-next-line prefer-object-spread
      const console: Console.Console = Object.assign({}, globalThis.console, {
        log: (...args: readonly unknown[]) => {
          lines.push(args.join(" "));
        },
      });

      return Command.runWith(root, { version: "0.0.0" })(["--describe"]).pipe(
        Effect.provide(services),
        Effect.provide(BunServices.layer),
        Effect.provideService(Console.Console, console),
        Effect.as(lines),
      );
    }),
  );

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Describe.Description));

const describeWith = async <A>(services: Layer.Layer<A>) => {
  const lines = await run(services);

  expect(lines).toHaveLength(1);

  return decode(lines[0] ?? "");
};

describe("--describe", () => {
  test("a two-command tree prints the expected document, which the codec decodes", async () => {
    const decoded = await describeWith(declaredRoot);

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
      requestMedia: ["application/json", "application/merge-patch+json"],
      responses: ["200", "4XX", "default"],
      security: [["bearerAuth"], ["apiKey", "session"]],
      servers: ["https://eu.example.com"],
    });
    expect(decoded.commands[1]?.flags).toEqual([]);
  });

  test("an operation-level servers override wins over the root servers", async () => {
    const decoded = await describeWith(declaredRoot);

    expect(decoded.commands[0]?.servers).toEqual(["https://eu.example.com"]);
  });

  test("without an override, the root servers from the Servers service are inherited", async () => {
    const decoded = await describeWith(declaredRoot);

    expect(decoded.commands[1]?.servers).toEqual(["https://api.example.com/{version}"]);
  });

  test("when no level declares servers, the effective server is /", async () => {
    const decoded = await describeWith(undeclaredRoot);

    expect(decoded.commands[1]?.servers).toEqual(["/"]);
    expect(decoded.commands[0]?.servers).toEqual(["https://eu.example.com"]);
  });

  test("without the Servers service, root-inherited servers are empty (fail closed)", async () => {
    const decoded = await describeWith(Layer.empty);

    expect(decoded.commands[1]?.servers).toEqual([]);
    expect(decoded.commands[0]?.servers).toEqual(["https://eu.example.com"]);
  });

  test("security is the operation's requirement, or the root-inherited one", async () => {
    const decoded = await describeWith(declaredRoot);

    expect(decoded.commands[0]?.security).toEqual([["bearerAuth"], ["apiKey", "session"]]);
    expect(decoded.commands[1]?.security).toEqual([["rootAuth"]]);
  });

  test("request media and response keys are listed as spelled, in order", async () => {
    const decoded = await describeWith(declaredRoot);

    expect(decoded.commands[0]?.requestMedia).toEqual([
      "application/json",
      "application/merge-patch+json",
    ]);
    expect(decoded.commands[0]?.responses).toEqual(["200", "4XX", "default"]);
    expect(decoded.commands[1]?.requestMedia).toEqual([]);
    expect(decoded.commands[1]?.responses).toEqual(["200"]);
  });

  test("the output is byte-stable and fields are alphabetical", async () => {
    const first = await run(declaredRoot);
    const second = await run(declaredRoot);
    const text = first[0] ?? "";

    expect(first).toEqual(second);
    expect(text.indexOf('"commands"')).toBeLessThan(text.indexOf('"describeVersion"'));
    expect(text.indexOf('"location"')).toBeLessThan(text.indexOf('"name"'));
    expect(text.indexOf('"name"')).toBeLessThan(text.indexOf('"wireName"'));
    expect(text.indexOf('"pointer": "/paths')).toBeLessThan(text.indexOf('"requestMedia"'));
    expect(text.indexOf('"requestMedia"')).toBeLessThan(text.indexOf('"responses"'));
    expect(text.indexOf('"responses"')).toBeLessThan(text.indexOf('"security"'));
    expect(text.indexOf('"security"')).toBeLessThan(text.indexOf('"servers"'));
  });

  test("a command without a binding is a group and is not listed", async () => {
    const decoded = await describeWith(declaredRoot);

    expect(decoded.commands.some((c) => c.path.join(" ") === "users")).toBe(false);
  });
});
