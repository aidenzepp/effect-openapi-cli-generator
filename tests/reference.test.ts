import { beforeAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { Effect, Schema } from "effect";

/**
 * Run the compiled reference and capture both CLI output streams.
 *
 * @param args - Arguments following the users list command.
 * @returns The exit code and output produced by the real Node CLI.
 */
const invoke = async (args: string[]) => {
  const child = Bun.spawn(["node", "examples/reference/dist/main.js", "users", "list", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { code, err, out };
};

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: "examples/reference",
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, err] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  expect(code, err).toBe(0);
});

test("base URL rejection never echoes credentials or query and fragment secrets", async () => {
  await Effect.runPromise(
    Effect.forEach(
      [
        "https://dummy-user:dummy-secret@example.test/api",
        "https://example.test/api?token=dummy-secret",
        "https://example.test/api#dummy-secret",
        "dummy-secret",
        "file:///dummy-secret",
      ],
      (url) =>
        Effect.promise(async () => {
          const result = await invoke(["--base-url", url]);
          expect(result.code).toBe(1);
          expect(result.out).not.toContain("dummy-secret");
          expect(result.out).not.toContain("dummy-user");
          expect(result.err).toContain("--base-url");
          expect(result.err).toContain("HTTP(S)");
          expect(result.err).not.toContain("dummy-secret");
          expect(result.err).not.toContain("dummy-user");
        }),
      { concurrency: 1, discard: true },
    ),
  );
});

test("help describes path prefixes and active requires explicit true or false", async () => {
  const help = await invoke(["--help"]);
  expect(help.code).toBe(0);
  expect(help.out).toContain("path prefix");

  const invalid = await invoke(["--base-url", "http://127.0.0.1:1", "--active", "yes"]);
  expect(invalid.code).toBe(1);
  expect(invalid.err).toContain("true");
  expect(invalid.err).toContain("false");
});

test("HTTP execution preserves prefixes and boolean values and reports safe failures", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if ((request.url ?? "").startsWith("/missing/")) {
      response.writeHead(404).end("private-server-detail");
    } else if ((request.url ?? "").startsWith("/unavailable/")) {
      response.writeHead(503).end("private-server-detail");
    } else if ((request.url ?? "").startsWith("/truncated/")) {
      response.writeHead(200, { "Content-Length": 100 });
      response.write("private-server-detail", () => {
        response.destroy();
      });
    } else {
      response.end('[{"id":0,"active":false}]');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
  );
  const origin = `http://127.0.0.1:${port}`;
  try {
    await Effect.runPromise(
      Effect.forEach(
        [[], ["--active", "true"], ["--active", "false"]],
        (active) =>
          Effect.promise(async () => {
            const result = await invoke(["--base-url", `${origin}/api/`, ...active]);
            expect(result).toEqual({ code: 0, err: "", out: '[{"id":0,"active":false}]\n' });
          }),
        { concurrency: 1, discard: true },
      ),
    );
    expect(requests).toEqual([
      "GET /api/users",
      "GET /api/users?active=true",
      "GET /api/users?active=false",
    ]);
    await Effect.runPromise(
      Effect.forEach(
        [
          ["missing", "HTTP 404"],
          ["unavailable", "HTTP 503"],
          ["truncated", "response could not be read"],
        ] as const,
        ([prefix, message]) =>
          Effect.promise(async () => {
            const result = await invoke(["--base-url", `${origin}/${prefix}`]);
            expect(result.code).toBe(1);
            expect(result.out).toBe("");
            expect(result.err).toContain(message);
            expect(result.err).not.toContain("private-server-detail");
          }),
        { concurrency: 1, discard: true },
      ),
    );
  } finally {
    await server[Symbol.asyncDispose]();
  }
  const refused = await invoke(["--base-url", origin]);
  expect(refused.code).toBe(1);
  expect(refused.out).toBe("");
  expect(refused.err).toContain("connection failed");
  expect(refused.err).toContain("server is reachable");
}, 20_000);
