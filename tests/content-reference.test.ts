import { beforeAll, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { Effect, Schema } from "effect";

const invoke = async (args: string[]) => {
  const child = Bun.spawn(
    ["node", "examples/content-reference/dist/main.js", "users", "posts", ...args],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { code, err, out };
};

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: "examples/content-reference",
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, out, err] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  expect(code, `${out}${err}`).toBe(0);
});

test("all operations expose help without required request inputs", async () => {
  await Effect.runPromise(
    Effect.forEach(
      [["list"], ["create"], ["files", "list"]],
      (args) =>
        Effect.promise(async () => {
          const result = await invoke([...args, "--help"]);
          expect(result.code).toBe(0);
          expect(result.out).toContain("--base-url");
          expect(result.out).toContain("--user");
        }),
      { concurrency: 1, discard: true },
    ),
  );
});

test("real requests preserve paths, optional query values and JSON body values", async () => {
  const requests: {
    body: string;
    contentType: string | undefined;
    method: string | undefined;
    url: string | undefined;
  }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      requests.push({
        body,
        contentType: request.headers["content-type"],
        method: request.method,
        url: request.url,
      });
      if ((request.url ?? "").startsWith("/failure/")) {
        response.writeHead(503).end("private-server-detail");
      } else if ((request.url ?? "").startsWith("/truncated/")) {
        response.writeHead(201, { "Content-Length": 100 });
        response.write("private-created-post", () => {
          response.destroy();
        });
      } else {
        response.end("wire-response");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
  );
  const origin = `http://127.0.0.1:${port}`;
  const base = ["--base-url", `${origin}/api/`, "--user", "alice/a? #"];
  try {
    await Effect.runPromise(
      Effect.forEach(
        [
          ["list"],
          ["list", "--status", "draft", "--limit", "20", "--published", "false"],
          ["list", "--status", "published", "--limit", "1", "--published", "true"],
          ["list", "--limit", "100"],
          ["create", "--body", '{"title":" First 🦉 ","published":false,"tags":["a","b"]}'],
          ["create", "--body", '{"title":"Only title"}'],
          ["files", "list", "--post", "post/1?#"],
        ],
        (args) =>
          Effect.promise(async () => {
            const result = await invoke([...args, ...base]);
            expect(result).toEqual({ code: 0, err: "", out: "wire-response\n" });
          }),
        { concurrency: 1, discard: true },
      ),
    );
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /api/users/alice%2Fa%3F%20%23/posts",
      "GET /api/users/alice%2Fa%3F%20%23/posts?limit=20&published=false&status=draft",
      "GET /api/users/alice%2Fa%3F%20%23/posts?limit=1&published=true&status=published",
      "GET /api/users/alice%2Fa%3F%20%23/posts?limit=100",
      "POST /api/users/alice%2Fa%3F%20%23/posts",
      "POST /api/users/alice%2Fa%3F%20%23/posts",
      "GET /api/users/alice%2Fa%3F%20%23/posts/post%2F1%3F%23/files",
    ]);

    const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
    expect(decodeBody(requests[4]?.body)).toEqual({
      published: false,
      tags: ["a", "b"],
      title: " First 🦉 ",
    });
    expect(decodeBody(requests[5]?.body)).toEqual({ title: "Only title" });
    expect(requests[4]?.contentType).toBe("application/json");
    expect(
      requests
        .filter((request) => request.method === "GET")
        .every((request) => request.body === ""),
    ).toBe(true);

    await Effect.runPromise(
      Effect.forEach(
        [
          ["list", "--limit", "0"],
          ["list", "--limit", "101"],
          ["list", "--limit", "1.5"],
          ["list", "--status", "deleted"],
          ["list", "--published", "yes"],
          ["create"],
          ["create", "--body", "{"],
          ["create", "--body", "null"],
          ["create", "--body", "{}"],
          ["create", "--body", '{"title":""}'],
          ["create", "--body", '{"title":1}'],
          ["create", "--body", '{"title":"x","published":"false"}'],
          ["create", "--body", '{"title":"x","tags":[1]}'],
          ["create", "--body", '{"title":"x","extra":true}'],
          ["files", "list", "--post", "."],
          ["files", "list", "--post", ".."],
          ["files", "list", "--post", ""],
        ],
        (args) =>
          Effect.promise(async () => {
            const result = await invoke([...args, ...base]);
            expect(result.code, `${args.join(" ")}: ${result.err}`).toBe(1);
          }),
        { concurrency: 1, discard: true },
      ),
    );
    await Effect.runPromise(
      Effect.forEach(
        [[], ["--user", ""], ["--user", "."], ["--user", ".."]],
        (args) =>
          Effect.promise(async () => {
            const result = await invoke(["list", "--base-url", `${origin}/api`, ...args]);
            expect(result.code).toBe(1);
          }),
        { concurrency: 1, discard: true },
      ),
    );
    await Effect.runPromise(
      Effect.forEach(
        [
          `${origin}/api?secret=private-token`,
          `${origin}/api#private-token`,
          `http://private-token@127.0.0.1:${port}/api`,
          "private-token",
          "file:///private-token",
        ],
        (url) =>
          Effect.promise(async () => {
            const result = await invoke(["list", "--user", "alice", "--base-url", url]);
            expect(result.code).toBe(1);
            expect(result.err).toContain("Invalid --base-url");
            expect(`${result.out}${result.err}`).not.toContain("private-token");
          }),
        { concurrency: 1, discard: true },
      ),
    );
    expect(requests).toHaveLength(7);

    await Effect.runPromise(
      Effect.forEach(
        [["list"], ["create", "--body", '{"title":"x"}'], ["files", "list", "--post", "p"]],
        (args) =>
          Effect.promise(async () => {
            const result = await invoke([
              ...args,
              "--base-url",
              `${origin}/failure`,
              "--user",
              "alice",
            ]);
            expect(result.code).toBe(1);
            expect(result.out).toBe("");
            expect(result.err).toContain(
              "The server returned HTTP 503. Check the API service status.",
            );
            expect(result.err).not.toContain("private-server-detail");
          }),
        { concurrency: 1, discard: true },
      ),
    );
    expect(requests).toHaveLength(10);

    const truncated = await invoke([
      "create",
      "--body",
      '{"title":"Created once"}',
      "--base-url",
      `${origin}/truncated`,
      "--user",
      "alice",
    ]);
    expect(truncated.code).toBe(1);
    expect(truncated.out).toBe("");
    expect(truncated.err).toContain(
      "The response could not be read. Check the API server and connection.",
    );
    expect(truncated.err.toLowerCase()).not.toContain("retry");
    expect(truncated.err).not.toContain("private-created-post");
    expect(requests).toHaveLength(11);
    expect(requests[10]?.method).toBe("POST");
    expect(requests[10]?.url).toBe("/truncated/users/alice/posts");
  } finally {
    await server[Symbol.asyncDispose]();
  }
  const refused = await invoke(["list", "--base-url", origin, "--user", "alice"]);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("Connection failed.");
}, 30_000);
