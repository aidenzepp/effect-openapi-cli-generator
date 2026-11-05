import { describe, expect, test } from "bun:test";
import {
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Runtime,
  Stdio,
  Terminal,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import type { SelectionInput } from "../../src/runtime-src/runtime/base-url.ts";

const canary = "CANARY-7f3a9";

const table: BaseUrl.ServersTable = {
  boundOrigins: ["https://api.example.com", "https://eu.example.com"],
  defaultServer: 0,
  servers: [
    { url: "https://api.example.com/{version}", variables: { version: { default: "v1" } } },
    {
      name: "eu",
      url: "https://{region}.example.com/{version}",
      variables: {
        region: { default: "eu", enum: ["eu"] },
        version: { default: "v2", enum: ["v1", "v2"] },
      },
    },
  ],
};

const serverAt = (index: number): BaseUrl.ServerEntry => {
  const entry = table.servers[index];
  if (entry === undefined) {
    throw new Error("fixture has no such server");
  }

  return entry;
};

const noDefault: BaseUrl.ServersTable = { boundOrigins: [], servers: table.servers };

const input = (parts: Partial<SelectionInput> = {}): SelectionInput => ({
  baseUrl: Option.none(),
  server: Option.none(),
  serverVariables: [],
  ...parts,
});

const run = (
  selection: SelectionInput,
  options: {
    readonly env?: Record<string, string>;
    readonly table?: BaseUrl.ServersTable;
  } = {},
) =>
  Effect.runPromiseExit(
    BaseUrl.select(selection).pipe(
      Effect.provide(BaseUrl.layer(options.table ?? table, "EXAMPLE")),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(options.env ?? {}))),
    ),
  );

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (!Exit.isFailure(exit)) {
    throw new Error("expected a failure");
  }

  const [error] = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" ? [reason.error] : [],
  );
  if (error === undefined) {
    throw new Error("expected a typed failure");
  }

  return error;
};

const expectUsage = (error: UsageError, flag: string) => {
  expect(error).toMatchObject({ _tag: "UsageError", flag });
  expect(Runtime.getErrorExitCode(error)).toBe(2);
  expect(JSON.stringify(error)).not.toContain(canary);
  expect(error.message).toContain(flag);
  expect(error.message).not.toContain(canary);
};

describe("BaseUrl.layer", () => {
  test("provides Servers with the given table and prefix", async () => {
    const service = await Effect.runPromise(
      BaseUrl.Servers.pipe(Effect.provide(BaseUrl.layer(table, "EXAMPLE"))),
    );
    expect(service.table).toBe(table);
    expect(service.envPrefix).toBe("EXAMPLE");
  });
});

describe("precedence", () => {
  test("--base-url beats the env value, a server and the default", async () => {
    const exit = await run(
      input({ baseUrl: Option.some("https://flag.example.org/api"), server: Option.some("eu") }),
      { env: { EXAMPLE_BASE_URL: "https://env.example.org" } },
    );
    expect(exit).toEqual(
      Exit.succeed({ baseUrl: "https://flag.example.org/api", provenance: "operator" }),
    );
  });

  test("the env value beats --server and the default, and is operator-chosen", async () => {
    const exit = await run(input({ server: Option.some("eu") }), {
      env: { EXAMPLE_BASE_URL: "http://localhost:8080" },
    });
    expect(exit).toEqual(
      Exit.succeed({ baseUrl: "http://localhost:8080", provenance: "operator" }),
    );
  });

  test("--server with --server-variable beats the default and expands variables over defaults", async () => {
    const exit = await run(
      input({
        server: Option.some("eu"),
        serverVariables: [{ name: "version", value: "v1" }],
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        provenance: "server",
        server: serverAt(1),
        variables: { region: "eu", version: "v1" },
      }),
    );
  });

  test("--server accepts an index", async () => {
    const exit = await run(input({ server: Option.some("1") }));
    expect(exit).toEqual(
      Exit.succeed({
        provenance: "server",
        server: serverAt(1),
        variables: { region: "eu", version: "v2" },
      }),
    );
  });

  test("a variable without --server applies to the accepted default", async () => {
    const exit = await run(input({ serverVariables: [{ name: "version", value: "v9" }] }));
    expect(exit).toEqual(
      Exit.succeed({ provenance: "server", server: serverAt(0), variables: { version: "v9" } }),
    );
  });

  test("the accepted default is the last resort and has server provenance", async () => {
    const exit = await run(input());
    expect(exit).toEqual(
      Exit.succeed({ provenance: "server", server: serverAt(0), variables: { version: "v1" } }),
    );
  });

  test("with no base at all the error names --base-url and exits 2", async () => {
    const error = failure(await run(input(), { table: noDefault }));
    expectUsage(error, "--base-url");
  });
});

describe("invalid values never echo the value", () => {
  const badUrls = [
    ["scheme", `ftp://${canary}.example.org`],
    ["not absolute", canary],
    ["userinfo", `https://user:${canary}@example.org`],
    ["empty userinfo", `https://@${canary}.example.org`],
    ["userinfo after a slash run", `https:///user:${canary}@example.org`],
    ["userinfo after a backslash", `https:/\\${canary}@example.org`],
    ["query", `https://example.org/?token=${canary}`],
    ["empty query", `https://${canary}.example.org/?`],
    ["fragment", `https://example.org/#${canary}`],
  ] as const;

  test.each(badUrls)("--base-url %s", async (_cause, value) => {
    expectUsage(
      failure(await Effect.runPromiseExit(BaseUrl.validateBaseUrl("--base-url", value))),
      "--base-url",
    );
    expectUsage(failure(await run(input({ baseUrl: Option.some(value) }))), "--base-url");
  });

  test.each(badUrls)("env value %s", async (_cause, value) => {
    expectUsage(
      failure(await run(input(), { env: { EXAMPLE_BASE_URL: value } })),
      "EXAMPLE_BASE_URL",
    );
  });

  test("an empty env value is unset, as the config provider reads it", async () => {
    const exit = await run(input(), { env: { EXAMPLE_BASE_URL: "" } });
    expect(exit).toEqual(
      Exit.succeed({ provenance: "server", server: serverAt(0), variables: { version: "v1" } }),
    );
  });

  test("a valid base URL passes through unchanged", async () => {
    const exit = await Effect.runPromiseExit(
      BaseUrl.validateBaseUrl("--base-url", "https://example.org/a/b/"),
    );
    expect(exit).toEqual(Exit.succeed("https://example.org/a/b/"));
  });

  test.each([canary, "", `=${canary}`])("malformed --server-variable %p", async (value) => {
    expectUsage(
      failure(await Effect.runPromiseExit(BaseUrl.parseServerVariable(value))),
      "--server-variable",
    );
  });

  test("a well-formed --server-variable pair splits at the first =", async () => {
    const exit = await Effect.runPromiseExit(BaseUrl.parseServerVariable("version=a=b"));
    expect(exit).toEqual(Exit.succeed({ name: "version", value: "a=b" }));
  });

  test("unknown server by name and by index", async () => {
    expectUsage(failure(await run(input({ server: Option.some(canary) }))), "--server");
    expectUsage(failure(await run(input({ server: Option.some("9") }))), "--server");
  });

  test("unknown variable", async () => {
    expectUsage(
      failure(await run(input({ serverVariables: [{ name: canary, value: "x" }] }))),
      "--server-variable",
    );
  });

  test("value outside the enum", async () => {
    expectUsage(
      failure(
        await run(
          input({
            server: Option.some("eu"),
            serverVariables: [{ name: "version", value: canary }],
          }),
        ),
      ),
      "--server-variable",
    );
  });

  test("a variable assigned twice", async () => {
    expectUsage(
      failure(
        await run(
          input({
            serverVariables: [
              { name: "version", value: "v1" },
              { name: "version", value: canary },
            ],
          }),
        ),
      ),
      "--server-variable",
    );
  });

  test("--server-variable is not checked against the table when --base-url wins", async () => {
    const exit = await run(
      input({
        baseUrl: Option.some("https://flag.example.org"),
        serverVariables: [{ name: canary, value: "x" }],
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({ baseUrl: "https://flag.example.org", provenance: "operator" }),
    );
  });
});

const flagEnvironment = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      display: () => Effect.void,
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      rows: Effect.succeed(24),
      size: Effect.die("unused"),
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused")),
  ),
);

describe("global settings", () => {
  test("--base-url fails at parse time without echoing the value", async () => {
    const exit = await Effect.runPromiseExit(
      BaseUrl.baseUrlSetting.flag
        .parse({ arguments: [], flags: { "base-url": [`ftp://${canary}`] } })
        .pipe(Effect.provide(flagEnvironment)),
    );
    const error = failure(exit);
    expect(error).toMatchObject({ _tag: "UserError" });
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(error.message).toContain("--base-url");
  });

  test("--server-variable is repeatable and splits each pair", async () => {
    const exit = await Effect.runPromiseExit(
      BaseUrl.serverVariableSetting.flag
        .parse({ arguments: [], flags: { "server-variable": ["a=1", "b=2"] } })
        .pipe(Effect.provide(flagEnvironment)),
    );
    expect(exit).toEqual(
      Exit.succeed([
        [],
        [
          { name: "a", value: "1" },
          { name: "b", value: "2" },
        ],
      ]),
    );
  });

  test("export the three flag names", () => {
    expect(BaseUrl.baseUrlSetting.id).toBe("base-url");
    expect(BaseUrl.serverSetting.id).toBe("server");
    expect(BaseUrl.serverVariableSetting.id).toBe("server-variable");
  });
});
