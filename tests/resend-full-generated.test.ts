import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { Array, Effect, Order, Schema } from "effect";
import { generate } from "../src/index.js";

const root = "examples/resend-full-generated";

const JsonObject = Schema.fromJsonString(Schema.JsonObject);

const Paths = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.JsonObject));

const invoke = async (args: readonly string[]) => {
  const process = Bun.spawn(["node", `${root}/dist/main.js`, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, out, err] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  return { code, err, out };
};

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], { cwd: root, stderr: "pipe", stdout: "pipe" });
  const [code, out, err] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  expect({ code, err, out }).toMatchObject({ code: 0 });
});

test("full input retains every value from the pinned unannotated snapshot", async () => {
  const raw = await readFile("examples/resend-reference/upstream/resend.json.snapshot", "utf-8");
  expect(createHash("sha256").update(raw).digest("hex")).toBe(
    "834cc0af1324a7a01e8cbe7d125297a249233ecb0fd344faf1024acff9139949",
  );

  const original = Schema.decodeUnknownSync(JsonObject)(raw);
  const input = Schema.decodeUnknownSync(JsonObject)(
    await readFile(`${root}/openapi.json`, "utf-8"),
  );
  const paths = Schema.decodeUnknownSync(Paths)(input.paths);
  expect(Object.keys(paths)).toHaveLength(72);
  expect(Object.values(paths).flatMap((item) => Object.values(item))).toHaveLength(113);
  expect(
    Object.keys(
      Schema.decodeUnknownSync(Schema.Struct({ schemas: Schema.JsonObject }))(input.components)
        .schemas,
    ),
  ).toHaveLength(197);
  expect(input).toEqual(original);
});

test("all 113 raw operationId command help routes work without credentials or a base URL", async () => {
  const input = Schema.decodeUnknownSync(JsonObject)(
    await readFile(`${root}/openapi.json`, "utf-8"),
  );
  const paths = Schema.decodeUnknownSync(Paths)(input.paths);
  const operations = Object.values(paths).flatMap((item) => Object.values(item));
  await Effect.runPromise(
    Effect.forEach(
      operations,
      (operation) =>
        Effect.promise(async () => {
          const id = Schema.decodeUnknownSync(Schema.String)(operation.operationId);
          const address = id.split("/");
          const result = await invoke([...address, "--help"]);
          expect(result.code, `${address.join(" ")} ${result.err}`).toBe(0);
          expect(result.out).toContain("--help");
        }),
      { concurrency: 4, discard: true },
    ),
  );
}, 120_000);

test("full source is deterministic current generator output with no stale modules", async () => {
  const input = Schema.decodeUnknownSync(JsonObject)(
    await readFile(`${root}/openapi.json`, "utf-8"),
  );
  const output = await Effect.runPromise(generate(input, { name: "resend-full-generated" }));
  expect(await Effect.runPromise(generate(input, { name: "resend-full-generated" }))).toEqual(
    output,
  );
  await Promise.all(
    output.files.map(async (file) => {
      expect(await readFile(`${root}/${file.path}`, "utf-8"), file.path).toBe(file.content);
    }),
  );
  const entries = await readdir(`${root}/src`, { recursive: true });
  const actual = Array.sort(
    entries.filter((entry) => entry.endsWith(".ts")),
    Order.String,
  );
  const expected = Array.sort(
    output.files.filter((file) => file.path.startsWith("src/")).map((file) => file.path.slice(4)),
    Order.String,
  );
  expect(actual).toEqual(expected);
});

const fixture = async () => {
  const requests: { body: string; contentType: string; url: string; method: string | undefined }[] =
    [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      requests.push({
        body,
        contentType: request.headers["content-type"] ?? "",
        method: request.method,
        url: request.url ?? "",
      });
      response.end("accepted");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
  );

  return { origin: `http://127.0.0.1:${port}`, requests, server };
};

test("query arrays serialize declared form values and reject ambiguity before HTTP", async () => {
  const { server, requests, origin } = await fixture();
  try {
    const command = ["emails", "metrics", "--base-url", origin, "--bearer-auth", "local-test"];
    const result = await invoke([
      ...command,
      "--metrics",
      '["sent","opened"]',
      "--dimensions",
      '["period"]',
      "--domain-id",
      '["one","two"]',
    ]);
    expect(result.code, result.err).toBe(0);

    const url = new URL(requests[0]?.url ?? "", origin);
    expect(url.pathname).toBe("/emails/metrics");
    expect(url.searchParams.get("metrics")).toBe("sent,opened");
    expect(url.searchParams.get("dimensions")).toBe("period");
    expect(url.searchParams.get("domain_id")).toBe("one,two");
    expect(url.searchParams.has("broadcast_id")).toBe(false);

    const empty = await invoke([...command, "--domain-id", "[]"]);
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("domain_id");

    const comma = await invoke([...command, "--domain-id", '["private,delimiter"]']);
    expect(comma.code).toBe(1);
    expect(comma.err).toContain("domain_id");
    expect(comma.err).not.toContain("private");
    expect(requests).toHaveLength(1);
  } finally {
    await server[Symbol.asyncDispose]();
  }
}, 30_000);

test("new request models preserve mixed values and arbitrary JSON array items", async () => {
  const { server, requests, origin } = await fixture();
  const common = ["--base-url", origin, "--bearer-auth", "local-test"];
  const cases = [
    {
      body: { email: "test@example.com", properties: { missing: null, number: 0, text: "" } },
      command: ["contacts", "create"],
    },
    {
      body: { properties: { enabled: false, missing: null } },
      command: ["contacts", "update", "--id", "contact"],
    },
    {
      body: {
        html: "<p>Test</p>",
        name: "test",
        variables: [
          { fallback_value: [null, false, 0, "", { nested: [1] }], key: "items", type: "list" },
        ],
      },
      command: ["templates", "create"],
    },
  ];
  try {
    await Effect.runPromise(
      Effect.forEach(
        cases,
        (entry) =>
          Effect.promise(async () => {
            const result = await invoke([
              ...entry.command,
              ...common,
              "--body",
              JSON.stringify(entry.body),
            ]);
            expect(result.code, result.err).toBe(0);

            const request = requests.at(-1);
            expect(
              Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(request?.body),
            ).toEqual(entry.body);
          }),
        { concurrency: 1, discard: true },
      ),
    );
    const invalid = await invoke([
      "contacts",
      "create",
      ...common,
      "--body",
      '{"email":"test@example.com","properties":{"enabled":false}}',
    ]);
    expect(invalid.code).toBe(1);
    expect(requests).toHaveLength(3);
  } finally {
    await server[Symbol.asyncDispose]();
  }
}, 30_000);

test("raw Resend contacts create-import uploads the declared file and unchanged text", async () => {
  const { server, requests, origin } = await fixture();
  const directory = await mkdtemp(path.join(tmpdir(), "resend-import-"));
  try {
    const filename = path.join(directory, "contacts.csv");
    const csv = "email,first_name\nreader@example.com,Reader\n";
    await writeFile(filename, csv);
    const result = await invoke([
      "contacts",
      "create-import",
      "--base-url",
      origin,
      "--bearer-auth",
      "local-test",
      "--file",
      filename,
      "--column-map",
      "raw text",
      "--additional-fields",
      '{"future":"preserved"}',
    ]);
    expect(result.code, result.err).toBe(0);
    expect(requests).toHaveLength(1);

    const [request] = requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/contacts/imports");
    expect(request?.contentType).toContain("multipart/form-data; boundary=");

    const response = new Response(request?.body, {
      headers: { "content-type": request?.contentType ?? "" },
    });
    // oxlint-disable-next-line typescript/no-deprecated -- Parse only this trusted local fixture's small captured body.
    const form = await response.formData();
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) {
      throw new Error("Expected the generated file part.");
    }

    expect(file.name).toBe("contacts.csv");
    expect(await file.text()).toBe(csv);
    expect(form.get("column_map")).toBe("raw text");
    expect(form.get("future")).toBe("preserved");
    expect(form.has("on_conflict")).toBe(false);
  } finally {
    await server[Symbol.asyncDispose]();
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);
