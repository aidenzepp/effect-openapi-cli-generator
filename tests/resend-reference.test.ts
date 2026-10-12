import { beforeAll, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { Effect, Schema } from "effect";

const invoke = async (args: string[], apiKey = "") => {
  const child = Bun.spawn(["node", "examples/resend-reference/dist/main.js", ...args], {
    env: { ...process.env, RESEND_API_KEY: apiKey },
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

const each = <A>(values: readonly A[], f: (value: A) => Promise<void>) =>
  Effect.runPromise(
    Effect.forEach(values, (value) => Effect.promise(() => f(value)), {
      concurrency: 1,
      discard: true,
    }),
  );

const fixture = async () => {
  const requests: {
    authorization: string | undefined;
    body: string;
    contentType: string | undefined;
    idempotency: string | string[] | undefined;
    method: string | undefined;
    url: string;
  }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body,
        contentType: request.headers["content-type"],
        idempotency: request.headers["idempotency-key"],
        method: request.method,
        url: request.url ?? "",
      });
      if ((request.url ?? "").startsWith("/unauthorized/")) {
        response.writeHead(401).end("private-server-detail");
      } else if ((request.url ?? "").startsWith("/unavailable/")) {
        response.writeHead(503).end("private-server-detail");
      } else if ((request.url ?? "").startsWith("/truncated/")) {
        response.writeHead(201, { "Content-Length": 100 });
        response.write("private-created-email", () => {
          response.destroy();
        });
      } else {
        response.end("wire-response");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
  );

  return { origin: `http://127.0.0.1:${address.port}`, requests, server };
};

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: "examples/resend-reference",
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

test("Resend help requires neither credentials nor an API URL", async () => {
  await each(
    [
      [],
      ["domains", "list"],
      ["domains", "create"],
      ["domains", "update"],
      ["domains", "delete"],
      ["emails", "send"],
      ["emails", "batch", "send"],
      ["emails", "attachments", "list"],
      ["emails", "attachments", "get"],
    ],
    async (command) => {
      const result = await invoke([...command, "--help"]);
      expect(result.code, result.err).toBe(0);
      expect(result.out).not.toBe("");
    },
  );
});

test("eight Resend operations preserve methods, path segments, headers and omitted bodies", async () => {
  const { origin, requests, server } = await fixture();
  const base = ["--base-url", `${origin}/api/`, "--api-key", "local-test-token"];
  try {
    await each(
      [
        ["domains", "list"],
        ["domains", "create"],
        ["domains", "update", "--domain-id", "domain/a?#"],
        ["domains", "delete", "--domain-id", "domain/a?#"],
        ["emails", "send", "--idempotency-key", "send-once"],
        ["emails", "batch", "send"],
        ["emails", "attachments", "list", "--email-id", "email/a?#"],
        ["emails", "attachments", "get", "--email-id", "email/a?#", "--attachment-id", "file/a?#"],
      ],
      async (command) => {
        expect(await invoke([...command, ...base])).toEqual({
          code: 0,
          err: "",
          out: "wire-response\n",
        });
      },
    );
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET /api/domains",
      "POST /api/domains",
      "PATCH /api/domains/domain%2Fa%3F%23",
      "DELETE /api/domains/domain%2Fa%3F%23",
      "POST /api/emails",
      "POST /api/emails/batch",
      "GET /api/emails/email%2Fa%3F%23/attachments",
      "GET /api/emails/email%2Fa%3F%23/attachments/file%2Fa%3F%23",
    ]);
    expect(requests.every(({ authorization }) => authorization === "Bearer local-test-token")).toBe(
      true,
    );
    expect(requests.every(({ body }) => body === "")).toBe(true);
    expect(requests[4]?.idempotency).toBe("send-once");
    expect(requests[5]?.idempotency).toBeUndefined();

    const fallback = await invoke(
      ["domains", "list", "--base-url", `${origin}/api`],
      "environment-test-token",
    );
    expect(fallback.code, fallback.err).toBe(0);
    expect(requests.at(-1)?.authorization).toBe("Bearer environment-test-token");

    const explicit = await invoke(["domains", "list", ...base], "environment-test-token");
    expect(explicit.code, explicit.err).toBe(0);
    expect(requests.at(-1)?.authorization).toBe("Bearer local-test-token");
  } finally {
    await server[Symbol.asyncDispose]();
  }
}, 30_000);

test("request models preserve original JSON, unknown fields and omitted defaults", async () => {
  const { origin, requests, server } = await fixture();
  const base = ["--base-url", `${origin}/api`, "--api-key", "local-test-token"];
  const email = {
    attachments: [{ content: "@/not-a-real-file", extra: { keep: false }, filename: "" }],
    from: "",
    headers: { "X-Test": "value", extra: { zero: 0 } },
    subject: "",
    tags: [{ name: "not constrained by prose 🦉", value: "x".repeat(257) }],
    template: { extra: false, id: "", variables: { count: 0, text: "" } },
    to: "recipient@example.test",
    unknown: { keep: [false, 0, ""] },
  };
  const domain = {
    capabilities: { extra: "keep", receiving: "disabled", sending: "disabled" },
    click_tracking: false,
    name: "",
    open_tracking: false,
    region: "eu-west-1",
    tls: "enforced",
    unknown: true,
  };
  try {
    const cases = [
      { body: email, command: ["emails", "send", "--idempotency-key", "x".repeat(256)] },
      { body: { ...email, to: ["a"] }, command: ["emails", "send"] },
      {
        body: { ...email, to: Array.from({ length: 50 }, () => "a") },
        command: ["emails", "send"],
      },
      {
        body: [{ ...email, to: ["a@example.test", "b@example.test"] }],
        command: ["emails", "batch", "send"],
      },
      { body: [], command: ["emails", "batch", "send"] },
      { body: domain, command: ["domains", "create"] },
      { body: { name: "example.test" }, command: ["domains", "create"] },
      {
        body: { click_tracking: false, open_tracking: false },
        command: ["domains", "update", "--domain-id", "id"],
      },
    ];
    await each(cases, async ({ body, command }) => {
      const result = await invoke([...command, ...base, "--body", JSON.stringify(body)]);
      expect(result.code, result.err).toBe(0);
      expect(JSON.parse(requests.at(-1)?.body ?? "null")).toEqual(body);
      expect(requests.at(-1)?.contentType).toBe("application/json");
    });
  } finally {
    await server[Symbol.asyncDispose]();
  }
}, 30_000);

test("pagination follows declared numeric bounds without inventing cursor exclusivity", async () => {
  const { origin, requests, server } = await fixture();
  const base = ["--base-url", `${origin}/api`, "--api-key", "local-test-token"];
  try {
    await each(
      [
        ["domains", "list", "--limit", "1", "--after", "a?", "--before", "b#"],
        ["domains", "list", "--limit", "100"],
        [
          "emails",
          "attachments",
          "list",
          "--email-id",
          "id",
          "--limit",
          "0",
          "--after",
          "a",
          "--before",
          "b",
        ],
      ],
      async (command) => {
        const result = await invoke([...command, ...base]);
        expect(result.code, result.err).toBe(0);
      },
    );
    const first = new URL(requests[0]?.url ?? "", origin);
    expect(Object.fromEntries(first.searchParams)).toEqual({
      after: "a?",
      before: "b#",
      limit: "1",
    });

    const last = new URL(requests[2]?.url ?? "", origin);
    expect(Object.fromEntries(last.searchParams)).toEqual({ after: "a", before: "b", limit: "0" });
    await each(
      [
        ["domains", "list", "--limit", "0"],
        ["domains", "list", "--limit", "101"],
        ["domains", "list", "--limit", "1.5"],
        ["emails", "attachments", "list", "--email-id", "id", "--limit", "1.5"],
      ],
      async (command) => {
        const result = await invoke([...command, ...base]);
        expect(result.code).toBe(1);
      },
    );
    expect(requests).toHaveLength(3);
  } finally {
    await server[Symbol.asyncDispose]();
  }
}, 30_000);

test("invalid body models fail before HTTP and do not reveal body contents", async () => {
  const { origin, requests, server } = await fixture();
  const base = ["--base-url", `${origin}/api`, "--api-key", "local-test-token"];
  const email = { from: "private-sender", subject: "private-subject", to: "a" };
  try {
    const cases = [
      { body: "{", command: ["emails", "send"] },
      { body: "null", command: ["emails", "send"] },
      { body: "{}", command: ["emails", "send"] },
      { body: JSON.stringify({ ...email, to: [] }), command: ["emails", "send"] },
      {
        body: JSON.stringify({ ...email, to: Array.from({ length: 51 }, () => "a") }),
        command: ["emails", "send"],
      },
      { body: JSON.stringify({ ...email, to: 1 }), command: ["emails", "send"] },
      {
        body: JSON.stringify({ ...email, template: { variables: {} } }),
        command: ["emails", "send"],
      },
      {
        body: JSON.stringify({ ...email, template: { id: "x", variables: { bad: true } } }),
        command: ["emails", "send"],
      },
      { body: JSON.stringify([{}]), command: ["emails", "batch", "send"] },
      { body: JSON.stringify(email), command: ["emails", "batch", "send"] },
      { body: "{}", command: ["domains", "create"] },
      { body: '{"name":"x","region":"moon"}', command: ["domains", "create"] },
      { body: '{"name":"x","tls":"none"}', command: ["domains", "create"] },
      { body: '{"name":"x","capabilities":{"sending":"yes"}}', command: ["domains", "create"] },
      { body: '{"open_tracking":"false"}', command: ["domains", "update", "--domain-id", "id"] },
    ];
    await each(cases, async ({ body, command }) => {
      const result = await invoke([...command, ...base, "--body", body]);
      expect(result.code, `${command.join(" ")}: ${result.err}`).toBe(1);
      expect(`${result.out}${result.err}`).not.toContain("private-sender");
      expect(`${result.out}${result.err}`).not.toContain("private-subject");
    });
    const tooLong = await invoke(["emails", "send", ...base, "--idempotency-key", "x".repeat(257)]);
    expect(tooLong.code).toBe(1);
    await each([".", ".."], async (id) => {
      const result = await invoke(["domains", "delete", ...base, "--domain-id", id]);
      expect(result.code).toBe(1);
    });
    expect(requests).toHaveLength(0);
  } finally {
    await server[Symbol.asyncDispose]();
  }
}, 30_000);

test("transport and authentication errors are safe and writes are never retried", async () => {
  const { origin, requests, server } = await fixture();
  try {
    const noAuth = await invoke(["domains", "list", "--base-url", `${origin}/api`]);
    expect(noAuth.code).toBe(1);
    expect(requests).toHaveLength(0);
    await each(
      [["unauthorized", "401"] as const, ["unavailable", "503"] as const],
      async ([prefix, status]) => {
        const result = await invoke([
          "emails",
          "send",
          "--base-url",
          `${origin}/${prefix}`,
          "--api-key",
          "private-test-credential",
        ]);
        expect(result.code).toBe(1);
        expect(result.out).toBe("");
        expect(result.err).toContain(status);
        expect(result.err).not.toContain("private-server-detail");
        expect(result.err).not.toContain("private-test-credential");
      },
    );
    const truncated = await invoke([
      "emails",
      "send",
      "--base-url",
      `${origin}/truncated`,
      "--api-key",
      "private-test-credential",
    ]);
    expect(truncated.code).toBe(1);
    expect(truncated.out).toBe("");
    expect(truncated.err).not.toContain("private-created-email");
    expect(truncated.err).not.toContain("private-test-credential");
    expect(truncated.err.toLowerCase()).not.toContain("retry");
    expect(requests).toHaveLength(3);
    expect(requests.every(({ method }) => method === "POST")).toBe(true);
  } finally {
    await server[Symbol.asyncDispose]();
  }
}, 30_000);
