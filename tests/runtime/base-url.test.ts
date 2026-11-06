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
import { HttpClient, HttpClientResponse } from "effect/http";
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

// An operation-level override (design 6.4): its own servers, its own accepted default, the same
// bound set. The root table above stays the `Servers` service's table.
const operationServer: BaseUrl.ServerEntry = { url: "https://ops.example.com/oplevel" };

const operationTable: BaseUrl.ServersTable = {
  boundOrigins: [...table.boundOrigins, "https://alt.example.com", "https://ops.example.com"],
  defaultServer: 0,
  servers: [operationServer, { name: "alt", url: "https://alt.example.com" }],
};

const unacceptedOperation: BaseUrl.ServersTable = {
  boundOrigins: table.boundOrigins,
  servers: [{ url: "https://unaccepted.example.com/v1" }],
};

const runFor = (
  selection: SelectionInput,
  override: BaseUrl.ServersTable,
  env: Record<string, string> = {},
) =>
  Effect.runPromiseExit(
    BaseUrl.select(selection, override).pipe(
      Effect.flatMap((chosen) => BaseUrl.resolve(chosen, override)),
      Effect.provide(BaseUrl.layer(table, "EXAMPLE")),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
    ),
  );

describe("effective servers: an operation override", () => {
  test("the request base is the operation's accepted default, not the root's", async () => {
    const exit = await runFor(input(), operationTable);
    expect(exit).toEqual(Exit.succeed("https://ops.example.com/oplevel"));
  });

  test("--server indexes the operation's list", async () => {
    expect(await runFor(input({ server: Option.some("1") }), operationTable)).toEqual(
      Exit.succeed("https://alt.example.com"),
    );
    expect(await runFor(input({ server: Option.some("alt") }), operationTable)).toEqual(
      Exit.succeed("https://alt.example.com"),
    );
    expectUsage(
      failure(await runFor(input({ server: Option.some("eu") }), operationTable)),
      "--server",
    );
  });

  test("an operation whose servers are not accepted has no default and names --base-url", async () => {
    expectUsage(failure(await runFor(input(), unacceptedOperation)), "--base-url");
  });

  test("an unaccepted operation server is reached through --base-url or the env value", async () => {
    expect(
      await runFor(
        input({ baseUrl: Option.some("https://unaccepted.example.com/v1") }),
        unacceptedOperation,
      ),
    ).toEqual(Exit.succeed("https://unaccepted.example.com/v1"));
    expect(
      await runFor(input(), unacceptedOperation, {
        EXAMPLE_BASE_URL: "https://unaccepted.example.com/v1",
      }),
    ).toEqual(Exit.succeed("https://unaccepted.example.com/v1"));
  });

  test("an operation server outside the operation's bound set is refused", async () => {
    const outside: BaseUrl.ServersTable = { ...operationTable, boundOrigins: table.boundOrigins };
    expectUsage(failure(await runFor(input(), outside)), "--server");
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

const server = (url: string, variables?: BaseUrl.ServerEntry["variables"]): BaseUrl.ServerEntry =>
  variables === undefined ? { url } : { url, variables };

const resolveServer = (
  entry: BaseUrl.ServerEntry,
  values: Readonly<Record<string, string>>,
  bound: readonly string[] = ["https://api.example.com"],
) =>
  Effect.runPromiseExit(
    BaseUrl.resolve({ provenance: "server", server: entry, variables: values }).pipe(
      Effect.provide(BaseUrl.layer({ boundOrigins: bound, servers: [entry] }, "EXAMPLE")),
    ),
  );

// A client that counts the requests it is given and answers each with 204.
const counting = () => {
  const urls: string[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      urls.push(request.url);

      return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
    }),
  );

  return { layer: Layer.succeed(HttpClient.HttpClient, client), urls };
};

const sendThrough = (selection: BaseUrl.Selection, boundTable: BaseUrl.ServersTable) => {
  const { layer: clientLayer, urls } = counting();
  const program = Effect.gen(function* send() {
    const base = yield* BaseUrl.resolve(selection);
    const client = yield* HttpClient.HttpClient;

    return yield* client.get(BaseUrl.requestUrl(base, "/users/1", "a=b"));
  }).pipe(Effect.provide(BaseUrl.layer(boundTable, "EXAMPLE")), Effect.provide(clientLayer));

  return { exit: Effect.runPromiseExit(program), urls };
};

describe("resolve: operator selection", () => {
  test("returns the operator's base unchanged and does not check the bound set", async () => {
    const exit = await Effect.runPromiseExit(
      BaseUrl.resolve({
        baseUrl: "https://elsewhere.example.org/api",
        provenance: "operator",
      }).pipe(Effect.provide(BaseUrl.layer(table, "EXAMPLE"))),
    );
    expect(exit).toEqual(Exit.succeed("https://elsewhere.example.org/api"));
  });
});

describe("resolve: server expansion", () => {
  test("expands defaults and keeps the template's encoded bytes", async () => {
    const exit = await resolveServer(
      server("https://api.example.com/a%20b/{version}", { version: { default: "v1" } }),
      { version: "v1" },
    );
    expect(exit).toEqual(Exit.succeed("https://api.example.com/a%20b/v1"));
  });

  test("encodes a path-position value per segment", async () => {
    const exit = await resolveServer(
      server("https://api.example.com/{p}", { p: { default: "x" } }),
      { p: "a b/c?d#e" },
    );
    expect(exit).toEqual(Exit.succeed("https://api.example.com/a%20b%2Fc%3Fd%23e"));
  });

  test("a path value of /evil.com cannot leave the origin", async () => {
    const exit = await resolveServer(
      server("https://api.example.com/{x}", { x: { default: "v1" } }),
      { x: "/evil.com" },
    );
    expect(exit).toEqual(Exit.succeed("https://api.example.com/%2Fevil.com"));
  });

  test("a path value of ../ or // stays inside one segment", async () => {
    const exit = await resolveServer(
      server("https://api.example.com/{x}", { x: { default: "v1" } }),
      { x: "//evil.com" },
    );
    expect(exit).toEqual(Exit.succeed("https://api.example.com/%2F%2Fevil.com"));
  });

  test("an authority variable inside the bound set expands", async () => {
    const exit = await resolveServer(
      server("https://{region}.example.com/v1", { region: { default: "api", enum: ["api"] } }),
      { region: "api" },
    );
    expect(exit).toEqual(Exit.succeed("https://api.example.com/v1"));
  });

  test("a bound origin written with a default port is matched after parsing", async () => {
    const exit = await resolveServer(server("https://api.example.com:443/v1"), {}, [
      "https://api.example.com",
    ]);
    expect(exit).toEqual(Exit.succeed("https://api.example.com:443/v1"));
  });

  test("a template naming an undeclared variable is a UsageError", async () => {
    const error = failure(await resolveServer(server("https://api.example.com/{ghost}"), {}));
    expect(error).toMatchObject({ _tag: "UsageError", flag: "--server" });
  });

  test("a stray brace after expansion is a UsageError", async () => {
    const error = failure(await resolveServer(server("https://api.example.com/{v"), {}));
    expect(error).toMatchObject({ _tag: "UsageError" });
  });
});

describe("resolve: unbound origins", () => {
  const host = server("https://{host}/v1", { host: { default: "api.example.com" } });

  test("an unbound --server-variable origin names --server-variable", async () => {
    const error = failure(await resolveServer(host, { host: `${canary}.evil.test` }));
    expectUsage(error, "--server-variable");
  });

  test("an unbound origin from a server without variables names --server", async () => {
    const error = failure(await resolveServer(server("https://other.example.net/v1"), {}));
    expect(error).toMatchObject({ _tag: "UsageError", flag: "--server" });
    expect(Runtime.getErrorExitCode(error)).toBe(2);
  });

  test("a different scheme or port is a different origin", async () => {
    const scheme = failure(await resolveServer(server("http://api.example.com/v1"), {}));
    const port = failure(await resolveServer(server("https://api.example.com:8443/v1"), {}));
    expect(scheme).toMatchObject({ _tag: "UsageError" });
    expect(port).toMatchObject({ _tag: "UsageError" });
  });

  test("an authority value that adds userinfo is refused without the value", async () => {
    const error = failure(await resolveServer(host, { host: `${canary}@api.example.com` }));
    expectUsage(error, "--server-variable");
  });

  test("a suffix that keeps the origin but adds a query is refused", async () => {
    const error = failure(
      await resolveServer(server("https://api.example.com{x}", { x: { default: "" } }), {
        x: `?k=${canary}`,
      }),
    );
    expectUsage(error, "--server-variable");
  });

  test("an authority value that adds a fragment is refused", async () => {
    const error = failure(await resolveServer(host, { host: `api.example.com#${canary}` }));
    expectUsage(error, "--server-variable");
  });

  test("a non-http scheme from a scheme variable is refused", async () => {
    const error = failure(
      await resolveServer(
        server("{scheme}://api.example.com/v1", { scheme: { default: "https" } }),
        { scheme: "ftp" },
        ["ftp://api.example.com"],
      ),
    );
    expect(error).toMatchObject({ _tag: "UsageError", flag: "--server-variable" });
  });

  test("zero requests reach the client through --server-variable", async () => {
    const entry = server("https://{host}/v1", { host: { default: "api.example.com" } });
    const { exit, urls } = sendThrough(
      { provenance: "server", server: entry, variables: { host: "evil.example.net" } },
      { boundOrigins: ["https://api.example.com"], servers: [entry] },
    );
    expect(failure(await exit)).toMatchObject({ _tag: "UsageError", flag: "--server-variable" });
    expect(urls).toEqual([]);
  });

  test("zero requests reach the client through --server", async () => {
    const entry = server("https://unbound.example.net/v1");
    const { exit, urls } = sendThrough(
      { provenance: "server", server: entry, variables: {} },
      { boundOrigins: ["https://api.example.com"], servers: [entry] },
    );
    expect(failure(await exit)).toMatchObject({ _tag: "UsageError", flag: "--server" });
    expect(urls).toEqual([]);
  });

  test("a bound expansion reaches the client once with the concatenated URL", async () => {
    const entry = server("https://api.example.com/a%20b/{version}", {
      version: { default: "v1" },
    });
    const { exit, urls } = sendThrough(
      { provenance: "server", server: entry, variables: { version: "v1" } },
      { boundOrigins: ["https://api.example.com"], servers: [entry] },
    );
    await exit;
    expect(urls).toEqual(["https://api.example.com/a%20b/v1/users/1?a=b"]);
  });
});

describe("requestUrl", () => {
  test("concatenates base, path and query", () => {
    expect(BaseUrl.requestUrl("https://api.example.com", "/users/1", "a=b")).toBe(
      "https://api.example.com/users/1?a=b",
    );
  });

  test("omits the separator when the query is absent or empty", () => {
    expect(BaseUrl.requestUrl("https://api.example.com", "/users")).toBe(
      "https://api.example.com/users",
    );
    expect(BaseUrl.requestUrl("https://api.example.com", "/users", "")).toBe(
      "https://api.example.com/users",
    );
  });

  test("keeps a base path prefix and its encoded bytes", () => {
    expect(BaseUrl.requestUrl("https://api.example.com/v1/a%20b", "/users/x%2Fy", "q=1")).toBe(
      "https://api.example.com/v1/a%20b/users/x%2Fy?q=1",
    );
  });

  test("a trailing slash on the base does not double the separator", () => {
    expect(BaseUrl.requestUrl("https://api.example.com/v1/", "/users")).toBe(
      "https://api.example.com/v1/users",
    );
  });

  test("a path that looks absolute never replaces the base", () => {
    expect(BaseUrl.requestUrl("https://api.example.com/v1", "//evil.com/x")).toBe(
      "https://api.example.com/v1//evil.com/x",
    );
  });
});
